// 감독판(대표님용 휴대폰 화면). 서버에서 읽기만 하고(pc_sync, drive_download) 아무것도 쓰지 않는다.
// 계산은 ceo-logic.js(먼저 불러옴), 여기는 화면 그리기와 서버 통신만 맡는다. 서버에서 온 글은 textContent 로만 넣는다.
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 60 * 1000;
const FEED_PAGE = 100;
const TIMEOUT_MS = 45 * 1000;
const ERRORS = { bad_code: '접속 코드가 맞지 않습니다.', locked: '시도가 너무 많습니다. 10분 후 다시 해주세요.' };
const STATE_TEXT = { done: '✅ 측정완료', issue: '⚠ 이상보고', missing: '❌ 미측정' };
const FILE_KINDS = ['전체', '사진', '측량', '도면'];

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 저장 못 해도 앱은 동작해야 한다 */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* 위와 같음 */ } },
};

// 기기 시계 기준 오늘(yyyy-MM-dd). toISOString 은 UTC 라 한국 새벽에 어제로 나온다.
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const state = {
  code: store.get('ceoCode') ?? '',
  data: { sites: [], instruments: [], records: [], issues: [], drawingNotes: [], drive: null },
  date: localToday(),
  site: '전체',
  fileKind: '전체',
  openSite: '',
  feedLimit: FEED_PAGE,
  loading: false,
  seq: 0,          // 요청 번호. 입력 화면으로 돌아가면 올려서, 늦게 온 옛 응답을 버린다
  timer: null,
};

// ---------- 서버 ----------

async function api(action, payload = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ code: state.code, action, ...payload }), signal: ctl.signal });
    data = await res.json();
  } catch {
    throw Object.assign(new Error('인터넷 연결을 확인하세요.'), { network: true });
  } finally {
    clearTimeout(timer);
  }
  if (data.ok) return data;
  throw Object.assign(new Error(ERRORS[data.error] ?? '서버 오류'), { isAuth: data.error === 'bad_code' });   // 잠김(locked)은 코드가 맞을 수도 있으니 저장된 코드를 지우지 않는다
}

// ---------- 작은 도우미 ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const show = (node, on) => node.classList.toggle('hidden', !on);
const fill = (node, children, emptyText) => {
  node.replaceChildren(...(children.length ? children : [el('p', 'c-empty', emptyText)]));
};

function linkButtons(urls, label) {
  const box = el('div', 'c-links');
  urls.forEach((u, i) => {
    const a = el('a', '', urls.length > 1 ? `${label} ${i + 1}` : label);
    a.href = u;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  });
  return box;
}

// ---------- 그리기 ----------

function renderTiles(sum) {
  const specs = [
    ['기준일 입력 건수', `${sum.todayCount.toLocaleString()}건`, false],
    ['가동 현장 / 전체', `${sum.activeSites} / ${sum.totalSites}곳`, false],
    ['현장 이상보고', `${sum.issueCount}건`, sum.issueCount > 0],
    ['수정·삭제 기록', `${sum.editedCount}건`, false],
  ];
  $('tiles').replaceChildren(...specs.map(([k, v, alert]) => {
    const t = el('div', alert ? 'c-tile alert' : 'c-tile');
    t.append(el('span', 'k', k), el('span', 'v', v));
    return t;
  }));
}

function instrumentRow(item) {
  const row = el('div', 'c-inst');
  const left = el('div');
  left.append(el('b', '', item.inst.id), el('div', 'c-sub', [item.inst.type, item.inst.place].filter(Boolean).join(' · ')));
  const right = el('div');
  right.style.textAlign = 'right';
  right.append(el('span', `c-chip ${item.state}`, STATE_TEXT[item.state]));
  if (item.rec) right.append(el('div', 'c-sub', `${field(item.rec, COL.user)} · ${valueText(item.rec)}`));
  row.append(left, right);
  return row;
}

function coverageCard(c) {
  const card = el('div', `c-card tap lv-${c.level}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', c.site), el('span', 'c-badge', `${c.rate}%`));
  const bar = el('div', 'c-bar');
  const fillBar = el('i');
  fillBar.style.width = `${c.rate}%`;
  bar.append(fillBar);
  card.append(head, bar, el('div', 'c-sub', `등록 ${c.total} · 완료 ${c.done} · 미측정 ${c.missing}`));
  card.append(el('div', 'c-sub', `투입 ${c.workers.join(', ') || '-'} · 최근 ${c.last}`));
  if (state.openSite === c.site) {
    const list = el('div', 'c-insts');
    list.append(...c.items.map(instrumentRow));
    card.append(list);
  }
  const toggle = () => { state.openSite = state.openSite === c.site ? '' : c.site; renderHome(); };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return card;
}

function visibleSites() {
  return state.site === '전체' ? state.data.sites : state.data.sites.filter((s) => s === state.site);
}

function renderHome() {
  const d = state.data;
  const scoped = state.site === '전체' ? d.records : d.records.filter((r) => field(r, COL.site) === state.site);
  const issues = state.site === '전체' ? d.issues : d.issues.filter((r) => field(r, 2) === state.site);
  renderTiles(summarize(state.date, scoped, issues, visibleSites()));
  const cov = siteCoverage(state.date, visibleSites(), d.instruments, d.records.filter(isActive));
  fill($('coverageList'), cov.map(coverageCard), '등록된 현장이 없습니다.');
}

function feedCard(r) {
  const status = field(r, COL.status);
  const card = el('div', status === '삭제' ? 'c-card is-deleted' : 'c-card');
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', field(r, COL.site)), el('span', `c-chip ${status ? 'issue' : 'done'}`, status || (field(r, COL.history) ? '수정됨' : '정상')));
  card.append(head);
  card.append(el('div', 'c-sub', `${field(r, COL.time)} · ${field(r, COL.user)}`));
  card.append(el('div', 'c-sub', [field(r, COL.id), field(r, COL.type), field(r, COL.place)].filter(Boolean).join(' · ')));
  card.append(el('div', 'c-value', valueText(r)));
  const delta = field(r, COL.delta);
  if (delta) card.append(el('div', 'c-sub', `전회 ${field(r, COL.prev) || '-'} · 변화 ${delta}`));
  if (field(r, COL.memo)) card.append(el('div', 'c-memo', field(r, COL.memo)));
  const links = splitLinks(field(r, COL.link));
  if (links.length) card.append(linkButtons(links, '📷 사진'));
  return card;
}

function renderFeed() {
  const rows = filterFeed(state.data.records, { site: state.site, keyword: $('feedSearch').value });
  fill($('feedList'), rows.slice(0, state.feedLimit).map(feedCard), '조건에 맞는 기록이 없습니다.');
  show($('feedMore'), rows.length > state.feedLimit);
}

function auditCard(r) {
  const card = el('div', 'c-card');
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', field(r, COL.site)), el('span', `c-chip ${field(r, COL.status) === '삭제' ? 'missing' : 'issue'}`, field(r, COL.status) || '수정됨'));
  card.append(head, el('div', 'c-sub', `${field(r, COL.time)} · ${field(r, COL.user)} · ${field(r, COL.id)}`));
  card.append(el('div', 'c-memo', field(r, COL.history)));
  return card;
}

// 이상보고 시트 열: 0 보고시각, 2 현장, 3 보고자, 4 측정일, 5 계측기ID, 6 종류, 7 위치, 8 이상 상태, 9 메모, 10 사진
function issueCard(r) {
  const card = el('div', 'c-card');
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', field(r, 2)), el('span', 'c-chip missing', field(r, 8)));
  card.append(head, el('div', 'c-sub', `${field(r, 0)} · ${field(r, 3)} · ${field(r, 5)} ${field(r, 6)} ${field(r, 7)}`.trim()));
  if (field(r, 9)) card.append(el('div', 'c-memo', field(r, 9)));
  const links = splitLinks(field(r, 10));
  if (links.length) card.append(linkButtons(links, '📷 사진'));
  return card;
}

function renderAudit() {
  const inSite = (r, idx) => state.site === '전체' || field(r, idx) === state.site;
  const issues = [...state.data.issues].reverse().filter((r) => inSite(r, 2));
  const edits = editedOrDeleted(state.data.records).reverse().filter((r) => inSite(r, COL.site));
  fill($('issueList'), issues.map(issueCard), '접수된 이상보고가 없습니다.');
  fill($('auditList'), edits.slice(0, FEED_PAGE).map(auditCard), '수정·삭제된 기록이 없습니다.');
}

const isImage = (f) => f.mime.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(f.name);

function fileCard(f) {
  const card = el('div', 'c-card');
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', f.name), el('span', 'c-chip plain', f.category));
  card.append(head, el('div', 'c-sub', `${f.site} · ${f.updated} · ${f.sizeKb} KB`));
  if (isImage(f)) {
    const b = el('button', 'btn c-wide', '사진 보기');
    b.type = 'button';
    b.addEventListener('click', () => openImage(f));
    card.append(b);
  } else if (f.url) {
    card.append(linkButtons([f.url], '열기'));
  }
  return card;
}

function noteCard(n) {
  const card = el('div', 'c-card');
  const head = el('div', 'c-row');
  head.append(el('span', 'c-name', n.fileName), el('span', 'c-chip plain', `마커 ${n.pinCount} · 필기 ${n.strokeCount}`));
  card.append(head, el('div', 'c-sub', `${n.site} · ${n.user} · ${n.updated}`), el('div', 'c-memo', n.summary));
  return card;
}

function renderFiles() {
  const chips = FILE_KINDS.map((k) => {
    const b = el('button', '', k);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(k === state.fileKind));
    b.addEventListener('click', () => { state.fileKind = k; renderFiles(); });
    return b;
  });
  $('fileChips').replaceChildren(...chips);
  const files = driveItems(state.data.drive)
    .filter((f) => (state.site === '전체' || f.site === state.site) && (state.fileKind === '전체' || f.category.startsWith(state.fileKind)));
  fill($('fileList'), files.slice(0, FEED_PAGE).map(fileCard), '표시할 자료가 없습니다.');
  const notes = state.data.drawingNotes.map(summarizeNote).filter((n) => state.site === '전체' || n.site === state.site).reverse();
  fill($('noteList'), notes.map(noteCard), '도면 메모가 없습니다.');
}

function renderAll() {
  renderHome();
  renderFeed();
  renderAudit();
  renderFiles();
}

// ---------- 사진 미리보기 (로그인 없이 접속 코드로 받아 온다) ----------

async function openImage(f) {
  $('viewerTitle').textContent = `${f.name} 불러오는 중…`;
  $('viewerBody').replaceChildren();
  $('viewer').showModal();
  try {
    const res = await api('drive_download', { fileId: f.id });
    if (!$('viewer').open) return;   // 불러오는 사이 닫았으면 그리지 않는다
    const blob = await (await fetch(`data:${res.mime || 'image/jpeg'};base64,${res.base64}`)).blob();
    const img = el('img');
    img.alt = f.name;
    img.src = URL.createObjectURL(blob);
    $('viewerBody').replaceChildren(img);
    $('viewerTitle').textContent = f.name;
  } catch (err) {
    $('viewerTitle').textContent = err.message;
  }
}

function closeViewer() {
  const img = $('viewerBody').querySelector('img');
  if (img) URL.revokeObjectURL(img.src);
  $('viewerBody').replaceChildren();
  $('viewer').close();
}

// ---------- 불러오기 ----------

function hideSplash() {
  const s = $('splash');
  s.classList.add('leaving');
  setTimeout(() => s.classList.add('hidden'), 300);
}

function showGate(message) {
  clearInterval(state.timer);
  state.seq += 1;
  state.loading = false;
  show($('app'), false);
  show($('tabbar'), false);
  show($('gate'), true);
  $('gateError').textContent = message || '';
  show($('gateError'), Boolean(message));
  hideSplash();
}

function fillSiteFilter() {
  const names = ['전체', ...state.data.sites];
  const sel = $('siteFilter');
  sel.replaceChildren(...names.map((s) => { const o = el('option', '', s); o.value = s; return o; }));
  if (!names.includes(state.site)) state.site = '전체';
  sel.value = state.site;
}

function applySync(res) {
  state.data = {
    sites: res.sites ?? [],
    instruments: res.instruments ?? [],
    records: res.records ?? [],
    issues: res.issues ?? [],
    drawingNotes: res.drawingNotes ?? [],
    drive: res.drive ?? state.data.drive,
  };
  fillSiteFilter();
  renderAll();
  const t = new Date();
  $('syncNote').textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 동기화 · 기록 ${state.data.records.length.toLocaleString()}건`;
  show($('gate'), false);
  show($('app'), true);
  show($('tabbar'), true);
  hideSplash();
}

function onLoadError(err) {
  if (err.isAuth) { store.remove('ceoCode'); state.code = ''; showGate(err.message); return; }
  if (!$('app').classList.contains('hidden')) { $('syncNote').textContent = `${err.message} (마지막 동기화 기준으로 표시 중)`; return; }
  if (!$('gate').classList.contains('hidden')) { $('gateError').textContent = err.message; show($('gateError'), true); return; }
  show($('splashLoading'), false);
  $('splashMessage').textContent = err.message;
  show($('splashError'), true);
}

async function load({ withDrive }) {
  if (state.loading) return;
  state.loading = true;
  const mine = ++state.seq;
  $('refresh').classList.add('spin');
  try {
    const res = await api('pc_sync', { limit: 5000, includeDrive: withDrive });
    if (mine === state.seq) applySync(res);
  } catch (err) {
    if (mine === state.seq) onLoadError(err);
  } finally {
    if (mine === state.seq) state.loading = false;
    $('refresh').classList.remove('spin');
  }
}

function start() {
  if (!state.code) { showGate(''); return; }
  show($('splashError'), false);
  show($('splashLoading'), true);
  if (!$('gate').classList.contains('hidden')) { $('gateError').textContent = '연결 중…'; show($('gateError'), true); }
  load({ withDrive: true });
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) load({ withDrive: false }); }, REFRESH_MS);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('#tabbar button')) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  for (const sec of document.querySelectorAll('.c-tab')) show(sec, sec.id === `tab-${name}`);
  window.scrollTo(0, 0);
}

// ---------- 이벤트 ----------

$('gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.code = $('code').value.trim();
  if (!state.code) return;
  store.set('ceoCode', state.code);
  $('code').value = '';
  start();
});
$('retry').addEventListener('click', start);
$('refresh').addEventListener('click', () => load({ withDrive: true }));
$('changeCode').addEventListener('click', () => { store.remove('ceoCode'); state.code = ''; showGate(''); });
$('siteFilter').addEventListener('change', () => { state.site = $('siteFilter').value; state.feedLimit = FEED_PAGE; renderAll(); });
$('dateInput').addEventListener('change', () => { state.date = $('dateInput').value || localToday(); renderHome(); });
$('feedSearch').addEventListener('input', () => { state.feedLimit = FEED_PAGE; renderFeed(); });
$('feedMore').addEventListener('click', () => { state.feedLimit += FEED_PAGE; renderFeed(); });
$('viewerClose').addEventListener('click', closeViewer);
$('viewer').addEventListener('cancel', (e) => { e.preventDefault(); closeViewer(); });
document.querySelectorAll('#tabbar button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

$('dateInput').value = state.date;
start();
