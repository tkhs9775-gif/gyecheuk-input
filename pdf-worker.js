// 도면 백그라운드 렌더 워커(모듈 워커): pdf.js 의 페이지 그리기(Canvas2D)와 타일 그리기를 화면 스레드 밖 OffscreenCanvas 에서 실행한다.
// 화면(drawing.js)이 버벅이지 않고, 확대한 부분만 512px 타일로 고해상도 렌더링한 뒤 ImageBitmap(무복사 전송)으로 넘긴다.
const V = new URL(self.location.href).searchParams.get('v') || '-';

class OffscreenCanvasFactory {
  constructor({ enableHWA = false } = {}) {
    this._enableHWA = enableHWA;
  }
  create(w, h) {
    const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: !this._enableHWA }) };
  }
  reset(entry, w, h) {
    entry.canvas.width = Math.max(1, Math.ceil(w));
    entry.canvas.height = Math.max(1, Math.ceil(h));
  }
  destroy(entry) {
    if (!entry?.canvas) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

class NoopFilterFactory {
  constructor() {}
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  destroy() {}
}

const CMAP_URL = new URL('./vendor/cmaps/', self.location.href).href;
const STANDARD_FONT_URL = new URL('./vendor/standard_fonts/', self.location.href).href;

let libP = null;
let nestedPdfWorker = null;
async function ensureLib() {
  if (!libP) {
    libP = import(`./vendor/pdf4.min.js?v=${V}`).then(() => {
      const lib = globalThis.pdfjsLib;
      if (!lib?.getDocument) throw new Error('pdf.js load failed in worker');
      const workerUrl = new URL(`./vendor/pdf4.worker.min.js?v=${V}`, self.location.href).href;
      if (!nestedPdfWorker && typeof Worker !== 'undefined') {
        try {
          nestedPdfWorker = new Worker(workerUrl, { type: 'module' });
          lib.GlobalWorkerOptions.workerPort = nestedPdfWorker;
        } catch {
          lib.GlobalWorkerOptions.workerSrc = workerUrl;
        }
      } else if (!lib.GlobalWorkerOptions.workerPort) {
        lib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return lib;
    }).catch((err) => {
      libP = null;
      throw err;
    });
  }
  return libP;
}

let doc = null;
let docSeq = 0;
let docOpen = false;
const pageCache = new Map();
let minSeq = 0;
let active = null;   // { docSeq, seq, jobId, task }
const queue = [];
let pumping = false;

const isStale = (dSeq, rSeq) => !docOpen || dSeq !== docSeq || rSeq < minSeq;

function cancelObsoleteQueue() {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i];
    if (isStale(item.docSeq, item.seq)) {
      queue.splice(i, 1);
      self.postMessage({ type: 'cancelled', jobId: item.jobId });
    }
  }
  if (active && isStale(active.docSeq, active.seq)) {
    try { active.task?.cancel(); } catch { /* ignore */ }
  }
}

function getPageCached(pageNum) {
  if (!doc) throw new Error('no open pdf document');
  if (!pageCache.has(pageNum)) {
    pageCache.set(pageNum, doc.getPage(pageNum));
  }
  return pageCache.get(pageNum);
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      cancelObsoleteQueue();
      const job = queue.shift();
      if (!job) continue;
      if (isStale(job.docSeq, job.seq)) {
        self.postMessage({ type: 'cancelled', jobId: job.jobId });
        continue;
      }
      let canvas = null;
      try {
        const page = await getPageCached(job.pageNum);
        if (isStale(job.docSeq, job.seq)) {
          self.postMessage({ type: 'cancelled', jobId: job.jobId });
          continue;
        }
        const viewport = page.getViewport({
          scale: job.renderScale,
          rotation: job.rotation,
          offsetX: job.offsetX || 0,
          offsetY: job.offsetY || 0,
        });
        const w = Math.max(1, Math.round(job.pixelW || viewport.width));
        const h = Math.max(1, Math.round(job.pixelH || viewport.height));
        canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const task = page.render({
          canvasContext: ctx,
          viewport,
          background: 'rgb(255,255,255)',
        });
        active = { docSeq: job.docSeq, seq: job.seq, jobId: job.jobId, task };
        await task.promise;
        if (isStale(job.docSeq, job.seq)) {
          canvas.width = 0;
          self.postMessage({ type: 'cancelled', jobId: job.jobId });
          continue;
        }
        const bitmap = canvas.transferToImageBitmap();
        canvas.width = 0;
        self.postMessage({ type: 'rendered', jobId: job.jobId, seq: job.seq, bitmap }, [bitmap]);
      } catch (err) {
        if (canvas) canvas.width = 0;
        if (err?.name === 'RenderingCancelledException' || isStale(job.docSeq, job.seq)) {
          self.postMessage({ type: 'cancelled', jobId: job.jobId });
        } else {
          self.postMessage({ type: 'error', jobId: job.jobId, message: String(err?.message || err) });
        }
      } finally {
        active = null;
      }
    }
  } finally {
    pumping = false;
  }
}

function detachDoc() {
  const prev = doc;
  doc = null;
  pageCache.clear();
  cancelObsoleteQueue();
  if (prev) prev.destroy().catch(() => {});
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'warm') {
      await ensureLib();
      self.postMessage({ type: 'warmed', jobId: data.jobId });
      return;
    }
    if (data.type === 'open') {
      const targetSeq = data.docSeq;
      if (targetSeq <= docSeq) { self.postMessage({ type: 'cancelled', jobId: data.jobId }); return; }
      docSeq = targetSeq;
      docOpen = true;
      detachDoc();
      const lib = await ensureLib();
      if (!docOpen || docSeq !== targetSeq) { self.postMessage({ type: 'cancelled', jobId: data.jobId }); return; }
      const opts = {
        data: data.bytes,
        isEvalSupported: false,
        CanvasFactory: OffscreenCanvasFactory,
        canvasFactory: new OffscreenCanvasFactory(),
        FilterFactory: NoopFilterFactory,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_URL,
        useWorkerFetch: true,
        ownerDocument: self.fonts ? { fonts: self.fonts, baseURI: data.baseURI } : { baseURI: data.baseURI },
        disableFontFace: !self.fonts,
      };
      const opened = await lib.getDocument(opts).promise;
      if (!docOpen || docSeq !== targetSeq) {
        try { await opened.destroy(); } catch { /* ignore */ }
        self.postMessage({ type: 'cancelled', jobId: data.jobId });
        return;
      }
      doc = opened;
      self.postMessage({ type: 'opened', jobId: data.jobId, docSeq: targetSeq, numPages: opened.numPages });
      return;
    }
    if (data.type === 'pageDims') {
      if (!docOpen || data.docSeq !== docSeq || !doc) { self.postMessage({ type: 'cancelled', jobId: data.jobId }); return; }
      const page = await getPageCached(data.pageNum);
      if (!docOpen || data.docSeq !== docSeq) { self.postMessage({ type: 'cancelled', jobId: data.jobId }); return; }
      const rotation = (page.rotate + (data.userRotation || 0)) % 360;
      const vp = page.getViewport({ scale: 1, rotation });
      self.postMessage({ type: 'pageDims', jobId: data.jobId, rotate: rotation, width: vp.width, height: vp.height });
      return;
    }
    if (data.type === 'render') {
      if (isStale(data.docSeq, data.seq) || !doc) {
        self.postMessage({ type: 'cancelled', jobId: data.jobId });
        return;
      }
      queue.push(data);
      pumpQueue();
      return;
    }
    if (data.type === 'cancelBelow') {
      if ((!data.docSeq || data.docSeq === docSeq) && data.minSeq > minSeq) {
        minSeq = data.minSeq;
        cancelObsoleteQueue();
      }
      return;
    }
    if (data.type === 'close') {
      if (data.docSeq === docSeq) {
        docOpen = false;
        detachDoc();
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', jobId: data.jobId, message: String(err?.message || err) });
  }
};
