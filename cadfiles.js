'use strict';
// CAD 탭의 현장 폴더(도면 탭처럼 현장 → 폴더): 클라우드 CAD/<현장>/ 의 DWG·DXF 만 보인다(서버 cad_list 가 확장자로 거른다).
// 50MB 도면도 서버 한 요청 한도를 넘지 않게 4MB 씩 나눠 받고(cad_download) 나눠 올린다(cad_upload_start → cad_upload_chunk).
// 한 번 받은 도면은 폰 보관함(cad.js 최근 파일, 열쇠 'cloud:<파일ID>')에 두고, 서버 목록의 수정시각·크기가 같으면 다시 받지 않는다.

const CAD_NET_RETRIES = 3;               // 신호가 끊긴 조각을 다시 보내거나 받는 횟수
const CAD_CALL_MS = 3 * 60 * 1000;       // 조각 하나(약 5.6MB 글자) 요청의 시간 한도
const CAD_RETRY_WAIT_MS = 1500;
const cadFiles = { site: '', seq: 0 };

const cadMb = (n) => (n / MB).toFixed(1);
const cadSize = (n) => (n < MB / 10 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${cadMb(n)}MB`);
const cadSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cadKey = (id) => `cloud:${id}`;

function base64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// 열거나 올릴 수 있는 CAD 파일인지. 문제가 있으면 사람용 문구, 없으면 ''
function cadFileProblem(file) {
  if (!/\.(dwg|dxf)$/i.test(file.name)) return 'DWG·DXF 파일만 열거나 올릴 수 있습니다.';
  if (!file.size) return '비어 있는 파일입니다.';
  if (file.size > CAD_MAX_FILE) return `도면 파일은 ${CAD_MAX_FILE / MB}MB 이하만 됩니다.`;
  return '';
}

// 신호 문제(err.network)일 때만 잠깐 쉬고 다시. 접속 코드·입력 거절은 바로 던진다
async function cadRetry(fn) {
  for (let i = 0; ; i += 1) {
    try { return await fn(i); } catch (err) {
      if (!err.network || i >= CAD_NET_RETRIES) throw err;
      await cadSleep(CAD_RETRY_WAIT_MS * (i + 1));
    }
  }
}

// ---------- 1단계: 현장 목록 ----------

function renderCadSites() {
  const ul = $('cadSites');
  const sites = state.config.sites || [];
  if (!sites.length) {
    ul.replaceChildren(el('li', 'empty', '등록된 현장이 없습니다. 홈의 ⚙ 버튼에서 현장을 먼저 추가해 주세요.'));
    return;
  }
  ul.replaceChildren(...sites.map((site) => {
    const li = el('li', 'tap');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const meta = el('div', 'meta');
    meta.append(el('b', null, `📁 ${site}`), el('small', null, '터치하여 CAD 도면(DWG·DXF) 폴더 열기'));
    li.append(meta, el('div', 'val', '›'));
    const go = () => openCadSite(site);
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return li;
  }));
}

function showCadSites(on) {
  cadFiles.seq += 1;   // 늦게 온 목록이 다른 화면을 바꾸지 않게
  show($('cadSitesView'), on);
  show($('cadFilesView'), !on);
}

// ---------- 2단계: 현장 폴더 (폰 보관 목록을 먼저 보여 주고 서버 목록으로 바꾼다) ----------

async function openCadSite(site) {
  showCadSites(false);
  const seq = cadFiles.seq;
  cadFiles.site = site;
  $('cadSiteName').textContent = `${site} CAD`;
  $('cadFileSearch').value = '';
  const cached = readCached(`cadlist_${site}`);
  await renderCadFiles(cached, cached ? '' : 'CAD 폴더를 불러오는 중...');
  try {
    const res = await api('cad_list', { site });
    if (seq !== cadFiles.seq) return;
    const list = { files: res.files || [], folders: res.folders || [] };
    store.set(`cadlist_${site}`, JSON.stringify(list));
    await renderCadFiles(list, '');
  } catch (err) {
    if (seq !== cadFiles.seq) return;
    if (err.isAuth) { signOut(); return; }
    await renderCadFiles(cached, cached
      ? '신호가 약해 이전에 불러온 목록을 보여 드립니다.'
      : `CAD 목록을 불러오지 못했습니다: ${errorText(err)} 신호가 잡히면 현장을 다시 눌러 주세요.`);
  }
}

async function renderCadFiles(list, note) {
  const ul = $('cadFileList');
  const files = list?.files || [];
  const folders = list?.folders || [];
  const count = files.length + folders.reduce((n, fo) => n + fo.files.length, 0);
  const kept = new Map((await cadRecentList()).map((r) => [r.name, r]));
  $('cadFilesNote').textContent = note || (count ? `DWG·DXF ${count}개 · 터치하면 열립니다(처음 한 번은 받는 시간이 걸립니다).` : '');
  if (!list) { ul.replaceChildren(); return; }
  if (!count) {
    ul.replaceChildren(el('li', 'empty', '이 현장 CAD 폴더에 DWG·DXF 가 없습니다. 위의 [올리기]로 폰의 도면을 올리거나, PC 프로그램 CAD 탭에서 올려 주세요.'));
    return;
  }
  const rows = files.map((f) => cadFileRow(f, kept));
  for (const fo of folders) rows.push(el('li', 'cad-folder-head', `📁 ${fo.name}`), ...fo.files.map((f) => cadFileRow(f, kept)));
  ul.replaceChildren(...rows);
}

function cadFileRow(f, kept) {
  const li = el('li', 'tap');
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.dataset.name = f.name;
  const k = kept.get(cadKey(f.id));
  const onPhone = k && k.updated === f.updated && k.size === f.size;
  const meta = el('div', 'meta');
  meta.append(el('b', null, `📐 ${f.name}`), el('small', null, `${cadSize(f.size)} · ${f.updated || ''}${onPhone ? ' · 폰에 있음' : ''}`));
  li.append(meta, el('div', 'val', '›'));
  const go = () => openCadCloud(f);
  li.addEventListener('click', go);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return li;
}

// ---------- 받기 ----------

async function openCadCloud(f) {
  const key = cadKey(f.id);
  const kept = (await cadRecentList()).find((r) => r.name === key);
  if (kept && kept.updated === f.updated && kept.size === f.size) {
    cadOpen(f.name, kept.buf.slice(0));
    return;
  }
  busyShow(`도면을 받는 중... 0 / ${cadMb(f.size)}MB`);
  try {
    const res = await cadDownloadAll(f.id, (got, total) => busyText(`도면을 받는 중... ${cadMb(got)} / ${cadMb(total)}MB`));
    await cadRemember(f.name, res.buf.slice(0), { key, id: f.id, updated: res.updated, site: cadFiles.site });
    await cadOpen(f.name, res.buf);   // 모래시계를 닫지 않은 채 열기로 넘어간다(받기→열기 사이에 깜빡이지 않게)
  } catch (err) {
    if (err.isAuth) { busyHide(); signOut(); return; }
    alert(`도면을 받지 못했습니다: ${friendlyError(err, '신호를 확인해 주세요.')}`);
  } finally {
    busyHide();
  }
}

// 조각을 차례로 받아 붙인다. 받는 도중 서버 파일이 바뀌면(수정시각·크기) 섞이지 않게 멈춘다
async function cadDownloadAll(fileId, onProgress) {
  let out = null, first = null, at = 0;
  for (;;) {
    const r = await cadRetry(() => api('cad_download', { fileId, offset: at }, { timeoutMs: CAD_CALL_MS }));
    if (!first) { first = r; out = new Uint8Array(r.size); }
    if (r.size !== first.size || r.updated !== first.updated) throw new Error('받는 도중 도면이 바뀌었습니다. 목록을 새로 연 뒤 다시 눌러 주세요.');
    const bytes = base64ToBytes(r.base64);
    if (r.offset !== at || at + bytes.length > out.length) throw new Error('받은 조각이 맞지 않습니다. 다시 눌러 주세요.');
    out.set(bytes, at);
    at = r.next;
    onProgress(at, r.size);
    if (r.done) return { buf: out.buffer, updated: r.updated };
  }
}

// ---------- 올리기 ----------

async function cadUploadPick(file) {
  if (!file) return;
  const problem = cadFileProblem(file);
  if (problem) { alert(problem); return; }
  const site = cadFiles.site;
  if (!site) return;
  busyShow(`'${site}' CAD 폴더에 올릴 준비 중...`);
  try {
    const st = await api('cad_upload_start', { site, name: file.name, size: file.size });
    let at = 0, r = null;
    while (!r?.done) {
      busyText(`올리는 중... ${cadMb(at)} / ${cadMb(file.size)}MB`);
      const end = Math.min(file.size, at + st.chunk);
      const b64 = uint8ToBase64(new Uint8Array(await file.slice(at, end).arrayBuffer()));
      r = await cadSendChunk(st.token, at, b64);
      at = r.next;
    }
    busyText('폰에도 보관하는 중...');
    await cadRemember(file.name, await file.arrayBuffer(), { key: cadKey(r.file.id), id: r.file.id, updated: r.file.updated, site });
    busyHide();
    store.remove(`cadlist_${site}`);
    await openCadSite(site);
    $('cadFilesNote').textContent = `✓ ${file.name} (${cadMb(file.size)}MB) 을 올렸습니다. PC 프로그램 CAD 탭에서도 보입니다.`;
  } catch (err) {
    busyHide();
    if (err.isAuth) { signOut(); return; }
    alert(`올리지 못했습니다: ${friendlyError(err, '신호를 확인해 주세요.')}`);
  }
}

// 조각 하나 보내기. 신호가 끊겨 응답을 못 받았으면 서버에 '어디까지 받았나'를 물어(base64 '') 그 자리부터 잇는다
async function cadSendChunk(token, offset, base64) {
  return cadRetry(async (i) => {
    if (i > 0) {
      const q = await api('cad_upload_chunk', { token, offset, base64: '' }, { timeoutMs: CAD_CALL_MS });
      if (q.done || q.next !== offset) return q;   // 지난번 조각이 이미 들어갔다
    }
    return api('cad_upload_chunk', { token, offset, base64 }, { timeoutMs: CAD_CALL_MS });
  });
}

// ---------- 연결 ----------

function initCadFiles() {
  if (!$('cadSitesView')) return;
  attachListSearch($('cadSitesSearch'), $('cadSites'), (li) => li.querySelector('b')?.textContent || '');
  attachListSearch($('cadFileSearch'), $('cadFileList'), (li) => li.dataset.name || '');
  $('cadBackSites').addEventListener('click', () => { showCadSites(true); renderCadRecent(); });
  $('cadUploadBtn').addEventListener('click', () => $('cadUploadFile').click());
  $('cadUploadFile').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; cadUploadPick(f); });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initCadFiles);
