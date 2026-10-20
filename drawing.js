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

let pdfjsLoaded = null;
let tesseractLoaded = null;
let pdflibLoaded = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`라이브러리를 불러올 수 없습니다: ${src}`));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  pdfjsLoaded ??= loadScriptOnce(PDFJS_CDN).then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window.pdfjsLib;
  });
  return pdfjsLoaded;
}

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  tesseractLoaded ??= loadScriptOnce(TESSERACT_CDN).then(() => window.Tesseract);
  return tesseractLoaded;
}

async function ensurePdfLib() {
  if (window.PDFLib) return window.PDFLib;
  pdflibLoaded ??= loadScriptOnce(PDFLIB_CDN).then(() => window.PDFLib);
  return pdflibLoaded;
}

// 원본 파일명에서 확장자(.pdf)와 기존 날짜 꼬리표(_YYYY-MM-DD(요) 또는 _YYYYMMDD(요))를 떼고
// '원본이름_YYYY-MM-DD(요일한글자).pdf' 형태의 새 파일명을 만든다.
function buildSavedDrawingFileName(originalName, now = new Date()) {
  const withoutExt = String(originalName || '도면').replace(/\.pdf$/i, '').trim();
  const baseName = withoutExt.replace(/_\d{4}-?\d{2}-?\d{2}\([일월화수목금토]\)$/, '').trim() || '도면';
  const ymdStr = now.toLocaleDateString('sv-SE');
  const dayChar = WEEKDAYS_KO[now.getDay()];
  return `${baseName}_${ymdStr}(${dayChar}).pdf`;
}

const drawingState = {
  site: '',
  files: [],
  currentFile: null,
  rawPdfBytes: null,
  pdfDoc: null,
  pageNum: 1,
  pageCount: 1,
  scale: 1.25,
  pinMode: false,
  penMode: false,
  notes: { pins: [], strokes: {} }, // pins: [{ id, page, x, y, text, author, time }], strokes: { [page]: [ [{x,y}, ...] ] }
  activePinId: null,
  dirty: false,
};

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

const prefetchInFlight = new Set();
async function prefetchPdfToCache(fileId) {
  if (!fileId || prefetchInFlight.has(fileId)) return;
  if (await getCachedPdfBytes(fileId)) return;
  prefetchInFlight.add(fileId);
  try {
    const dl = await api('drive_download', { fileId });
    if (dl && dl.base64) {
      await putCachedPdfBytes(fileId, b64ToUint8(dl.base64));
    }
  } catch { /* ignore */ } finally {
    prefetchInFlight.delete(fileId);
  }
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

async function openSiteDrawingFolder(site) {
  drawingState.site = site;
  $('drawingSiteTitle').textContent = `${site} 도면`;
  $('drawingFolderNote').textContent = '도면 폴더를 불러오는 중...';
  $('drawingFileList').replaceChildren();
  show($('drawingSitesView'), false);
  show($('drawingFilesView'), true);

  try {
    const res = await api('drawing_list', { site });
    drawingState.files = res.files || [];
    store.set(`drawings_${site}`, JSON.stringify(drawingState.files));
    renderDrawingFiles();
    // 폴더 내 도면들을 백그라운드로 미리 휴대폰에 받아두어 터치 시 0.1초 만에 열리게 한다!
    drawingState.files.slice(0, 6).forEach((f) => prefetchPdfToCache(f.id));
  } catch (err) {
    const cached = readCached(`drawings_${site}`);
    if (cached) {
      drawingState.files = cached;
      renderDrawingFiles();
      $('drawingFolderNote').textContent = '신호가 약해 이전에 불러온 도면 목록을 표시합니다.';
    } else {
      $('drawingFolderNote').textContent = `도면 목록을 불러오지 못했습니다: ${errorText(err)}`;
    }
  }
}

function renderDrawingFiles() {
  const files = drawingState.files;
  $('drawingFolderNote').textContent = files.length
    ? `PDF 도면 ${files.length}개 · 터치하면 전체화면 야장으로 열립니다.`
    : '아직 이 현장 폴더에 등록된 PDF 도면이 없습니다. [＋ PDF 도면 추가]로 올려주세요.';

  const ul = $('drawingFileList');
  if (files.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '등록된 PDF 도면 파일이 없습니다.';
    ul.replaceChildren(li);
    return;
  }

  ul.replaceChildren(...files.map((f) => {
    const li = document.createElement('li');
    li.className = 'tap';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = `📄 ${f.name}`;
    const sub = document.createElement('small');
    sub.textContent = `${f.updated || ''} · ${fmtSize(f.size || 0)} · 터치하여 야장 열기`;
    meta.append(b, sub);
    const badge = document.createElement('div');
    badge.className = 'val';
    badge.style.fontSize = '15px';
    badge.style.color = '#1F62A8';
    badge.textContent = '야장 열기';
    li.append(meta, badge);
    li.addEventListener('click', () => openPdfFieldbook(f));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPdfFieldbook(f); });
    return li;
  }));
}

async function uploadDrawingPdf(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    alert('PDF 파일(.pdf)만 도면으로 올릴 수 있습니다.');
    return;
  }
  const btn = $('btnUploadDrawing');
  btn.disabled = true;
  $('drawingFolderNote').textContent = `'${file.name}' 도면을 클라우드 폴더에 올리는 중...`;
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
    alert(`도면 업로드 실패: ${errorText(err)}`);
    renderDrawingFiles();
  } finally {
    btn.disabled = false;
  }
}

// ---------- 3단계: PDF 전체화면 야장 뷰어 ----------

async function openPdfFieldbook(file) {
  drawingState.currentFile = file;
  drawingState.pageNum = 1;
  drawingState.scale = 1.25;
  drawingState.activePinId = null;
  drawingState.dirty = false;
  setPinMode(false);
  setPenMode(false);
  closePinMemoBox();

  $('pdfTitle').textContent = file.name;
  $('pdfPageInfo').textContent = '도면 불러오는 중...';
  show($('pdfViewer'), true);

  try {
    const pdfjsLib = await ensurePdfJs();

    // 1) IndexedDB 고속 캐시 확인 + 2) 야장 메모 조회를 병렬로 동시에 실행!
    const [cachedBytes, noteRes] = await Promise.all([
      getCachedPdfBytes(file.id),
      api('drawing_notes_get', { fileId: file.id }).catch(() => null),
    ]);

    let bytes = cachedBytes;
    if (!bytes) {
      const legacyB64 = store.get(`pdf_b64_${file.id}`);
      if (legacyB64) {
        bytes = b64ToUint8(legacyB64);
      } else {
        const dl = await api('drive_download', { fileId: file.id });
        bytes = b64ToUint8(dl.base64);
      }
      putCachedPdfBytes(file.id, bytes);
    }
    drawingState.rawPdfBytes = bytes.slice();

    if (noteRes && noteRes.data && Array.isArray(noteRes.data.pins)) {
      drawingState.notes = { pins: noteRes.data.pins, strokes: noteRes.data.strokes || {} };
      store.set(`pdf_notes_${file.id}`, JSON.stringify(drawingState.notes));
    } else {
      const localNotes = readCached(`pdf_notes_${file.id}`);
      drawingState.notes = localNotes || { pins: [], strokes: {} };
    }

    drawingState.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    drawingState.pageCount = drawingState.pdfDoc.numPages;
    await renderPdfPage();
  } catch (err) {
    alert(`PDF 도면을 열지 못했습니다: ${errorText(err)}`);
    show($('pdfViewer'), false);
  }
}

async function renderPdfPage() {
  if (!drawingState.pdfDoc) return;
  const page = await drawingState.pdfDoc.getPage(drawingState.pageNum);
  const wrapW = Math.max(320, $('pdfStageWrap').clientWidth - 24);
  const unscaled = page.getViewport({ scale: 1 });
  const fitScale = (wrapW / unscaled.width) * drawingState.scale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: fitScale * dpr });

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

  await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport }).promise;
  $('pdfPageInfo').textContent = `${drawingState.pageNum} / ${drawingState.pageCount}쪽 · 마커 ${currentPagePins().length}개`;
  redrawPageInk();
  renderPagePins();
}

function currentPagePins() {
  return (drawingState.notes.pins || []).filter((p) => p.page === drawingState.pageNum);
}

// ---------- 4단계: 왼쪽 하단 동그란 원(마커) 모드 & 메모 박스 ----------

function setPinMode(on) {
  drawingState.pinMode = on;
  if (on) setPenMode(false);
  $('btnPinMode').setAttribute('aria-pressed', String(on));
  $('pinModeLabel').textContent = on ? '도면을 터치하세요 (ON)' : '동그라미 메모';
  $('pinLayer').classList.toggle('pin-mode-active', on);
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
  const pins = currentPagePins();
  layer.replaceChildren(...pins.map((pin, idx) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pdf-pin${pin.id === drawingState.activePinId ? ' selected' : ''}`;
    el.style.left = `${(pin.x * 100).toFixed(2)}%`;
    el.style.top = `${(pin.y * 100).toFixed(2)}%`;
    el.textContent = String(idx + 1);
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
  const x = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
  const y = Math.max(0.02, Math.min(0.98, (e.clientY - rect.top) / rect.height));
  const newPin = {
    id: crypto.randomUUID(),
    page: drawingState.pageNum,
    x,
    y,
    text: '',
    author: $('user')?.value || '',
    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
  };
  drawingState.notes.pins.push(newPin);
  drawingState.dirty = true;
  renderPagePins();
  $('pdfPageInfo').textContent = `${drawingState.pageNum} / ${drawingState.pageCount}쪽 · 마커 ${currentPagePins().length}개`;
  openPinMemoBox(newPin.id);
  saveDrawingNotesQuiet();
}

function openPinMemoBox(pinId) {
  const pin = drawingState.notes.pins.find((p) => p.id === pinId);
  if (!pin) return;
  drawingState.activePinId = pinId;
  const idx = currentPagePins().findIndex((p) => p.id === pinId) + 1;
  $('pinMemoTitle').textContent = `⭕ 동그라미 #${idx} 메모`;
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
  $('pdfPageInfo').textContent = `${drawingState.pageNum} / ${drawingState.pageCount}쪽 · 마커 ${currentPagePins().length}개`;
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
  const res = await fetch(GOOGLE_HANDWRITING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json && json[0] === 'SUCCESS' && Array.isArray(json[1]?.[0]?.[1])) {
    return json[1][0][1].map((s) => String(s).trim()).filter(Boolean);
  }
  return [];
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
      if (list.length > 0) {
        renderOcrCandidates(list);
        $('ocrStatus').textContent = `실시간 판독: 「${list[0]}」 — 위 후보를 바로 터치하거나 아래 확인 버튼을 누르세요.`;
      }
    } catch { /* ignore live preview errors */ }
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
    $('ocrStatus').textContent = `판독 실패: ${err.message}`;
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
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * 10000) / 10000,
      y: Math.round(((e.clientY - r.top) / r.height) * 10000) / 10000,
    };
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

  c.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    stroke.push(pt(e));
    redrawPageInk();
  });

  const end = () => {
    if (!stroke) return;
    stroke = null;
    saveDrawingNotesQuiet();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

function redrawPageInk() {
  const c = $('inkCanvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const strokes = drawingState.notes.strokes?.[String(drawingState.pageNum)] || [];
  ctx.strokeStyle = '#E53935';
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (!s.length) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x * c.width, s[0].y * c.height);
    for (let i = 1; i < s.length; i += 1) {
      ctx.lineTo(s[i].x * c.width, s[i].y * c.height);
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
function renderPageAnnotationsPng(pageIndex1Based, widthPx, heightPx) {
  const pagePins = (drawingState.notes.pins || []).filter((p) => p.page === pageIndex1Based);
  const pageStrokes = drawingState.notes.strokes?.[String(pageIndex1Based)] || [];
  if (!pagePins.length && !pageStrokes.length) return null;

  const c = document.createElement('canvas');
  c.width = Math.round(widthPx * 2);
  c.height = Math.round(heightPx * 2);
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);

  // 1) 자유 펜 필기 그리기
  ctx.strokeStyle = '#E53935';
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
  pagePins.forEach((pin, idx) => {
    const cx = pin.x * widthPx;
    const cy = pin.y * heightPx;
    const r = 13;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(229, 57, 53, 0.94)';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px "Noto Sans KR", "Malgun Gothic", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(idx + 1), cx, cy);

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
      ctx.roundRect(bx, by, boxW, boxH, 5);
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
async function buildAnnotatedPdfBase64() {
  const PDFLib = await ensurePdfLib();
  const pdfDoc = await PDFLib.PDFDocument.load(drawingState.rawPdfBytes);
  const pages = pdfDoc.getPages();

  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const { width, height } = p.getSize();
    const pngUrl = renderPageAnnotationsPng(i + 1, width, height);
    if (!pngUrl) continue;
    const pngImage = await pdfDoc.embedPng(pngUrl);
    p.drawImage(pngImage, { x: 0, y: 0, width, height });
  }

  const outBytes = await pdfDoc.save();
  return uint8ToBase64(outBytes);
}

let saveNotesTimer = null;
function saveDrawingNotesQuiet() {
  if (!drawingState.currentFile) return;
  store.set(`pdf_notes_${drawingState.currentFile.id}`, JSON.stringify(drawingState.notes));
}

async function saveDrawingNotesToServer(showAlert = true) {
  const file = drawingState.currentFile;
  if (!file) return;
  const btn = $('pdfSaveNotes');
  btn.disabled = true;
  btn.textContent = '저장중..';
  store.set(`pdf_notes_${file.id}`, JSON.stringify(drawingState.notes));

  const newFileName = buildSavedDrawingFileName(file.name, new Date());

  try {
    // 1) 원본 파일에도 야장 메모 JSON은 보존해 두고,
    // 2) '원본이름_수정날짜(요일한글자).pdf' 로 야장 메모가 합쳐진 새 PDF를 다른 이름으로 저장!
    let pdfBase64 = store.get(`pdf_b64_${file.id}`);
    if (drawingState.rawPdfBytes) {
      try {
        pdfBase64 = await buildAnnotatedPdfBase64();
      } catch {
        pdfBase64 = uint8ToBase64(drawingState.rawPdfBytes);
      }
    }

    const res = await api('drawing_upload', {
      site: drawingState.site,
      file: {
        name: newFileName,
        base64: pdfBase64,
        replaceSameName: true,
        user: $('user')?.value || '',
        notes: drawingState.notes,
      },
    });

    if (res.file) {
      // 새로 저장한 파일도 즉시 IndexedDB 캐시에 넣어 다시 열 때 0.1초 만에 뜨도록 함
      if (pdfBase64) putCachedPdfBytes(res.file.id, b64ToUint8(pdfBase64));
      drawingState.files = [res.file, ...drawingState.files.filter((f) => f.name !== res.file.name && f.id !== res.file.id)];
      store.set(`drawings_${drawingState.site}`, JSON.stringify(drawingState.files));
      store.set(`pdf_notes_${res.file.id}`, JSON.stringify(drawingState.notes));
      $('pdfTitle').textContent = res.file.name;
      renderDrawingFiles();
    }

    drawingState.dirty = false;
    btn.textContent = '저장됨✓';
    if (showAlert) alert(`'${newFileName}' 이름으로 도면 폴더에 새로 저장되었습니다!`);
    setTimeout(() => { btn.textContent = '다른이름 저장'; }, 2200);
  } catch (err) {
    btn.textContent = '폰보관✓';
    if (showAlert) alert(`신호가 약해 이 휴대폰에 먼저 보관했습니다: ${errorText(err)}`);
  } finally {
    btn.disabled = false;
  }
}

function initDrawingModule() {
  $('drawingBackSites').addEventListener('click', loadDrawingTab);
  $('btnUploadDrawing').addEventListener('click', () => $('inputDrawingPdf').click());
  $('inputDrawingPdf').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) uploadDrawingPdf(f);
  });

  $('pdfClose').addEventListener('click', async () => {
    if (drawingState.dirty) await saveDrawingNotesToServer(false);
    show($('pdfViewer'), false);
    closePinMemoBox();
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

if (typeof module !== 'undefined') module.exports = { buildSavedDrawingFileName };
