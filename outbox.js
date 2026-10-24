// 신호가 약할 때 입력 보존: 보내지 못한 입력(계측값·사진·측량 파일)을 이 폰(IndexedDB)에 보관했다가 신호가 잡히면 자동으로 보낸다.
// 서버가 같은 clientId를 한 번만 받아 주므로 응답만 유실돼 다시 보내도 중복으로 쌓이지 않는다.
// 이 파일은 app.js보다 먼저 읽히므로, 화면 요소($)·api·state는 함수가 불릴 때만 쓴다.

const OUTBOX_DB = 'gyecheuk';
const OUTBOX_STORE = 'outbox';
const FLUSH_EVERY_MS = 30 * 1000;
const FLASH_MS = 4000;
const MAX_SERVER_TRIES = 5;

let dbPromise = null;
let flushing = null;
let flashText = '';
let flashTimer = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function runStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, mode);
    const req = fn(tx.objectStore(OUTBOX_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const outboxPut = (item) => runStore('readwrite', (s) => s.put(item));
const outboxDelete = (id) => runStore('readwrite', (s) => s.delete(id));
const outboxAll = async () => (await runStore('readonly', (s) => s.getAll())).sort((a, b) => a.createdAt - b.createdAt);

// 서버가 입력 자체를 거부한 것: 다시 보내도 결과가 같으므로 바로 실패로 표시한다
const PERMANENT_ERRORS = ['invalid', 'bad_code', 'forbidden', 'expired', 'not_found', 'duplicate', 'bad_action'];

// 보내기에 실패했을 때: 'stop' 지금은 멈추고 나중에 다시(신호 없음·잠김) / 'retry' 서버가 잠시 바쁜 것('server')이라 횟수를 올리고 다음 기회에 다시 / 'failed' 고칠 수 없으니 보관함에 실패로 표시
function classifyFailure(err, tries) {
  if (err.network || err.code === 'locked') return 'stop';
  if (err.fields || PERMANENT_ERRORS.includes(err.code)) return 'failed';
  return tries + 1 >= MAX_SERVER_TRIES ? 'failed' : 'retry';
}

// 보관함 창에서 항목 아래에 보이는 상태 글
function outboxItemText(item) {
  if (item.state === 'failed') return `${STATE_TEXT.failed} · ${item.error ?? ''}`;
  if (item.tries > 0) return `다시 보낼 예정 (${item.tries}회 실패 · ${item.error ?? ''})`;
  return STATE_TEXT.wait;
}

// 측량 파일은 보관할 때는 File 그대로 두고, 보낼 때 base64로 바꾼다(15MB를 미리 부풀려 두지 않으려고)
async function requestBody(item) {
  if (!item.rawFiles) return item.payload;
  const files = {};
  for (const [kind, list] of Object.entries(item.rawFiles)) {
    files[kind] = [];
    for (const f of list) files[kind].push({ name: f.name, base64: await readFileAsBase64(f) });
  }
  return { entry: item.entry, files };
}

// 바로 보내 보고, 신호 문제로 못 보내면 이 폰에 보관한다. 'sent' 또는 'queued'를 돌려주고,
// 서버가 거부한 경우(입력 오류 등)는 그대로 던져서 화면이 고치게 한다.
async function submitOrQueue(req) {
  const item = { ...req, createdAt: Date.now(), tries: 0, state: 'wait' };
  if (navigator.onLine !== false) {
    try {
      await api(item.action, await requestBody(item));
      return 'sent';
    } catch (err) {
      if (!err.network) throw err;
    }
  }
  try {
    await outboxPut(item);
  } catch {
    throw new Error('이 폰에 임시 보관하지 못했습니다. 신호가 잡히는 곳에서 다시 저장해 주세요.');
  }
  renderOutbox();
  return 'queued';
}

function flushOutbox() {
  if (!state.code) return Promise.resolve(0);
  flushing ??= doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  let sent = 0;
  let items;
  try { items = (await outboxAll()).filter((i) => i.state !== 'failed'); } catch { return 0; }
  for (const item of items) {
    try {
      await api(item.action, await requestBody(item));
      await outboxDelete(item.id);
      sent += 1;
    } catch (err) {
      if (err.isAuth) { signOut(); break; }
      const verdict = classifyFailure(err, item.tries);
      if (verdict === 'stop') break;
      await outboxPut({ ...item, tries: item.tries + 1, state: verdict === 'failed' ? 'failed' : 'wait', error: errorText(err) })
        .catch((e) => console.warn('보관함 상태 저장 실패', e));
    }
  }
  if (sent > 0) {
    flash(`✓ 보관해 둔 입력 ${sent}건을 보냈습니다`);
    reloadLists();
  }
  await renderOutbox();
  return sent;
}

// 맨 위 안내 줄에 잠깐 보이는 알림(다른 알릴 것이 없을 때만 보인다)
function flash(text) {
  flashText = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = ''; renderOutbox(); }, FLASH_MS);
  renderOutbox();
}

// ---------- 화면: 맨 위 안내 줄과 보관함 창 ----------

const STATE_TEXT = { wait: '보내는 중·대기', failed: '보내지 못함' };

function netBarContent(items, offline, staleList) {
  const failed = items.filter((i) => i.state === 'failed').length;
  const waiting = items.length - failed;
  if (failed) return { text: `⚠ 전송하지 못한 입력 ${failed}건 — 확인이 필요합니다`, kind: 'err', action: '보기' };
  if (waiting && offline) return { text: `📡 신호 없음 · 입력 ${waiting}건을 보관 중 (잡히면 자동 전송)`, kind: 'warn', action: '보기' };
  if (waiting) return { text: `📤 입력 ${waiting}건을 보내는 중...`, kind: 'warn', action: '보기' };
  if (offline) return { text: '📡 신호 없음 · 입력은 이 폰에 보관되고, 잡히면 자동으로 전송됩니다', kind: 'warn', action: '' };
  if (staleList) return { text: '이전에 불러온 목록으로 열렸습니다. 새로고침하면 최신 목록이 됩니다', kind: 'warn', action: '새로고침' };
  if (flashText) return { text: flashText, kind: 'ok', action: '' };
  return { text: '', kind: '', action: '' };
}

async function renderOutbox() {
  let items = [];
  try { items = await outboxAll(); } catch { /* IndexedDB를 못 쓰는 환경: 보관함 없이 동작 */ }
  const bar = netBarContent(items, navigator.onLine === false, state.offline && navigator.onLine !== false);
  $('netBar').className = `netbar ${bar.kind}${bar.text ? '' : ' hidden'}`;
  $('netText').textContent = bar.text;
  show($('netAction'), bar.action !== '');
  $('netAction').textContent = bar.action;
  if ($('outboxDialog').open) renderOutboxList(items);
}

function renderOutboxList(items) {
  const ul = $('outboxList');
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '보관 중인 입력이 없습니다.';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('b');
    title.textContent = item.label;
    const sub = document.createElement('small');
    sub.textContent = outboxItemText(item);
    meta.append(title, sub);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm(`'${item.label}' 입력을 보관함에서 지울까요?\n서버에는 아직 올라가지 않은 입력입니다.`)) return;
      await outboxDelete(item.id).catch(() => {});
      renderOutbox();
    });
    li.append(meta, del);
    return li;
  }));
}

// 실패로 표시된 것까지 모두 다시 보낸다. 보내는 동안 창의 버튼은 잠긴다
async function retryAll() {
  await withBusy($('outboxDialog'), async () => {
    try {
      for (const item of await outboxAll()) await outboxPut({ ...item, state: 'wait', tries: 0, error: '' });
    } catch (err) { console.warn('보관함 초기화 실패', err); }
    await renderOutbox();
    await flushOutbox();
    if (navigator.onLine === false) flash('📡 신호가 없어 보내지 못했습니다. 잡히면 자동으로 보냅니다');
  });
}

function initOutbox() {
  $('netAction').addEventListener('click', async () => {
    if ($('netAction').textContent === '새로고침') { location.reload(); return; }
    renderOutboxList(await outboxAll().catch(() => []));   // 창이 빈 채로 열리지 않게 목록을 먼저 채운다
    $('outboxDialog').showModal();
  });
  $('outboxClose').addEventListener('click', () => $('outboxDialog').close());
  $('outboxSend').addEventListener('click', retryAll);
  window.addEventListener('online', () => { renderOutbox(); flushOutbox(); });
  window.addEventListener('offline', renderOutbox);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushOutbox(); });
  setInterval(flushOutbox, FLUSH_EVERY_MS);
  renderOutbox();
}

if (typeof module !== 'undefined') module.exports = { classifyFailure, netBarContent, outboxItemText, MAX_SERVER_TRIES };
