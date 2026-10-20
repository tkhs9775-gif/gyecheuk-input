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

let pdfjsLoaded = null;
let tesseractLoaded = null;

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

const drawingState = {
  site: '',
  files: [],
  currentFile: null,
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

// ---------- 1단계: 현장명 목록 화면 ----------

function loadDrawingTab() {
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
    // 캐시된 PDF가 있는지 먼저 확인하고 없으면 서버에서 다운로드
    let base64 = store.get(`pdf_b64_${file.id}`);
    if (!base64) {
      const dl = await api('drive_download', { fileId: file.id });
      base64 = dl.base64;
      // 용량이 너무 크지 않으면 로컬에도 캐시
      if (base64 && base64.length < 3500000) store.set(`pdf_b64_${file.id}`, base64);
    }
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    // 저장된 야장 데이터(동그란 원 메모 + 자유 필기) 불러오기
    try {
      const noteRes = await api('drawing_notes_get', { fileId: file.id });
      drawingState.notes = noteRes.data && Array.isArray(noteRes.data.pins)
        ? { pins: noteRes.data.pins, strokes: noteRes.data.strokes || {} }
        : { pins: [], strokes: {} };
      store.set(`pdf_notes_${file.id}`, JSON.stringify(drawingState.notes));
    } catch {
      const localNotes = readCached(`pdf_notes_${file.id}`);
      drawingState.notes = localNotes || { pins: [], strokes: {} };
    }

    drawingState.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
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

// ---------- 5단계: 메모 박스 한 번 더 터치 → 손글씨 펜 필기 & OCR 자동 텍스트 변환 ----------

let ocrDrawing = false;
let ocrHasInk = false;

function openHandwritingOcrPad() {
  if (!drawingState.activePinId) return;
  clearOcrPad();
  $('ocrStatus').textContent = '펜이나 손가락으로 글씨·숫자를 쓴 뒤 [필체 판독하여 텍스트로 넣기]를 누르세요.';
  $('ocrPadDialog').showModal();
}

function clearOcrPad() {
  const c = $('ocrPadCanvas');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ocrHasInk = false;
}

function initOcrPadEvents() {
  const c = $('ocrPadCanvas');
  const ctx = c.getContext('2d');

  const pt = (e) => {
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    ocrDrawing = true;
    ocrHasInk = true;
    const p = pt(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });

  c.addEventListener('pointermove', (e) => {
    if (!ocrDrawing) return;
    const p = pt(e);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000000';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  const stop = () => { ocrDrawing = false; };
  c.addEventListener('pointerup', stop);
  c.addEventListener('pointercancel', stop);
}

async function recognizeHandwritingToText() {
  if (!ocrHasInk) {
    $('ocrStatus').textContent = '먼저 흰 칸에 글씨나 숫자를 써 주세요!';
    return;
  }
  const btn = $('ocrPadRecognize');
  btn.disabled = true;
  $('ocrStatus').textContent = '🔍 필체를 OCR로 판독하여 텍스트로 변환하는 중입니다...';

  try {
    const c = $('ocrPadCanvas');
    const dataUrl = c.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    let recognized = '';

    // 1순위: 서버(Google Drive OCR) 시도
    if (navigator.onLine !== false) {
      try {
        const srv = await api('ocr_handwriting', { base64 });
        if (srv && srv.text) recognized = srv.text.trim();
      } catch { /* 클라이언트 OCR로 진행 */ }
    }

    // 2순위: 브라우저 내장 Tesseract.js 한국어+영어+숫자 OCR 엔진 실행
    if (!recognized) {
      const Tesseract = await ensureTesseract();
      const { data } = await Tesseract.recognize(dataUrl, 'kor+eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            $('ocrStatus').textContent = `🔍 필체 판독 중... (${Math.round((m.progress || 0) * 100)}%)`;
          }
        },
      });
      recognized = (data?.text || '').replace(/\s+/g, ' ').trim();
    }

    if (!recognized) {
      $('ocrStatus').textContent = '글씨를 명확히 인식하지 못했습니다. 조금 더 크게 다시 써보시거나 아래 키보드 칸을 이용해 주세요.';
      return;
    }

    const pin = drawingState.notes.pins.find((p) => p.id === drawingState.activePinId);
    const merged = pin && pin.text ? `${pin.text} ${recognized}` : recognized;
    updateActivePinText(merged);
    $('ocrPadDialog').close();
  } catch (err) {
    $('ocrStatus').textContent = `OCR 판독 실패: ${err.message}`;
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

// ---------- 야장 저장 ----------

let saveNotesTimer = null;
function saveDrawingNotesQuiet() {
  if (!drawingState.currentFile) return;
  store.set(`pdf_notes_${drawingState.currentFile.id}`, JSON.stringify(drawingState.notes));
  clearTimeout(saveNotesTimer);
  saveNotesTimer = setTimeout(() => {
    saveDrawingNotesToServer(false);
  }, 1200);
}

async function saveDrawingNotesToServer(showAlert = true) {
  const file = drawingState.currentFile;
  if (!file) return;
  const btn = $('pdfSaveNotes');
  btn.textContent = '저장중..';
  store.set(`pdf_notes_${file.id}`, JSON.stringify(drawingState.notes));
  try {
    await api('drawing_notes_save', {
      fileId: file.id,
      site: drawingState.site,
      fileName: file.name,
      user: $('user')?.value || '',
      data: drawingState.notes,
    });
    drawingState.dirty = false;
    btn.textContent = '저장됨✓';
    setTimeout(() => { btn.textContent = '저장'; }, 2000);
  } catch (err) {
    btn.textContent = '폰보관✓';
    if (showAlert) alert('신호가 약해 이 휴대폰에 야장 메모를 보관했습니다.');
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
  $('ocrPadClear').addEventListener('click', clearOcrPad);
  $('ocrPadRecognize').addEventListener('click', recognizeHandwritingToText);

  initOcrPadEvents();
  initInkCanvasEvents();
}
