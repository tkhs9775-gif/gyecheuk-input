// 도면(야장) 탭:
// 1) 현장명 목록만 표시 → 현장명을 터치하면 해당 현장의 도면(PDF) 폴더가 열림
// 2) PDF를 터치하면 전체화면 도면 야장으로 열림
// 3) 왼쪽 하단의 '동그란 원(동그라미 메모)' 버튼을 누른 상태로 도면의 어느 한 곳을 터치하면
//    동그란 원이 찍히면서 메모 박스가 뜸
// 4) 그 메모 박스를 한 번 더 터치하면 펜으로 필체를 쓰는 손글씨 입력창이 열리고,
//    OCR 판독으로 글씨체를 알아보고 텍스트 형태로 자동 변환해 메모에 넣어줌
// 5) 진짜 야장처럼 도면 위에 바로 자유 펜 필기도 가능하며 클라우드와 기기에 저장됨

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PDFLIB_CDN = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_DRAWING_BYTES = 18 * 1024 * 1024;   // 서버 상한(base64 25,000,000자)과 같다
const PREFETCH_COUNT = 6;
const NOTES_SAVE_DELAY_MS = 300;
const OCR_TIMEOUT_MS = 12 * 1000;
const BTN_RESET_MS = 2200;
const INK_COLOR = '#C62828';   // 흰 글자가 4.5:1 이상 읽히는 빨강(마커·필기 공통)

// CDN 라이브러리는 탭을 열 때 받는다. 한 번 실패한 주소는 다음에 다시 받을 수 있게 기억에서 지운다
const scriptLoads = new Map();
function loadScriptOnce(src) {
  if (!scriptLoads.has(src)) {
    scriptLoads.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        s.remove();
        scriptLoads.delete(src);
        reject(new Error(navigator.onLine === false
          ? '신호가 없어 도면 기능 파일을 내려받지 못했습니다. 신호가 잡히면 다시 열어 주세요.'
          : '도면 기능 파일을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.'));
      };
      document.head.appendChild(s);
    }));
  }
  return scriptLoads.get(src);
}

async function ensureLib(src, globalName) {
  if (!window[globalName]) await loadScriptOnce(src);
  if (!window[globalName]) throw new Error('도면 기능 파일이 올바르지 않습니다. 정보 탭에서 새로고침해 주세요.');
  return window[globalName];
}

async function ensurePdfJs() {
  const lib = await ensureLib(PDFJS_CDN, 'pdfjsLib');
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}
const ensureTesseract = () => ensureLib(TESSERACT_CDN, 'Tesseract');
const ensurePdfLib = () => ensureLib(PDFLIB_CDN, 'PDFLib');

// 오류를 사람이 읽을 한 줄로: 서버가 짚어 준 칸이 있으면 그 칸, 한글 문구면 그대로, 영어(pdf.js·OCR 라이브러리)면 fallback
function friendlyError(err, fallback) {
  const message = String(err?.message ?? '');
  if (err?.fields && typeof errorText === 'function') return errorText(err);
  return /[가-힣]/.test(message) ? message : fallback;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 저장분(폰·서버)이 깨져 있어도 화면이 멈추지 않게 모양을 맞춘다. sourceId(저장본의 원본 도면)·gps(Pro 기준점)는 있을 때만 둔다
function normalizeNotes(data) {
  const pins = Array.isArray(data?.pins) ? data.pins.filter((p) => p && typeof p === 'object' && p.id) : [];
  const strokes = isPlainObject(data?.strokes) ? data.strokes : {};
  const out = { pins, strokes };
  if (typeof data?.sourceId === 'string' && data.sourceId) out.sourceId = data.sourceId;
  if (isPlainObject(data?.gps)) out.gps = data.gps;
  return out;
}

const DATE_TAG = /_\d{4}-?\d{2}-?\d{2}\([일월화수목금토]\)$/;
const stemOf = (name) => String(name || '').replace(/\.pdf$/i, '').trim();

// 저장본(원본이름_날짜(요).pdf)은 동그라미가 이미 PDF 그림 속에 들어 있다. 그 위에 메모를 또 띄우면 두 겹이 되고, 다시 저장하면 계속 쌓인다.
// 그래서 같은 폴더의 원본(메모에 적어 둔 sourceId, 없으면 날짜 꼬리표를 뗀 이름)을 찾아 그것을 바탕으로 그린다. 못 찾으면 null(그 파일 그대로)
function sourceFileOf(file, notes, files) {
  const others = (files || []).filter((f) => f && f.id !== file.id);
  const byId = notes?.sourceId && others.find((f) => f.id === notes.sourceId);
  if (byId) return byId;
  const stem = stemOf(file.name);
  if (!DATE_TAG.test(stem)) return null;
  const base = stem.replace(DATE_TAG, '').trim();
  return others.find((f) => stemOf(f.name) === base) || null;
}

// 원본 파일명에서 확장자(.pdf)와 기존 날짜 꼬리표(_YYYY-MM-DD(요) 또는 _YYYYMMDD(요))를 떼고
// '원본이름_YYYY-MM-DD(요일한글자).pdf' 형태의 새 파일명을 만든다.
function buildSavedDrawingFileName(originalName, now = new Date()) {
  const baseName = stemOf(originalName || '도면').replace(DATE_TAG, '').trim() || '도면';
  const ymdStr = now.toLocaleDateString('sv-SE');
  const dayChar = WEEKDAYS_KO[now.getDay()];
  return `${baseName}_${ymdStr}(${dayChar}).pdf`;
}

// 동그라미 범례: 원 안에 코드 글자와 번호가 들어간다(W1, W2, H1...). 코드가 없는 옛 메모는 번호만
const PIN_TYPES = [
  { code: 'W', name: '수위' },
  { code: 'H', name: '굴착고' },
  { code: 'S', name: '변형률계' },
  { code: 'L', name: '하중계' },
  { code: 'C', name: '균열' },
  { code: 'P', name: '측량' },
];
const pinTypeName = (code) => PIN_TYPES.find((t) => t.code === code)?.name || '';

// 항상 음수인 종류(수위 W, 굴착고 H): 숫자만 쓰면 앞에 -를 붙인다. 0과 글자가 섞인 메모, 이미 -가 있는 값은 그대로
const NEGATIVE_PIN_TYPES = ['W', 'H'];
function negateIfPlainNumber(type, text) {
  return NEGATIVE_PIN_TYPES.includes(type) && /^\d+(\.\d+)?$/.test(text) && Number(text) !== 0 ? `-${text}` : text;
}

const drawingState = {
  site: '',
  files: [],
  folders: [],            // 원본별 폴더(계측기별 PDF 묶음): [{ name, files }]
  openFolders: new Set(), // 펼쳐 둔 폴더 이름
  currentFile: null,
  sourceFile: null,       // 저장본을 열었을 때 바탕으로 그린 원본 도면(없으면 null = 연 파일 그대로)
  rawPdfBytes: null,
  pdfDoc: null,
  pageNum: 1,
  pageCount: 1,
  scale: 1.25,
  rotation: 0,            // 보기 회전(시계 방향 0·90·180·270). 메모 좌표는 회전 전 쪽 기준으로 저장한다
  pinMode: false,
  pinType: '', // 범례에서 고른 계측기 코드. ''이면 전체 보기·종류 없는 메모
  penMode: false,
  notes: { pins: [], strokes: {} }, // pins: [{ id, page, x, y, text, author, time }], strokes: { [page]: [ [{x,y}, ...] ] }
  activePinId: null,
  dirty: false,
};

const EXTERNAL_DIR = '외부계측기';
const PDF_CACHE_DB = 'gyecheuk_pdf_cache';
const PDF_CACHE_STORE = 'pdfs';
let pdfCacheDbPromise = null;

function openPdfCacheDb() {
  pdfCacheDbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_CACHE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PDF_CACHE_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { pdfCacheDbPromise = null; reject(req.error); };
  });
  return pdfCacheDbPromise;
}

async function getCachedPdfBytes(fileId) {
  try {
    const db = await openPdfCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(PDF_CACHE_STORE, 'readonly');
      const req = tx.objectStore(PDF_CACHE_STORE).get(fileId);
      req.onsuccess = () => resolve(req.result?.bytes || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putCachedPdfBytes(fileId, bytes) {
  try {
    const db = await openPdfCacheDb();
    await new Promise((resolve) => {
      const tx = db.transaction(PDF_CACHE_STORE, 'readwrite');
      tx.objectStore(PDF_CACHE_STORE).put({ id: fileId, bytes, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch { /* ignore */ }
}

function b64ToUint8(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ponytail: 받아 둔 PDF는 지우지 않는다(현장당 도면 수십 개 수준). 용량이 문제되면 savedAt 기준으로 오래된 것부터 지운다
// 같은 파일을 두 번 받지 않는다: 미리 받는 중이면 그 약속을 돌려주어 열 때 기다릴 수 있다
const prefetchInFlight = new Map();
function prefetchPdfToCache(fileId) {
  if (!fileId || navigator.onLine === false) return Promise.resolve();
  if (!prefetchInFlight.has(fileId)) {
    prefetchInFlight.set(fileId, (async () => {
      try {
        if (await getCachedPdfBytes(fileId)) return;
        const dl = await api('drive_download', { fileId });
        if (typeof dl?.base64 === 'string' && dl.base64) await putCachedPdfBytes(fileId, b64ToUint8(dl.base64));
      } catch (err) {
        console.warn('도면 미리 받기 실패', err);
      } finally {
        prefetchInFlight.delete(fileId);
      }
    })());
  }
  return prefetchInFlight.get(fileId);
}

function updatePageInfo() {
  $('pdfPageInfo').textContent = `${drawingState.pageNum} / ${drawingState.pageCount}쪽 · 마커 ${currentPagePins().length}개`;
}

// ---------- 1단계: 현장명 목록 화면 ----------

function loadDrawingTab() {
  ensurePdfJs().catch(() => {}); // 도면 탭 진입 즉시 PDF 엔진 예열!
  show($('drawingSitesView'), true);
  show($('drawingFilesView'), false);
  renderDrawingSites();
}

function renderDrawingSites() {
  const ul = $('drawingSiteList');
  const sites = state.config.sites || [];
  if (sites.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '등록된 현장이 없습니다. 홈의 ⚙ 버튼에서 현장을 먼저 추가해 주세요.';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...sites.map((site) => {
    const li = document.createElement('li');
    li.className = 'tap';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = `📁 ${site}`;
    const sub = document.createElement('small');
    sub.textContent = '터치하여 도면(PDF) 폴더 열기';
    meta.append(b, sub);
    const arrow = document.createElement('div');
    arrow.className = 'val';
    arrow.textContent = '›';
    li.append(meta, arrow);
    li.addEventListener('click', () => openSiteDrawingFolder(site));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSiteDrawingFolder(site); });
    return li;
  }));
}

// ---------- 2단계: 현장 터치 시 관련 도면 폴더(PDF 목록) 열기 ----------

let folderSeq = 0;   // 현장을 연달아 바꿀 때 늦게 온 옛 목록이 새 목록을 덮지 않게 한다

async function openSiteDrawingFolder(site) {
  const seq = ++folderSeq;
  drawingState.site = site;
  $('drawingSiteTitle').textContent = `${site} 도면`;
  $('drawingFolderNote').textContent = '도면 폴더를 불러오는 중...';
  $('drawingFileList').replaceChildren();
  show($('drawingSitesView'), false);
  show($('drawingFilesView'), true);

  try {
    const res = await api('drawing_list', { site });
    if (seq !== folderSeq) return;
    drawingState.files = Array.isArray(res.files) ? res.files : [];
    drawingState.folders = Array.isArray(res.folders) ? res.folders.map((f) => ({ name: f.name, files: Array.isArray(f.files) ? f.files : [] })) : [];
    store.set(`drawings_${site}`, JSON.stringify(drawingState.files));
    store.set(`drawing_folders_${site}`, JSON.stringify(drawingState.folders));
    renderDrawingFiles();
    // 폴더 내 도면들을 하나씩 차례로 미리 받아 둔다(한꺼번에 받으면 사용자가 연 도면이 느려진다)
    (async () => {
      for (const f of drawingState.files.slice(0, PREFETCH_COUNT)) {
        if (seq !== folderSeq) return;
        await prefetchPdfToCache(f.id);
      }
    })();
  } catch (err) {
    if (seq !== folderSeq) return;
    if (err.isAuth) { signOut(); return; }
    const cached = readCached(`drawings_${site}`);
    if (cached) {
      drawingState.files = cached;
      drawingState.folders = readCached(`drawing_folders_${site}`) || [];
      renderDrawingFiles();
      $('drawingFolderNote').textContent = '신호가 약해 이전에 불러온 도면 목록을 표시합니다.';
    } else {
      $('drawingFolderNote').textContent = `도면 목록을 불러오지 못했습니다: ${errorText(err)} 신호가 잡히면 현장을 다시 눌러 주세요.`;
    }
  }
}

function drawingRow(title, subText, badgeText, onOpen, extraClass = '') {
  const li = document.createElement('li');
  li.className = `tap ${extraClass}`.trim();
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const b = document.createElement('b');
  b.textContent = title;
  const sub = document.createElement('small');
  sub.textContent = subText;
  meta.append(b, sub);
  const badge = document.createElement('div');
  badge.className = 'val';
  badge.style.fontSize = '15px';
  badge.style.color = '#1F62A8';
  badge.textContent = badgeText;
  li.append(meta, badge);
  li.addEventListener('click', onOpen);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpen(); });
  return li;
}

const drawingFileRow = (f, extraClass = '') => drawingRow(
  `📄 ${f.name}`, `${f.updated || ''} · ${fmtSize(f.size || 0)} · 터치하여 야장 열기`, '야장 열기', () => openPdfFieldbook(f), extraClass,
);

// 원본별 폴더 한 줄(터치하면 펼침/접힘) + 펼쳤을 때 폴더 안 PDF 줄들
function drawingFolderRows(folder) {
  const isOpen = drawingState.openFolders.has(folder.name);
  const head = drawingRow(
    `${isOpen ? '📂' : '📁'} ${folder.name}`, `계측기별 PDF ${folder.files.length}개`, isOpen ? '접기' : '펼치기',
    () => {
      if (drawingState.openFolders.has(folder.name)) drawingState.openFolders.delete(folder.name);
      else drawingState.openFolders.add(folder.name);
      renderDrawingFiles();
    },
    'folder',
  );
  if (!isOpen) return [head];
  const rows = folder.files.length
    ? folder.files.map((f) => drawingFileRow(f, 'in-folder'))
    : [Object.assign(document.createElement('li'), { className: 'empty in-folder', textContent: '폴더가 비어 있습니다.' })];
  return [head, ...rows];
}

function renderDrawingFiles() {
  const { files, folders } = drawingState;
  const total = files.length + folders.reduce((n, f) => n + f.files.length, 0);
  $('drawingFolderNote').textContent = total
    ? `PDF 도면 ${files.length}개${folders.length ? ` · 계측기별 폴더 ${folders.length}개` : ''} · 터치하면 전체화면 야장으로 열립니다.`
    : '아직 이 현장 폴더에 등록된 PDF 도면이 없습니다. [＋ PDF 도면 추가]로 올려주세요.';

  const ul = $('drawingFileList');
  if (total === 0 && folders.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '등록된 PDF 도면 파일이 없습니다.';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...files.map((f) => drawingFileRow(f)), ...folders.flatMap(drawingFolderRows));
}

async function uploadDrawingPdf(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) { alert('PDF 파일(.pdf)만 도면으로 올릴 수 있습니다.'); return; }
  if (file.size === 0) { alert('비어 있는 파일입니다. 다른 파일을 골라 주세요.'); return; }
  if (file.size > MAX_DRAWING_BYTES) { alert(`도면 PDF는 ${MAX_DRAWING_BYTES / MB}MB 이하만 올릴 수 있습니다. (이 파일 ${fmtSize(file.size)})`); return; }
  const btn = $('btnUploadDrawing');
  btn.disabled = true;
  $('drawingFolderNote').textContent = `'${file.name}' 도면을 클라우드 폴더에 올리는 중... (파일이 크면 1분 정도 걸립니다)`;
  try {
    const base64 = await readFileAsBase64(file);
    const res = await api('drawing_upload', { site: drawingState.site, file: { name: file.name, base64 } });
    if (res.file) {
      await putCachedPdfBytes(res.file.id, b64ToUint8(base64));
      drawingState.files.unshift(res.file);
      store.set(`drawings_${drawingState.site}`, JSON.stringify(drawingState.files));
    }
    renderDrawingFiles();
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    alert(`도면 업로드 실패: ${friendlyError(err, '파일을 읽지 못했습니다. 다시 골라 주세요.')}`);
    renderDrawingFiles();
  } finally {
    btn.disabled = false;
  }
}

// ---------- 3단계: PDF 전체화면 야장 뷰어 ----------

// 폰 보관분 → 미리 받는 중인 것 → 옛 보관 방식 → 서버 순으로 PDF 바이트를 구한다
async function loadPdfBytes(fileId) {
  let bytes = await getCachedPdfBytes(fileId);
  if (!bytes && prefetchInFlight.has(fileId)) {   // 미리 받는 중이면 다시 받지 않고 그것을 기다린다
    await prefetchInFlight.get(fileId);
    bytes = await getCachedPdfBytes(fileId);
  }
  if (bytes) return bytes;
  const legacyB64 = store.get(`pdf_b64_${fileId}`);
  if (legacyB64) return b64ToUint8(legacyB64);
  const dl = await api('drive_download', { fileId });
  if (typeof dl.base64 !== 'string' || !dl.base64) throw new Error('서버에서 도면 내용을 받지 못했습니다.');
  bytes = b64ToUint8(dl.base64);
  putCachedPdfBytes(fileId, bytes);
  return bytes;
}

let openSeq = 0;              // 도면을 연달아 두 번 누르면 먼저 것은 버린다
let viewerReturnFocus = null; // 뷰어를 닫으면 열기 전에 있던 자리(도면 줄)로 포커스를 돌려준다
let closingViewer = false;

async function openPdfFieldbook(file) {
  const seq = ++openSeq;
  persistNotesNow();
  drawingState.pdfDoc?.destroy();   // 이전 도면 메모리 해제
  drawingState.pdfDoc = null;
  drawingState.rawPdfBytes = null;
  drawingState.currentFile = file;
  drawingState.pageNum = 1;
  drawingState.pageCount = 1;
  drawingState.scale = 1.25;
  drawingState.rotation = 0;
  drawingState.activePinId = null;
  drawingState.dirty = false;
  drawingState.notes = normalizeNotes(readCached(`pdf_notes_${file.id}`));
  drawingState.sourceFile = sourceFileOf(file, drawingState.notes, drawingState.files);
  setPinMode(false);
  setPenMode(false);
  closePinMemoBox();

  $('pdfTitle').textContent = file.name;
  $('pdfPageInfo').textContent = '도면 불러오는 중...';
  if ($('pdfViewer').classList.contains('hidden')) {
    viewerReturnFocus = document.activeElement;
    // 안드로이드 뒤로가기(history.back)가 화면을 바꾸는 대신 뷰어를 닫게 한 칸 넣어 둔다
    try { history.pushState({ pdfViewer: true }, ''); } catch (err) { console.warn('history 사용 불가', err); }
    show($('pdfViewer'), true);
    $('pdfClose').focus();
  }

  // 야장 메모 조회(서버)는 도면 그리기를 막지 않도록 먼저 출발만 시켜 두고, 그리기 끝난 뒤 반영한다
  const notesPromise = api('drawing_notes_get', { fileId: file.id }).catch((err) => { console.warn('야장 메모 조회 실패', err); return null; });

  try {
    const source = drawingState.sourceFile;
    const [pdfjsLib, sourceBytes] = await Promise.all([
      ensurePdfJs(),
      source ? loadPdfBytes(source.id).catch((err) => { console.warn('원본 도면을 받지 못해 저장본 그대로 엽니다', err); return null; }) : null,
    ]);
    if (source && !sourceBytes && seq === openSeq) drawingState.sourceFile = null;
    const bytes = sourceBytes || await loadPdfBytes(file.id);
    if (seq !== openSeq) return;
    drawingState.rawPdfBytes = bytes.slice();

    // isEvalSupported:false — pdf.js 3.x 는 PDF 글꼴로 임의 JS를 실행당할 수 있다(CVE-2024-4367). 4.2.67 이상으로 올려도 이 줄은 둔다
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    if (seq !== openSeq) { pdfDoc.destroy(); return; }
    drawingState.pdfDoc = pdfDoc;
    drawingState.pageCount = pdfDoc.numPages;
    await renderPdfPage();
    applyServerNotes(file, await notesPromise);
  } catch (err) {
    if (seq !== openSeq) return;
    if (err.isAuth) { drawingState.dirty = false; signOut(); closePdfViewer(); return; }
    alert(`PDF 도면을 열지 못했습니다: ${friendlyError(err, '파일이 손상되었거나 PDF가 아닙니다.')}`);
    closePdfViewer();
  }
}

// 뷰어 닫기: 열 때 history에 한 칸 넣었으면 뒤로가기(popstate)로 닫히고, 아니면 바로 닫는다
function closePdfViewer() {
  if (closingViewer) return;
  if (history.state?.pdfViewer) { closingViewer = true; history.back(); } else hideViewer();
}

// 화면을 실제로 닫는다. 고친 메모가 있으면 먼저 서버에 저장한다(그동안 저장 버튼에 '저장중..'이 보인다)
async function hideViewer() {
  closingViewer = false;
  if ($('pdfViewer').classList.contains('hidden')) return;
  openSeq += 1;   // 아직 열리던 도면은 버린다
  if (savingNotes) await savingNotes;
  else if (drawingState.dirty) await saveDrawingNotesToServer(false);
  show($('pdfViewer'), false);
  closePinMemoBox();
  persistNotesNow();
  drawingState.pdfDoc?.destroy();
  drawingState.pdfDoc = null;
  drawingState.rawPdfBytes = null;
  drawingState.currentFile = null;
  drawingState.sourceFile = null;
  if (typeof stopGps === 'function') stopGps();
  if (viewerReturnFocus?.isConnected) viewerReturnFocus.focus();
  viewerReturnFocus = null;
}

// 서버 메모가 늦게 도착해도, 그 사이 다른 도면으로 바뀌었거나 사용자가 이미 고친 게 있으면 덮어쓰지 않는다
function applyServerNotes(file, noteRes) {
  if (drawingState.currentFile !== file || drawingState.dirty) return;
  if (!noteRes?.data || !Array.isArray(noteRes.data.pins)) return;
  drawingState.notes = normalizeNotes(noteRes.data);
  persistNotesNow();
  updatePageInfo();
  redrawPageInk();
  renderPagePins();
}

// 쪽 기준(0~1) 좌표 <-> 시계 방향으로 rot도 돌려 본 화면 좌표
function toView({ x, y }, rot) {
  if (rot === 90) return { x: 1 - y, y: x };
  if (rot === 180) return { x: 1 - x, y: 1 - y };
  if (rot === 270) return { x: y, y: 1 - x };
  return { x, y };
}
function fromView({ x, y }, rot) {
  if (rot === 90) return { x: y, y: 1 - x };
  if (rot === 180) return { x: 1 - x, y: 1 - y };
  if (rot === 270) return { x: 1 - y, y: x };
  return { x, y };
}

let renderTask = null;
let renderSeq = 0;

// 확대·쪽 넘김을 빠르게 연달아 누르면 이전 그리기를 멈추고 마지막 것만 그린다(같은 캔버스에 두 번 그리면 pdf.js가 예외를 던진다)
async function renderPdfPage() {
  if (!drawingState.pdfDoc) return;
  const my = ++renderSeq;
  if (renderTask) {
    renderTask.cancel();
    await renderTask.promise.catch(() => {});
    renderTask = null;
  }
  if (my !== renderSeq) return;
  const doc = drawingState.pdfDoc;
  try {
    const page = await doc.getPage(drawingState.pageNum);
    if (my !== renderSeq || doc !== drawingState.pdfDoc) return;
    const wrapW = Math.max(320, $('pdfStageWrap').clientWidth - 24);
    const rotation = (page.rotate + drawingState.rotation) % 360;
    const unscaled = page.getViewport({ scale: 1, rotation });
    const fitScale = (wrapW / unscaled.width) * drawingState.scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: fitScale * dpr, rotation });

    const pdfCanvas = $('pdfCanvas');
    const cssW = Math.round(viewport.width / dpr);
    const cssH = Math.round(viewport.height / dpr);
    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    pdfCanvas.style.width = `${cssW}px`;
    pdfCanvas.style.height = `${cssH}px`;

    const inkCanvas = $('inkCanvas');
    inkCanvas.width = cssW;
    inkCanvas.height = cssH;
    inkCanvas.style.width = `${cssW}px`;
    inkCanvas.style.height = `${cssH}px`;

    const pinLayer = $('pinLayer');
    pinLayer.style.width = `${cssW}px`;
    pinLayer.style.height = `${cssH}px`;

    const task = page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport });
    renderTask = task;
    await task.promise;
    if (renderTask === task) renderTask = null;
    if (my !== renderSeq) return;
    updatePageInfo();
    redrawPageInk();
    renderPagePins();
    if (typeof refreshGps === 'function') refreshGps();
  } catch (err) {
    if (err?.name === 'RenderingCancelledException' || my !== renderSeq) return;
    console.warn('도면 그리기 실패', err);
    $('pdfPageInfo').textContent = '이 쪽을 그리지 못했습니다. 확대·축소를 다시 눌러 주세요.';
  }
}

function currentPagePins() {
  return (drawingState.notes.pins || []).filter((p) => p.page === drawingState.pageNum);
}

// ---------- 4단계: 왼쪽 하단 동그란 원(마커) 모드 & 메모 박스 ----------

function setPinMode(on) {
  drawingState.pinMode = on;
  if (on) setPenMode(false);
  $('btnPinMode').setAttribute('aria-pressed', String(on));
  refreshPinModeLabel();
  $('pinLayer').classList.toggle('pin-mode-active', on);
}

function refreshPinModeLabel() {
  const type = drawingState.pinType;
  const onText = type ? `${type} ${pinTypeName(type)} 터치 (ON)` : '도면을 터치하세요 (ON)';
  $('pinModeLabel').textContent = drawingState.pinMode ? onText : '동그라미 메모';
}

// 같은 쪽·같은 종류끼리 번호를 센다. 보기 필터와 상관없이 번호가 고정된다
function pinLabel(pin) {
  const same = (drawingState.notes.pins || []).filter((p) => p.page === pin.page && (p.type || '') === (pin.type || ''));
  return `${pin.type || ''}${same.indexOf(pin) + 1}`;
}

function visiblePagePins() {
  return currentPagePins().filter((p) => !drawingState.pinType || p.type === drawingState.pinType);
}

function setPinType(code) {
  drawingState.pinType = drawingState.pinType === code ? '' : code;
  const active = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (active && drawingState.pinType && active.type !== drawingState.pinType) closePinMemoBox();
  refreshPinModeLabel();
  renderPinLegend();
  renderPagePins();
}

function renderPinLegend() {
  const items = [{ code: '', label: '전체' }, ...PIN_TYPES.map((t) => ({ code: t.code, label: `${t.code} ${t.name}` }))];
  $('pinLegend').replaceChildren(...items.map((item) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin-legend-item';
    el.textContent = item.label;
    el.setAttribute('aria-pressed', String(drawingState.pinType === item.code));
    el.addEventListener('click', () => (item.code ? setPinType(item.code) : setPinType(drawingState.pinType)));
    return el;
  }));
}

function setPenMode(on) {
  drawingState.penMode = on;
  if (on) setPinMode(false);
  $('btnPenMode').setAttribute('aria-pressed', String(on));
  $('inkCanvas').classList.toggle('drawing-active', on);
  show($('btnClearInk'), on);
}

function renderPagePins() {
  const layer = $('pinLayer');
  const pins = visiblePagePins();
  layer.replaceChildren(...pins.map((pin) => {
    const label = pinLabel(pin);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pdf-pin${pin.id === drawingState.activePinId ? ' selected' : ''}${label.length > 2 ? ' small' : ''}`;
    const at = toView(pin, drawingState.rotation);
    el.style.left = `${(at.x * 100).toFixed(2)}%`;
    el.style.top = `${(at.y * 100).toFixed(2)}%`;
    el.textContent = label;
    if (pin.text) {
      const tag = document.createElement('span');
      tag.className = 'pdf-pin-tag';
      tag.textContent = pin.text;
      el.appendChild(tag);
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openPinMemoBox(pin.id);
    });
    return el;
  }));
}

function handleStageTapForPin(e) {
  if (!drawingState.pinMode) return;
  if (e.target.closest('.pdf-pin')) return;
  const rect = $('pinLayer').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { x, y } = fromView({
    x: Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0.02, Math.min(0.98, (e.clientY - rect.top) / rect.height)),
  }, drawingState.rotation);
  const newPin = {
    id: crypto.randomUUID(),
    page: drawingState.pageNum,
    x,
    y,
    type: drawingState.pinType,
    text: '',
    author: $('user')?.value || '',
    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
  };
  drawingState.notes.pins.push(newPin);
  drawingState.dirty = true;
  renderPagePins();
  updatePageInfo();
  openPinMemoBox(newPin.id);
  saveDrawingNotesQuiet();
}

function openPinMemoBox(pinId) {
  const pin = drawingState.notes.pins.find((p) => p.id === pinId);
  if (!pin) return;
  drawingState.activePinId = pinId;
  const kind = pinTypeName(pin.type);
  $('pinMemoTitle').textContent = `⭕ ${pinLabel(pin)}${kind ? ` ${kind}` : ''} 메모`;
  $('pinMemoDisplay').textContent = pin.text || '';
  $('pinMemoKeyboard').value = pin.text || '';
  show($('pinMemoBox'), true);
  renderPagePins();
}

function closePinMemoBox() {
  drawingState.activePinId = null;
  show($('pinMemoBox'), false);
  renderPagePins();
}

function updateActivePinText(newText) {
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (!pin) return;
  newText = negateIfPlainNumber(pin.type, newText);
  pin.text = newText;
  drawingState.dirty = true;
  $('pinMemoDisplay').textContent = newText;
  $('pinMemoKeyboard').value = newText;
  renderPagePins();
  saveDrawingNotesQuiet();
}

function deleteActivePin() {
  if (!drawingState.activePinId) return;
  if (!confirm('이 동그라미 메모를 도면에서 삭제할까요?')) return;
  drawingState.notes.pins = drawingState.notes.pins.filter((p) => p.id !== drawingState.activePinId);
  drawingState.dirty = true;
  closePinMemoBox();
  updatePageInfo();
  saveDrawingNotesQuiet();
}

// ---------- 5단계: 메모 박스 한 번 더 터치 → 손글씨 펜 필기 & 최상급 AI 필체 인식(획 궤적 딥러닝 + OCR) ----------

const GOOGLE_HANDWRITING_URL = 'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8';

let ocrDrawing = false;
let ocrHasInk = false;
let ocrStrokes = [];       // 각 획의 [{ x, y, t }] 배열
let currentOcrStroke = null;
let livePreviewTimer = null;

function openHandwritingOcrPad() {
  if (!drawingState.activePinId) return;
  clearOcrPad();
  $('ocrStatus').textContent = '펜이나 손가락으로 글씨·숫자를 쓰면 실시간으로 판독 후보가 나타나고, [필체 판독하여 넣기]를 누르면 바로 입력됩니다.';
  $('ocrPadDialog').showModal();
}

function redrawOcrPad() {
  const c = $('ocrPadCanvas');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  for (const s of ocrStrokes) {
    if (!s.length) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i += 1) ctx.lineTo(s[i].x, s[i].y);
    ctx.stroke();
  }
}

function clearOcrPad() {
  ocrStrokes = [];
  currentOcrStroke = null;
  ocrHasInk = false;
  clearTimeout(livePreviewTimer);
  redrawOcrPad();
  show($('ocrCandidates'), false);
  $('ocrCandidates').replaceChildren();
}

function undoOcrStroke() {
  if (!ocrStrokes.length) return;
  ocrStrokes.pop();
  ocrHasInk = ocrStrokes.length > 0;
  redrawOcrPad();
  if (ocrHasInk) scheduleLiveHandwritingPreview();
  else {
    show($('ocrCandidates'), false);
    $('ocrCandidates').replaceChildren();
    $('ocrStatus').textContent = '지워졌습니다. 다시 적어주세요.';
  }
}

function initOcrPadEvents() {
  const c = $('ocrPadCanvas');
  const ctx = c.getContext('2d');
  let padStartMs = 0;

  const pt = (e) => {
    const r = c.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * c.width),
      y: Math.round(((e.clientY - r.top) / r.height) * c.height),
      t: Math.max(0, Date.now() - padStartMs),
    };
  };

  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    if (!ocrStrokes.length) padStartMs = Date.now();
    ocrDrawing = true;
    ocrHasInk = true;
    const p = pt(e);
    currentOcrStroke = [p];
    ocrStrokes.push(currentOcrStroke);
    ctx.beginPath();
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    ctx.moveTo(p.x, p.y);
  });

  c.addEventListener('pointermove', (e) => {
    if (!ocrDrawing || !currentOcrStroke) return;
    const p = pt(e);
    currentOcrStroke.push(p);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  const stop = () => {
    if (!ocrDrawing) return;
    ocrDrawing = false;
    currentOcrStroke = null;
    scheduleLiveHandwritingPreview();
  };
  c.addEventListener('pointerup', stop);
  c.addEventListener('pointercancel', stop);
}

// 1순위: Google Input Tools Handwriting 딥러닝 엔진 (획 순서·방향·시간차 기반 한글+영문+숫자+기호 최상급 인식)
async function recognizeWithGoogleInk(strokes, width, height) {
  const ink = strokes.map((s) => [
    s.map((p) => p.x),
    s.map((p) => p.y),
    s.map((p) => p.t),
  ]);
  const payload = {
    options: 'enable_pre_space',
    requests: [{
      writing_guide: { writing_area_width: width, writing_area_height: height },
      ink,
      language: 'ko',
    }],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OCR_TIMEOUT_MS);   // 신호가 약하면 '판독 중'에 묶이지 않고 다음 방법으로 넘어간다
  try {
    const res = await fetch(GOOGLE_HANDWRITING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const json = await res.json();
    if (json && json[0] === 'SUCCESS' && Array.isArray(json[1]?.[0]?.[1])) {
      return json[1][0][1].map((s) => String(s).trim()).filter(Boolean);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 3순위 오프라인 대비: 글씨 영역만 자동으로 잘라내고(Bounding-Box Crop) 고해상도 대비 강화를 거친 정밀 OCR
function buildCroppedHighContrastImage(strokes, srcCanvas) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return srcCanvas.toDataURL('image/png');
  const pad = 28;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const w = Math.max(80, Math.min(srcCanvas.width - x0, (maxX - minX) + pad * 2));
  const h = Math.max(60, Math.min(srcCanvas.height - y0, (maxY - minY) + pad * 2));

  const out = document.createElement('canvas');
  out.width = w * 2;
  out.height = h * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.scale(2, 2);
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000000';
  for (const s of strokes) {
    if (!s.length) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x - x0, s[0].y - y0);
    for (let i = 1; i < s.length; i += 1) ctx.lineTo(s[i].x - x0, s[i].y - y0);
    ctx.stroke();
  }
  return out.toDataURL('image/png');
}

function applyOcrTextAndClose(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  const merged = pin && pin.text ? `${pin.text} ${clean}` : clean;
  updateActivePinText(merged);
  $('ocrPadDialog').close();
}

function renderOcrCandidates(candidates) {
  const box = $('ocrCandidates');
  if (!candidates || !candidates.length) {
    show(box, false);
    box.replaceChildren();
    return;
  }
  show(box, true);
  box.replaceChildren(...candidates.slice(0, 5).map((word, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (idx === 0) b.setAttribute('aria-pressed', 'true');
    b.textContent = idx === 0 ? `✓ ${word}` : word;
    b.addEventListener('click', () => applyOcrTextAndClose(word));
    return b;
  }));
}

function scheduleLiveHandwritingPreview() {
  clearTimeout(livePreviewTimer);
  if (!ocrStrokes.length || navigator.onLine === false) return;
  livePreviewTimer = setTimeout(async () => {
    try {
      const c = $('ocrPadCanvas');
      const list = await recognizeWithGoogleInk(ocrStrokes, c.width, c.height);
      if (!$('ocrPadDialog').open || !ocrStrokes.length) return;   // 기다리는 사이 닫혔거나 지워졌다
      if (list.length > 0) {
        renderOcrCandidates(list);
        $('ocrStatus').textContent = `실시간 판독: 「${list[0]}」 — 위 후보를 바로 터치하거나 아래 확인 버튼을 누르세요.`;
      }
    } catch (err) {
      console.warn('실시간 판독 실패', err);   // 미리보기는 덤: [필체 판독하여 넣기]가 다른 방법으로 이어 간다
    }
  }, 320);
}

async function recognizeHandwritingToText() {
  if (!ocrHasInk || !ocrStrokes.length) {
    $('ocrStatus').textContent = '먼저 흰 칸에 글씨나 숫자를 써 주세요!';
    return;
  }
  const btn = $('ocrPadRecognize');
  btn.disabled = true;
  $('ocrStatus').textContent = '🔍 AI 필기 엔진으로 판독 중입니다...';

  try {
    const c = $('ocrPadCanvas');
    let recognized = '';

    // 1순위: Google Input Tools Handwriting 딥러닝 엔진 (획 순서 + 방향 분석)
    if (navigator.onLine !== false) {
      try {
        const list = await recognizeWithGoogleInk(ocrStrokes, c.width, c.height);
        if (list.length > 0) {
          recognized = list[0];
          renderOcrCandidates(list);
        }
      } catch { /* 2순위로 이동 */ }
    }

    // 2순위: 서버(Google Drive OCR) 시도
    if (!recognized && navigator.onLine !== false) {
      try {
        const croppedUrl = buildCroppedHighContrastImage(ocrStrokes, c);
        const srv = await api('ocr_handwriting', { base64: croppedUrl.split(',')[1] });
        if (srv && srv.text) recognized = srv.text.trim();
      } catch { /* 3순위로 이동 */ }
    }

    // 3순위: 글씨 영역 자동 크롭 + 2배 확대 고대비 전처리 후 Tesseract OCR
    if (!recognized) {
      const croppedUrl = buildCroppedHighContrastImage(ocrStrokes, c);
      const Tesseract = await ensureTesseract();
      const { data } = await Tesseract.recognize(croppedUrl, 'kor+eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            $('ocrStatus').textContent = `🔍 정밀 판독 중... (${Math.round((m.progress || 0) * 100)}%)`;
          }
        },
      });
      recognized = (data?.text || '').replace(/\s+/g, ' ').trim();
    }

    if (!recognized) {
      $('ocrStatus').textContent = '글씨를 인식하지 못했습니다. [다 지우기] 후 다시 적어주세요.';
      return;
    }

    applyOcrTextAndClose(recognized);
  } catch (err) {
    console.warn('필체 판독 실패', err);
    $('ocrStatus').textContent = `판독 실패: ${friendlyError(err, '판독 엔진을 불러오지 못했습니다. 신호를 확인하거나 아래 칸에 키보드로 입력해 주세요.')}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 도면 위 자유 펜 필기 (야장 스케치) ----------

function initInkCanvasEvents() {
  const c = $('inkCanvas');
  let stroke = null;

  const pt = (e) => {
    const r = c.getBoundingClientRect();
    const p = fromView({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, drawingState.rotation);
    return { x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 };
  };

  c.addEventListener('pointerdown', (e) => {
    if (!drawingState.penMode) return;
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    stroke = [pt(e)];
    const pageKey = String(drawingState.pageNum);
    drawingState.notes.strokes[pageKey] ??= [];
    drawingState.notes.strokes[pageKey].push(stroke);
    drawingState.dirty = true;
    redrawPageInk();
  });

  // 전체를 다시 그리지 않고 새 구간만 잇는다: 필기가 많아도 손을 따라오는 속도가 느려지지 않는다
  c.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const prev = stroke[stroke.length - 1];
    const p = pt(e);
    stroke.push(p);
    const ctx = c.getContext('2d');
    inkStyle(ctx);
    const a = toView(prev, drawingState.rotation);
    const b = toView(p, drawingState.rotation);
    ctx.beginPath();
    ctx.moveTo(a.x * c.width, a.y * c.height);
    ctx.lineTo(b.x * c.width, b.y * c.height);
    ctx.stroke();
  });

  const end = () => {
    if (!stroke) return;
    stroke = null;
    saveDrawingNotesQuiet();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

function inkStyle(ctx) {
  ctx.strokeStyle = INK_COLOR;
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function redrawPageInk() {
  const c = $('inkCanvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const strokes = drawingState.notes.strokes?.[String(drawingState.pageNum)] || [];
  inkStyle(ctx);
  for (const s of strokes) {
    if (!s.length) continue;
    ctx.beginPath();
    const v = s.map((p) => toView(p, drawingState.rotation));
    ctx.moveTo(v[0].x * c.width, v[0].y * c.height);
    for (let i = 1; i < v.length; i += 1) {
      ctx.lineTo(v[i].x * c.width, v[i].y * c.height);
    }
    ctx.stroke();
  }
}

// ---------- 야장 저장 (원본이름_수정날짜(요일한글자).pdf 로 다른 이름 저장) ----------

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 특정 페이지의 동그라미 마커 + OCR 텍스트 태그 + 자유 펜 필기를 투명 PNG 데이터로 그린다
// onlyType을 주면 그 계측기 메모만 그린다(자유 펜 필기는 계측기와 무관하므로 뺀다). 없으면 전부
function renderPageAnnotationsPng(pageIndex1Based, widthPx, heightPx, onlyType = null) {
  const pagePins = (drawingState.notes.pins || []).filter((p) => p.page === pageIndex1Based && (!onlyType || p.type === onlyType));
  const pageStrokes = onlyType ? [] : (drawingState.notes.strokes?.[String(pageIndex1Based)] || []);
  if (!pagePins.length && !pageStrokes.length) return null;

  const c = document.createElement('canvas');
  c.width = Math.round(widthPx * 2);
  c.height = Math.round(heightPx * 2);
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);

  // 1) 자유 펜 필기 그리기
  ctx.strokeStyle = INK_COLOR;
  ctx.lineWidth = 3.0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of pageStrokes) {
    if (!s.length) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x * widthPx, s[0].y * heightPx);
    for (let i = 1; i < s.length; i += 1) {
      ctx.lineTo(s[i].x * widthPx, s[i].y * heightPx);
    }
    ctx.stroke();
  }

  // 2) 동그란 원 마커 및 OCR 텍스트 라벨 그리기
  pagePins.forEach((pin) => {
    const cx = pin.x * widthPx;
    const cy = pin.y * heightPx;
    const r = 13;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(198, 40, 40, 0.94)';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px "Noto Sans KR", "Malgun Gothic", sans-serif';
    const label = pinLabel(pin);
    ctx.font = `bold ${label.length > 2 ? 10 : 12}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);

    if (pin.text) {
      ctx.font = 'bold 12px "Noto Sans KR", "Malgun Gothic", sans-serif';
      const padX = 7;
      const boxH = 22;
      const textW = ctx.measureText(pin.text).width;
      const boxW = textW + padX * 2;
      const bx = Math.max(4, Math.min(widthPx - boxW - 4, cx - boxW / 2));
      const by = Math.min(heightPx - boxH - 4, cy + r + 4);

      ctx.fillStyle = 'rgba(27, 42, 87, 0.94)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 5); else ctx.rect(bx, by, boxW, boxH);   // 옛 WebView에는 roundRect가 없다
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.text, bx + padX, by + boxH / 2);
    }
  });

  return c.toDataURL('image/png');
}

// 원본 PDF 바이트 위에 모든 페이지의 야장 메모/필기를 합성한 새 PDF base64 생성
async function buildAnnotatedPdfBase64(onlyType = null) {
  const PDFLib = await ensurePdfLib();
  const pdfDoc = await PDFLib.PDFDocument.load(drawingState.rawPdfBytes);
  const pages = pdfDoc.getPages();

  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const { width, height } = p.getSize();
    const pngUrl = renderPageAnnotationsPng(i + 1, width, height, onlyType);
    if (!pngUrl) continue;
    const pngImage = await pdfDoc.embedPng(pngUrl);
    p.drawImage(pngImage, { x: 0, y: 0, width, height });
  }

  const outBytes = await pdfDoc.save();
  return uint8ToBase64(outBytes);
}

// 폰 보관: 획마다·글자마다 불리므로 잠깐 모아서 한 번만 쓴다. 닫거나 서버에 보낼 때는 바로 쓴다(persistNotesNow)
let saveNotesTimer = null;
function persistNotesNow() {
  clearTimeout(saveNotesTimer);
  if (drawingState.currentFile) store.set(`pdf_notes_${drawingState.currentFile.id}`, JSON.stringify(drawingState.notes));
}
function saveDrawingNotesQuiet() {
  if (!drawingState.currentFile) return;
  clearTimeout(saveNotesTimer);
  saveNotesTimer = setTimeout(persistNotesNow, NOTES_SAVE_DELAY_MS);
}

// 저장은 한 번에 하나만: 저장 중에 닫기를 눌러도 같은 저장을 기다린다
let savingNotes = null;
function saveDrawingNotesToServer(showAlert = true) {
  savingNotes ??= doSaveDrawingNotes(showAlert).finally(() => { savingNotes = null; });
  return savingNotes;
}

async function doSaveDrawingNotes(showAlert) {
  const file = drawingState.currentFile;
  if (!file) return;
  const btn = $('pdfSaveNotes');
  btn.disabled = true;
  btn.textContent = '저장중..';
  persistNotesNow();

  const newFileName = buildSavedDrawingFileName(file.name, new Date());
  let flattened = true;   // 메모를 PDF 그림에 합쳤는지(합치기 라이브러리를 못 받으면 원본 그대로 올린다)

  try {
    // 1) 원본 파일에도 야장 메모 JSON은 보존해 두고,
    // 2) '원본이름_수정날짜(요일한글자).pdf' 로 야장 메모가 합쳐진 새 PDF를 다른 이름으로 저장!
    let pdfBase64 = store.get(`pdf_b64_${file.id}`);
    if (drawingState.rawPdfBytes) {
      try {
        pdfBase64 = await buildAnnotatedPdfBase64();
      } catch (err) {
        console.warn('메모 합치기 실패, 원본 그대로 저장', err);
        flattened = false;
        pdfBase64 = uint8ToBase64(drawingState.rawPdfBytes);
      }
    }
    if (!pdfBase64) throw new Error('도면이 아직 다 열리지 않았습니다. 도면이 보인 뒤 다시 저장해 주세요.');

    // 새 저장본의 메모에 바탕 원본을 적어 둔다: 저장본을 다시 열어도 원본 위에 동그라미 한 겹만 그린다
    const savedNotes = { ...drawingState.notes, sourceId: (drawingState.sourceFile || file).id };
    const res = await api('drawing_upload', {
      site: drawingState.site,
      file: {
        name: newFileName,
        base64: pdfBase64,
        replaceSameName: true,
        user: $('user')?.value || '',
        notes: savedNotes,
      },
    });

    if (res.file) {
      // 새로 저장한 파일도 즉시 IndexedDB 캐시에 넣어 다시 열 때 0.1초 만에 뜨도록 함
      if (pdfBase64) putCachedPdfBytes(res.file.id, b64ToUint8(pdfBase64));
      drawingState.files = [res.file, ...drawingState.files.filter((f) => f.name !== res.file.name && f.id !== res.file.id)];
      store.set(`drawings_${drawingState.site}`, JSON.stringify(drawingState.files));
      store.set(`pdf_notes_${res.file.id}`, JSON.stringify(savedNotes));
      $('pdfTitle').textContent = res.file.name;
      renderDrawingFiles();
    }

    drawingState.dirty = false;
    btn.textContent = '저장됨✓';
    if (showAlert) {
      alert(flattened
        ? `'${newFileName}' 이름으로 도면 폴더에 새로 저장되었습니다!`
        : `'${newFileName}' 이름으로 저장했지만, 합치기 기능 파일을 받지 못해 메모를 PDF 그림에 합치지는 못했습니다.\n메모 자체는 서버에 보관되어 다시 열면 보입니다.`);
    }
  } catch (err) {
    if (err.isAuth) { drawingState.dirty = false; signOut(); closePdfViewer(); return; }
    btn.textContent = '폰보관✓';
    const reason = friendlyError(err, '메모를 PDF로 만들지 못했습니다.');
    // 서버가 입력을 거부한 것(파일 이름·메모 크기 등)은 신호 문제가 아니므로 그 사유를 그대로 보여 준다
    if (showAlert) alert(err.network ? `신호가 약해 이 휴대폰에 먼저 보관했습니다: ${reason}` : `서버에 저장하지 못해 이 휴대폰에만 보관했습니다: ${reason}`);
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (btn.textContent !== '저장중..') btn.textContent = '다른이름 저장'; }, BTN_RESET_MS);
  }
}

// 원본 도면 하나에서 계측기(범례 종류)별로 PDF를 따로 만들어 올린다. 메모가 있는 종류만, 종류마다 한 파일
async function saveTypedPdfs() {
  const file = drawingState.currentFile;
  if (!file || !drawingState.rawPdfBytes) return;
  const pins = drawingState.notes.pins || [];
  const types = PIN_TYPES.filter((t) => pins.some((p) => p.type === t.code));
  if (!types.length) {
    alert('계측기 종류를 고른 동그라미 메모가 없습니다. 범례에서 종류를 고른 뒤 동그라미를 찍어 주세요.');
    return;
  }
  const btn = $('pdfSaveTyped');
  btn.disabled = true;
  // 원본 이름에서 .pdf와 날짜 꼬리표를 뗀 이름이 폴더 이름. 날짜가 달라져도 같은 폴더를 쓴다
  const folderName = buildSavedDrawingFileName(file.name).replace(/_\d{4}-\d{2}-\d{2}\([일월화수목금토]\)\.pdf$/, '');
  const savePath = `${folderName}/${EXTERNAL_DIR}`;   // 원본 폴더 안의 외부계측기 폴더
  const saved = [];
  const failed = [];
  for (const t of types) {
    btn.textContent = `${t.name} 저장중..`;
    const name = buildSavedDrawingFileName(file.name, new Date()).replace(/(_\d{4}-\d{2}-\d{2}\([일월화수목금토]\)\.pdf)$/, `_${t.name}$1`);
    try {
      const base64 = await buildAnnotatedPdfBase64(t.code);
      const res = await api('drawing_upload', {
        site: drawingState.site,
        file: { name, base64, replaceSameName: true, subdir: savePath, user: $('user')?.value || '' },
      });
      if (!res.file) throw new Error(res.error || '저장 실패');
      // 옛 서버 코드는 folder를 안 돌려주고 subdir을 무시한 채 현장 폴더에 저장한다
      if (res.folder !== `도면/${drawingState.site}/${savePath}`) throw new Error(`서버가 옛 버전이라 ${res.folder || '도면/' + drawingState.site} 에 저장됨. Code.gs를 새 버전으로 배포하세요`);
      saved.push(t.name);
      // 도면 목록에도 바로 보이도록 폴더 목록을 갱신한다(같은 이름은 교체)
      const dir = drawingState.folders.find((f) => f.name === folderName) || { name: folderName, files: [] };
      const nextDir = { name: folderName, files: [res.file, ...dir.files.filter((f) => f.name !== res.file.name)] };
      drawingState.folders = [...drawingState.folders.filter((f) => f.name !== folderName), nextDir]
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      store.set(`drawing_folders_${drawingState.site}`, JSON.stringify(drawingState.folders));
    } catch (err) {
      if (err.isAuth) { btn.disabled = false; btn.textContent = '계측기별 PDF'; drawingState.dirty = false; signOut(); closePdfViewer(); return; }
      failed.push(`${t.name}(${friendlyError(err, 'PDF를 만들지 못했습니다')})`);
    }
  }
  btn.disabled = false;
  btn.textContent = '계측기별 PDF';
  const untyped = pins.filter((p) => !p.type).length;
  alert([
    saved.length ? `'${folderName}' 폴더에 ${saved.length}개 저장: ${saved.join(', ')}` : '저장된 파일이 없습니다',
    failed.length ? `실패: ${failed.join(', ')}` : '',
    untyped ? `종류 없는 메모 ${untyped}개는 계측기별 PDF에 들어가지 않습니다` : '',
  ].filter(Boolean).join('\n'));
}

function initDrawingModule() {
  renderPinLegend();
  $('pdfSaveTyped').addEventListener('click', saveTypedPdfs);
  $('drawingBackSites').addEventListener('click', loadDrawingTab);
  $('btnUploadDrawing').addEventListener('click', () => $('inputDrawingPdf').click());
  $('inputDrawingPdf').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) uploadDrawingPdf(f);
  });

  $('pdfClose').addEventListener('click', closePdfViewer);
  // 안드로이드 뒤로가기·브라우저 뒤로가기: 뷰어가 열려 있으면 화면을 바꾸지 않고 뷰어만 닫는다
  window.addEventListener('popstate', () => { if (!$('pdfViewer').classList.contains('hidden')) hideViewer(); });
  // Esc: 메모 박스가 열려 있으면 그것부터, 아니면 뷰어를 닫는다(<dialog>가 열려 있으면 그 쪽이 먼저 받는다)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('pdfViewer').classList.contains('hidden') || document.querySelector('dialog[open]')) return;
    if (!$('pinMemoBox').classList.contains('hidden')) closePinMemoBox();
    else closePdfViewer();
  });
  $('pdfPrevPage').addEventListener('click', () => {
    if (drawingState.pageNum > 1) {
      drawingState.pageNum -= 1;
      closePinMemoBox();
      renderPdfPage();
    }
  });
  $('pdfNextPage').addEventListener('click', () => {
    if (drawingState.pageNum < drawingState.pageCount) {
      drawingState.pageNum += 1;
      closePinMemoBox();
      renderPdfPage();
    }
  });
  $('pdfZoomIn').addEventListener('click', () => {
    drawingState.scale = Math.min(3.0, drawingState.scale + 0.35);
    renderPdfPage();
  });
  $('pdfZoomOut').addEventListener('click', () => {
    drawingState.scale = Math.max(0.75, drawingState.scale - 0.35);
    renderPdfPage();
  });
  $('pdfRotate').addEventListener('click', () => {
    drawingState.rotation = (drawingState.rotation + 90) % 360;
    closePinMemoBox();
    renderPdfPage();
  });
  $('pdfSaveNotes').addEventListener('click', () => saveDrawingNotesToServer(true));

  $('btnPinMode').addEventListener('click', () => setPinMode(!drawingState.pinMode));
  $('btnPenMode').addEventListener('click', () => setPenMode(!drawingState.penMode));
  $('btnClearInk').addEventListener('click', () => {
    if (!confirm('이 쪽에 그린 자유 펜 필기를 지울까요? (동그라미 메모는 유지됩니다)')) return;
    drawingState.notes.strokes[String(drawingState.pageNum)] = [];
    drawingState.dirty = true;
    redrawPageInk();
    saveDrawingNotesQuiet();
  });

  $('pinLayer').addEventListener('click', handleStageTapForPin);
  $('pinMemoClose').addEventListener('click', closePinMemoBox);
  $('pinMemoDelete').addEventListener('click', deleteActivePin);

  // 메모 칸을 한 번 더 터치하면 손글씨 펜 입력(OCR) 패드 오픈!
  $('pinMemoDisplay').addEventListener('click', openHandwritingOcrPad);
  $('pinMemoOpenPad').addEventListener('click', openHandwritingOcrPad);
  $('pinMemoKeyboard').addEventListener('input', (e) => updateActivePinText(e.target.value));

  $('ocrPadClose').addEventListener('click', () => $('ocrPadDialog').close());
  $('ocrPadUndo').addEventListener('click', undoOcrStroke);
  $('ocrPadClear').addEventListener('click', clearOcrPad);
  $('ocrPadRecognize').addEventListener('click', recognizeHandwritingToText);

  initOcrPadEvents();
  initInkCanvasEvents();
}

if (typeof module !== 'undefined') module.exports = { buildSavedDrawingFileName, negateIfPlainNumber, toView, fromView, normalizeNotes, friendlyError, sourceFileOf, PIN_TYPES };
