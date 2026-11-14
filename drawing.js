// 도면(야장) 탭:
// 1) 현장명 목록만 표시 → 현장명을 터치하면 해당 현장의 도면(PDF) 폴더가 열림
// 2) PDF를 터치하면 전체화면 도면 야장으로 열림
// 3) 왼쪽 하단의 '동그란 원(동그라미 메모)' 버튼을 누른 상태로 도면의 어느 한 곳을 터치하면
//    동그란 원이 찍히면서 메모 박스가 뜸
// 4) 그 메모 박스를 한 번 더 터치하면 펜으로 필체를 쓰는 손글씨 입력창이 열리고,
//    OCR 판독으로 글씨체를 알아보고 텍스트 형태로 자동 변환해 메모에 넣어줌
// 5) 진짜 야장처럼 도면 위에 바로 자유 펜 필기도 가능하며 클라우드와 기기에 저장됨

// pdf.js(4.10.38 legacy 빌드)는 CDN 대신 앱 안(web/vendor/)에 둔다: 서비스 워커가 폰에 저장해 두므로 탭을 열 때마다 1.8MB를 내려받지 않고, 신호 없는 현장에서도 도면이 열린다.
// 4.x 는 ES 모듈(.mjs)뿐이라 import() 로 읽는다. 이름은 .js 로 둔다: APK 의 오프라인 응답(MainActivity.mimeOf)이 .mjs 를 JS 로 알려 주지 않아서
const DRAWING_BUILD = (typeof document !== 'undefined' && document.currentScript && new URL(document.currentScript.src).searchParams.get('v')) || '-';
const PDFJS_URL = `vendor/pdf4.min.js?v=${DRAWING_BUILD}`;
const PDFJS_WORKER = `vendor/pdf4.worker.min.js?v=${DRAWING_BUILD}`;
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PDFLIB_CDN = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_DRAWING_BYTES = 18 * 1024 * 1024;   // 서버 상한(base64 25,000,000자)과 같다
const PREFETCH_COUNT = 8;      // 현장을 열면 미리 받아 두는 원본 도면 수(데이터 절약 모드이고 Wi-Fi 가 아닐 때)
const PREFETCH_MAX = 24;       // 그 밖(데이터 절약 모드가 아니거나 Wi-Fi)일 때 미리 받는 수
const PREFETCH_PARALLEL = 1;   // 동시에 1개만 미리 받는다: 2개씩 받으면 사용자가 방금 누른 도면·야장 조회가 뒤로 밀린다
const PREFETCH_DELAY_MS = 1200; // 현장 폴더를 연 직후 사용자가 바로 도면을 누를 여유 시간(너무 일찍 시작하면 첫 도면 열기와 대역폭이 겹친다)
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;   // 도면 받기: 보내는 양은 작고 받는 양(수 MB)이 커서 기본 30초로는 느린 신호에서 끊긴다
const LOWRES_DPR = 0.5;        // 처음 그릴 때 먼저 보여 주는 거친 그림의 선명도(화면 1px 에 0.5px). 이어서 선명한 그림으로 바꾼다
const NOTES_SAVE_DELAY_MS = 300;
const OCR_TIMEOUT_MS = 12 * 1000;
const BTN_RESET_MS = 2200;
const INK_COLOR = '#C62828';   // 흰 글자가 4.5:1 이상 읽히는 빨강(마커·필기 공통)

// CDN 라이브러리는 탭을 열 때 받는다. 한 번 실패한 주소는 다음에 다시 받을 수 있게 기억에서 지운다
const scriptLoads = new Map();
// integrity를 주면 CDN 파일이 한 글자라도 바뀌었을 때 실행하지 않는다
function loadScriptOnce(src, integrity = '') {
  if (!scriptLoads.has(src)) {
    scriptLoads.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      if (integrity) Object.assign(s, { integrity, crossOrigin: 'anonymous' });
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

async function ensureLib(src, globalName, integrity = '') {
  if (!window[globalName]) await loadScriptOnce(src, integrity);
  if (!window[globalName]) throw new Error('도면 기능 파일이 올바르지 않습니다. 정보 탭에서 새로고침해 주세요.');
  return window[globalName];
}

let pdfJsLoad = null;
function ensurePdfJs() {
  if (!pdfJsLoad) {
    pdfJsLoad = import(new URL(PDFJS_URL, document.baseURI).href).then((lib) => {
      if (!lib?.getDocument) throw new Error('도면 기능 파일이 올바르지 않습니다. 정보 탭에서 새로고침해 주세요.');
      lib.GlobalWorkerOptions.workerSrc = new URL(PDFJS_WORKER, document.baseURI).href;
      return lib;
    }, () => {
      pdfJsLoad = null;   // 실패하면 다음에 다시 받는다
      throw new Error(navigator.onLine === false
        ? '신호가 없어 도면 기능 파일을 내려받지 못했습니다. 신호가 잡히면 다시 열어 주세요.'
        : '도면 기능 파일을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.');
    });
  }
  return pdfJsLoad;
}

// 앱을 연 뒤 한가할 때 pdf.js 본체와 백그라운드 워커까지 미리 올려 둔다(app.js·도면 탭 진입 시): 첫 도면을 눌러도 워커 부팅·엔진 해석을 기다리지 않는다
function warmPdfWorker() {
  if (navigator.onLine === false || typeof getPdfWorker !== 'function') return false;
  if (getPdfWorker()) {
    workerCall('warm').catch(() => {});
    return true;
  }
  return false;
}
function warmDrawing() {
  if (navigator.onLine === false) return;
  if (!warmPdfWorker()) {
    ensurePdfJs().catch(() => {});
    fetch(PDFJS_WORKER).catch(() => {});
  }
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
  // date(적은 날)·history(이전 값)가 깨진 모양이면 그 칸만 뺀다(메모 상자의 전회값 표시가 멈추지 않게). 멀쩡한 pin 은 그대로
  const cleanPin = (p) => {
    const bad = ('date' in p && typeof p.date !== 'string') || ('history' in p && !Array.isArray(p.history));
    if (!bad) return p;
    const { date, history, ...rest } = p;
    return { ...rest, ...(typeof date === 'string' ? { date } : {}), ...(Array.isArray(history) ? { history } : {}) };
  };
  const pins = Array.isArray(data?.pins) ? data.pins.filter((p) => p && typeof p === 'object' && p.id).map(cleanPin) : [];
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

// 저장본·계측기별 PDF 가 모이는 묶음(원본) 이름: 확장자·종류·날짜 꼬리표를 뗀 이름. 저장본을 열고 다시 저장해도 같은 묶음에 들어간다.
// 원본 이름 자체가 '_수위' 로 끝나는 경우(예: 배치도_수위.pdf)도 있으므로, 날짜 꼬리표가 없는 이름은 그대로 두고, 종류를 뗀 이름보다 뗴기 전 이름의 원본이 있으면 그쪽을 쓴다
function familyNameOf(fileName, files = []) {
  const stem = stemOf(fileName);
  const m = SAVED_STEM_RE.exec(stem);
  if (!m) return driveFolderName(stem);
  const base = m[1];
  const type = TYPE_NAMES.find((n) => base.endsWith(`_${n}`));
  if (!type || files.some((f) => driveFolderName(stemOf(f.name)) === driveFolderName(base))) return driveFolderName(base);
  return driveFolderName(base.slice(0, -(type.length + 1)));
}

// 동그라미 범례: 원 안에 코드 글자와 번호가 들어간다(W1, W2, H1...). 코드가 없는 옛 메모는 번호만
const PIN_TYPES = [
  { code: 'W', name: '수위' },
  { code: 'H', name: '굴착고' },
  { code: 'S', name: '변형률계' },
  { code: 'L', name: '하중계' },
  { code: 'C', name: '균열' },
  { code: 'P', name: '측량' },
  { code: 'E', name: '기타' },
];
const pinTypeName = (code) => PIN_TYPES.find((t) => t.code === code)?.name || '';

// 항상 음수인 종류(수위 W, 굴착고 H): 숫자만 쓰면 앞에 -를 붙인다. 0과 글자가 섞인 메모, 이미 -가 있는 값은 그대로
const NEGATIVE_PIN_TYPES = ['W', 'H'];
function negateIfPlainNumber(type, text) {
  return NEGATIVE_PIN_TYPES.includes(type) && /^\d+(\.\d+)?$/.test(text) && Number(text) !== 0 ? `-${text}` : text;
}

// ---------- 하중계(L)·변형률계(S): 같은 지점의 1단·2단·3단을 동그라미 하나로 묶어 보인다 ----------
// 저장은 단마다 동그라미(pin) 하나씩 그대로다(번호 'L1-1단' 처럼 num 이 '<지점>-<N>단'). 그리는 순간에만 같은 쪽·종류·지점끼리 묶으므로 옛 도면도 그대로 묶인다.
// 변형률계 값은 text 에 'a/b/c'(칸 3개, 빈 칸은 그대로 비움)로 둔다. '신규설치 1-3단' 같은 표시는 묶음의 첫 동그라미에 note(+noteDate=적은 날)로 두고, 그날만 보인다.
const GROUP_TYPES = ['L', 'S'];
const LEVEL_NUM_RE = /^(.+)-(\d+)단$/;
const STRAIN_CELLS = 3;
const NOTE_CHIP = '신규설치';   // 글자를 고칠 수 없는 고정 표시(눌러서 넣고 빼기만 한다)
const NOTE_TAIL_MAX = 12;

function pinItems(pins) {
  const items = [];
  const byKey = new Map();
  for (const pin of pins || []) {
    if (!GROUP_TYPES.includes(pin.type)) { items.push({ anchor: pin, rows: null }); continue; }
    const m = LEVEL_NUM_RE.exec(String(pin.num || ''));
    const key = m ? `${pin.page}|${pin.type}|${m[1]}` : `id|${pin.id}`;
    let item = byKey.get(key);
    if (!item) { item = { anchor: pin, base: m ? m[1] : null, rows: [] }; byKey.set(key, item); items.push(item); }
    item.rows.push({ pin, level: m ? Number(m[2]) : null });
  }
  for (const item of items) {
    if (!item.rows) continue;
    item.rows.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    item.anchor = item.rows[0].pin;
  }
  return items;
}

// 변형률계 text → 칸 3개. 'a/b/c'이면 칸대로, 구분이 없으면 공백으로 나눈다(손글씨 판독처럼 공백으로 들어온 값)
function strainCells(text) {
  const s = String(text ?? '');
  const parts = s.includes('/') ? s.split('/') : s.split(/\s+/);
  return Array.from({ length: STRAIN_CELLS }, (_, i) => (parts[i] || '').trim());
}
const joinStrainCells = (cells) => cells.map((c) => String(c).trim()).join('/').replace(/\/+$/, '');
const rowCells = (pin) => (pin.type === 'S' ? strainCells(pin.text) : [String(pin.text ?? '').trim()]);

// 손글씨(OCR)로 읽은 글을 변형률계 칸에 넣는다: 공백으로 나뉜 값마다 한 칸씩, 첫 빈 칸부터(값이 남은 칸보다 많으면 앞으로 당겨 넣고, 칸이 다 찼으면 뒤쪽 칸을 바꾼다)
function placeOcrInCells(cells, text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean).slice(0, STRAIN_CELLS);
  const out = cells.slice();
  if (!tokens.length) return out;
  const free = out.findIndex((c) => !c);
  const at = Math.min(free < 0 ? STRAIN_CELLS : free, STRAIN_CELLS - tokens.length);
  tokens.forEach((t, i) => { out[at + i] = t; });
  return out;
}

// 신규설치 표시: 그날 적은 것만 보인다(다음 날 계측용 도면에는 남지 않는다)
const liveNote = (pin) => (pin && pin.note && pin.noteDate === todayKst() ? String(pin.note) : '');
function parseNote(note) {
  const s = String(note || '');
  const chip = s.startsWith(NOTE_CHIP);
  return { chip, tail: (chip ? s.slice(NOTE_CHIP.length) : s).trim() };
}
const joinNote = ({ chip, tail }) => [chip ? NOTE_CHIP : '', tail].filter(Boolean).join(' ');
// 키패드 한 번 누름: 'chip' 은 신규설치 넣고 빼기, 'back' 은 끝 글자 지움, 그 밖은 숫자·'단'·'-' 덧붙이기
function pressNoteKey(note, key) {
  const cur = parseNote(note);
  if (key === 'chip') return joinNote({ ...cur, chip: !cur.chip });
  if (key === 'back') return joinNote({ ...cur, tail: cur.tail.slice(0, -1) });
  if (key === 'clear') return '';
  if (!/^(\d|단|-)$/.test(key) || cur.tail.length >= NOTE_TAIL_MAX) return joinNote(cur);
  return joinNote({ ...cur, tail: cur.tail + key });
}
const itemHasTag = (item) => !!liveNote(item.anchor) || item.rows.some((r) => String(r.pin.text || '').trim());

const drawingState = {
  site: '',
  files: [],
  folders: [],            // 현장 폴더 안 하위 폴더(원본별 묶음): [{ name, files }]
  view: 'original',       // 목록 구분: original(원본) · saved(저장본) · typed(계측기별)
  groupOpen: new Map(),   // '구분:원본이름' → 펼침 여부(사용자가 누른 것만. 없으면 묶음이 하나일 때만 펼침)
  listing: false,         // 서버에서 최신 목록을 받는 중(지난번 목록을 먼저 보여 준 상태)
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

// 고친 횟수: 저장은 시작할 때의 번호를 기억했다가, 저장하는 동안 또 고친 게 없을 때만 dirty 를 내린다(저장 중에 적은 값이 '저장됨'으로 처리돼 사라지지 않게)
let notesVersion = 0;
function markDirty() {
  drawingState.dirty = true;
  notesVersion += 1;
}

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.35;            // ＋/－ 한 번에 바뀌는 배율
const TAP_SLOP_PX = 14;            // 이만큼까지 손가락이 흔들려도 '찍기'로 본다
const GHOST_CLICK_MS = 700;        // 손가락을 뗀 뒤 브라우저가 만드는 click이 올 수 있는 시간
const MAX_CANVAS_PX = 12000000;    // 도면 캔버스 최대 화소 수. 그리는 동안 숨은 캔버스가 하나 더 있으므로 폰 메모리 한도의 절반 아래로

const SAVED_DIR = '저장본';   // '다른이름 저장'본이 들어가는 폴더: 도면/<현장>/<원본이름>/저장본/. 계측기별 PDF 는 도면/<현장>/<원본이름>/<종류>/
const PDF_CACHE_DB = 'gyecheuk_pdf_cache';
const PDF_CACHE_STORE = 'pdfs';
const PAGE_CACHE_STORE = 'pages';   // 그려 둔 쪽 그림(JPEG): 다시 열 때 pdf.js 가 그리기 전에 먼저 보여 준다
const NOTES_CACHE_STORE = 'notes';  // 서버 야장 사본 + 버전(ETag): 다음 조회 때 '바뀌지 않음'이면 내용 없이 답을 받는다
let pdfCacheDbPromise = null;

function openPdfCacheDb() {
  pdfCacheDbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_CACHE_DB, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [PDF_CACHE_STORE, PAGE_CACHE_STORE, NOTES_CACHE_STORE]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); pdfCacheDbPromise = null; };   // 새 판 탭이 올리려 하면 비켜 준다
      resolve(db);
    };
    // 옛 판 탭이 열려 있어 판 올리기가 막히면 기다리지 않는다: 캐시 없이(서버에서 받아) 동작한다
    req.onblocked = () => { pdfCacheDbPromise = null; reject(new Error('indexedDB blocked')); };
    req.onerror = () => { pdfCacheDbPromise = null; reject(req.error); };
  });
  return pdfCacheDbPromise;
}

async function idbGet(storeName, id) {
  try {
    const db = await openPdfCacheDb();
    return await new Promise((resolve) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// 넣기에 성공하면 true. 저장 공간이 모자라면(QuotaExceeded) false — 부르는 쪽이 정리 후 한 번 더 해 볼 수 있다
async function idbPut(storeName, value) {
  try {
    const db = await openPdfCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ ...value, savedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);   // 저장 공간이 모자라면(QuotaExceeded) abort 만 온다. 기다리는 쪽(업로드 버튼·미리 받기)이 멈추지 않게
    });
  } catch {
    return false;   // 캐시는 덤
  }
}

async function idbDelete(storeName, id) {
  try {
    const db = await openPdfCacheDb();
    await new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch { /* 캐시는 덤 */ }
}

// 저장소 항목의 id·크기·저장 시각만 훑는다(커서라 큰 PDF 를 한꺼번에 메모리에 올리지 않는다)
async function idbListMeta(storeName) {
  try {
    const db = await openPdfCacheDb();
    return await new Promise((resolve) => {
      const out = [];
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        const v = cur.value || {};
        out.push({ id: v.id, size: v.size || v.bytes?.byteLength || v.blob?.size || 0, savedAt: v.savedAt || 0 });
        cur.continue();
      };
      req.onerror = () => resolve(out);
    });
  } catch {
    return [];
  }
}

// ---------- 저장 공간 지키기: 영구 보관 요청 + 오래 안 본 도면부터 정리(LRU) ----------
// 폰 저장 공간이 모자라면 브라우저가 이 앱의 저장소를 통째로 지울 수 있다(보내지 못한 보관함 포함). persist() 는 그것을 막아 달라는 요청이다.
// 미리 받은 도면 PDF·쪽 그림은 다시 받을 수 있으므로, 공간이 빠듯하면 그것부터 오래 안 본 순으로 지운다(보관함·야장 사본은 건드리지 않는다)
const CACHE_BUDGET_BYTES = 300 * 1024 * 1024;   // 도면 PDF + 쪽 그림 합계 상한
const CACHE_MIN_BUDGET_BYTES = 40 * 1024 * 1024;
const QUOTA_SHARE = 0.5;                         // 브라우저가 허락한 공간(quota)의 절반까지만 도면 캐시로
const QUOTA_HIGH_RATIO = 0.8;                    // 전체 사용량이 이만큼을 넘으면 캐시를 절반으로 줄인다
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const CACHE_USED_KEY = 'pdf_cache_used';         // 마지막으로 연 시각(id → ms). 큰 PDF 를 다시 쓰지 않으려고 따로 둔다
const CACHE_PRUNED_KEY = 'pdf_cache_pruned';
const CACHE_USED_MAX = 400;

let cacheUsed = null;
let cacheUsedTimer = 0;
function cacheUsedMap() {
  if (!cacheUsed) {
    try { cacheUsed = JSON.parse(store.get(CACHE_USED_KEY) || '{}') || {}; } catch { cacheUsed = {}; }
  }
  return cacheUsed;
}
function touchCache(id) {
  if (!id || typeof store === 'undefined') return;
  const m = cacheUsedMap();
  m[id] = Date.now();
  clearTimeout(cacheUsedTimer);
  cacheUsedTimer = setTimeout(() => {
    const keep = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, CACHE_USED_MAX);
    cacheUsed = Object.fromEntries(keep);
    store.set(CACHE_USED_KEY, JSON.stringify(cacheUsed));
  }, 1000);
}

// 순수 함수: 합계가 budget 아래가 될 때까지 지울 id 목록. 마지막 사용(usedAt, 없으면 savedAt)이 오래된 것부터, keep(id) 가 true 인 것은 남긴다
function pickEvictions(entries, budget, keep = () => false) {
  let total = entries.reduce((n, e) => n + (e.size || 0), 0);
  if (total <= budget) return [];
  const order = entries
    .filter((e) => !keep(e.id))
    .sort((a, b) => (a.usedAt || a.savedAt || 0) - (b.usedAt || b.savedAt || 0));
  const out = [];
  for (const e of order) {
    if (total <= budget) break;
    out.push(e.id);
    total -= e.size || 0;
  }
  return out;
}

// 순수 함수: 이번 정리의 상한. quota 를 모르면 기본값, 전체 사용량이 높으면 지금 캐시의 절반
function cacheBudgetOf(estimate, cacheTotal) {
  let budget = CACHE_BUDGET_BYTES;
  if (estimate?.quota > 0) {
    budget = Math.min(budget, Math.max(CACHE_MIN_BUDGET_BYTES, estimate.quota * QUOTA_SHARE));
    if ((estimate.usage || 0) / estimate.quota > QUOTA_HIGH_RATIO) budget = Math.min(budget, Math.floor(cacheTotal / 2));
  }
  return budget;
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

let pruning = null;
function pruneDrawingCache(force = false) {
  if (pruning) return pruning;
  const last = Number(store.get(CACHE_PRUNED_KEY) || 0);
  if (!force && Date.now() - last < PRUNE_EVERY_MS) return Promise.resolve(0);
  pruning = (async () => {
    store.set(CACHE_PRUNED_KEY, String(Date.now()));
    const used = cacheUsedMap();
    const withUse = (storeName) => async () => (await idbListMeta(storeName)).map((e) => ({ ...e, storeName, usedAt: used[String(e.id).split('|')[0]] || 0 }));
    const entries = [...await withUse(PDF_CACHE_STORE)(), ...await withUse(PAGE_CACHE_STORE)()];
    const total = entries.reduce((n, e) => n + e.size, 0);
    let estimate = null;
    try { estimate = await navigator.storage?.estimate?.(); } catch { estimate = null; }
    const budget = force ? Math.min(cacheBudgetOf(estimate, total), Math.floor(total * 0.7)) : cacheBudgetOf(estimate, total);
    // 지금 연 도면과 그 원본, 보관함에서 기다리는 도면은 남긴다
    const openIds = new Set([drawingState.currentFile?.id, drawingState.sourceFile?.id, ...pendingOutboxIds].filter(Boolean).map(String));
    const keep = (id) => openIds.has(String(id).split('|')[0]);
    const victims = new Set(pickEvictions(entries, budget, keep));
    for (const e of entries) if (victims.has(e.id)) await idbDelete(e.storeName, e.id);
    if (victims.size) console.info(`도면 캐시 정리: ${victims.size}개, 약 ${Math.round(entries.filter((e) => victims.has(e.id)).reduce((n, e) => n + e.size, 0) / 1048576)}MB`);
    return victims.size;
  })().catch((err) => { console.warn('도면 캐시 정리 실패', err); return 0; }).finally(() => { pruning = null; });
  return pruning;
}

// 넣다가 공간이 모자라면 오래된 캐시를 비우고 한 번만 더 해 본다
async function idbPutWithRoom(storeName, value) {
  if (await idbPut(storeName, value)) return true;
  await pruneDrawingCache(true);
  return idbPut(storeName, value);
}

const getCachedPdfBytes = async (fileId) => {
  const bytes = (await idbGet(PDF_CACHE_STORE, fileId))?.bytes || null;
  if (bytes) touchCache(fileId);
  return bytes;
};
const putCachedPdfBytes = (fileId, bytes) => { touchCache(fileId); return idbPutWithRoom(PDF_CACHE_STORE, { id: fileId, bytes, size: bytes?.byteLength || 0 }); };
// 쪽 그림은 '그린 문서ID|쪽|보기회전' 으로 둔다(저장본은 원본 그림 위에 메모를 얹으므로 원본 ID). rot 은 실제로 그린 회전(PDF 자체 회전 포함)
// 오래된 것은 pruneDrawingCache 가 도면 PDF 와 함께 정리한다
const getPageSnapshot = (id) => idbGet(PAGE_CACHE_STORE, id);
const putPageSnapshot = (id, blob, rot) => idbPutWithRoom(PAGE_CACHE_STORE, { id, blob, rot, size: blob?.size || 0 });

// ---------- 야장 조회: 버전(ETag) 맞추기 ----------
// 순수 함수: 서버 답(res)과 이 폰의 사본(cached)으로 완전한 답을 만든다. unchanged 인데 사본이 맞지 않으면 null(전체를 다시 받아야 함)
function resolveNotesResponse(res, cached) {
  if (!res?.unchanged) return res;
  if (!cached?.data || !res.version || cached.version !== res.version) return null;
  return { ok: true, updated: res.updated ?? cached.updated, user: res.user ?? cached.user ?? '', data: cached.data, version: res.version };
}

// drawing_notes_get 대신 쓴다: 가진 버전을 보내 바뀌지 않았으면 내용 없이 받고, 바뀌었으면 새 내용과 버전을 저장해 둔다.
// 옛 서버는 ifVersion 을 모르고 늘 전체(version 없음)를 주므로 그대로 동작한다
async function fetchDrawingNotes(fileId, callApi = api) {
  const id = String(fileId);
  const cached = await idbGet(NOTES_CACHE_STORE, id);
  const ifVersion = cached?.version && cached.data ? cached.version : '';
  const res = await callApi('drawing_notes_get', ifVersion ? { fileId: id, ifVersion } : { fileId: id });
  let full = resolveNotesResponse(res, cached);
  if (!full) full = await callApi('drawing_notes_get', { fileId: id });
  if (full?.version && full.data && !full.unchanged) {
    if (!cached || cached.version !== full.version) idbPut(NOTES_CACHE_STORE, { id, version: full.version, updated: full.updated, user: full.user, data: full.data });
  } else if (full && !full.version && cached) {
    idbDelete(NOTES_CACHE_STORE, id);   // 줄이 없어졌거나 옛 서버: 맞지 않을 수 있는 사본은 버린다
  }
  return full;
}

function b64ToUint8(base64) {
  if (typeof rustB64ToBytes === 'function') {
    try { return rustB64ToBytes(base64); } catch { /* fallback below */ }
  }
  if (typeof Uint8Array.fromBase64 === 'function') {
    try { return Uint8Array.fromBase64(base64); } catch { /* fallback below */ }
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 받아 둔 PDF는 공간이 빠듯할 때 pruneDrawingCache 가 오래 안 본 것부터 지운다(다시 열면 서버에서 받는다)
// 같은 파일을 두 번 받지 않는다: 미리 받는 중이면 그 약속을 돌려주어 열 때 기다릴 수 있다
const prefetchInFlight = new Map();
const downloadPdf = (fileId) => api('drive_download', { fileId }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

async function downloadPdfBytes(fileId) {
  if (typeof postWorkerBinary === 'function') {
    try {
      const w = await postWorkerBinary('/pdf', { fileId });
      if (w?.binary && w.bytes?.byteLength > 4) {
        const okPdf = typeof rustLooksLikePdf === 'function' ? rustLooksLikePdf(w.bytes) : (w.bytes[0] === 0x25 && w.bytes[1] === 0x50);
        if (okPdf) return w.bytes;
      } else if (w && !w.binary && typeof w.data?.base64 === 'string' && w.data.base64) {
        return b64ToUint8(w.data.base64);
      }
    } catch { /* GAS 폴백 */ }
  }
  const dl = await downloadPdf(fileId);
  if (typeof dl?.base64 !== 'string' || !dl.base64) throw new Error('서버에서 도면 내용을 받지 못했습니다.');
  return b64ToUint8(dl.base64);
}

// 사용자가 직접 연 도면을 받는 동안에는 대기 중인 미리 받기를 시작하지 않는다(이미 받는 중인 것은 끝까지 받는다).
// userLoads 가 0 이 되면 userIdle 이 풀려 미리 받기가 이어진다
let userLoads = 0;
let userIdle = Promise.resolve();
let releaseUserIdle = () => {};
function beginUserLoad() {
  if (userLoads === 0) userIdle = new Promise((resolve) => { releaseUserIdle = resolve; });
  userLoads += 1;
}
function endUserLoad() {
  userLoads = Math.max(0, userLoads - 1);
  if (userLoads === 0) releaseUserIdle();
}

// 순수 함수: 미리 받을 수. 데이터 절약 모드(saveData)이고 Wi-Fi 가 아니면 예전 수(8), 아니면 넉넉히(24). 연결 정보가 없는 브라우저는 넉넉히
const prefetchLimit = (conn) => (conn?.saveData && conn.type !== 'wifi' ? PREFETCH_COUNT : PREFETCH_MAX);

function prefetchPdfToCache(fileId) {
  if (!fileId || navigator.onLine === false) return Promise.resolve();
  if (!prefetchInFlight.has(fileId)) {
    prefetchInFlight.set(fileId, (async () => {
      try {
        if (await getCachedPdfBytes(fileId)) return;
        const bytes = await downloadPdfBytes(fileId);
        if (bytes?.byteLength) await putCachedPdfBytes(fileId, bytes);
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
  if (drawingState.renderFailed) return;
  $('pdfPageInfo').textContent = `${drawingState.pageNum} / ${drawingState.pageCount}쪽 · 마커 ${currentPagePins().length}개`;
}

// ---------- 1단계: 현장명 목록 화면 ----------

// 홈 '최근 입력'의 도면 메모를 누르면: 도면 탭 → 그 현장 → 그 도면(목록에 없으면, 예: 같은 이름으로 다시 저장돼 바뀐 경우, 현장 도면 목록까지)
async function openRecentDrawing(r) {
  if (location.hash !== '#drawing') {
    const moved = new Promise((resolve) => window.addEventListener('hashchange', resolve, { once: true }));
    location.hash = '#drawing';
    await moved;   // route()가 도면 탭을 먼저 그린 뒤에 연다
  }
  if (!r.site) return;
  await openSiteDrawingFolder(r.site);
  // 계측용(가상) 도면에서 적은 값이면 그 묶음의 계측용 도면을 다시 연다(그 뒤 저장본이 생겼으면 최근 것 기준으로)
  if (String(r.fileId || '').startsWith(TEMPLATE_PREFIX)) {
    const prefix = templateId(r.site, '');
    const family = String(r.fileId).startsWith(prefix) ? String(r.fileId).slice(prefix.length) : '';
    const group = buildDrawingGroups().groups.find((g) => g.name === family);
    if (group?.saved.length && group.originals.length) openTemplateDrawing(group);
    else alert('이 메모의 계측용 도면을 지금 목록에서 찾지 못했습니다. 신호가 잡히면 현장을 다시 열어 주세요.');
    return;
  }
  const file = allDrawingFiles().find((f) => f.id === r.fileId);
  if (file) openPdfFieldbook(file);
}

// 연 기록이 없는 현장은 폰에 보관된 도면 목록의 최근 파일 날짜로(v81 이전에 열어 본 현장도 바로 최근 순에 반영). 탭 들어올 때만 다시 읽는다
let drawingSiteHint;

function loadDrawingTab() {
  drawingSiteHint = SiteSort.cached((s) => SiteSort.newest(readCached(`drawings_${s}`), readCached(`drawing_folders_${s}`)));
  if (!warmPdfWorker()) ensurePdfJs().catch(() => {}); // 도면 탭 진입 즉시 백그라운드 워커 예열(워커 불가 시 메인 스레드 폴백)
  pruneDrawingCache().catch(() => {});
  show($('drawingSitesView'), true);
  show($('drawingFilesView'), false);
  renderDrawingSites();
  SiteSort.warm(drawingSiteHint, state.config.sites);
}

function renderDrawingSites() {
  const ul = $('drawingSiteList');
  if (!$('drawingSiteSort')) ul.before(Object.assign(SiteSort.control('drawing', renderDrawingSites), { id: 'drawingSiteSort' }));
  const sites = SiteSort.sorted('drawing', state.config.sites || [], drawingSiteHint);
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

// ---------- 2단계: 현장 터치 시 도면 목록 — 원본 / 저장본 / 계측기별 세 묶음 ----------
// Drive 에는 도면/<현장>/ 바로 아래 원본 PDF, <원본이름>/저장본/ 에 '다른이름 저장'본, <원본이름>/<종류>/ 에 계측기별 PDF 가 쌓인다.
// 목록은 폴더 위치가 아니라 파일 이름으로 가른다: 옛 판이 현장 폴더 바로 아래·외부계측기 폴더에 둔 파일도 같은 규칙으로 제자리에 보이고, 서버(Code.gs)는 바꾸지 않아도 된다.

const VIEW_NAMES = { original: '원본', saved: '저장본', typed: '계측기별' };
const SAVED_STEM_RE = /^(.*)_(\d{4})-?(\d{2})-?(\d{2})\(([일월화수목금토])\)$/;   // 원본이름[_종류]_날짜(요)
const TYPE_NAMES = PIN_TYPES.map((t) => t.name);

// 파일 하나를 { kind: 'original'|'saved'|'typed', family: 원본 이름, date: 'YYYY-MM-DD', day: '수', type: '수위' } 로.
// 묶음(family)은 파일 이름의 원본 부분으로 정한다(앱이 만든 이름 규칙). 들어 있는 폴더 이름은 표시에만 쓴다(사람이 다른 폴더에 옮겨 두어도 제 원본 묶음에 보이게)
function classifyDrawing(file) {
  const stem = stemOf(file.name);
  const m = SAVED_STEM_RE.exec(stem);
  if (!m) return { kind: 'original', family: driveFolderName(stem), date: '', day: '', type: '' };
  let base = m[1];
  const type = TYPE_NAMES.find((n) => base.endsWith(`_${n}`)) || '';
  if (type) base = base.slice(0, -(type.length + 1));
  return { kind: type ? 'typed' : 'saved', family: driveFolderName(base || stem), date: `${m[2]}-${m[3]}-${m[4]}`, day: m[5], type };
}

const newerFirst = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : ((a.file.updated || '') < (b.file.updated || '') ? 1 : -1));

// 현장 도면 전체를 원본 이름(family)별 묶음으로. 순수 함수(화면 시험용): groups 는 이름순, originals 는 현장 폴더 바로 아래 것부터
// 현장 폴더 바로 아래에 날짜 달린 파일만 있고 같은 이름의 원본이 없으면(원본을 날짜 이름으로 올린 경우) 가장 오래된 것을 원본으로 본다
function groupDrawings(files, folders) {
  const items = [
    ...(files || []).map((file) => ({ file, dir: '', ...classifyDrawing(file) })),
    ...(folders || []).flatMap((fo) => (fo.files || []).map((file) => ({ file, dir: fo.name, ...classifyDrawing(file) }))),
  ];
  // 원본 이름이 '_수위' 처럼 종류로 끝나면(배치도_수위.pdf) 그 저장본(배치도_수위_날짜)이 계측기별로 잘못 보일 수 있다 → 그 이름의 원본이 있으면 저장본으로 본다
  const originalStems = new Set(items.filter((it) => it.kind === 'original').map((it) => it.family));
  for (const it of items) {
    if (it.kind === 'typed' && originalStems.has(`${it.family}_${it.type}`)) Object.assign(it, { kind: 'saved', family: `${it.family}_${it.type}`, type: '' });
  }
  const groups = new Map();
  const groupOf = (name) => {
    if (!groups.has(name)) groups.set(name, { name, originals: [], saved: [], typed: [] });
    return groups.get(name);
  };
  for (const it of items) groupOf(it.family)[it.kind === 'original' ? 'originals' : it.kind].push(it);
  for (const g of groups.values()) {
    if (!g.originals.length) {
      const rootSaved = g.saved.filter((it) => !it.dir).sort(newerFirst);
      const oldest = rootSaved[rootSaved.length - 1];
      if (oldest) {
        g.saved = g.saved.filter((it) => it !== oldest);
        g.originals.push({ ...oldest, kind: 'original' });
      }
    }
    g.originals.sort((a, b) => (!!a.dir - !!b.dir) || ((a.file.updated || '') < (b.file.updated || '') ? 1 : -1));
    g.saved.sort(newerFirst);
    g.typed.sort((a, b) => newerFirst(a, b) || TYPE_NAMES.indexOf(a.type) - TYPE_NAMES.indexOf(b.type));
  }
  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { groups: list, originals: list.flatMap((g) => g.originals).sort((a, b) => (!!a.dir - !!b.dir)) };
}

const buildDrawingGroups = () => groupDrawings(drawingState.files, drawingState.folders);

// 순수 함수: 도면 검색. 묶음(원본) 이름이 맞으면 그 묶음 전부, 아니면 파일 이름·폴더·종류·날짜가 맞는 파일만 남긴다. 빈 검색어면 그대로.
// search.js(searchMatch)가 없으면(옛 앱 사본) 거르지 않는다
function filterDrawingGroups(groups, query) {
  if (typeof searchMatch !== 'function' || !searchTokens(query).length) return groups;
  const tokens = searchTokens(query);
  const hit = (it) => searchMatch(`${it.file.name} ${it.dir || ''} ${it.type || ''} ${it.date || ''}`, tokens);
  return groups.flatMap((g) => {
    if (searchMatch(g.name, tokens)) return [g];
    const out = { ...g, originals: g.originals.filter(hit), saved: g.saved.filter(hit), typed: g.typed.filter(hit) };
    return out.originals.length || out.saved.length || out.typed.length ? [out] : [];
  });
}

// 서버 응답과 폰 보관분(깨졌을 수 있음)을 같은 모양으로: 파일은 id·name 이 있는 것만, 폴더는 name 과 파일 배열이 있는 것만
const fileListOf = (v) => (Array.isArray(v) ? v.filter((f) => f && typeof f === 'object' && f.id && typeof f.name === 'string') : []);
const folderListOf = (v) => (Array.isArray(v) ? v.filter((fo) => fo && typeof fo.name === 'string').map((fo) => ({ name: fo.name, files: fileListOf(fo.files) })) : []);

// Drive 폴더 이름 규칙(서버 cleanPart 와 같게): 이름에 못 쓰는 글자와 '/'(폴더 구분자라 단계가 늘어남)를 _ 로. 원본 '배치도(1/600).pdf' 도 한 묶음으로
const driveFolderName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100);

let folderSeq = 0;   // 현장을 연달아 바꿀 때 늦게 온 옛 목록이 새 목록을 덮지 않게 한다

// 지난번 목록(폰 보관분)이 있으면 서버를 기다리지 않고 바로 보여 주고, 최신 목록은 뒤에서 받아 달라진 것만 바꿔 넣는다(서버 응답 1.5~3초를 매번 기다리지 않게)
async function openSiteDrawingFolder(site) {
  const seq = ++folderSeq;
  SiteSort.touch('drawing', site);
  drawingState.site = site;
  drawingState.view = 'original';
  drawingState.groupOpen = new Map();
  drawingState.query = '';   // 다른 현장의 검색어가 남아 빈 목록으로 보이지 않게
  $('drawingFileSearch').value = '';
  $('drawingSiteTitle').textContent = `${site} 도면`;
  show($('drawingSitesView'), false);
  show($('drawingFilesView'), true);
  window.contactsOpenSite?.(site);   // 폴더 위 현장 담당자 명함(contacts.js)

  const cachedFiles = readCached(`drawings_${site}`);
  drawingState.files = fileListOf(cachedFiles);
  drawingState.folders = cachedFiles ? folderListOf(readCached(`drawing_folders_${site}`)) : [];
  drawingState.listing = true;
  syncPendingOutboxDrawings();
  renderDrawingFiles();
  const showBusy = !cachedFiles || drawingState.files.length === 0;
  if (showBusy && typeof busyShow === 'function') busyShow('도면 목록을 불러오는 중...');
  if (!cachedFiles) $('drawingFolderNote').textContent = '도면 폴더를 불러오는 중...';
  else prefetchOriginals(seq);   // 서버 목록(1.5~3초)을 기다리지 않고 폰 보관 목록으로 미리 받기 시작

  try {
    const res = await api('drawing_list', { site });
    if (seq !== folderSeq) return;
    const files = fileListOf(res.files);
    const folders = folderListOf(res.folders);
    const changed = JSON.stringify(files) !== JSON.stringify(drawingState.files) || JSON.stringify(folders) !== JSON.stringify(drawingState.folders);
    drawingState.files = files;
    drawingState.folders = folders;
    drawingState.listing = false;
    store.set(`drawings_${site}`, JSON.stringify(files));
    store.set(`drawing_folders_${site}`, JSON.stringify(folders));
    if (changed || !cachedFiles) renderDrawingFiles();
    else renderDrawingNote();
    prefetchOriginals(seq);
  } catch (err) {
    if (seq !== folderSeq) return;
    drawingState.listing = false;
    if (err.isAuth) { signOut(); return; }
    $('drawingFolderNote').textContent = cachedFiles
      ? '신호가 약해 이전에 불러온 도면 목록을 표시합니다.'
      : `도면 목록을 불러오지 못했습니다: ${errorText(err)} 신호가 잡히면 현장을 다시 눌러 주세요.`;
  } finally {
    if (showBusy && typeof busyHide === 'function') busyHide();
  }
}

// 원본만 미리 받는다: 저장본·계측기별 PDF 는 열 때 원본 그림 위에 메모를 다시 그리므로, 원본만 폰에 있으면 어느 것이든 바로 열린다.
// 폰 보관 목록이 뜨자마자 한 번, 서버 목록이 오면 다시 부른다: 줄(queue)을 새 목록으로 바꾸기만 하고, 받는 일꾼은 PREFETCH_PARALLEL 개까지만 둔다
// (두 번 불러도 4개가 동시에 받지 않게). 같은 파일은 prefetchInFlight·폰 보관분 확인으로 두 번 받지 않는다
let prefetchQueue = [];
let prefetchSeq = 0;
let prefetchWorkers = 0;
function prefetchOriginals(seq) {
  prefetchQueue = buildDrawingGroups().originals.map((it) => it.file.id).slice(0, prefetchLimit(navigator.connection));
  prefetchSeq = seq;
  // 일꾼은 줄 길이만큼만 더 세운다. 줄이 빈 일꾼은 await 없이 바로 끝나 수를 되돌리므로 'while (일꾼 < 2)' 로 세우면 끝나지 않는다
  const start = Math.min(PREFETCH_PARALLEL - prefetchWorkers, prefetchQueue.length);
  for (let i = 0; i < start; i += 1) {
    prefetchWorkers += 1;
    runPrefetchWorker();
  }
}
async function runPrefetchWorker() {
  if (navigator.onLine === false) { prefetchWorkers -= 1; return; }
  await new Promise((r) => setTimeout(r, PREFETCH_DELAY_MS));
  // 줄이 비었는지 보는 것과 일꾼 수를 줄이는 것 사이에 await 가 없다: 그사이 새 목록이 들어와도 일꾼 없이 남지 않는다
  while (prefetchQueue.length && prefetchSeq === folderSeq) {
    if (userLoads) { await userIdle; continue; }   // 사용자가 연 도면을 먼저 받는다
    await prefetchPdfToCache(prefetchQueue.shift());
  }
  prefetchWorkers -= 1;
}

function setDrawingView(view) {
  if (!VIEW_NAMES[view]) return;
  drawingState.view = view;
  renderDrawingFiles();
}

// 한 줄: title 은 글자 또는 요소. data 는 시험·찾기용 data-* 속성. onHold 가 있으면 길게 누르기(안드로이드 contextmenu·마우스 오른쪽·F2)로 부른다
function drawingRow({ title, sub, badge = '›', onOpen, onHold = null, cls = '', data = {} }) {
  const li = document.createElement('li');
  li.className = `tap drawing ${cls}`.trim();
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  for (const [k, v] of Object.entries(data)) li.dataset[k] = v;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const b = document.createElement('b');
  if (typeof title === 'string') b.textContent = title; else b.append(title);
  const small = document.createElement('small');
  small.textContent = sub;
  meta.append(b, small);
  const val = document.createElement('div');
  val.className = 'val chev';
  val.textContent = badge;
  li.append(meta, val);
  bindTapHold(li, onOpen, onHold);
  return li;
}

const HOLD_MS = 500;   // 이만큼 누르고 있으면 '길게 누름'. 손가락이 TAP_SLOP_PX 넘게 움직이면(스크롤) 아니다

// 짧게 누르면 onOpen, 길게 누르면 onHold. 길게 누른 뒤 손을 떼면 브라우저가 click 을 하나 만드는데 그건 먹는다(도면이 열리지 않게).
// 안드로이드는 길게 누르면 contextmenu 를 내므로 그것도 길게 누름으로 받고 기본 메뉴(글자 선택)는 막는다
function bindTapHold(li, onOpen, onHold) {
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpen(); else if (e.key === 'F2' && onHold) onHold(); });
  if (!onHold) { li.addEventListener('click', onOpen); return; }
  let timer = 0;
  let held = false;
  let x0 = 0;
  let y0 = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const fire = () => { cancel(); held = true; navigator.vibrate?.(15); onHold(); };
  li.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    held = false;
    x0 = e.clientX;
    y0 = e.clientY;
    cancel();
    timer = setTimeout(fire, HOLD_MS);
  });
  li.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > TAP_SLOP_PX) cancel(); });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) li.addEventListener(type, cancel);
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!held) fire(); });
  li.addEventListener('click', () => { if (held) { held = false; return; } onOpen(); });
}

const dateTitle = (it) => `${Number(it.date.slice(5, 7))}월 ${Number(it.date.slice(8, 10))}일 (${it.day})`;

let pendingOutboxIds = new Set();
async function syncPendingOutboxDrawings() {
  if (typeof outboxAll !== 'function') return;
  try {
    const items = await outboxAll();
    const next = new Set(items.filter((x) => x.kind === 'drawing_notes' && x.payload?.fileId).map((x) => String(x.payload.fileId)));
    const changed = next.size !== pendingOutboxIds.size || [...next].some((id) => !pendingOutboxIds.has(id));
    pendingOutboxIds = next;
    if (changed && !$('drawingFilesView').classList.contains('hidden')) renderDrawingFiles();
  } catch { /* ignore */ }
}

// 원본 줄: 파일 이름 + 딸린 저장본·계측기별 개수. 저장본·계측기별 줄: 긴 파일 이름 대신 날짜(계측기별은 종류 배지)
function drawingFileRow(it, group, inFolder = false) {
  const f = it.file;
  const open = () => openPdfFieldbook(f);
  const data = { fileId: f.id, name: f.name };
  const cls = [inFolder ? 'in-folder' : '', it.kind === 'original' ? 'is-original' : ''].filter(Boolean).join(' ');
  if (it.kind === 'original') {
    const extra = [group.saved.length ? `저장본 ${group.saved.length}` : '', group.typed.length ? `계측기별 ${group.typed.length}` : ''].filter(Boolean).join(' · ');
    const sub = [f.updated || '', fmtSize(f.size || 0), it.dir ? `📁 ${it.dir}` : '', extra].filter(Boolean).join(' · ');
    let title = `📄 ${f.name}`;
    if (pendingOutboxIds.has(String(f.id))) {
      const frag = document.createDocumentFragment();
      const wait = document.createElement('span');
      wait.className = 'kind outbox-wait';
      wait.textContent = '전송대기';
      frag.append(wait, title);
      title = frag;
    }
    return drawingRow({ title, sub, onOpen: open, onHold: renameHoldOf(f), cls, data });
  }
  let title = dateTitle(it);
  if (it.kind === 'typed') {
    const frag = document.createDocumentFragment();
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = it.type;
    frag.append(kind, title);
    title = frag;
  }
  return drawingRow({ title, sub: [f.updated || '', fmtSize(f.size || 0)].filter(Boolean).join(' · '), onOpen: open, cls, data });
}

// 계측용(번호만) 줄: 최근 저장본의 동그라미를 값 없이 원본 위에 띄우는 가상 도면(파일로 만들지 않는다). 저장본이 있는 원본 아래에만 보인다
function templateRow(group) {
  const latest = group.saved[0];
  const title = document.createDocumentFragment();
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = '계측용';
  title.append(kind, group.name);
  const when = latest.date === todayKst() ? '오늘 저장본 있음' : `전회 ${dateTitle(latest)}`;
  return drawingRow({
    title,
    sub: `번호만 있는 동그라미 · 터치해 오늘 값 입력 · ${when}`,
    onOpen: () => openTemplateDrawing(group),
    cls: 'template',
    data: { template: group.name, latestId: latest.file.id },
  });
}

// 저장본·계측기별 구분: 원본 이름 묶음 머리줄(누르면 접기/펼치기) + 펼쳤을 때 그 안의 줄들
function drawingGroupRows(group, view, single) {
  const list = group[view];
  const key = `${view}:${group.name}`;
  const isOpen = drawingState.groupOpen.has(key) ? drawingState.groupOpen.get(key) : single;
  const head = drawingRow({
    title: `${isOpen ? '📂' : '📁'} ${group.name}`,
    sub: `${VIEW_NAMES[view]} ${list.length}개 · ${isOpen ? '접기' : '펼치기'}`,
    badge: isOpen ? '▾' : '▸',
    onOpen: () => { drawingState.groupOpen.set(key, !isOpen); renderDrawingFiles(); },
    onHold: group.originals[0] ? renameHoldOf(group.originals[0].file) : null,   // 묶음 이름을 길게 누르면 그 원본의 이름을 바꾼다
    cls: 'folder',
    data: { group: group.name },
  });
  return isOpen ? [head, ...list.map((it) => drawingFileRow(it, group, true))] : [head];
}

function renderDrawingNote(counts) {
  const n = counts || viewCounts(buildDrawingGroups().groups);
  const view = drawingState.view;
  const text = {
    original: n.original ? `원본 도면 ${n.original}개 · 터치하면 전체화면 야장으로 열립니다.` : '아직 이 현장에 올린 도면이 없습니다. [＋ 도면 추가]로 올려 주세요. (PDF·JPG)',
    saved: n.saved ? `[다른이름 저장]으로 만든 도면 ${n.saved}개 · 원본별로 모았습니다.` : '아직 [다른이름 저장]한 도면이 없습니다.',
    typed: n.typed ? `[계측기별 PDF]로 만든 도면 ${n.typed}개 · 원본별로 모았습니다.` : '아직 [계측기별 PDF]로 만든 도면이 없습니다.',
  }[view];
  $('drawingFolderNote').textContent = drawingState.listing ? `${text} 최신 목록 확인 중...` : text;
}

const viewCounts = (groups) => ({
  original: groups.reduce((s, g) => s + g.originals.length, 0),
  saved: groups.reduce((s, g) => s + g.saved.length, 0),
  typed: groups.reduce((s, g) => s + g.typed.length, 0),
});

function renderDrawingFiles() {
  const all = buildDrawingGroups();
  const query = drawingState.query || '';
  const searching = typeof searchTokens === 'function' && searchTokens(query).length > 0;
  // 검색 중이면 맞는 것만 보이되, 줄을 만들 때는 거르지 않은 묶음을 쓴다(계측용 줄은 최근 저장본, 원본 줄의 '저장본 N' 은 전체 수여야 한다)
  const shownGroups = searching ? filterDrawingGroups(all.groups, query) : all.groups;
  const fullOf = new Map(all.groups.map((g) => [g.name, g]));
  const groups = searching ? shownGroups.map((g) => fullOf.get(g.name)) : all.groups;
  const originals = searching ? shownGroups.flatMap((g) => g.originals).sort((a, b) => (!!a.dir - !!b.dir)) : all.originals;
  const view = drawingState.view;
  const counts = viewCounts(shownGroups);
  for (const btn of $('drawingViewSeg').querySelectorAll('button[data-view]')) {
    btn.textContent = `${VIEW_NAMES[btn.dataset.view]} ${counts[btn.dataset.view]}`;
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  }
  show($('btnUploadDrawing'), view === 'original');
  renderDrawingNote(counts);

  const ul = $('drawingFileList');
  let rows;
  if (view === 'original') {
    // 저장본이 있는 원본 바로 아래에 계측용(번호만) 줄을 하나 붙인다(같은 묶음에 원본이 둘이면 첫 원본 아래에만)
    rows = originals.flatMap((it) => {
      const group = groups.find((g) => g.name === it.family);
      const row = drawingFileRow(it, group);
      return group.saved.length && group.originals[0] === it ? [row, templateRow(group)] : [row];
    });
  } else {
    // 검색 중이면 맞는 파일만 담은 묶음을 펼쳐 보인다(묶음 이름 바꾸기 등은 전체 묶음 기준)
    const withFiles = shownGroups.filter((g) => g[view].length).map((g) => ({ ...fullOf.get(g.name), [view]: g[view] }));
    rows = withFiles.flatMap((g) => drawingGroupRows(g, view, withFiles.length === 1 || searching));
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = searching ? `'${query.trim()}' 검색 결과가 없습니다. (원본·저장본·계측기별 구분을 바꿔 보세요)` : { original: '등록된 원본 도면이 없습니다.', saved: '저장본이 없습니다. 도면을 열고 [다른이름 저장]을 누르면 여기에 날짜별로 쌓입니다.', typed: '계측기별 PDF 가 없습니다. 도면을 열고 [계측기별 PDF]를 누르면 종류별로 여기에 쌓입니다.' }[view];
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...rows);
}

// 저장·업로드 직후 목록에 바로 반영: 같은 ID 는 어디에 있든, 같은 이름은 같은 폴더 안에서만 지우고(서버 replaceSameName 과 같은 범위.
// 오늘 날짜가 붙은 원본과 오늘 저장본은 이름이 같아도 폴더가 달라 둘 다 남는다), folderName 이 있으면 그 묶음에, 없으면 현장 폴더 바로 아래에 넣는다.
// 받는 중이던 서버 목록이 있으면 버린다: 늦게 온 옛 목록이 방금 넣은 파일을 지우지 않게(다음에 현장을 열 때 새로 받는다)
function upsertDrawingFile(file, folderName = '') {
  const same = (f, dir) => f.id === file.id || (f.name === file.name && dir === folderName);
  drawingState.files = drawingState.files.filter((f) => !same(f, ''));
  drawingState.folders = drawingState.folders.map((fo) => ({ ...fo, files: fo.files.filter((f) => !same(f, fo.name)) }));
  if (drawingState.listing) { folderSeq += 1; drawingState.listing = false; }
  if (folderName) {
    const dir = drawingState.folders.find((fo) => fo.name === folderName) || { name: folderName, files: [] };
    drawingState.folders = [...drawingState.folders.filter((fo) => fo.name !== folderName), { ...dir, files: [file, ...dir.files] }]
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } else {
    drawingState.files = [file, ...drawingState.files];
  }
  store.set(`drawings_${drawingState.site}`, JSON.stringify(drawingState.files));
  store.set(`drawing_folders_${drawingState.site}`, JSON.stringify(drawingState.folders));
  renderDrawingFiles();
}

// ---------- 도면 이름 수정(길게 누르기) ----------

// 날짜 꼬리표가 없는 진짜 원본만 이름을 바꿀 수 있다(날짜 이름으로 올린 원본은 저장본과 구분이 안 돼 묶음이 갈라진다)
const renameHoldOf = (file) => (DATE_TAG.test(stemOf(file.name)) ? null : () => renameDrawing(file));

// 도면 이름 수정 창. 취소하면 null, 아니면 확장자 없는 새 이름(앞뒤 공백 제거)
async function askDrawingName(current) {
  const dlg = $('renameDialog');
  if (dlg.open) return null;   // 이미 열려 있으면(연달아 길게 누름) 두 번 열지 않는다
  const input = $('renameInput');
  input.value = current;
  dlg.returnValue = '';   // 바탕을 눌러 닫으면 취소
  dlg.showModal();
  input.select();
  // 길게 누른 손가락을 떼면 그 자리(지금은 창 바탕)에 click 이 하나 오는데, 바탕 click 은 창을 닫으므로(app.js) 연 직후의 것은 먹는다
  const openedAt = Date.now();
  const guard = (e) => { if (e.target === dlg && Date.now() - openedAt < GHOST_CLICK_MS) e.stopImmediatePropagation(); };
  dlg.addEventListener('click', guard, true);
  await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
  dlg.removeEventListener('click', guard, true);
  return dlg.returnValue === 'ok' ? input.value.trim() : null;
}

// 길게 누른 원본 도면의 이름을 바꾼다. 서버(drawing_rename)가 같은 묶음(<원본>/ 폴더·저장본·계측기별 PDF)도 함께 바꿔 돌려주면 목록과 폰 보관분에 바로 반영한다
async function renameDrawing(file) {
  const oldStem = stemOf(file.name);
  const name = await askDrawingName(oldStem);
  if (!name || name === oldStem) return;   // 취소·빈 이름·그대로면 아무것도 안 한다
  $('drawingFolderNote').textContent = `'${name}' 으로 이름을 바꾸는 중...`;
  try {
    const res = await api('drawing_rename', { site: drawingState.site, fileId: file.id, name });
    applyRenamed(res.renamed || [], driveFolderName(oldStem), driveFolderName(stemOf(res.file?.name || name)));
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    const why = err.code === 'duplicate' ? '같은 이름의 도면이나 폴더가 이미 있습니다.'
      : err.fields ? '쓸 수 없는 이름입니다. 날짜 꼬리표(_2026-11-05(수)) 없이 100자 안으로 적어 주세요.'
        : friendlyError(err, '서버 오류');
    alert(`이름 바꾸기 실패: ${why}`);
    renderDrawingFiles();
  }
}

// 바뀐 이름을 목록 상태와 폰 보관분에 넣는다. 묶음 폴더 이름과 계측용(가상) 도면에 적어 둔 값의 키도 새 이름으로 옮긴다
function applyRenamed(renamed, from, to) {
  const names = new Map(renamed.map((r) => [r.id, r.name]));
  const fix = (f) => (names.has(f.id) ? { ...f, name: names.get(f.id) } : f);
  if (drawingState.listing) { folderSeq += 1; drawingState.listing = false; }   // 받는 중이던 옛 목록이 새 이름을 덮지 않게
  drawingState.files = drawingState.files.map(fix);
  drawingState.folders = drawingState.folders.map((fo) => ({ name: fo.name === from ? to : fo.name, files: fo.files.map(fix) }));
  for (const view of Object.keys(VIEW_NAMES)) {   // 사용자가 펼쳐 둔 묶음은 새 이름으로도 펼쳐진 채
    if (!drawingState.groupOpen.has(`${view}:${from}`)) continue;
    drawingState.groupOpen.set(`${view}:${to}`, drawingState.groupOpen.get(`${view}:${from}`));
    drawingState.groupOpen.delete(`${view}:${from}`);
  }
  const keptKey = `pdf_notes_${templateId(drawingState.site, from)}`;
  const kept = store.get(keptKey);
  if (kept) { store.set(`pdf_notes_${templateId(drawingState.site, to)}`, kept); store.remove(keptKey); }
  store.set(`drawings_${drawingState.site}`, JSON.stringify(drawingState.files));
  store.set(`drawing_folders_${drawingState.site}`, JSON.stringify(drawingState.folders));
  renderDrawingFiles();
}

const IMAGE_DRAWING_RE = /\.jpe?g$/i;
const PDF_MAX_PAGE_PT = 14400;   // PDF 한 쪽의 최대 가로·세로

// JPG 도면은 그림 한 장짜리 PDF로 바꿔 올린다. 이후 보기·동그라미·저장·내 위치는 PDF 도면과 똑같이 돈다
async function imageToPdfBase64(file) {
  const PDFLib = await ensurePdfLib();
  const doc = await PDFLib.PDFDocument.create();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const img = await doc.embedJpg(bytes);
  const { width, height } = img.scale(Math.min(1, PDF_MAX_PAGE_PT / Math.max(img.width, img.height)));
  doc.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
  return uint8ToBase64(await doc.save());
}

async function uploadDrawingPdf(file) {
  if (!file) return;
  const isImage = IMAGE_DRAWING_RE.test(file.name);
  if (!isImage && !file.name.toLowerCase().endsWith('.pdf')) { alert('PDF·JPG 파일만 도면으로 올릴 수 있습니다.'); return; }
  if (file.size === 0) { alert('비어 있는 파일입니다. 다른 파일을 골라 주세요.'); return; }
  if (file.size > MAX_DRAWING_BYTES) { alert(`도면 파일은 ${MAX_DRAWING_BYTES / MB}MB 이하만 올릴 수 있습니다. (이 파일 ${fmtSize(file.size)})`); return; }
  const btn = $('btnUploadDrawing');
  btn.disabled = true;
  $('drawingFolderNote').textContent = `'${file.name}' 도면을 클라우드 폴더에 올리는 중... (파일이 크면 1분 정도 걸립니다)`;
  try {
    const base64 = isImage ? await imageToPdfBase64(file) : await readFileAsBase64(file);
    const name = isImage ? file.name.replace(IMAGE_DRAWING_RE, '.pdf') : file.name;
    const res = await api('drawing_upload', { site: drawingState.site, file: { name, base64 } });
    if (res.file) {
      await putCachedPdfBytes(res.file.id, b64ToUint8(base64));
      upsertDrawingFile(res.file);
    } else {
      renderDrawingFiles();
    }
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
// tr: 속도 기록(perf.js). 어디서 받았는지(bytes:cache·prefetch·legacy·server)와 바이트 수를 적는다
async function loadPdfBytes(fileId, tr = null) {
  let bytes = await getCachedPdfBytes(fileId);
  if (bytes) { tr?.step('bytes:cache', bytes.length); return bytes; }
  // 사용자가 연 도면: 대기 중인 미리 받기를 멈추게 하고(받는 중인 것은 그대로) 먼저 받는다
  beginUserLoad();
  try {
    if (prefetchInFlight.has(fileId)) {   // 미리 받는 중이면 다시 받지 않고 그것을 기다린다
      await prefetchInFlight.get(fileId);
      bytes = await getCachedPdfBytes(fileId);
      if (bytes) { tr?.step('bytes:prefetch', bytes.length); return bytes; }
    }
    const legacyB64 = store.get(`pdf_b64_${fileId}`);
    if (legacyB64) { bytes = b64ToUint8(legacyB64); tr?.step('bytes:legacy', bytes.length); return bytes; }
    bytes = await downloadPdfBytes(fileId);
    tr?.step('bytes:server', bytes.length);
    putCachedPdfBytes(fileId, bytes);
    return bytes;
  } finally {
    endUserLoad();
  }
}

// 현장 폴더 바로 아래 도면 + 원본별 폴더 안의 도면(원본이 폴더 안에 있어도 저장본의 바탕으로 찾을 수 있게)
const allDrawingFiles = () => [...drawingState.files, ...(drawingState.folders || []).flatMap((f) => f.files || [])];

let openSeq = 0;              // 도면을 연달아 두 번 누르면 먼저 것은 버린다
let viewerReturnFocus = null; // 뷰어를 닫으면 열기 전에 있던 자리(도면 줄)로 포커스를 돌려준다
let closingViewer = false;

// 계측용(번호만) 도면: 최근 저장본의 동그라미만(지난 값은 history 로) 원본 위에 띄운다. Drive 파일이 아니라 열 때 만드는 가상 파일이고,
// id 는 'tpl:<현장>|<원본이름>' 로 묶음마다 하나다(그 뒤 다른 폰이 새 저장본을 만들어도 이 폰에 적어 둔 값을 같은 키로 찾는다).
// 값을 적고 닫으면 다른이름 저장과 같은 흐름으로 '<원본이름>_오늘날짜(요).pdf' 가 <원본이름>/저장본 에 저장된다(name 이 원본 이름이라 같은 묶음에 들어간다).
// 메모는 폰 보관분 → 서버 순으로 받아 templateNotes() 로 만든다. 고치다가 저장 못 한 값이 폰에 남아 있으면(앱이 꺼졌던 경우) 그것을 이어서 쓴다
const TEMPLATE_PREFIX = 'tpl:';
const templateId = (site, family) => `${TEMPLATE_PREFIX}${site}|${family}`;
async function openTemplateDrawing(group) {
  const latest = group.saved[0]?.file;
  const original = group.originals[0]?.file;
  if (!latest || !original) return;
  if (typeof templateNotes !== 'function') { alert('도면 기능 파일이 덜 받아졌습니다. 정보 탭에서 새로고침해 주세요.'); return; }
  const today = todayKst();
  // 제목 칸이 좁아 앞 글자만 보이므로 '계측용' 을 앞에 둔다
  const file = { id: templateId(drawingState.site, group.name), name: `${group.name}.pdf`, label: `계측용 · ${group.name}`, templateOf: latest.id, mime: 'application/pdf' };
  const latestNotes = normalizeNotes(readCached(`pdf_notes_${latest.id}`));
  const source = sourceFileOf(latest, latestNotes, allDrawingFiles()) || original;
  const fresh = templateNotes(latestNotes, today);
  // 폰에 적어 둔 값(고친 게 있을 때만 남는다)이 있으면 이어서 쓴다: 지난 날짜 값은 history 로 넘기고(오늘 값처럼 보이지 않게), 그사이 생긴 최근 저장본의 동그라미와 합친다
  const kept = templateNotes(normalizeNotes(readCached(`pdf_notes_${file.id}`)), today);
  const resuming = kept.pins.length > 0;
  const build = (base) => (resuming ? mergeResumeNotes(kept, base, today) : base);   // 최근 저장본 템플릿이 바탕, 그 위에 내 미저장분
  const notes = build(fresh);
  // 서버 메모는 줄이 있을 때만(updated) 받아들인다: 메모 없이 올린 저장본이면 서버가 빈 메모를 돌려주는데, 그것으로 폰에 있던 동그라미를 지우지 않게.
  // 이어쓰는 중에도 받는다(그사이 다른 사람이 저장한 지난 값·새 동그라미가 들어오게). 열고 나서 고친 게 있으면 applyServerNotes 가 덮지 않는다
  const notesPromise = fetchDrawingNotes(latest.id)
    .then((res) => (res?.updated && res.data ? { updated: res.updated, data: build(templateNotes(normalizeNotes(res.data), today)) } : null))
    .catch((err) => { console.warn('최근 저장본 메모 조회 실패', err); return null; });
  await openPdfFieldbook(file, { source, notes, notesPromise });
  // 동그라미를 하나도 못 불러왔으면(다른 폰이 저장한 저장본인데 서버 메모를 못 받음) 닫는다: 빈 도면에 새로 찍어 저장하면 그것이 최근 저장본이 되어 옛 동그라미 사슬이 끊긴다
  if (drawingState.currentFile === file && !drawingState.notes.pins.length) {
    alert('동그라미를 불러오지 못했습니다. 신호가 잡히면 다시 열어 주세요.');
    closePdfViewer();
  }
}

// preset: 계측용 도면처럼 바탕 원본(source)·메모(notes)·늦게 올 메모(notesPromise)를 미리 정해 열 때. 폰 보관분·서버 메모 조회·이름으로 원본 찾기를 건너뛴다
async function openPdfFieldbook(file, preset = null) {
  const seq = ++openSeq;
  drawingState.openTrace?.end('replaced');   // 앞 도면이 다 열리기 전에 다른 도면을 누름
  const tr = window.perfTrace?.('open') || null;
  drawingState.openTrace = tr;
  tr?.step('open:tap');
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
  drawingState.notes = preset ? preset.notes : normalizeNotes(readCached(`pdf_notes_${file.id}`));
  drawingState.sourceFile = preset ? preset.source : sourceFileOf(file, drawingState.notes, allDrawingFiles());
  // 다른 폰(또는 PC)에서 저장한 저장본은 이 폰에 메모가 없어 원본 표시(sourceId)를 모른다 → 이름으로도 원본을 못 찾을 때만 서버 메모를 받아 본 뒤 원본을 정한다
  // (이름으로 찾았으면 기다리지 않는다: 서버 왕복 1.5~3초를 아낀다. 원본을 같은 이름으로 다시 올려 ID가 바뀐 경우에도 이름으로 찾은 새 원본이 맞다)
  const askServerForSource = !preset && !drawingState.notes.sourceId && !drawingState.sourceFile && DATE_TAG.test(stemOf(file.name));
  setPinMode(false);
  setPenMode(false);
  closePinMemoBox();

  $('pdfTitle').textContent = file.label || file.name;
  $('pdfPageInfo').textContent = '도면 불러오는 중...';
  if ($('pdfViewer').classList.contains('hidden')) {
    viewerReturnFocus = document.activeElement;
    // 안드로이드 뒤로가기(history.back)가 화면을 바꾸는 대신 뷰어를 닫게 한 칸 넣어 둔다
    try { history.pushState({ pdfViewer: true }, ''); } catch (err) { console.warn('history 사용 불가', err); }
    show($('pdfViewer'), true);
    $('pdfClose').focus();
  }

  beginUserLoad();
  // 야장 메모 조회(서버)는 도면 그리기를 막지 않도록 먼저 출발만 시켜 두고, 그리기 끝난 뒤 반영한다
  const notesPromise = preset ? preset.notesPromise : fetchDrawingNotes(file.id).catch((err) => { console.warn('야장 메모 조회 실패', err); return null; });
  // 전에 그려 둔 첫 쪽 그림이 폰에 있으면 pdf.js 가 그리기 전에(0.1초 안에) 먼저 보여 준다. 선명한 그림이 준비되면 그 자리에서 바뀐다
  showPageSnapshot((drawingState.sourceFile || file).id, seq).then((shown) => { if (shown) tr?.step('open:snap'); }).catch(() => {});
  // 다른 폰이 저장한 저장본(원본을 모름): 서버 메모를 기다리는 동안 그 저장본 PDF 도 같이 받기 시작한다.
  // 메모에서 원본을 찾으면 원본으로 그리고(받아 둔 저장본은 폰 보관분으로 남는다), 못 찾으면 받아 둔 저장본을 그대로 연다
  const ownBytes = askServerForSource ? loadPdfBytes(file.id, tr) : null;
  ownBytes?.catch(() => {});   // 원본으로 열면 이 실패는 쓰지 않는다(쓸 때 아래에서 다시 던진다)

  try {
    if (askServerForSource) {
      const serverNotes = await notesPromise;
      if (seq !== openSeq) return;
      tr?.step('notes:got');
      if (serverNotes?.data?.sourceId) drawingState.sourceFile = sourceFileOf(file, normalizeNotes(serverNotes.data), allDrawingFiles()) || drawingState.sourceFile;
    }
    const source = drawingState.sourceFile;
    const sourceBytes = source ? await loadPdfBytes(source.id, tr).catch((err) => { console.warn('원본 도면을 받지 못해 저장본 그대로 엽니다', err); return null; }) : null;
    if (seq !== openSeq) return;   // 그사이 다른 도면을 열었으면 여기서 끝(가상 파일 id 로 서버에 받으러 가지 않게)
    if (source && !sourceBytes) {
      // 계측용 도면은 원본 위에만 그린다(가상 파일이라 대신 받을 PDF 가 없다)
      if (preset) throw new Error('원본 도면을 받지 못해 계측용 도면을 열 수 없습니다. 신호가 잡히면 다시 열어 주세요.');
      drawingState.sourceFile = null;
    }
    const bytes = sourceBytes || await (ownBytes || loadPdfBytes(file.id, tr));
    if (seq !== openSeq) return;
    drawingState.rawPdfBytes = bytes;

    const pdfDoc = await openPdfDocument(bytes);
    if (seq !== openSeq) { pdfDoc.destroy(); return; }
    tr?.step('pdf:doc');
    drawingState.pdfDoc = pdfDoc;
    drawingState.pageCount = pdfDoc.numPages;
    await renderPdfPage();
    applyServerNotes(file, await notesPromise);
    if (seq === openSeq) { tr?.step('notes:applied'); tr?.end(); }
    // 저장 때 쓸 합치기 라이브러리(pdf-lib, 1MB)를 도면을 보는 동안 미리 받아 둔다(저장을 누른 뒤 받으면 그만큼 기다린다)
    if (navigator.onLine !== false) ensurePdfLib().catch(() => {});
  } catch (err) {
    if (seq !== openSeq) return;
    tr?.end(err.network ? 'network' : 'error');
    if (err.isAuth) { drawingState.dirty = false; signOut(); closePdfViewer(); return; }
    alert(`PDF 도면을 열지 못했습니다: ${friendlyError(err, '파일이 손상되었거나 PDF가 아닙니다.')}`);
    closePdfViewer();
  } finally {
    endUserLoad();
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
  renderSeq += 1;
  drawingState.openTrace?.end('closed');
  // 열자마자 닫아도 다음에 먼저 보여 줄 그림이 남게: 다 그린 1쪽이 캔버스에 있으면 지금 저장한다(이미 저장했으면 건너뛴다). 거친 그림(저해상)만 있으면 저장하지 않는다
  if (drawingState.pdfDoc && shownSharp && shownKey === `${drawingState.currentFile?.id}|1|${shownRot}`) savePageSnapshot($('pdfCanvas'), shownRot);
  clearPdfTiles();
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
  // 서버에 줄이 있을 때만(updated): 줄이 없으면 빈 메모가 오는데, 그것으로 폰에만 있는 동그라미(저장이 거부됐던 원본 등)를 지우지 않게
  if (!noteRes?.updated || !noteRes.data || !Array.isArray(noteRes.data.pins)) return;
  const targetId = String((drawingState.sourceFile || file).id);
  const srv = normalizeNotes(noteRes.data);
  if (pendingOutboxIds.has(targetId)) {
    const today = typeof todayKst === 'function' ? todayKst() : '';
    drawingState.notes = mergeNotesForSave(drawingState.notes, srv, today);
  } else {
    drawingState.notes = srv;
  }
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
const DEFAULT_SCALE = 1.25;   // 도면을 열 때 배율. 이 배율로 그린 쪽 그림만 저장해 두고 다음에 열 때 먼저 보여 준다

const snapshotKey = (docId, page, rotation) => `${docId}|${page}|${rotation}`;
const stageWidth = () => Math.max(320, $('pdfStageWrap').clientWidth - 24);

// 저장해 둔 쪽 그림을 캔버스에 먼저 올린다(열 때: 1쪽·보기 회전 0). 선명한 그림이 먼저 끝났으면(shownKey 가 이미 같음) 덮어쓰지 않고,
// 그림을 푸는 사이 쪽을 넘겼거나 다른 도면으로 바뀌었으면 버린다
async function showPageSnapshot(docId, seq) {
  const snap = await getPageSnapshot(snapshotKey(docId, 1, 0));
  const stillFirst = () => seq === openSeq && drawingState.pageNum === 1 && drawingState.rotation === 0;
  if (!snap?.blob || !stillFirst()) return false;
  const key = `${drawingState.currentFile?.id}|1|${snap.rot || 0}`;   // renderPdfPage 와 같은 꼴(PDF 자체 회전 포함)
  if (shownKey === key) return false;
  const bmp = await createImageBitmap(snap.blob);
  try {
    if (!stillFirst() || shownKey === key) return false;
    const cssW = Math.round(stageWidth() * drawingState.scale);
    const cssH = Math.round((cssW * bmp.height) / bmp.width);
    const pdfCanvas = $('pdfCanvas');
    pdfCanvas.width = bmp.width;
    pdfCanvas.height = bmp.height;
    pdfCanvas.getContext('2d').drawImage(bmp, 0, 0);
    $('pdfTileLayer')?.replaceChildren();
    for (const id of ['pdfCanvas', 'inkCanvas', 'pinLayer']) { $(id).style.width = `${cssW}px`; $(id).style.height = `${cssH}px`; }
    $('inkCanvas').width = cssW;
    $('inkCanvas').height = cssH;
    shownKey = key;   // renderPdfPage 가 같은 쪽을 그릴 때 이 그림을 지우지 않고 늘려 두었다가 바꿔 끼운다
    shownSharp = false;
    redrawPageInk();
    renderPagePins();
    $('pdfPageInfo').textContent = '지난번 그림으로 먼저 표시 · 선명하게 그리는 중...';
    return true;
  } finally {
    bmp.close();
  }
}

// 방금 그린 1쪽을 JPEG 로 저장해 둔다(열 때 상태: 기본 배율·보기 회전 0 — 읽는 곳도 그것뿐). 긴 변 SNAPSHOT_MAX_PX 로 줄여 수백 KB 안에 둔다.
// 같은 그림을 방금 저장했으면 건너뛴다(열 때마다 쓰지 않게). toBlob 은 부르는 순간의 그림을 잡으므로 뒤에 캔버스가 바뀌어도 된다
const SNAPSHOT_MAX_PX = 1600;
const SNAPSHOT_REPEAT_MS = 10 * 60 * 1000;
const SNAPSHOT_SAVE_DELAY_MS = 400;
const snapshotSavedAt = new Map();
function savePageSnapshot(canvas, rot) {
  const doc = drawingState.sourceFile || drawingState.currentFile;
  if (!doc || drawingState.scale !== DEFAULT_SCALE || drawingState.pageNum !== 1 || drawingState.rotation !== 0 || canvas.width <= 1) return;
  const id = snapshotKey(doc.id, 1, 0);
  const last = snapshotSavedAt.get(id) || 0;
  if (Date.now() - last < SNAPSHOT_REPEAT_MS) return;
  snapshotSavedAt.set(id, Date.now());
  try {
    const k = Math.min(1, SNAPSHOT_MAX_PX / Math.max(canvas.width, canvas.height));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(canvas.width * k));
    small.height = Math.max(1, Math.round(canvas.height * k));
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    small.toBlob((blob) => { small.width = 0; if (blob) putPageSnapshot(id, blob, rot); }, 'image/jpeg', 0.82);
  } catch (err) {
    console.warn('쪽 그림 저장 실패', err);
  }
}

// 확대·쪽 넘김을 빠르게 연달아 누르면 이전 그리기를 멈추고 마지막 것만 그린다(같은 캔버스에 두 번 그리면 pdf.js가 예외를 던진다)
// 크기는 바로 바꾸고(지금 그림을 늘려 보여 줌 → 확대가 손에 바로 반응), 선명한 그림은 숨은 캔버스에 그린 뒤 한 번에 바꿔 끼운다(그리는 1~2초 동안 하얗게 비지 않게).
// afterLayout: 크기를 바꾼 바로 그 순간에 부르는 함수(확대 기준점 스크롤 맞추기). 같은 순간이라 화면이 튀지 않는다
let shownKey = '';   // 지금 캔버스에 있는 그림이 어느 문서·쪽·회전인지. 다르면 늘려 보이지 않고 비운다(다른 쪽 그림이 잠깐 보이지 않게)
let shownRot = 0;    // 지금 캔버스 그림의 실제 회전(PDF 자체 회전 포함). 닫을 때 그림을 저장하는 데 쓴다
let shownSharp = false;   // 지금 캔버스 그림이 선명한 그림인지(거친 그림·저장해 둔 그림이면 false). 거친 그림은 쪽 그림으로 저장하지 않는다

const PDF_TILE_SIZE = 512;      // 확대 시 화면에 보이는 부분만 나눠 그리는 조각 크기(CSS px)
const PDF_TILE_MARGIN = 128;    // 끌기 직전에 끝이 비어 보이지 않게 화면 바깥을 조금 미리 그린다
const BASE_MAX_PX = 1600000;    // 전체 바탕 캔버스 상한(약 1.6MP). 이보다 크면 바탕만 두고 보이는 타일만 고해상도 렌더링
const TILE_MAX_PX = 1048576;    // 타일 한 조각 최대 화소(1024×1024)
const MAX_TILE_CANVASES = 20;   // 화면에 유지할 최대 타일 수(오래 안 본 타일은 메모리 즉시 반환)

// 순수 함수: 이 크기·해상도에서 타일 분할 그리기를 쓸지(전체 1장을 고해상도로 그리면 폰 메모리가 모자랄 때)
function shouldUseTiles(cssW, cssH, dpr, maxBasePx = BASE_MAX_PX) {
  return cssW * cssH * dpr * dpr > maxBasePx;
}

// 순수 함수: 현재 뷰포트 안에 들어오는 512px 타일 목록(가운데 가까운 것부터 우선, Rust WASM 가속 지원)
function planVisibleTiles({ pageW, pageH, viewLeft, viewTop, viewW, viewH, tileSize = PDF_TILE_SIZE, margin = PDF_TILE_MARGIN }) {
  if (!(pageW > 0 && pageH > 0 && viewW > 0 && viewH > 0)) return [];
  if (typeof rustPlanTiles === 'function') {
    const fast = rustPlanTiles({ pageW, pageH, viewLeft, viewTop, viewW, viewH, tileSize, margin });
    if (fast) return fast;
  }
  const x0 = Math.max(0, Math.floor((viewLeft - margin) / tileSize) * tileSize);
  const y0 = Math.max(0, Math.floor((viewTop - margin) / tileSize) * tileSize);
  const x1 = Math.min(pageW, viewLeft + viewW + margin);
  const y1 = Math.min(pageH, viewTop + viewH + margin);
  const cx = viewLeft + viewW / 2;
  const cy = viewTop + viewH / 2;
  const tiles = [];
  for (let y = y0, row = Math.floor(y0 / tileSize); y < y1; y += tileSize, row += 1) {
    const h = Math.min(tileSize, pageH - y);
    for (let x = x0, col = Math.floor(x0 / tileSize); x < x1; x += tileSize, col += 1) {
      const w = Math.min(tileSize, pageW - x);
      tiles.push({ col, row, x, y, w, h, key: `${col},${row}`, dist: Math.hypot(x + w / 2 - cx, y + h / 2 - cy) });
    }
  }
  tiles.sort((a, b) => a.dist - b.dist);
  return tiles.map(({ dist, ...t }) => t);
}

// ---------- 백그라운드 워커(OffscreenCanvas) + 메인 스레드 폴백 ----------
let pdfWorker = null;
let pdfWorkerDisabled = false;
let pdfDocSeq = 0;
let workerJobSeq = 0;
const workerPending = new Map();

function resetPdfWorker(err = null) {
  if (pdfWorker) {
    try { pdfWorker.terminate(); } catch { /* ignore */ }
    pdfWorker = null;
  }
  for (const [, p] of workerPending) p.reject(err || new Error('pdf worker stopped'));
  workerPending.clear();
}

function getPdfWorker() {
  if (pdfWorkerDisabled || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (!pdfWorker) {
    try {
      const url = new URL(`pdf-worker.js?v=${DRAWING_BUILD}`, document.baseURI).href;
      const w = new Worker(url, { type: 'module' });
      w.onmessage = ({ data }) => {
        const job = workerPending.get(data.jobId);
        if (!job) {
          if (data.bitmap && typeof data.bitmap.close === 'function') data.bitmap.close();
          return;
        }
        workerPending.delete(data.jobId);
        if (data.type === 'cancelled') {
          const e = new Error('cancelled');
          e.name = 'RenderingCancelledException';
          job.reject(e);
        } else if (data.type === 'error') {
          job.reject(new Error(data.message || 'pdf worker error'));
        } else {
          job.resolve(data);
        }
      };
      w.onerror = (ev) => {
        pdfWorkerDisabled = true;
        resetPdfWorker(new Error(ev?.message || 'pdf worker crashed'));
      };
      pdfWorker = w;
    } catch {
      pdfWorkerDisabled = true;
      return null;
    }
  }
  return pdfWorker;
}

function workerCall(type, payload, transfer = []) {
  const w = getPdfWorker();
  if (!w) return Promise.reject(new Error('pdf worker unavailable'));
  const jobId = ++workerJobSeq;
  return new Promise((resolve, reject) => {
    workerPending.set(jobId, { resolve, reject });
    try {
      w.postMessage({ type, jobId, ...payload }, transfer);
    } catch (err) {
      workerPending.delete(jobId);
      reject(err);
    }
  });
}

async function openPdfFallback(bytes) {
  const pdfjsLib = await ensurePdfJs();
  // isEvalSupported:false — pdf.js 3.x 는 PDF 글꼴로 임의 JS를 실행당할 수 있다(CVE-2024-4367). 4.2.67 이상으로 올려도 이 줄은 둔다
  const cMapUrl = new URL('./vendor/cmaps/', document.baseURI).href;
  const standardFontDataUrl = new URL('./vendor/standard_fonts/', document.baseURI).href;
  const raw = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, cMapUrl, cMapPacked: true, standardFontDataUrl }).promise;
  let minMainSeq = 0;
  let destroyed = false;
  return {
    numPages: raw.numPages,
    getPage: (pageNum) => raw.getPage(pageNum),
    async pageDims(pageNum, userRotation) {
      const page = await raw.getPage(pageNum);
      const rotation = (page.rotate + (userRotation || 0)) % 360;
      const vp = page.getViewport({ scale: 1, rotation });
      return { rotate: rotation, width: vp.width, height: vp.height };
    },
    async renderRegion({ seq, pageNum, renderScale, rotation, offsetX = 0, offsetY = 0, pixelW, pixelH }) {
      if (renderTask) {
        renderTask.cancel();
        await renderTask.promise.catch(() => {});
        renderTask = null;
      }
      if (destroyed || seq < minMainSeq) {
        const e = new Error('cancelled');
        e.name = 'RenderingCancelledException';
        throw e;
      }
      const page = await raw.getPage(pageNum);
      const viewport = page.getViewport({ scale: renderScale, rotation, offsetX, offsetY });
      const buf = document.createElement('canvas');
      buf.width = Math.max(1, Math.round(pixelW || viewport.width));
      buf.height = Math.max(1, Math.round(pixelH || viewport.height));
      const task = page.render({ canvasContext: buf.getContext('2d'), viewport, background: 'rgb(255,255,255)' });
      renderTask = task;
      try {
        await task.promise;
      } catch (err) {
        buf.width = 0;
        throw err;
      } finally {
        if (renderTask === task) renderTask = null;
      }
      if (destroyed || seq < minMainSeq) {
        buf.width = 0;
        const e = new Error('cancelled');
        e.name = 'RenderingCancelledException';
        throw e;
      }
      return { bitmap: buf };
    },
    cancelBelow(seq) {
      if (seq > minMainSeq) minMainSeq = seq;
      if (renderTask) {
        renderTask.cancel();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderTask?.cancel();
      raw.destroy().catch(() => {});
    },
  };
}

async function openPdfDocument(bytes) {
  const myDocSeq = ++pdfDocSeq;
  if (getPdfWorker()) {
    try {
      const copy = bytes.slice();
      const res = await workerCall('open', { docSeq: myDocSeq, bytes: copy, baseURI: document.baseURI }, [copy.buffer]);
      let destroyed = false;
      return {
        numPages: res.numPages,
        isWorker: true,
        getPage: async (pageNum) => {
          const dims = await workerCall('pageDims', { docSeq: myDocSeq, pageNum, userRotation: 0 });
          return {
            rotate: dims.rotate,
            getViewport: ({ scale = 1, rotation = 0 } = {}) => {
              const swap = ((rotation % 360) + 360) % 180 !== 0;
              const w = (swap ? dims.height : dims.width) * scale;
              const h = (swap ? dims.width : dims.height) * scale;
              return { width: w, height: h, scale, rotation: (dims.rotate + rotation) % 360 };
            },
          };
        },
        pageDims: (pageNum, userRotation) => workerCall('pageDims', { docSeq: myDocSeq, pageNum, userRotation }),
        renderRegion: (params) => workerCall('render', { docSeq: myDocSeq, ...params }),
        cancelBelow: (minSeq) => { try { getPdfWorker()?.postMessage({ type: 'cancelBelow', docSeq: myDocSeq, minSeq }); } catch { /* ignore */ } },
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          try { pdfWorker?.postMessage({ type: 'close', docSeq: myDocSeq }); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.warn('도면 워커 열기 실패, 기본 렌더러로 전환합니다', err);
        pdfWorkerDisabled = true;
        resetPdfWorker();
      } else {
        throw err;
      }
    }
  }
  return openPdfFallback(bytes);
}

// Worker(ImageBitmap)와 폴백(HTMLCanvasElement) 모두 화면 캔버스에 옮기고 즉시 GPU/메모리를 돌려준다
function swapIntoCanvas(target, img) {
  target.width = img.width;
  target.height = img.height;
  target.getContext('2d').drawImage(img, 0, 0);
  if (typeof img.close === 'function') img.close();
  else img.width = 0;
}

// ---------- 타일 레이어: 확대 시 화면에 보이는 512px 조각만 고해상도로 얹는다 ----------
let tileSession = null;
let tileScrollTimer = 0;
let tilePumping = false;

function clearPdfTiles() {
  tileSession = null;
  clearTimeout(tileScrollTimer);
  tileScrollTimer = 0;
  const layer = $('pdfTileLayer');
  if (layer) {
    for (const c of layer.querySelectorAll('canvas')) c.width = 0;
    layer.replaceChildren();
  }
}

function scheduleVisibleTilesDebounced() {
  if (!tileSession) return;
  clearTimeout(tileScrollTimer);
  tileScrollTimer = setTimeout(() => { scheduleVisibleTiles(); }, 80);
}

function visibleViewportRectInStage() {
  const wrap = $('pdfStageWrap');
  const stage = $('pdfStage');
  if (!wrap || !stage) return null;
  const wr = wrap.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  return {
    viewLeft: Math.max(0, wr.left - sr.left),
    viewTop: Math.max(0, wr.top - sr.top),
    viewW: wr.width,
    viewH: wr.height,
  };
}

function scheduleVisibleTiles() {
  const s = tileSession;
  if (!s || s.seq !== renderSeq || s.doc !== drawingState.pdfDoc) return;
  const vp = visibleViewportRectInStage();
  if (!vp) return;
  const list = planVisibleTiles({ pageW: s.cssW, pageH: s.cssH, ...vp });
  s.wanted = list;
  const keepKeys = new Set(list.map((t) => t.key));
  const now = Date.now();
  for (const t of list) {
    const hit = s.rendered.get(t.key);
    if (hit) hit.lastUsed = now;
  }
  s.keepKeys = keepKeys;
  pumpTileQueue(s);
}

async function pumpTileQueue(s) {
  if (tilePumping || s !== tileSession) return;
  tilePumping = true;
  try {
    while (s === tileSession && s.seq === renderSeq && s.doc === drawingState.pdfDoc) {
      const next = (s.wanted || []).find((t) => !s.rendered.has(t.key) && !s.inFlight.has(t.key));
      if (!next) break;
      s.inFlight.add(next.key);
      const { tileDpr, fitScale, rotation, pageNum, doc, seq } = s;
      const px = Math.round(next.x * tileDpr);
      const py = Math.round(next.y * tileDpr);
      const pw = Math.max(1, Math.round((next.x + next.w) * tileDpr) - px);
      const ph = Math.max(1, Math.round((next.y + next.h) * tileDpr) - py);
      try {
        const res = await doc.renderRegion({
          seq,
          pageNum,
          renderScale: fitScale * tileDpr,
          rotation,
          offsetX: -px,
          offsetY: -py,
          pixelW: pw,
          pixelH: ph,
        });
        if (s !== tileSession || seq !== renderSeq || doc !== drawingState.pdfDoc) {
          if (typeof res?.bitmap?.close === 'function') res.bitmap.close();
          else if (res?.bitmap) res.bitmap.width = 0;
          break;
        }
        const layer = $('pdfTileLayer');
        if (layer && res?.bitmap) {
          const tileCanvas = document.createElement('canvas');
          tileCanvas.className = 'pdf-tile';
          tileCanvas.style.left = `${px / tileDpr}px`;
          tileCanvas.style.top = `${py / tileDpr}px`;
          tileCanvas.style.width = `${pw / tileDpr}px`;
          tileCanvas.style.height = `${ph / tileDpr}px`;
          swapIntoCanvas(tileCanvas, res.bitmap);
          layer.appendChild(tileCanvas);
          s.rendered.set(next.key, { canvas: tileCanvas, lastUsed: Date.now() });
          if (s.rendered.size > MAX_TILE_CANVASES) {
            const evict = [...s.rendered.entries()]
              .filter(([k]) => !s.keepKeys?.has(k))
              .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            while (s.rendered.size > MAX_TILE_CANVASES && evict.length) {
              const [k, item] = evict.shift();
              item.canvas.width = 0;
              item.canvas.remove();
              s.rendered.delete(k);
            }
          }
        }
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.warn('타일 그리기 실패', err);
      } finally {
        s.inFlight.delete(next.key);
      }
    }
  } finally {
    tilePumping = false;
    // 도중에 스크롤해서 새 타일이 추가됐으면 이어서 그린다
    if (tileSession && tileSession.seq === renderSeq && (tileSession.wanted || []).some((t) => !tileSession.rendered.has(t.key) && !tileSession.inFlight.has(t.key))) {
      pumpTileQueue(tileSession);
    }
  }
}

async function renderPdfPage(afterLayout) {
  if (!drawingState.pdfDoc) return;
  const my = ++renderSeq;
  const tr = drawingState.openTrace;   // 도면을 열 때의 첫 그리기만 속도 기록에 적는다
  const doc = drawingState.pdfDoc;
  drawingState.renderFailed = false;
  clearPdfTiles();
  doc.cancelBelow(my);
  if (my !== renderSeq) return;
  try {
    const dims = await doc.pageDims(drawingState.pageNum, drawingState.rotation);
    if (my !== renderSeq || doc !== drawingState.pdfDoc) return;
    tr?.step('pdf:page');
    const wrapW = Math.max(320, $('pdfStageWrap').clientWidth - 24);
    const rotation = dims.rotate;
    const fitScale = (wrapW / dims.width) * drawingState.scale;
    const nativeDpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, Math.round(dims.width * fitScale));
    const cssH = Math.max(1, Math.round(dims.height * fitScale));
    const tiled = drawingState.scale > 1.5 && shouldUseTiles(cssW, cssH, nativeDpr);
    const backdropDpr = Math.min(
      nativeDpr,
      Math.sqrt((tiled ? BASE_MAX_PX : MAX_CANVAS_PX) / Math.max(1, cssW * cssH)),
    );

    const pdfCanvas = $('pdfCanvas');
    const key = `${drawingState.currentFile?.id}|${drawingState.pageNum}|${rotation}`;
    const fresh = key !== shownKey;   // 이 쪽 그림이 캔버스에 아직 없음(저장해 둔 그림도 없음)
    if (fresh) {
      pdfCanvas.width = 1;   // 다른 쪽·문서: 옛 그림을 지운다(흰 바탕만 보임)
      pdfCanvas.height = 1;
    }
    for (const id of ['pdfCanvas', 'pdfTileLayer', 'inkCanvas', 'pinLayer']) {
      const el = $(id);
      if (el) { el.style.width = `${cssW}px`; el.style.height = `${cssH}px`; }
    }
    const inkCanvas = $('inkCanvas');
    inkCanvas.width = cssW;
    inkCanvas.height = cssH;
    redrawPageInk();
    renderPagePins();
    if (afterLayout) afterLayout();

    tr?.step('render:start');
    // 화면에 아무 그림도 없고 아주 큰 고해상도 캔버스(>2.2MP)일 때만 거친 그림을 먼저 그린다. 일반 첫 열기는 한 번에 선명하게 그려 2중 렌더링을 없앤다
    if (fresh && backdropDpr > LOWRES_DPR && (cssW * cssH * backdropDpr * backdropDpr) > 2200000) {
      const low = await doc.renderRegion({
        seq: my,
        pageNum: drawingState.pageNum,
        renderScale: fitScale * LOWRES_DPR,
        rotation,
        pixelW: Math.max(1, Math.round(cssW * LOWRES_DPR)),
        pixelH: Math.max(1, Math.round(cssH * LOWRES_DPR)),
      });
      if (my !== renderSeq || !low?.bitmap) {
        if (typeof low?.bitmap?.close === 'function') low.bitmap.close();
        return;
      }
      swapIntoCanvas(pdfCanvas, low.bitmap);
      shownKey = key;
      shownRot = rotation;
      shownSharp = false;
      tr?.step('render:low');
      $('pdfPageInfo').textContent = '선명하게 그리는 중...';
    }

    const base = await doc.renderRegion({
      seq: my,
      pageNum: drawingState.pageNum,
      renderScale: fitScale * backdropDpr,
      rotation,
      pixelW: Math.max(1, Math.round(cssW * backdropDpr)),
      pixelH: Math.max(1, Math.round(cssH * backdropDpr)),
    });
    if (my !== renderSeq || !base?.bitmap) {
      if (typeof base?.bitmap?.close === 'function') base.bitmap.close();
      return;
    }
    tr?.step('render:end');
    swapIntoCanvas(pdfCanvas, base.bitmap);
    shownKey = key;
    shownRot = rotation;
    shownSharp = true;
    drawingState.renderFailed = false;
    tr?.step('render:swap');
    updatePageInfo();
    // 쪽 그림 저장은 화면이 다 뜬 뒤 한 박자 쉬고(그리는 시간에 끼지 않게), 그사이 다른 쪽으로 바뀌지 않았을 때만
    setTimeout(() => { if (shownKey === key && shownSharp && drawingState.pdfDoc === doc) savePageSnapshot(pdfCanvas, rotation); }, SNAPSHOT_SAVE_DELAY_MS);
    if (typeof refreshGps === 'function') refreshGps();

    // 확대 상태라 바탕만으로는 흐릴 때: 현재 화면에 보이는 512px 타일만 원래 선명도로 얹는다
    if (tiled) {
      const tileDpr = Math.min(nativeDpr, Math.sqrt(TILE_MAX_PX / (PDF_TILE_SIZE * PDF_TILE_SIZE)));
      tileSession = {
        seq: my,
        doc,
        pageNum: drawingState.pageNum,
        rotation,
        fitScale,
        tileDpr,
        cssW,
        cssH,
        rendered: new Map(),
        inFlight: new Set(),
        wanted: [],
        keepKeys: new Set(),
      };
      scheduleVisibleTiles();
    }
  } catch (err) {
    if (err?.name === 'RenderingCancelledException' || my !== renderSeq) return;
    if (doc.isWorker && drawingState.rawPdfBytes) {
      console.warn('도면 워커 그리기 실패, 기본 렌더러로 자동 복구합니다', err);
      pdfWorkerDisabled = true;
      resetPdfWorker();
      try {
        drawingState.pdfDoc = await openPdfFallback(drawingState.rawPdfBytes);
        if (my === renderSeq) return await renderPdfPage(afterLayout);
      } catch (fbErr) {
        console.warn('기본 렌더러 복구 실패', fbErr);
      }
    }
    console.warn('도면 그리기 실패', err);
    drawingState.renderFailed = true;
    $('pdfPageInfo').textContent = '이 쪽을 그리지 못했습니다. 확대·축소를 다시 눌러 주세요.';
  }
}

function currentPagePins() {
  return (drawingState.notes.pins || []).filter((p) => p.page === drawingState.pageNum);
}

// ---------- 확대한 도면을 손가락으로 다루기 ----------
// 도면 칸의 끌기·확대는 브라우저에 맡기지 않고 직접 처리한다(.pdf-stage-wrap { touch-action: none }).
// 확대하면 화면이 사방으로 움직일 수 있어, 찍을 때 손가락이 조금만 흔들려도 브라우저가 '끌기'로 보고 터치를 버렸기 때문.
// 한 손가락: TAP_SLOP_PX 이하로 움직였다 떼면 찍기, 더 움직이면 끌어서 이동. 두 손가락: 벌리거나 오므려 확대·축소(손가락 사이가 제자리)
const stageGesture = { pts: new Map(), start: null, moved: false, pinch: null };
const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const clampScale = (s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

// 화면 좌표가 도면의 어디(가로·세로 비율)인지
function stageFraction(clientX, clientY) {
  const r = $('pdfStage').getBoundingClientRect();
  return { fx: (clientX - r.left) / (r.width || 1), fy: (clientY - r.top) / (r.height || 1) };
}

// 배율을 바꾸고, 바꾸기 전에 (fx, fy)였던 도면 위치가 다시 화면의 (clientX, clientY)에 오도록 스크롤한다
// 두 손가락으로 늘려 보이던 모양(transform)은 새 크기를 정하는 바로 그 순간에 걷어 내서, 손을 떼도 원래 크기로 튀었다 커지지 않는다
async function zoomStageTo(scale, { fx, fy }, clientX, clientY) {
  const stage = $('pdfStage');
  const next = clampScale(scale);
  if (next === drawingState.scale) { stage.style.transform = ''; return; }
  drawingState.scale = next;
  await renderPdfPage(() => {
    stage.style.transform = '';
    const wrap = $('pdfStageWrap');
    const r = stage.getBoundingClientRect();
    wrap.scrollLeft += r.left + fx * r.width - clientX;
    wrap.scrollTop += r.top + fy * r.height - clientY;
  });
}

// ＋/－ 버튼: 지금 보고 있는 화면 가운데를 기준으로
function zoomStageBy(step) {
  const r = $('pdfStageWrap').getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return zoomStageTo(drawingState.scale + step, stageFraction(cx, cy), cx, cy);
}

function onStageDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (drawingState.penMode && e.target === $('inkCanvas')) return;   // 펜은 잉크 캔버스가 받는다
  if (e.target.closest('#gpsLayer.calibrating')) return;              // GPS 기준점 찍기는 gps.js가 받는다
  const g = stageGesture;
  // 새 터치의 첫 손가락인데 지난 손가락이 남아 있으면(떼는 신호를 놓친 경우) 비운다. 안 그러면 한 손가락도 두 손가락으로 보여 찍기가 안 된다
  if (e.isPrimary && g.pts.size) { g.pts.clear(); g.pinch = null; $('pdfStage').style.transform = ''; }
  g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.pts.size === 1) {
    const wrap = $('pdfStageWrap');
    g.start = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, target: e.target };
    g.moved = false;
    return;
  }
  if (g.pts.size !== 2) return;
  g.moved = true;   // 두 손가락이면 찍기가 아니다
  const [a, b] = [...g.pts.values()];
  const mid = midOf(a, b);
  const at = stageFraction(mid.x, mid.y);
  g.pinch = { ...at, dist: distOf(a, b), mid, now: mid, factor: 1 };
  $('pdfStage').style.transformOrigin = `${at.fx * 100}% ${at.fy * 100}%`;
}

function onStageMove(e) {
  const g = stageGesture;
  if (!g.pts.has(e.pointerId)) return;
  g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.pinch) {
    if (g.pts.size < 2) return;
    const [a, b] = [...g.pts.values()];
    const p = g.pinch;
    p.now = midOf(a, b);
    p.factor = clampScale(drawingState.scale * (distOf(a, b) / p.dist)) / drawingState.scale;
    // 손을 떼기 전까지는 그림만 늘려 보여 주고(빠름), 뗄 때 그 배율로 다시 그린다
    $('pdfStage').style.transform = `translate(${p.now.x - p.mid.x}px, ${p.now.y - p.mid.y}px) scale(${p.factor})`;
    return;
  }
  if (!g.start) return;   // 두 손가락 확대 뒤 남은 손가락
  const dx = e.clientX - g.start.x;
  const dy = e.clientY - g.start.y;
  if (!g.moved && Math.hypot(dx, dy) <= TAP_SLOP_PX) return;
  g.moved = true;
  const wrap = $('pdfStageWrap');
  wrap.scrollLeft = g.start.left - dx;
  wrap.scrollTop = g.start.top - dy;
}

function onStageUp(e) {
  const g = stageGesture;
  if (!g.pts.delete(e.pointerId)) return;
  if (g.pinch) {
    if (g.pts.size >= 2) return;
    const p = g.pinch;
    g.pinch = null;
    g.start = null;
    zoomStageTo(drawingState.scale * p.factor, p, p.now.x, p.now.y);
    return;
  }
  const s = g.start;
  if (g.pts.size === 0) g.start = null;
  // 도면 위를 찍었을 때만(바깥 회색 여백은 아님). 이미 있는 동그라미는 그 동그라미가 받는다
  if (e.type === 'pointerup' && s && !g.moved && drawingState.pinMode && s.target.closest('#pdfStage') && !s.target.closest('.pdf-pin')) {
    swallowNextClick(e.clientX, e.clientY);
    handleStageTapForPin({ clientX: s.x, clientY: s.y, target: s.target });
  }
}

// 손가락을 떼면 브라우저가 그 자리에 click을 하나 더 만든다. 그때는 이미 번호창이 떠 있어서, click이 창 바탕에 떨어지면 창이 바로 닫히고(번호창이 안 뜸)
// [확인] 자리에 떨어지면 미리 채운 번호로 동그라미가 바로 생겼다. 찍은 직후 GHOST_CLICK_MS 안에 손가락 자리(x, y)에 오는 click 하나만 버린다
// (키보드 Enter로 [확인]을 누를 때 생기는 click이나 다른 자리를 누른 것은 그대로 둔다)
function swallowNextClick(x, y) {
  const eat = (ev) => {
    if (Math.hypot(ev.clientX - x, ev.clientY - y) > TAP_SLOP_PX * 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    done();
  };
  const done = () => { window.removeEventListener('click', eat, true); clearTimeout(timer); };
  const timer = setTimeout(done, GHOST_CLICK_MS);
  window.addEventListener('click', eat, true);
}

function initStageGestures() {
  const wrap = $('pdfStageWrap');
  wrap.addEventListener('pointerdown', onStageDown);
  wrap.addEventListener('pointermove', onStageMove);
  wrap.addEventListener('pointerup', onStageUp);
  wrap.addEventListener('pointercancel', onStageUp);
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

// 찍을 때 넣은 계측기 번호(pin.num)를 쓴다. 번호가 없는 옛 메모는 같은 쪽·같은 종류끼리 센 순서 번호
function pinLabel(pin) {
  if (pin.num) return `${pin.type || ''}${pin.num}`;
  const same = (drawingState.notes.pins || []).filter((p) => p.page === pin.page && (p.type || '') === (pin.type || ''));
  return `${pin.type || ''}${same.indexOf(pin) + 1}`;
}

// 동그라미를 찍기 전에 계측기 번호를 묻는다. 종류 글자(W·H…)는 고정이고 번호만 넣는다. 취소하면 null
// 하중계·변형률계의 다음 지점 번호: 이 쪽·종류에 있는 지점(묶음) 번호 중 가장 큰 숫자 + 1
function nextGroupBase(type, page) {
  const bases = pinItems((drawingState.notes.pins || []).filter((p) => p.page === page && p.type === type)).map((it) => Number(it.base ?? it.anchor.num));
  return String(Math.max(0, ...bases.filter(Number.isFinite)) + 1);
}

async function askPinNumber(type, page) {
  const dlg = $('pinNumDialog');
  const grouped = GROUP_TYPES.includes(type);
  const same = (drawingState.notes.pins || []).filter((p) => p.page === page && (p.type || '') === (type || ''));
  $('pinNumLabel').textContent = type ? `${type} ${pinTypeName(type)} 번호 (원 안에 ${type}+번호로 표시)` : '번호 (원 안에 표시)';
  show($('pinLevelField'), grouped);
  $('pinNumInput').value = grouped ? nextGroupBase(type, page) : String(same.length + 1);
  dlg.returnValue = '';   // 바탕을 눌러 닫으면 취소
  dlg.showModal();
  $('pinNumInput').select();
  await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
  if (dlg.returnValue !== 'ok') return null;
  return $('pinNumInput').value.trim().replace(/\s+/g, '') || (grouped ? nextGroupBase(type, page) : String(same.length + 1));
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
  layer.replaceChildren(...pinItems(visiblePagePins()).map((item) => {
    const pin = item.anchor;
    const label = item.base ? `${pin.type}${item.base}` : pinLabel(pin);
    const selected = (item.rows || [{ pin }]).some((r) => r.pin.id === drawingState.activePinId);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pdf-pin${selected ? ' selected' : ''}${label.length > 3 ? ' tiny' : label.length > 2 ? ' small' : ''}`;
    const at = toView(pin, drawingState.rotation);
    el.style.left = `${(at.x * 100).toFixed(2)}%`;
    el.style.top = `${(at.y * 100).toFixed(2)}%`;
    el.textContent = label;
    if (item.rows) {
      if (itemHasTag(item)) el.appendChild(buildGroupTag(item));
    } else if (pin.text) {
      const tag = document.createElement('span');
      tag.className = 'pdf-pin-tag';
      tag.textContent = pin.text;
      el.appendChild(tag);
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      // 묶음의 줄(단)을 눌렀으면 그 단, 아니면 첫 단
      openPinMemoBox(e.target.closest?.('[data-pid]')?.dataset.pid || pin.id);
    });
    return el;
  }));
}

// 화면용 묶음 상자(PDF 그림과 같은 모양): (신규설치 줄) + 단마다 한 줄, 변형률계는 칸 3개
function buildGroupTag(item) {
  const box = document.createElement('span');
  box.className = `pdf-pin-tag grp${item.anchor.type === 'S' ? ' strain' : ''}`;
  const note = liveNote(item.anchor);
  if (note) {
    const n = document.createElement('span');
    n.className = 'grp-note';
    n.textContent = note;
    box.appendChild(n);
  }
  for (const row of item.rows) {
    const r = document.createElement('span');
    r.className = `grp-row${row.pin.id === drawingState.activePinId ? ' active' : ''}`;
    r.dataset.pid = row.pin.id;
    if (row.level !== null) {
      const head = document.createElement('i');
      head.textContent = `${row.level}단`;
      r.appendChild(head);
    }
    for (const text of rowCells(row.pin)) {
      const c = document.createElement('b');
      c.textContent = text;
      r.appendChild(c);
    }
    box.appendChild(r);
  }
  return box;
}

async function handleStageTapForPin(e) {
  if (!drawingState.pinMode) return;
  if (e.target.closest('.pdf-pin')) return;
  if ($('pinNumDialog').open) return;
  const rect = $('pinLayer').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { x, y } = fromView({
    x: Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0.02, Math.min(0.98, (e.clientY - rect.top) / rect.height)),
  }, drawingState.rotation);
  const page = drawingState.pageNum;
  const type = drawingState.pinType;
  const num = await askPinNumber(type, page);
  if (num === null || page !== drawingState.pageNum) return;
  const grouped = GROUP_TYPES.includes(type);
  const levels = grouped ? Math.max(1, Math.min(9, parseInt($('pinLevelInput').value, 10) || 1)) : 0;
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const make = (n) => ({ id: crypto.randomUUID(), page, x, y, type, num: n, text: '', author: $('user')?.value || '', time });
  // 하중계·변형률계: 같은 지점의 단을 한 번에 만든다(번호 'L1-1단'…). 이미 있는 지점 번호면 새로 만들지 않고 그 지점을 연다
  const existing = grouped ? pinItems(drawingState.notes.pins.filter((p) => p.page === page && p.type === type)).find((it) => it.base === num) : null;
  if (existing) { openPinMemoBox(existing.anchor.id); return; }
  const added = grouped ? Array.from({ length: levels }, (_, i) => make(`${num}-${i + 1}단`)) : [make(num)];
  drawingState.notes.pins.push(...added);
  markDirty();
  renderPagePins();
  updatePageInfo();
  openPinMemoBox(added[0].id);
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
  // 지난 측정일의 값이 들어 있으면 칸을 누를 때 전체 선택: 지우지 않고 바로 새 값을 친다(옛 값은 전회로 남는다)
  $('pinMemoKeyboard').dataset.stale = pin.text && pin.date !== todayKst() ? '1' : '';
  renderPinReadings(pin);
  renderPinGroupUi(pin);
  show($('pinMemoBox'), true);
  renderPagePins();
}

// ---------- 하중계·변형률계 메모 상자: 단 선택줄 · 변형률계 칸 3개 · 신규설치 키패드 ----------
const itemOfPin = (pin) => pinItems(currentPagePins().filter((p) => p.type === pin.type)).find((it) => it.rows?.some((r) => r.pin.id === pin.id)) || null;
const noteOwner = (pin) => itemOfPin(pin)?.anchor || pin;
const levelButtonText = (row) => `${row.level ?? ''}단${rowCells(row.pin).some(Boolean) ? ' ✓' : ''}`;   // 값은 칸·도면에 보이므로 단 버튼에는 적었는지만

function renderPinGroupUi(pin) {
  const grouped = GROUP_TYPES.includes(pin.type);
  const strain = pin.type === 'S';
  const item = grouped ? itemOfPin(pin) : null;
  // 단 선택줄: 단마다 '1단 값' 버튼, 마지막에 ＋단(다음 단 추가)
  const levels = $('pinLevels');
  show(levels, !!item && item.rows.some((r) => r.level !== null));
  levels.replaceChildren();
  if (item) {
    for (const row of item.rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pin-level-btn';
      b.setAttribute('aria-pressed', String(row.pin.id === pin.id));
      b.textContent = levelButtonText(row);
      b.addEventListener('click', () => openPinMemoBox(row.pin.id));
      levels.appendChild(b);
    }
    if (item.base) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pin-level-btn add';
      add.textContent = '＋ 단 추가';
      add.addEventListener('click', () => addLevel(item));
      levels.appendChild(add);
    }
  }
  // 변형률계: 키보드 칸 대신 칸 3개
  show($('pinCells'), strain);
  $('pinMemoBox').classList.toggle('strain-mode', strain);   // 변형률계는 칸으로 적으므로 안내 글·손글씨 칸을 접어 상자를 작게
  show($('pinMemoKeyboard'), !strain);
  $('pinMemoOpenPad').textContent = strain ? '✍️ 손글씨로 입력 — 빈 칸에 차례로 들어갑니다' : '✍️ 펜 필기(OCR)';
  if (strain) strainCells(pin.text).forEach((c, i) => { $('pinCells').children[i].value = c; });
  // 신규설치 표시
  show($('pinNoteBar'), grouped);
  if (!grouped) setKeypadOpen(false);
  renderNoteBar(pin);
}

function addLevel(item) {
  const top = item.rows[item.rows.length - 1];
  if ((top.level || 0) >= 9) return;
  const a = item.anchor;
  const newPin = {
    id: crypto.randomUUID(), page: a.page, x: a.x, y: a.y, type: a.type, num: `${item.base}-${(top.level || 0) + 1}단`, text: '',
    author: $('user')?.value || '', time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
  };
  drawingState.notes.pins.push(newPin);
  markDirty();
  updatePageInfo();
  openPinMemoBox(newPin.id);
  saveDrawingNotesQuiet();
}

// 변형률계 칸 입력: 칸을 'a/b/c' 로 합쳐 값으로 저장한다. 한 칸이 6자리(숫자)가 되면 다음 칸으로
function onStrainCellInput(e) {
  const inputs = [...$('pinCells').querySelectorAll('input')];
  const i = inputs.indexOf(e.target);
  updateActivePinText(joinStrainCells(inputs.map((x) => x.value)), { keepCells: true });
  if (i < inputs.length - 1 && e.target.value.replace(/\D/g, '').length >= 6) inputs[i + 1].focus();
}

function renderNoteBar(pin) {
  const note = liveNote(noteOwner(pin));
  for (const id of ['pinNoteView', 'pinKeypadPreview']) {
    const view = $(id);
    view.textContent = note || '신규설치 표시 없음';
    view.classList.toggle('empty', !note);
  }
}

// 키패드는 메모 상자 위에 따로 뜨는 창이다(손글씨·키보드 입력 자리를 가리거나 숨기지 않는다)
function setKeypadOpen(on) {
  const dlg = $('pinKeypadDialog');
  if (on && !dlg.open) {
    if (!$('pinKeypad').childElementCount) buildKeypad();
    dlg.showModal();
  } else if (!on && dlg.open) dlg.close();
}

// 숫자 키패드(왼쪽) + '자주 쓰는 것'(오른쪽: 신규설치·단·-). 신규설치는 글자를 고칠 수 없고 넣고 빼기만 된다
function buildKeypad() {
  const mk = (cls, text, key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pin-key ${cls}`.trim();
    b.textContent = text;
    b.dataset.key = key;
    return b;
  };
  const cap = (cls, text) => { const d = document.createElement('div'); d.className = `pin-keypad-cap ${cls}`; d.textContent = text; return d; };
  const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'done'];
  const freq = [['chip', '신규설치'], ['단', '단'], ['-', '-']];
  const out = [cap('num', '숫자'), cap('freq', '자주 쓰는 것')];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const k = nums[row * 3 + col];
      out.push(k === 'back' ? mk('util', '⌫', 'back') : k === 'done' ? mk('util done', '완료', 'done') : mk('', k, k));
    }
    if (freq[row]) out.push(mk(`freq${freq[row][0] === 'chip' ? ' chip' : ''}`, freq[row][1], freq[row][0]));
    else out.push(document.createElement('span'));
  }
  $('pinKeypad').replaceChildren(...out);
}

function onKeypadPress(e) {
  const key = e.target.closest('button[data-key]')?.dataset.key;
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (!key || !pin) return;
  if (key === 'done') { setKeypadOpen(false); return; }
  const owner = noteOwner(pin);
  const next = pressNoteKey(liveNote(owner), key);
  drawingState.notes.pins = drawingState.notes.pins.map((p) => {
    if (p.id !== owner.id) return p;
    const { note, noteDate, ...rest } = p;
    return next ? { ...rest, note: next, noteDate: todayKst() } : rest;
  });
  markDirty();
  renderNoteBar(pin);
  renderPagePins();
  saveDrawingNotesQuiet();
}

// 지난 값 카드(pinhistory.js readingTiles): 초기치·전회·오늘 타일(오늘 값이 있으면 전회 대비 변화·초기치 대비 누적) + 지난 값 이력 칩.
// 지난 값이 없는 동그라미(처음 적는 것)에는 숨긴다. 모양(class)은 style.css .pin-memo-prev 와 맞춘 계약
const KEYBOARD_PLACEHOLDER = '키보드로 직접 수정할 수도 있습니다';
const mmdd = (date) => (date ? date.slice(5).replace('-', '/') : '');
function renderPinReadings(pin) {
  const box = $('pinMemoPrev');
  if (typeof readingTiles !== 'function') { show(box, false); return; }
  const t = readingTiles(pin, todayKst());
  if (pin.type === 'S') { t.delta = null; t.cumulative = null; }   // 값이 3칸이라 첫 숫자만 비교하면 틀린 변화가 나온다
  $('pinMemoKeyboard').placeholder = t.prev && !t.current ? '오늘 값을 입력하세요' : KEYBOARD_PLACEHOLDER;
  show(box, !!t.prev);
  if (!t.prev) { box.replaceChildren(); return; }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const tile = (cls, label, value, date) => {
    const d = el('div', `pin-reading ${cls}`);
    d.append(el('small', 'label', label), el('b', 'value', value));
    if (date) d.append(el('span', 'date', mmdd(date)));
    return d;
  };
  const readings = el('div', 'pin-readings');
  if (t.sameInitialPrev) readings.append(tile('initial', '초기치·전회', t.prev.text, t.prev.date));
  else readings.append(tile('initial', '초기치', t.initial.text, t.initial.date), tile('prev', '전회', t.prev.text, t.prev.date));
  const today = tile(t.current ? 'today' : 'today empty', '오늘', t.current || '—');
  if (t.delta !== null) today.append(el('span', 'delta', t.delta));
  if (t.cumulative !== null) today.append(el('span', 'cum', `누적 ${t.cumulative}`));
  readings.append(today);
  box.replaceChildren(readings);
  if (t.past.length > 1) {
    const hist = el('div', 'pin-history');
    t.past.forEach((h, i) => {
      const chip = el('span', i === t.past.length - 1 ? 'pin-hist last' : 'pin-hist');
      chip.append(el('small', '', mmdd(h.date)), h.text);
      hist.append(chip);
    });
    box.append(hist);
    // 칩이 많으면 가장 최근(전회)이 보이게 오른쪽 끝으로. 상자가 아직 숨겨져 있을 수 있어 한 프레임 뒤에
    requestAnimationFrame(() => { hist.scrollLeft = hist.scrollWidth; });
  }
}

// 메모 글자를 바꾼다. 지난 측정일의 값을 오늘 처음 고치는 순간 그 값이 history 로 넘어간다(같은 날에는 그냥 고쳐진다)
function replaceActivePinText(newText) {
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (!pin) return null;
  const moved = typeof pushPinHistory === 'function' ? pushPinHistory(pin, newText, todayKst()) : { ...pin, text: newText };
  // 값을 적은 사람이 author: 남이 찍어 둔 동그라미(계측용 도면)에 내가 값을 적으면 내 실시간 줄·홈 최근 입력에 들어가게
  const next = { ...moved, author: $('user')?.value || moved.author || '' };
  drawingState.notes.pins = drawingState.notes.pins.map((p) => (p === pin ? next : p));
  return next;
}

function closePinMemoBox() {
  const wasEditing = !!drawingState.activePinId;
  drawingState.activePinId = null;
  setKeypadOpen(false);
  show($('pinMemoBox'), false);
  renderPagePins();
  if (!wasEditing) return;
  persistNotesNow();   // 적던 값을 바로 폰에 쓰고
  flushLivePins();     // 서버에도 바로 보낸다(기다리지 않음)
}

function updateActivePinText(newText, { keepCells = false } = {}) {
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (!pin) return;
  newText = negateIfPlainNumber(pin.type, newText);
  const next = replaceActivePinText(newText);
  if (!next) return;
  markDirty();
  $('pinMemoDisplay').textContent = newText;
  $('pinMemoKeyboard').value = newText;
  $('pinMemoKeyboard').dataset.stale = '';
  if (pin.type === 'S' && !keepCells) strainCells(newText).forEach((c, i) => { $('pinCells').children[i].value = c; });   // 손글씨 판독 등 칸 밖에서 들어온 값
  renderPinReadings(next);
  refreshLevelButtons(next);
  renderPagePins();
  saveDrawingNotesQuiet();
}

// 값이 바뀌면 단 선택줄의 글자도 따라 바꾼다(줄을 다시 만들면 입력 칸의 커서가 끊기므로 글자만)
function refreshLevelButtons(pin) {
  const item = GROUP_TYPES.includes(pin.type) ? itemOfPin(pin) : null;
  if (!item) return;
  const buttons = $('pinLevels').querySelectorAll('.pin-level-btn:not(.add)');
  item.rows.forEach((row, i) => { if (buttons[i]) buttons[i].textContent = levelButtonText(row); });
}

function deleteActivePin() {
  if (!drawingState.activePinId) return;
  if (!confirm('이 동그라미 메모를 도면에서 삭제할까요?')) return;
  drawingState.notes.pins = drawingState.notes.pins.filter((p) => p.id !== drawingState.activePinId);
  markDirty();
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

// 판독한 글자를 메모에 넣는다. 오늘 적던 글 뒤에는 이어 붙이고, 지난 측정일의 값(전회값)은 새 값으로 바꾼다(옛 값은 history 로 남는다)
function applyOcrTextAndClose(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
  if (pin?.type === 'S') {
    // 변형률계: 판독한 값은 오늘 적던 칸 다음의 첫 빈 칸에 넣는다(다 찼으면 마지막 칸을 바꾼다)
    updateActivePinText(joinStrainCells(placeOcrInCells(strainCells(pin.date === todayKst() ? pin.text : ''), clean)));
    $('ocrPadDialog').close();
    return;
  }
  const merged = pin && pin.text && pin.date === todayKst() ? `${pin.text} ${clean}` : clean;
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
    markDirty();
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

// 메모 그림의 모양(쪽 단위, 위가 0). 아래 그리기와 묶음 범위 계산이 같은 값을 쓴다
const ANN_PIN_R = 13;
const ANN_PIN_EDGE = 2.2;
const ANN_INK_W = 3.0;
const ANN_TAG_PAD_X = 7;
const ANN_TAG_H = 22;
const ANN_TAG_GAP = 4;
const ANN_TAG_FONT = 'bold 12px "Noto Sans KR", "Malgun Gothic", sans-serif';
const ANN_PNG_SCALE = 2;   // 쪽 1단위를 PNG 2px 로(확대해도 글자가 깨지지 않게)
// 하중계·변형률계 묶음 상자: 단마다 한 줄(머리 '1단' + 값 칸). 변형률계는 칸 3개를 끊김 없이 이어 붙이고 칸 폭은 6자리 기준 고정
const ANN_ROW_H = 20;
const ANN_HEAD_W = 28;
const ANN_CELL_W_S = 50;
const ANN_CELL_W_L = 66;
const ANN_BLUE = '#1F62A8';
const ANN_INK_NAVY = '#10264F';
const ANN_LINE = '#D3E0F2';
const ANN_ROW_TINT = '#F3F7FD';
const ANN_ACTIVE_TINT = '#FFF1DE';

// 동그라미 아래 글자 상자 자리(쪽 가장자리 안으로 당긴다). textW: 글자 폭
function annTagBox(pin, textW, widthPx, heightPx) {
  const boxW = textW + ANN_TAG_PAD_X * 2;
  const cx = pin.x * widthPx;
  const cy = pin.y * heightPx;
  return { x: Math.max(4, Math.min(widthPx - boxW - 4, cx - boxW / 2)), y: Math.min(heightPx - ANN_TAG_H - 4, cy + ANN_PIN_R + ANN_TAG_GAP), w: boxW, h: ANN_TAG_H };
}

// 묶음 상자 자리(원 아래, 쪽 안으로 당긴다). 줄이 몇 개든 높이는 줄 수 × ANN_ROW_H (+ 신규설치 줄)
function annGroupBox(item, measure, widthPx, heightPx) {
  const isS = item.anchor.type === 'S';
  const head = item.rows.some((r) => r.level !== null) ? ANN_HEAD_W : 0;
  const cells = isS ? STRAIN_CELLS : 1;
  const cellW = isS ? ANN_CELL_W_S : ANN_CELL_W_L;
  const note = liveNote(item.anchor);
  const rowsW = head + cells * cellW;
  const w = Math.max(rowsW, note ? measure(note) + ANN_TAG_PAD_X * 2 : 0);
  const h = (note ? ANN_ROW_H : 0) + item.rows.length * ANN_ROW_H;
  const cx = item.anchor.x * widthPx;
  const cy = item.anchor.y * heightPx;
  return { x: Math.max(4, Math.min(widthPx - w - 4, cx - w / 2)), y: Math.min(heightPx - h - 4, cy + ANN_PIN_R + ANN_TAG_GAP), w, h, head, cells, cellW, rowsW, note };
}

// 순수 함수: 그릴 메모 전체를 감싸는 범위 { x, y, w, h }(쪽 단위, 위가 0, 정수로 넓혀 쪽 안으로 자름). 그릴 것이 없으면 null.
// measure(text): 글자 폭(ANN_TAG_FONT 기준). 저장할 때 쪽 전체 크기 PNG 대신 이 범위만 그려 넣는다(큰 도면에서 PNG 만들기·넣기가 가벼워진다)
function annotationBounds(pins, strokes, widthPx, heightPx, measure) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (ax, ay, bx, by) => { x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx); y1 = Math.max(y1, by); };
  const inkPad = ANN_INK_W / 2 + 1;
  for (const s of strokes || []) for (const p of s || []) add(p.x * widthPx - inkPad, p.y * heightPx - inkPad, p.x * widthPx + inkPad, p.y * heightPx + inkPad);
  const pinPad = ANN_PIN_R + ANN_PIN_EDGE / 2 + 1;
  for (const item of pinItems(pins)) {
    const pin = item.anchor;
    const cx = pin.x * widthPx;
    const cy = pin.y * heightPx;
    add(cx - pinPad, cy - pinPad, cx + pinPad, cy + pinPad);
    const b = item.rows ? (itemHasTag(item) ? annGroupBox(item, measure, widthPx, heightPx) : null) : (pin.text ? annTagBox(pin, measure(pin.text), widthPx, heightPx) : null);
    if (b) add(b.x - 1, b.y - 1, b.x + b.w + 1, b.y + b.h + 1);
  }
  if (x0 === Infinity) return null;
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(Math.ceil(widthPx), Math.ceil(x1));
  const bottom = Math.min(Math.ceil(heightPx), Math.ceil(y1));
  if (right <= left || bottom <= top) return null;   // 메모가 모두 쪽 밖
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// 순수 함수: 범위(위가 0)를 pdf-lib drawImage 자리(아래가 0)로. 예전처럼 쪽 전체(0,0,width,height)에 그리던 것과 같은 자리에 같은 크기로 놓인다
const pdfPlacement = (b, pageHeight) => ({ x: b.x, y: pageHeight - b.y - b.h, width: b.w, height: b.h });

const roundRectPath = (ctx, x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };

// 묶음 상자 그리기: 흰 카드 + 파란 테두리, (주황 신규설치 띠) + 단마다 한 줄(파란 단 머리 + 값 칸). 칸 사이는 연한 선으로 이어 붙이고, 칸보다 긴 값은 글자를 줄여 넣는다
function drawGroupTag(ctx, item, b) {
  ctx.textBaseline = 'middle';
  const totalH = b.h;
  // 카드 바탕 + 테두리
  ctx.fillStyle = '#FFFFFF';
  roundRectPath(ctx, b.x, b.y, b.w, totalH, 6);
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, b.x, b.y, b.w, totalH, 6);
  ctx.clip();
  let y = b.y;
  if (b.note) {
    const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
    g.addColorStop(0, '#FF8A1F');
    g.addColorStop(1, '#F2600C');
    ctx.fillStyle = g;
    ctx.fillRect(b.x, y, b.w, ANN_ROW_H);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = ANN_TAG_FONT;
    ctx.textAlign = 'center';
    ctx.fillText(b.note, b.x + b.w / 2, y + ANN_ROW_H / 2);
    y += ANN_ROW_H;
  }
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = ANN_LINE;
  item.rows.forEach((row, r) => {
    const ry = y + r * ANN_ROW_H;
    if (r % 2) { ctx.fillStyle = ANN_ROW_TINT; ctx.fillRect(b.x, ry, b.rowsW, ANN_ROW_H); }
    if (r) { ctx.beginPath(); ctx.moveTo(b.x, ry); ctx.lineTo(b.x + b.rowsW, ry); ctx.stroke(); }
    if (b.head) {
      ctx.fillStyle = ANN_BLUE;
      ctx.fillRect(b.x, ry, b.head, ANN_ROW_H);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 10px "Noto Sans KR", "Malgun Gothic", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${row.level}단`, b.x + b.head / 2, ry + ANN_ROW_H / 2);
    }
    rowCells(row.pin).forEach((text, i) => {
      const cx0 = b.x + b.head + i * b.cellW;
      if (i) { ctx.beginPath(); ctx.moveTo(cx0, ry); ctx.lineTo(cx0, ry + ANN_ROW_H); ctx.stroke(); }
      if (!text) return;
      let size = 12;
      ctx.font = `bold ${size}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
      while (size > 7 && ctx.measureText(text).width > b.cellW - 6) { size -= 1; ctx.font = `bold ${size}px "Noto Sans KR", "Malgun Gothic", sans-serif`; }
      ctx.fillStyle = ANN_INK_NAVY;
      ctx.textAlign = 'center';
      ctx.fillText(text, cx0 + b.cellW / 2, ry + ANN_ROW_H / 2);
    });
  });
  ctx.restore();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ANN_BLUE;
  roundRectPath(ctx, b.x, b.y, b.w, totalH, 6);
  ctx.stroke();
}

// 특정 페이지의 동그라미 마커 + OCR 텍스트 태그 + 자유 펜 필기를 투명 PNG 로 그린다. 메모가 있는 범위만 잘라 { url, box } 로 돌려준다(없으면 null).
// onlyType을 주면 그 계측기 메모만 그린다(자유 펜 필기는 계측기와 무관하므로 뺀다). 없으면 전부.
// 좌표는 예전(쪽 전체 PNG 를 0,0 에 쪽 크기로 놓기)과 같은 틀(getSize 의 가로·세로, 위가 0)이라 회전된 PDF 도 예전과 같은 자리에 놓인다
function renderPageAnnotationsPng(pageIndex1Based, widthPx, heightPx, onlyType = null, notes = drawingState.notes) {
  const pagePins = (notes.pins || []).filter((p) => p.page === pageIndex1Based && (!onlyType || p.type === onlyType));
  const pageStrokes = onlyType ? [] : (notes.strokes?.[String(pageIndex1Based)] || []);
  if (!pagePins.length && !pageStrokes.length) return null;

  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = ANN_TAG_FONT;
  const box = annotationBounds(pagePins, pageStrokes, widthPx, heightPx, (t) => ctx.measureText(t).width);
  if (!box) return null;
  c.width = Math.round(box.w * ANN_PNG_SCALE);
  c.height = Math.round(box.h * ANN_PNG_SCALE);
  ctx.scale(ANN_PNG_SCALE, ANN_PNG_SCALE);   // 크기를 바꾸면 그리기 설정이 풀리므로 그 뒤에 정한다
  ctx.translate(-box.x, -box.y);              // 아래 그리기는 쪽 전체 좌표 그대로

  // 1) 자유 펜 필기 그리기
  ctx.strokeStyle = INK_COLOR;
  ctx.lineWidth = ANN_INK_W;
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

  // 2) 동그란 원 마커 및 OCR 텍스트 라벨 그리기(하중계·변형률계는 같은 지점 단들을 원 하나 + 줄 상자로)
  pinItems(pagePins).forEach((item) => {
    const pin = item.anchor;
    const cx = pin.x * widthPx;
    const cy = pin.y * heightPx;

    ctx.beginPath();
    ctx.arc(cx, cy, ANN_PIN_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(198, 40, 40, 0.94)';
    ctx.fill();
    ctx.lineWidth = ANN_PIN_EDGE;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    const label = item.base ? `${pin.type}${item.base}` : pinLabel(pin);
    ctx.font = `bold ${label.length > 3 ? 8 : label.length > 2 ? 10 : 12}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);

    if (item.rows) {
      if (itemHasTag(item)) drawGroupTag(ctx, item, annGroupBox(item, (t) => { ctx.font = ANN_TAG_FONT; return ctx.measureText(t).width; }, widthPx, heightPx));
    } else if (pin.text) {
      ctx.font = ANN_TAG_FONT;
      const b = annTagBox(pin, ctx.measureText(pin.text).width, widthPx, heightPx);

      ctx.fillStyle = 'rgba(27, 42, 87, 0.94)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, 5); else ctx.rect(b.x, b.y, b.w, b.h);   // 옛 WebView에는 roundRect가 없다
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.text, b.x + ANN_TAG_PAD_X, b.y + b.h / 2);
    }
  });

  const url = c.toDataURL('image/png');
  c.width = 0;   // 캔버스 메모리를 바로 돌려준다
  return { url, box };
}

// pdf-lib 받기 + 문서 열기(1MB 도면이면 느린 폰에서 1초 안팎). 저장 때 서버 확인(같은 이름 저장본 합치기)과 나란히 돌려 기다리는 시간을 겹친다
async function loadPdfForAnnotate(bytes) {
  const PDFLib = await ensurePdfLib();
  return PDFLib.PDFDocument.load(bytes);
}

// 원본 PDF 바이트 위에 모든 페이지의 야장 메모/필기를 합성한 새 PDF base64 생성. docPromise 를 주면 미리 연 문서를 쓴다(문서에 그려 넣으므로 한 번만 쓸 것).
// notes 는 만들기 시작할 때의 메모로 고정한다(만드는 동안 값을 더 적거나 합치기가 끝나도 쪽마다 다른 메모가 섞이지 않게)
// tr: 속도 기록(perf.js) — lib(pdf-lib 받음)·load(문서 열림)·png(메모 그림)·embed(넣기)·pdfsave·b64 를 적는다
async function buildAnnotatedPdfBase64(onlyType = null, docPromise = null, notes = drawingState.notes, tr = null) {
  if (!docPromise) { await ensurePdfLib(); tr?.step('lib'); }
  const pdfDoc = await (docPromise || loadPdfForAnnotate(drawingState.rawPdfBytes));
  tr?.step('load');
  const pages = pdfDoc.getPages();
  let pngMs = 0;
  let embedMs = 0;
  let pngChars = 0;

  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const { width, height } = p.getSize();
    let t = performance.now();
    const png = renderPageAnnotationsPng(i + 1, width, height, onlyType, notes);
    pngMs += performance.now() - t;
    if (!png) continue;
    pngChars += png.url.length;
    t = performance.now();
    const pngImage = await pdfDoc.embedPng(png.url);
    p.drawImage(pngImage, pdfPlacement(png.box, height));
    embedMs += performance.now() - t;
  }
  tr?.step('png', Math.round(pngMs));
  tr?.step('embed', `${Math.round(embedMs)}ms·${pngChars}자`);

  const outBytes = await pdfDoc.save();
  tr?.step('pdfsave', outBytes.length);
  const b64 = uint8ToBase64(outBytes);
  tr?.step('b64', b64.length);
  return b64;
}

// 폰 보관: 획마다·글자마다 불리므로 잠깐 모아서 한 번만 쓴다. 닫거나 서버에 보낼 때는 바로 쓴다(persistNotesNow)
let saveNotesTimer = null;
function persistNotesNow() {
  clearTimeout(saveNotesTimer);
  const file = drawingState.currentFile;
  if (!file) return;
  // 계측용(가상) 도면은 고친 게 있을 때만 폰에 둔다: 열어 보기만 한 것까지 적으면 저장본마다 'pdf_notes_tpl:…' 키가 쌓인다(열 때마다 최근 저장본으로 다시 만들므로 필요 없다)
  if (file.templateOf && !drawingState.dirty) return;
  store.set(`pdf_notes_${file.id}`, JSON.stringify(drawingState.notes));
  scheduleLivePins();
}

// 내가 찍고 값을 적은 동그라미를 '다른이름 저장' 전에도 서버에 보내 둔다 → 홈 '최근 입력'에 바로 뜨고, 앱이 꺼져도 남는다.
// 도면 파일이 아니라 측정자별 실시간 줄(live:<원본ID>:<측정자>)에 쓰므로 다른 사람이 여는 도면 메모는 바뀌지 않는다.
// 글자를 치는 동안은 기다렸다가 손을 멈추면(LIVE_PINS_DELAY_MS) 보내고, 메모 상자를 닫거나 도면을 닫으면 바로 보낸다.
// 보내지면 홈 최근 입력을 새로 불러 새로고침 없이 보이게 한다. 실패하면(신호 없음 등) 다음에 메모를 고치거나 닫을 때 다시 보낸다
const LIVE_PINS_DELAY_MS = 800;
const livePinsSent = {};   // 실시간 줄 키 → 마지막으로 보낸 내용(같으면 다시 안 보냄)
let livePinsTimer = null;
let livePinsPending = null;   // 아직 안 보낸 내용 { key, body, payload }
function scheduleLivePins() {
  const file = drawingState.currentFile;
  const user = $('user')?.value || '';
  if (!file || !user) return;
  const sourceId = (drawingState.sourceFile || file).id;
  const mine = (drawingState.notes.pins || []).filter((p) => p.author === user && String(p.text || '').trim());
  const pins = typeof trimNotesForCell === 'function' ? trimNotesForCell({ pins: mine }).pins : mine;   // 시트 한 칸 한도 안으로
  const key = `live:${sourceId}:${user}`;
  const body = JSON.stringify(pins);
  if (livePinsSent[key] === body || (livePinsSent[key] === undefined && !pins.length)) return;
  // 지금 상태를 붙잡아 둔다: 도면을 닫거나 바꿔도 이 내용 그대로 보낸다
  // 계측용(가상) 도면이면 fileId 가 'tpl:…' 로 간다 → 홈 최근 입력을 누르면 openRecentDrawing 이 계측용 도면을 다시 연다
  livePinsPending = { key, body, payload: { fileId: key, site: drawingState.site, fileName: file.name, user, data: { live: true, sourceId, fileId: file.id, pins } } };
  clearTimeout(livePinsTimer);
  livePinsTimer = setTimeout(flushLivePins, LIVE_PINS_DELAY_MS);
}

function flushLivePins() {
  clearTimeout(livePinsTimer);
  const job = livePinsPending;
  if (!job) return;
  livePinsPending = null;
  api('drawing_notes_save', job.payload)
    .then(() => {
      livePinsSent[job.key] = job.body;
      if (typeof loadRecent === 'function') loadRecent().catch(() => {});   // 홈 최근 입력에 바로 반영
    })
    .catch((err) => console.warn('도면 메모 실시간 보내기 실패(다음에 다시)', err));
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

const PHONE_SAVE_KEY = 'drawingPhoneSave';   // 'always'면 묻지 않고 폰에도 저장

// 클라우드 저장 결과(message)를 보여 주며 이 폰에도 저장할지 묻는다. files: [{ name, base64, folder }]
async function askPhoneSave(message, files) {
  if (!files.length) { alert(message); return; }
  if (store.get(PHONE_SAVE_KEY) !== 'always') {
    const dlg = $('phoneSaveDialog');
    $('phoneSaveMsg').textContent = `${message}\n\n이 폰에도 ${files.length > 1 ? `${files.length}개 모두 ` : ''}저장할까요?`;
    $('phoneSaveYes').textContent = files.length > 1 ? `폰에도 ${files.length}개 저장` : '폰에도 저장';
    $('phoneSaveAlways').checked = false;
    dlg.returnValue = '';   // 바탕을 눌러 닫으면 '안 함'
    dlg.showModal();
    await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
    if (dlg.returnValue !== 'yes') return;
    if ($('phoneSaveAlways').checked) { store.set(PHONE_SAVE_KEY, 'always'); $('drawingPhoneAlways').checked = true; }
    message = '';
  }
  const { saved, total, same } = await savePdfsToPhone(files, drawingState.site, pdfToJpegs);
  const where = window.AndroidGallery ? `갤러리 「계측사진/${phoneAlbumFolder(drawingState.site)}/${DRAWING_ALBUM}」 폴더(JPG 그림)` : '다운로드 폴더';
  const fresh = saved - same;
  const result = [
    saved === total ? (fresh ? `폰에 ${fresh}개 저장했습니다: ${where}` : '') : `폰에 ${total}개 중 ${saved}개만 저장했습니다: ${where}`,
    same ? `${same}개는 폰에 같은 그림이 이미 있어 다시 저장하지 않았습니다(겹침 방지)` : '',
  ].filter(Boolean).join('\n');
  alert([message, result].filter(Boolean).join('\n\n'));
}

const PHONE_JPEG_LONG_PX = 3000;   // 갤러리에 저장할 도면 그림의 긴 변(작은 글씨도 확대하면 읽히는 정도)
const PHONE_JPEG_QUALITY = 0.85;

// 앱의 갤러리 저장은 JPG만 받으므로 PDF를 쪽마다 JPG(base64)로 그린다
async function pdfToJpegs(base64) {
  const pdfjsLib = await ensurePdfJs();
  const cMapUrl = new URL('./vendor/cmaps/', document.baseURI).href;
  const standardFontDataUrl = new URL('./vendor/standard_fonts/', document.baseURI).href;
  const doc = await pdfjsLib.getDocument({ data: b64ToUint8(base64), isEvalSupported: false, cMapUrl, cMapPacked: true, standardFontDataUrl }).promise;
  try {
    const out = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PHONE_JPEG_LONG_PX / Math.max(unscaled.width, unscaled.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';   // JPG는 투명이 없어 빈 곳이 검게 나오지 않도록 흰 바탕
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      out.push(canvas.toDataURL('image/jpeg', PHONE_JPEG_QUALITY).split(',')[1]);
      canvas.width = 0;   // 큰 그림 메모리 바로 해제
    }
    return out;
  } finally {
    doc.destroy();
  }
}

async function doSaveDrawingNotes(showAlert) {
  const file = drawingState.currentFile;
  if (!file) return;
  const targetFile = drawingState.sourceFile || file;
  const ver = notesVersion;
  const btn = $('pdfSaveNotes');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '저장중..';
  }
  const tr = window.perfTrace?.('save') || null;
  tr?.step('save:start');
  persistNotesNow();

  try {
    const notesAtBuild = structuredClone(drawingState.notes);
    const savedNotes = typeof trimNotesForCell === 'function' ? trimNotesForCell(notesAtBuild) : notesAtBuild;
    const uid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await submitOrQueue({
      id: `drawing_notes:${targetFile.id}:${uid}`,
      action: 'drawing_notes_save',
      kind: 'drawing_notes',
      label: `도면 메모 ${targetFile.name}`,
      payload: {
        fileId: targetFile.id,
        site: drawingState.site,
        fileName: targetFile.name,
        user: $('user')?.value || '',
        data: savedNotes,
      },
    }, true);

    store.set(`pdf_notes_${targetFile.id}`, JSON.stringify(notesAtBuild));
    syncPendingOutboxDrawings();
    if (notesVersion === ver) drawingState.dirty = false;
    tr?.step('save:done');
    tr?.end(result === 'queued' ? 'queued' : 'ok');
    if (btn) btn.textContent = result === 'queued' ? '폰보관✓' : '저장됨✓';
    if (showAlert) {
      alert(result === 'queued'
        ? `'${targetFile.name}' 메모를 이 폰에 보관했습니다. 신호가 잡히면 자동으로 저장됩니다.`
        : `'${targetFile.name}' 도면에 동그라미 메모를 저장했습니다.`);
    }
  } catch (err) {
    tr?.end(err.network ? 'network' : 'error');
    if (err.isAuth) { drawingState.dirty = false; signOut(); closePdfViewer(); return; }
    if (btn) btn.textContent = '저장실패';
    const reason = friendlyError(err, '메모를 저장하지 못했습니다.');
    if (showAlert) alert(`저장하지 못했습니다: ${reason}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { if (btn.textContent !== '저장중..') btn.textContent = '저장'; }, BTN_RESET_MS);
    }
  }
}

// 보관함(outbox.js)이 도면 업로드를 서버에 보낸 뒤: 새 파일을 목록에 넣고, 다시 열 때 0.1초 만에 뜨게 캐시를 채우고,
// 계측용(가상) 도면이 아직 열려 있으면 그 저장본을 연 것으로 바꾼다(이어 적는 값은 저장본 메모·실시간 줄에 그 id 로 남고, 가상 보관분은 치운다)
function onOutboxSent(item, res) {
  if (item?.kind === 'drawing_notes') {
    syncPendingOutboxDrawings();
    const fid = item.payload?.fileId;
    if (fid) {
      if (res?.version && item.payload?.data) {
        idbPut(NOTES_CACHE_STORE, {
          id: String(fid),
          version: res.version,
          updated: res.updated,
          user: item.payload.user || '',
          data: item.payload.data,
        });
      } else {
        idbDelete(NOTES_CACHE_STORE, String(fid));
      }
    }
    if (typeof loadRecent === 'function') loadRecent().catch(() => {});
    return;
  }
  if (item?.kind !== 'drawing' || !res?.file) return;
  const m = item.meta || {};
  const sent = item.payload?.file || {};
  if (sent.base64) putCachedPdfBytes(res.file.id, b64ToUint8(sent.base64));
  if (sent.notes) store.set(`pdf_notes_${res.file.id}`, JSON.stringify(sent.notes));
  if (drawingState.site === m.site) {
    // 옛 서버(subdir 모름)는 현장 폴더 바로 아래에 저장한다. 목록은 이름으로 가르므로 어디에 있든 제 구분에 보인다
    const inFolder = typeof res.folder === 'string' && res.folder.endsWith(`/${m.subdir}`);
    if (!inFolder) console.warn('서버가 옛 버전이라 도면을 현장 폴더에 저장함. Code.gs 를 새 버전으로 배포하면 원본별 폴더에 모입니다');
    upsertDrawingFile(res.file, inFolder ? m.familyName : '');
  }
  if (!m.templateId) return;
  store.remove(`pdf_notes_${m.templateId}`);
  const cur = drawingState.currentFile;
  if (cur?.id !== m.templateId) return;
  drawingState.currentFile = res.file;
  if (shownKey.startsWith(`${cur.id}|`)) shownKey = res.file.id + shownKey.slice(cur.id.length);   // 다음 확대·회전 때 흰 화면이 끼지 않게
  $('pdfTitle').textContent = res.file.name;
}

// 같은 날 다른 폰이 같은 이름으로 먼저 저장한 저장본이 있으면(두 사람이 한 도면을 나눠 적는 날) 그 메모를 받아 합친다. 안 하면 replaceSameName 으로 먼저 적은 값이 PDF 에서 사라진다.
// 목록은 현장을 열 때 받은 것이라 저장 직전에 다시 받는다(왕복 1~3초). 신호가 없거나 실패하면 내 것만 저장한다(원래 동작)
// 같은 이름 저장본과 그 메모를 구한다 → { rival, theirs }. 새 서버는 drawing_rival 한 번(왕복 1회), 그 액션을 모르는 옛 서버(bad_action)나
// 그 요청이 실패하면 예전 길(drawing_list → drawing_notes_get, 왕복 2회)로 다시 한다(웹을 서버보다 먼저 배포해도 깨지지 않게). 접속 코드 오류는 그대로 던진다.
// 예전 길: 목록을 못 받으면 { rival: null }(내 것만 저장), 저장본은 있는데 메모를 못 받으면 rival 오류(덮어쓰지 않음). check: 두 요청 사이에 부르는 확인
async function fetchRival(callApi, site, fileName, excludeId, check = () => {}) {
  try {
    const res = await callApi('drawing_rival', { site, fileName, excludeId });
    return { rival: res?.rival || null, theirs: res?.notes || null };
  } catch (err) {
    if (err.isAuth) throw err;
    if (err.code !== 'bad_action') console.warn('drawing_rival 실패, 예전 방식(목록→메모)으로 확인', err);
  }
  let rival = null;
  try {
    const res = await callApi('drawing_list', { site });
    const files = [...fileListOf(res.files), ...folderListOf(res.folders).flatMap((fo) => fo.files)];
    rival = files.find((f) => f.name === fileName && f.id !== excludeId) || null;
  } catch (err) {
    if (err.isAuth) throw err;
    console.warn('같은 이름 저장본 확인 건너뜀(목록을 못 받음)', err);   // 목록조차 못 받으면 원래대로 내 것만 저장한다
    return { rival: null, theirs: null };
  }
  if (!rival) return { rival: null, theirs: null };
  check();
  try {
    return { rival, theirs: await callApi('drawing_notes_get', { fileId: rival.id }) };
  } catch (err) {
    if (err.isAuth) throw err;
    // 남의 저장본이 있는 건 아는데 그 값을 못 받았으면 덮어쓰지 않는다(적은 값은 폰에 남아 다음 저장 때 다시 시도). rival 표시: 닫으며 저장할 때도 알림을 띄운다
    const e = new Error('다른 폰이 먼저 저장한 같은 이름 도면의 메모를 확인하지 못했습니다. 신호가 잡히면 다시 저장해 주세요.');
    e.rival = true;
    e.network = !!err.network;   // 신호 문제면 보관함이 횟수를 세지 않고 신호가 잡힐 때 다시 한다
    throw e;
  }
}

// 보관함(outbox.js)이 도면 업로드를 보내기 직전에 부른다: 같은 이름 저장본을 다른 폰이 먼저 올렸으면 그 오늘 값을 합치고 PDF 를 다시 만든 항목을 돌려준다.
// 안 하면 replaceSameName 으로 먼저 적은 값이 사라진다. 저장 버튼이 이 왕복(1.5~3초)을 기다리지 않게 여기로 옮겼다.
// 그쪽 메모를 못 받으면 던진다 → 보관함이 올리지 않고 나중에 다시 한다(덮어쓰지 않음)
async function beforeOutboxSend(item) {
  if (item?.kind === 'drawing_notes' && item.payload?.fileId && item.payload?.data) {
    const fileId = item.payload.fileId;
    const theirs = await fetchDrawingNotes(fileId);
    if (!theirs?.updated || !Array.isArray(theirs.data?.pins)) return item;
    const their = normalizeNotes(theirs.data);
    const today = todayKst();
    const merged = mergeNotesForSave(item.payload.data, their, today);
    if (JSON.stringify(merged.pins) === JSON.stringify(item.payload.data.pins)) return item;
    if ((drawingState.sourceFile || drawingState.currentFile)?.id === fileId) {
      drawingState.notes = mergeNotesForSave(drawingState.notes, their, today);
      persistNotesNow();
      renderPagePins();
      updatePageInfo();
    }
    const data = typeof trimNotesForCell === 'function' ? trimNotesForCell(merged) : merged;
    return { ...item, payload: { ...item.payload, data } };
  }
  const r = item?.kind === 'drawing' ? item.meta?.rival : null;
  const sent = item?.payload?.file;
  if (!r || !sent?.notes) return item;
  const { rival, theirs } = await fetchRival(api, item.meta.site, r.fileName, r.excludeId);
  if (!rival || !theirs?.updated || !Array.isArray(theirs.data?.pins)) return item;   // 메모 없이 올린 파일(PC 등)이면 합칠 것이 없다
  const their = normalizeNotes(theirs.data);
  const merged = mergeNotesForSave(sent.notes, their, r.today);
  if (JSON.stringify(merged.pins) === JSON.stringify(sent.notes.pins)) return item;   // 달라진 게 없으면 PDF 를 다시 만들 필요 없다
  // 그 도면이 아직 열려 있으면 화면에도 합친 값을 보여 준다(저장 대상은 아래 merged)
  if (drawingState.currentFile?.id === r.excludeId) {
    drawingState.notes = mergeNotesForSave(drawingState.notes, their, r.today);
    persistNotesNow();
    renderPagePins();
    updatePageInfo();
  }
  const bytes = await getCachedPdfBytes(r.bytesId) || await loadPdfBytes(r.bytesId);
  let base64 = null;
  try {
    await ensurePdfLib();
    base64 = await buildAnnotatedPdfBase64(null, loadPdfForAnnotate(bytes), merged);
  } catch (err) {
    console.warn('합친 메모를 PDF 에 굽지 못해 원본 그대로 올림(메모는 서버에 따로 남음)', err);
    base64 = uint8ToBase64(bytes);
  }
  const notes = typeof trimNotesForCell === 'function' ? trimNotesForCell(merged) : merged;
  return { ...item, payload: { ...item.payload, file: { ...sent, base64, notes } } };
}

// 순수 함수: 내 메모(mine)에 그쪽 메모(theirs)를 합친다. 내 동그라미는 그대로 두고, 그쪽에만 있는 동그라미는 그쪽이 오늘 값을 적은 것만 더한다
// (둘 다 같은 저장본에서 출발했으므로 그쪽에만 남은 옛 동그라미는 내가 오늘 지운 것일 수 있다 — 되살리지 않는다. 한계: 그쪽이 오늘 찍고 값은 안 적은 동그라미는 안 들어온다).
// 같은 동그라미(id)는 내게 오늘 값이 없고 그쪽에 오늘 값이 있을 때만 그쪽 값(text·date·history·author)을 받는다. 둘 다 오늘 값이면 내 것. 필기(strokes)는 내 것만
function mergeNotesForSave(mine, theirs, today) {
  const theirPins = Array.isArray(theirs?.pins) ? theirs.pins.filter((p) => p && p.id) : [];
  const byId = new Map(theirPins.map((p) => [p.id, p]));
  const pins = (mine.pins || []).map((p) => {
    const t = byId.get(p.id);
    const mineToday = !!p.text && p.date === today;
    const theirsToday = !!t?.text && t.date === today;
    return t && theirsToday && !mineToday ? { ...p, text: t.text, date: t.date, history: t.history || p.history, author: t.author || p.author } : p;
  });
  const have = new Set(pins.map((p) => p.id));
  return { ...mine, pins: [...pins, ...theirPins.filter((p) => !have.has(p.id) && !!p.text && p.date === today)] };
}

// 순수 함수: 이어쓰기 — 최근 저장본 템플릿(fresh)을 바탕으로 두고, 폰에 남아 있던 내 미저장분(kept)에서 오늘 값·지난 값 이력·내가 새로 찍은 동그라미만 얹는다.
// (fresh 가 더 새 사슬이다: 그사이 다른 사람이 저장한 지난 값·새 동그라미가 들어온다.) 같은 동그라미의 history 는 둘을 합친다(날짜·값이 같은 것은 하나로, 날짜순, 최대 20)
function mergeResumeNotes(kept, fresh, today) {
  const keptPins = Array.isArray(kept?.pins) ? kept.pins.filter((p) => p && p.id) : [];
  const freshPins = Array.isArray(fresh?.pins) ? fresh.pins.filter((p) => p && p.id) : [];
  const byId = new Map(keptPins.map((p) => [p.id, p]));
  const pins = freshPins.map((f) => {
    const k = byId.get(f.id);
    if (!k) return f;
    const history = unionPinHistory(f.history, k.history);
    const mineToday = !!k.text && k.date === today;
    return mineToday ? { ...f, history, text: k.text, date: k.date, author: k.author || f.author } : { ...f, history };
  });
  const have = new Set(pins.map((p) => p.id));
  const out = { ...fresh, pins: [...pins, ...keptPins.filter((p) => !have.has(p.id))] };
  if (!out.sourceId && kept?.sourceId) out.sourceId = kept.sourceId;
  if (!out.gps && kept?.gps) out.gps = kept.gps;
  return out;
}

function unionPinHistory(a, b) {
  const seen = new Set();
  const out = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .filter((h) => h && typeof h === 'object')
    .filter((h) => { const key = `${h.date}|${h.text}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((x, y) => (String(x.date) < String(y.date) ? -1 : String(x.date) > String(y.date) ? 1 : 0));
  return out.slice(-(typeof MAX_PIN_HISTORY === 'number' ? MAX_PIN_HISTORY : 20));
}

// 원본 도면 하나에서 계측기(범례 종류)별로 PDF를 따로 만들어 올린다. 메모가 있는 종류만, 종류마다 한 파일
async function saveTypedPdfs() {
  const file = drawingState.currentFile;
  if (!file || !drawingState.rawPdfBytes) return;
  const pins = drawingState.notes.pins || [];
  const hasValue = (p) => String(p.text || '').trim() !== '';
  // 값을 적은 종류만 만든다(2026-11-05 결정): 계측용 도면에서 오늘 안 잰 종류까지 번호만 있는 PDF 가 생기면 종류별 폴더에서 '잰 날'과 '안 잰 날'이 섞인다
  const types = PIN_TYPES.filter((t) => pins.some((p) => p.type === t.code && hasValue(p)));
  if (!types.length) {
    alert('값을 적은 계측기 종류가 없습니다. 동그라미에 값을 적은 종류만 계측기별 PDF 로 만듭니다.');
    return;
  }
  const btn = $('pdfSaveTyped');
  btn.disabled = true;
  // 원본 이름에서 .pdf와 날짜 꼬리표를 뗀 이름이 묶음 폴더 이름. 그 안에 종류(수위·굴착고…)마다 폴더를 두어 계측기별로 쌓인다
  const folderName = familyNameOf(file.name, allDrawingFiles());
  const queued = [];
  const failed = [];
  const phoneFiles = [];   // 클라우드에 못 올린 것도 PDF를 만들었으면 폰에는 저장할 수 있다
  for (const t of types) {
    btn.textContent = `${t.name} 만드는 중..`;
    const name = buildSavedDrawingFileName(file.name, new Date()).replace(/(_\d{4}-\d{2}-\d{2}\([일월화수목금토]\)\.pdf)$/, `_${t.name}$1`);
    const savePath = `${folderName}/${t.name}`;
    try {
      const base64 = await buildAnnotatedPdfBase64(t.code);
      phoneFiles.push({ name, base64, folder: savePath });
      // 업로드는 보관함에 넣고 뒤에서 보낸다(다른이름 저장과 같음). 목록 반영은 onOutboxSent
      await submitOrQueue({
        id: `drawing:${crypto.randomUUID()}`,
        action: 'drawing_upload',
        kind: 'drawing',
        label: `계측기별 PDF ${name}`,
        payload: { site: drawingState.site, file: { name, base64, replaceSameName: true, subdir: savePath, user: $('user')?.value || '' } },
        meta: { site: drawingState.site, familyName: folderName, subdir: savePath, templateId: '' },
      }, true);
      queued.push(t.name);
    } catch (err) {
      if (err.isAuth) { btn.disabled = false; btn.textContent = '계측기별 PDF'; drawingState.dirty = false; signOut(); closePdfViewer(); return; }
      failed.push(`${t.name}(${friendlyError(err, 'PDF를 만들지 못했습니다')})`);
    }
  }
  btn.disabled = false;
  btn.textContent = '계측기별 PDF';
  const untyped = pins.filter((p) => !p.type && hasValue(p)).length;
  askPhoneSave([
    queued.length ? `'${folderName}' 폴더로 ${queued.length}개를 올립니다(뒤에서 전송): ${queued.join(', ')}` : '만든 파일이 없습니다',
    failed.length ? `실패: ${failed.join(', ')}` : '',
    untyped ? `종류 없는 메모 ${untyped}개는 계측기별 PDF에 들어가지 않습니다` : '',
  ].filter(Boolean).join('\n'), phoneFiles);
}

function initDrawingModule() {
  requestPersistentStorage();
  renderPinLegend();
  $('pdfSaveTyped')?.addEventListener('click', saveTypedPdfs);
  $('drawingBackSites').addEventListener('click', loadDrawingTab);
  $('drawingViewSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setDrawingView(b.dataset.view); });
  // 검색(search.js): 현장 목록은 줄을 숨기고, 도면 목록은 묶음·파일을 걸러 다시 그린다. search.js 가 없는 옛 사본이면 검색 칸을 숨긴다
  if (typeof attachListSearch === 'function') {
    attachListSearch($('drawingSiteSearch'), $('drawingSiteList'), (li) => li.querySelector('b')?.textContent || '');   // 안내 글(터치하여…)은 빼고 현장 이름만
    $('drawingFileSearch').addEventListener('input', debounce(() => { drawingState.query = $('drawingFileSearch').value; renderDrawingFiles(); }));
  } else {
    for (const id of ['drawingSiteSearch', 'drawingFileSearch']) show($(id), false);
  }
  // 안드로이드는 터치를 놓을 때 커서를 다시 놓아 선택이 풀리므로 한 박자 뒤에 고른다
  $('pinMemoKeyboard').addEventListener('focus', (e) => { if (e.target.dataset.stale) setTimeout(() => e.target.select(), 0); });
  // 안드로이드 앱의 파일 선택 창은 accept의 첫 형식(PDF)만 보여 줄 수 있어 앱에서는 모든 파일을 보이고 uploadDrawingPdf가 거른다
  if (window.AndroidGallery) $('inputDrawingPdf').removeAttribute('accept');
  $('btnUploadDrawing').addEventListener('click', () => $('inputDrawingPdf').click());
  $('inputDrawingPdf').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) uploadDrawingPdf(f);
  });

  $('pdfClose').addEventListener('click', closePdfViewer);
  // 안드로이드 뒤로가기·브라우저 뒤로가기: 뷰어가 열려 있으면 화면을 바꾸지 않고 뷰어만 닫는다
  // 지도(Pro)만 닫힌 뒤로가기는 아직 뷰어 칸(pdfViewer)에 있으므로 뷰어를 닫지 않는다
  window.addEventListener('popstate', () => { if (!$('pdfViewer').classList.contains('hidden') && !history.state?.pdfViewer) hideViewer(); });
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
  $('pdfZoomIn').addEventListener('click', () => zoomStageBy(ZOOM_STEP));
  $('pdfZoomOut').addEventListener('click', () => zoomStageBy(-ZOOM_STEP));
  initStageGestures();
  $('pdfStageWrap')?.addEventListener('scroll', scheduleVisibleTilesDebounced, { passive: true });
  $('pdfRotate').addEventListener('click', () => {
    drawingState.rotation = (drawingState.rotation + 90) % 360;
    closePinMemoBox();
    renderPdfPage();
  });
  $('pdfSaveNotes').addEventListener('click', () => saveDrawingNotesToServer(true));
  $('drawingPhoneAlways').checked = store.get(PHONE_SAVE_KEY) === 'always';
  $('drawingPhoneAlways').addEventListener('change', (e) => (e.target.checked ? store.set(PHONE_SAVE_KEY, 'always') : store.remove(PHONE_SAVE_KEY)));

  $('btnPinMode').addEventListener('click', () => setPinMode(!drawingState.pinMode));
  $('btnPenMode').addEventListener('click', () => setPenMode(!drawingState.penMode));
  $('btnClearInk').addEventListener('click', () => {
    if (!confirm('이 쪽에 그린 자유 펜 필기를 지울까요? (동그라미 메모는 유지됩니다)')) return;
    drawingState.notes.strokes[String(drawingState.pageNum)] = [];
    markDirty();
    redrawPageInk();
    saveDrawingNotesQuiet();
  });

  $('pinNumCancel').addEventListener('click', () => $('pinNumDialog').close('cancel'));
  $('renameCancel').addEventListener('click', () => $('renameDialog').close('cancel'));
  $('pinMemoClose').addEventListener('click', closePinMemoBox);
  $('pinMemoDelete').addEventListener('click', deleteActivePin);

  // 메모 칸을 한 번 더 터치하면 손글씨 펜 입력(OCR) 패드 오픈!
  $('pinMemoDisplay').addEventListener('click', openHandwritingOcrPad);
  $('pinMemoOpenPad').addEventListener('click', openHandwritingOcrPad);
  $('pinMemoKeyboard').addEventListener('input', (e) => updateActivePinText(e.target.value));
  $('pinCells').addEventListener('input', onStrainCellInput);
  $('pinCells').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const inputs = [...$('pinCells').querySelectorAll('input')];
    const i = inputs.indexOf(e.target);
    if (i >= 0 && i < inputs.length - 1) { e.preventDefault(); inputs[i + 1].focus(); }
  });
  $('pinNoteToggle').addEventListener('click', () => setKeypadOpen(true));
  $('pinKeypad').addEventListener('click', onKeypadPress);
  $('pinKeypadClear').addEventListener('click', () => onKeypadPress({ target: { closest: () => ({ dataset: { key: 'clear' } }) } }));

  $('ocrPadClose').addEventListener('click', () => $('ocrPadDialog').close());
  $('ocrPadUndo').addEventListener('click', undoOcrStroke);
  $('ocrPadClear').addEventListener('click', clearOcrPad);
  $('ocrPadRecognize').addEventListener('click', recognizeHandwritingToText);

  initOcrPadEvents();
  initInkCanvasEvents();
}

if (typeof module !== 'undefined') module.exports = { buildSavedDrawingFileName, familyNameOf, classifyDrawing, groupDrawings, negateIfPlainNumber, toView, fromView, normalizeNotes, friendlyError, sourceFileOf, mergeNotesForSave, mergeResumeNotes, PIN_TYPES, annotationBounds, placeOcrInCells, pinItems, strainCells, joinStrainCells, pressNoteKey, parseNote, liveNote, pdfPlacement, filterDrawingGroups, prefetchLimit, PREFETCH_COUNT, PREFETCH_MAX, fetchRival, prefetchOriginals, drawingState, pickEvictions, cacheBudgetOf, resolveNotesResponse, shouldUseTiles, planVisibleTiles };
