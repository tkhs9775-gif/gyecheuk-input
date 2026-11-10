'use strict';
// CAD 탭: 폰에서 DWG·DXF 를 직접 열어 보는 뷰어(DWG FastView 의 보기·측정 기능을 우리 방식으로 새로 만든 것).
// 엔진: libredwg(wasm, cad-worker.js 에서 읽음) + cad-engine.js(그릴 목록·도각 찾기·스냅·측정). 보기 값은 cadcraft mechanics.json.
// 기능: 이동·두 손가락 확대·두 번 눌러 확대·전체보기 / 돋보기+스냅(끝점·중간점·중심·사분점·삽입점) / 거리·면적·좌표(X·Y 바꾸기)·측정 기록 /
//       펜 표시 / 도면층 켜고 끄기 / 글자 찾기 / 블록 개수 / 뷰 태그(화면 위치 저장) / 배경 3색 / 최근 파일 /
//       PDF 만들기: [도각 추적]으로 도면 틀마다 한 쪽 → 현장 고르기(검색) → 클라우드 도면/<현장>/DWG변환/ 에 올림 → 폰에도 저장할지 물음.
// ponytail: 모형 공간만 본다(배치 탭 X), 선 종류·굵기 X. 편집 기능은 계측앱의 일이 아니라 넣지 않았다.
// CADPocket: rea 로 만든 cadcraft 뷰어(Rust+egui, ../cadpocket)를 wasm 으로 빌드해 vendor/cadpocket 에 둔다. 도면을 열면 먼저 이 화면이 뜨고,
// 그 화면의 [PDF 만들기]·[◀ 닫기]·[열기] 는 아래 JS 가 받는다. 도각 추적·PDF·현장 저장은 JS 뷰어(아래)가 한다.

const CAD_SUBDIR = 'DWG변환';                 // DWG 에서 만든 PDF 가 들어가는 폴더: 도면/<현장>/DWG변환/ (도면 탭에서도 이 폴더로 보인다)
const CAD_MAX_FILE = 80 * 1024 * 1024;
const CAD_RECENT_MAX = 8;
const CAD_PDF_LONG_PX = 3508;                 // PDF 한 쪽 그림의 긴 변(A3 약 212dpi, A4 300dpi)
const CAD_PDF_LONG_PT = 1190.55;              // A3 긴 변(420mm)
const CAD_PDF_LINE_PX = 1.6;
const CAD_PDF_JPEG_Q = 0.9;
const CAD_PDF_SPLIT_BYTES = 16 * 1024 * 1024; // 서버 한도(18MB) 아래에서 파일을 나눈다
const CAD_HOLD_MS = 280;                      // 측정 도구에서 이만큼 누르고 있으면 돋보기
const CAD_TEXT_MIN_PX = 1.6;
const CAD_BG = { dark: '#22282F', white: '#FFFFFF', gray: '#8E979F' };
const CAD_BG_NAMES = { dark: '검정', white: '흰색', gray: '회색' };
const CAD_FONT = '"Malgun Gothic","Noto Sans KR","Apple SD Gothic Neo",sans-serif';
const CAD_MARK = '#FF5A36';
const CAD_FRAME = '#3781C9';

const cad = {
  name: '', model: null, frames: [], clusters: [], order: null, snapIdx: null,
  view: { cx: 0, cy: 0, s: 1 }, bg: 'dark', tool: 'pan',   // bg·swapXY 는 initCad 가 폰 보관값으로(store 는 app.js 가 나중에 만든다)
  cur: [], meas: [], ink: [], tags: [], swapXY: true,
  showFrames: false, pick: new Set(), mono: true, worker: null, dirty: false,
};

// ---------- 최근 파일(폰 보관) ----------

let cadDbP = null;
function cadDb() {
  cadDbP ??= new Promise((res, rej) => {
    const rq = indexedDB.open('gyecheuk_cad', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('files', { keyPath: 'name' });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => { cadDbP = null; rej(rq.error); };
  });
  return cadDbP;
}
async function cadIdb(mode, fn) {
  const db = await cadDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', mode), st = tx.objectStore('files');
    const rq = fn(st);
    tx.oncomplete = () => res(rq?.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}
const cadRecentList = async () => ((await cadIdb('readonly', (s) => s.getAll()).catch(() => [])) || []).sort((a, b) => b.at - a.at);
// 보관 열쇠(name)는 폰에서 연 파일이면 파일 이름, 클라우드에서 받은 파일이면 'cloud:<파일ID>'(extra.key). 화면에는 title(파일 이름)을 보인다
async function cadRemember(name, buf, extra = {}) {
  const { key, ...more } = extra;
  try {
    await cadIdb('readwrite', (s) => s.put({ ...more, name: key || name, title: name, buf, size: buf.byteLength, at: Date.now() }));
    const all = await cadRecentList();
    for (const old of all.slice(CAD_RECENT_MAX)) await cadIdb('readwrite', (s) => s.delete(old.name));
  } catch (err) { console.warn('최근 도면 보관 실패', err); }
}

// ---------- 1단계: 열기 화면 ----------

function loadCadTab() {
  if (typeof renderCadSites === 'function') { showCadSites(true); renderCadSites(); }
  renderCadRecent();
}

async function renderCadRecent() {
  const ul = $('cadRecent');
  const list = await cadRecentList();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 연 도면이 없습니다. 위의 [DWG·DXF 열기]로 폰에 있는 도면을 골라 주세요.';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...list.map((f) => {
    const li = document.createElement('li');
    li.className = 'tap';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = f.title || f.name;
    const b = document.createElement('b'); b.textContent = `📐 ${title}`;
    const sm = document.createElement('small'); sm.textContent = `${f.site ? `☁ ${f.site} · ` : ''}${(f.size / MB).toFixed(1)}MB · ${new Date(f.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    meta.append(b, sm);
    const v = document.createElement('div'); v.className = 'val'; v.textContent = '›';
    li.append(meta, v);
    const go = () => cadOpen(title, f.buf.slice(0));
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return li;
  }));
}

async function cadPickFile(file) {
  if (!file) return;
  const problem = cadFileProblem(file);   // cadfiles.js
  if (problem) { alert(problem); return; }
  const buf = await file.arrayBuffer();
  cadRemember(file.name, buf.slice(0));
  cadOpen(file.name, buf);
}

function cadWorker() {
  cad.worker ??= new Worker(`cad-worker.js?v=${DRAWING_BUILD}`, { type: 'module' });
  return cad.worker;
}

function cadParse(name, buf) {
  return new Promise((resolve, reject) => {
    const w = cadWorker();
    w.onmessage = ({ data }) => {
      if (data.progress) { busyText(data.progress); return; }
      if (data.ok) resolve(data); else reject(new Error(data.error));
    };
    w.onerror = (e) => {
      cad.worker?.terminate(); cad.worker = null;
      console.warn('cad worker error', e.message, e.filename, e.lineno);
      reject(Object.assign(new Error(`도면 읽기 도구가 멈췄습니다. ${e.message || '메모리가 부족할 수 있습니다. 다른 앱을 닫고 다시 열어 주세요.'}`), { crash: true }));
    };
    const copy = buf.slice(0);   // 작업자에게 넘기면 원본은 비므로 사본을 넘긴다(작업자가 멈추면 한 번 더 시도할 수 있게)
    w.postMessage({ name, buf: copy, wantDxf: pocketWanted() }, [copy]);
  });
}

async function cadOpen(name, buf) {
  busyShow('도면을 여는 중...');
  try {
    // 작업자가 읽기 전에 멈추면(파일 받기 실패 등, 메시지 없음) 새 작업자로 한 번 더
    // 엔진 파일(wasm 약 6MB 전송)이 폰에 없으면 먼저 받으며 받은 양을 보여 준다(미리 받는 중이면 거기에 합류). 못 받아도 아래에서 자기 오류를 낸다
    await cadWasmReady((a, b) => busyText(cadWasmProgressText(a, b))).catch(() => {});
    const res = await cadParse(name, buf).catch(async (err) => {
      if (err.crash) { busyText('다시 시도하는 중...'); return cadParse(name, buf); }
      if (!cadWasmBroken(err)) throw err;
      await cadWasmPurge('libredwg');   // 깨진 엔진 파일이면 폰 저장분을 지우고 새로 받아 한 번 더
      await cadWasmReady((a, b) => busyText(cadWasmProgressText(a, b)));
      return cadParse(name, buf);
    });
    busyText('화면에 그리는 중...');
    await busyYield();
    Object.assign(cad, {
      name, model: res.model, frames: res.frames, clusters: res.clusters, cur: [], meas: [], ink: [],
      showFrames: false, pick: new Set(), tool: 'pan', snapIdx: null,
    });
    cad.tags = JSON.parse(store.get(`cad_tags_${name}`) || '[]');
    cad.order = cadColorOrder(cad.model.polys);
    cad.snapIdx = cadSnapIndex(cad.model);
    $('cadTitle').textContent = name;
    show($('cadViewer'), true);
    document.body.classList.add('cad-open');
    cadResize();
    cadFit(cad.model.extents, CAD_MECH.openMargin);
    cadSetTool('pan');
    cadSheet(null);
    if (res.dxf) await pocketShow(name, res.dxf);
    const note = [];
    if (cad.model.truncated) note.push('도면이 너무 커서 일부 블록은 그리지 않았습니다.');
    cadInfo(note.join(' ') || `${cad.model.polys.length.toLocaleString()}개 선 · 도면층 ${cad.model.layers.length}개 · 도각 ${cad.frames.length}장`);
    renderCadRecent();
  } catch (err) {
    alert(`도면을 열지 못했습니다: ${friendlyError(err, '파일을 읽지 못했습니다.')}`);
  } finally {
    busyHide();
  }
}

function cadClose() {
  pocketHide();
  show($('cadViewer'), false);
  document.body.classList.remove('cad-open');
  cadSheet(null);
  cad.model = null; cad.order = null; cad.snapIdx = null;   // 큰 목록을 놓아 메모리를 돌려준다
}

// 색별로 묶어 그리면 stroke 호출이 수십만 번에서 수십 번으로 준다
function cadColorOrder(polys) {
  const by = new Map();
  polys.forEach((p, i) => { const k = `${p.c}`; if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
  return [...by].map(([c, idx]) => ({ c: Number(c), idx: Uint32Array.from(idx) }));
}

// ---------- 화면 좌표 ----------

const cadCanvas = () => $('cadCanvas');
let cadW = 0, cadH = 0, cadDpr = 1;
function cadResize() {
  const cv = cadCanvas(), r = cv.parentElement.getBoundingClientRect();
  cadDpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cadW = r.width; cadH = r.height;
  cv.width = Math.round(cadW * cadDpr); cv.height = Math.round(cadH * cadDpr);
  cadRender();
}
const toScr = (x, y, v = cad.view) => [(x - v.cx) * v.s + cadW / 2, (v.cy - y) * v.s + cadH / 2];
const toWorld = (sx, sy, v = cad.view) => ({ x: (sx - cadW / 2) / v.s + v.cx, y: v.cy - (sy - cadH / 2) / v.s });

function cadFit(r, margin = CAD_MECH.extentsMargin) {
  if (!r) return;
  const s = Math.min(cadW / (r.w * margin), cadH / (r.h * margin));
  cad.view = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, s: Number.isFinite(s) && s > 0 ? s : 1 };
  cadRender();
}

function cadZoomAt(f, sx = cadW / 2, sy = cadH / 2) {
  const p = toWorld(sx, sy);
  const s = cad.view.s * f;
  cad.view = { s, cx: p.x - (sx - cadW / 2) / s, cy: p.y + (sy - cadH / 2) / s };
  cadRender();
}

// ---------- 그리기 ----------

const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
function cadColor(c, bg, mono) {
  if (mono) return '#000';
  const dark = bg === 'dark';
  if (c === FG || c == null) return dark ? '#FFFFFF' : '#111111';
  if (dark) return hex(c);
  // 흰·회색 바탕에서 노랑·하늘색처럼 밝은 색은 어둡게(안 보이는 선이 없게)
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255, lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.7) return hex(c);
  const k = 0.55;
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

let cadRaf = 0;
function cadRender() {
  if (cadRaf) return;
  cadRaf = requestAnimationFrame(() => { cadRaf = 0; cadDraw(); });
}

function cadDraw() {
  const cv = cadCanvas(), g = cv.getContext('2d');
  g.setTransform(cadDpr, 0, 0, cadDpr, 0, 0);
  g.fillStyle = CAD_BG[cad.bg];
  g.fillRect(0, 0, cadW, cadH);
  if (!cad.model) return;
  const w0 = toWorld(0, cadH), w1 = toWorld(cadW, 0);
  drawModel(g, cad.model, cad.order, cad.view, { x0: w0.x, y0: w0.y, x1: w1.x, y1: w1.y }, cadW, cadH, cad.bg, false, 1);
  drawOverlay(g);
}

// 화면·PDF 공용: view(cx,cy,s) 로 box 안의 도형을 그린다
function drawModel(g, m, order, v, box, W, H, bg, mono, lineW) {
  const L = m.layers, s = v.s, ox = W / 2 - v.cx * s, oy = H / 2 + v.cy * s;
  const vis = (b) => b[2] >= box.x0 && b[0] <= box.x1 && b[3] >= box.y0 && b[1] <= box.y1;
  // 채움
  for (const f of m.fills) {
    if (!L[f.L].on || !vis(f.box)) continue;
    g.globalAlpha = f.alpha;
    g.fillStyle = cadColor(f.c, bg, mono);
    g.beginPath();
    for (const lp of f.loops) { for (let i = 0; i < lp.length; i += 2) { const x = lp[i] * s + ox, y = oy - lp[i + 1] * s; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.closePath(); }
    g.fill('evenodd');
  }
  g.globalAlpha = 1;
  // 선: 색별로 한 번에
  g.lineWidth = lineW; g.lineJoin = 'round'; g.lineCap = 'round';
  const tiny = 0.6 / s;
  for (const grp of order) {
    g.strokeStyle = cadColor(grp.c, bg, mono);
    g.beginPath();
    let n = 0;
    for (const i of grp.idx) {
      const p = m.polys[i];
      if (!L[p.L].on || !vis(p.box)) continue;
      const a = p.p;
      if (p.box[2] - p.box[0] < tiny && p.box[3] - p.box[1] < tiny) { g.rect(a[0] * s + ox, oy - a[1] * s, 0.6, 0.6); continue; }
      g.moveTo(a[0] * s + ox, oy - a[1] * s);
      for (let k = 2; k < a.length; k += 2) g.lineTo(a[k] * s + ox, oy - a[k + 1] * s);
      if (++n > 4000) { g.stroke(); g.beginPath(); n = 0; }
    }
    g.stroke();
  }
  // 글자
  g.textBaseline = 'alphabetic';
  for (const t of m.texts) {
    const hp = t.h * s;
    if (hp < CAD_TEXT_MIN_PX || !L[t.L].on || !vis(t.box)) continue;
    g.save();
    g.translate(t.x * s + ox, oy - t.y * s);
    g.rotate(-t.rot);
    if (t.xs !== 1) g.scale(t.xs, 1);
    g.fillStyle = cadColor(t.c, bg, mono);
    g.font = `${hp}px ${CAD_FONT}`;
    g.textAlign = ['left', 'center', 'right'][t.ha] || 'left';
    g.textBaseline = t.va;
    const lines = t.s.split('\n');
    lines.forEach((ln, i) => g.fillText(ln, 0, i * hp * 1.35));
    g.restore();
  }
}

function drawOverlay(g) {
  // 도각 틀
  if (cad.showFrames) {
    const list = cad.frames.length ? cad.frames : cad.clusters;
    g.lineWidth = 2;
    for (const f of list) {
      const [x0, y1] = toScr(f.x, f.y), [x1, y0] = toScr(f.x + f.w, f.y + f.h);
      const on = cad.pick.has(f.n);
      g.setLineDash(on ? [] : [6, 5]);
      g.strokeStyle = on ? CAD_FRAME : 'rgba(55,129,201,.55)';
      g.fillStyle = on ? 'rgba(55,129,201,.10)' : 'rgba(0,0,0,0)';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
      // 번호 동그라미: 틀이 화면에서 작으면 동그라미도 줄인다(이웃 번호와 겹치지 않게)
      const rr = Math.max(5, Math.min(13, (x1 - x0) / 4));
      g.fillStyle = on ? CAD_FRAME : '#7A8899';
      g.beginPath(); g.arc(x0 + rr + 3, y0 + rr + 3, rr, 0, Math.PI * 2); g.fill();
      if (rr >= 8) { g.font = `bold ${Math.round(rr * 1.05)}px ${CAD_FONT}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(`${f.n}`, x0 + rr + 3, y0 + rr + 4); }
    }
  }
  // 펜 표시
  g.strokeStyle = CAD_MARK; g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const st of cad.ink) { g.beginPath(); st.forEach((p, i) => { const [x, y] = toScr(p.x, p.y); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
  // 측정 기록 + 진행 중
  const drawMeas = (ms, live) => {
    g.strokeStyle = live ? '#FFC23D' : CAD_MARK; g.fillStyle = g.strokeStyle; g.lineWidth = 2;
    const pts = ms.pts.map((p) => toScr(p.x, p.y));
    if (ms.kind === 'area' && pts.length > 2) { g.globalAlpha = 0.18; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); g.globalAlpha = 1; }
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (ms.kind === 'area' && !live && pts.length > 2) g.closePath(); g.stroke();
    for (const [x, y] of pts) { g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); }
    if (ms.label && pts.length) {
      const [x, y] = ms.kind === 'id' ? pts[0] : pts.reduce((a, b) => [a[0] + b[0] / pts.length, a[1] + b[1] / pts.length], [0, 0]);
      g.font = `bold 13px ${CAD_FONT}`; g.textAlign = 'left'; g.textBaseline = 'bottom';
      const tw = g.measureText(ms.label).width;
      g.fillStyle = 'rgba(15,20,30,.82)'; g.fillRect(x + 6, y - 24, tw + 10, 20);
      g.fillStyle = '#fff'; g.fillText(ms.label, x + 11, y - 7);
    }
  };
  cad.meas.forEach((ms) => drawMeas(ms, false));
  if (cad.cur.length) drawMeas({ kind: cad.tool, pts: cad.cur }, true);
  if (cad.hover) {   // 스냅 표시
    const [x, y] = toScr(cad.hover.x, cad.hover.y);
    g.strokeStyle = '#2EE6A8'; g.lineWidth = 2; g.strokeRect(x - 7, y - 7, 14, 14);
  }
}

// ---------- 손가락·마우스 ----------

const gest = { pts: new Map(), start: null, base: null, moved: false, hold: 0, pinch: null, lastTap: 0 };

function cadPointerDown(e) {
  const cv = cadCanvas();
  cv.setPointerCapture(e.pointerId);
  gest.pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (gest.pts.size === 1) {
    gest.start = { x: e.offsetX, y: e.offsetY }; gest.base = { ...cad.view }; gest.moved = false;
    if (cad.tool === 'pen') cad.ink.push([toWorld(e.offsetX, e.offsetY)]);
    if (isPickTool()) {
      clearTimeout(gest.hold);
      gest.hold = setTimeout(() => loupeAt(gest.start.x, gest.start.y), e.pointerType === 'mouse' ? 0 : CAD_HOLD_MS);
    }
  } else if (gest.pts.size === 2) {
    clearTimeout(gest.hold); loupeHide();
    if (cad.tool === 'pen') cad.ink.pop();
    const [a, b] = [...gest.pts.values()];
    gest.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, base: { ...cad.view } };
  }
}

const isPickTool = () => ['dist', 'area', 'id'].includes(cad.tool);

function cadPointerMove(e) {
  if (!gest.pts.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && isPickTool()) { cad.hover = snapAt(e.offsetX, e.offsetY, 1); cadRender(); }
    return;
  }
  gest.pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (gest.pts.size === 2 && gest.pinch) {
    const [a, b] = [...gest.pts.values()], P = gest.pinch;
    const f = Math.hypot(a.x - b.x, a.y - b.y) / P.d, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const w = toWorld(P.m.x, P.m.y, P.base), s = P.base.s * f;
    cad.view = { s, cx: w.x - (m.x - cadW / 2) / s, cy: w.y + (m.y - cadH / 2) / s };
    gest.moved = true;
    cadRender();
    return;
  }
  const dx = e.offsetX - gest.start.x, dy = e.offsetY - gest.start.y;
  if (Math.hypot(dx, dy) > TAP_SLOP_PX) gest.moved = true;
  if (cad.tool === 'pen') { cad.ink[cad.ink.length - 1]?.push(toWorld(e.offsetX, e.offsetY)); cadRender(); return; }
  if (isPickTool() && (loupeOn || e.pointerType !== 'mouse')) {
    if (!loupeOn && gest.moved) { clearTimeout(gest.hold); loupeAt(e.offsetX, e.offsetY); }
    if (loupeOn) loupeAt(e.offsetX, e.offsetY);
    return;
  }
  if (gest.moved) {
    cad.view = { ...gest.base, cx: gest.base.cx - dx / gest.base.s, cy: gest.base.cy + dy / gest.base.s };
    cadRender();
  }
}

function cadPointerUp(e) {
  if (!gest.pts.has(e.pointerId)) return;
  gest.pts.delete(e.pointerId);
  clearTimeout(gest.hold);
  if (gest.pts.size) { gest.pinch = null; const [p] = [...gest.pts.values()]; gest.start = p; gest.base = { ...cad.view }; return; }
  if (gest.pinch) { gest.pinch = null; loupeHide(); return; }
  if (cad.tool === 'pen') { cadRender(); return; }
  if (isPickTool()) {
    const p = loupeOn ? loupePoint : (gest.moved ? null : (snapAt(e.offsetX, e.offsetY, e.pointerType === 'mouse' ? 1 : CAD_MECH.touchMul) || toWorld(e.offsetX, e.offsetY)));
    loupeHide();
    if (p) addPick(p);
    return;
  }
  if (!gest.moved) {   // 두 번 눌러 확대 / 도각 고르기
    if (cad.showFrames && toggleFrameAt(e.offsetX, e.offsetY)) return;
    const now = Date.now();
    if (now - gest.lastTap < 320) { cadZoomAt(CAD_MECH.zoomStep, e.offsetX, e.offsetY); gest.lastTap = 0; } else gest.lastTap = now;
  }
}

function cadWheel(e) {
  e.preventDefault();
  cadZoomAt(e.deltaY < 0 ? CAD_MECH.wheelNotch : 1 / CAD_MECH.wheelNotch, e.offsetX, e.offsetY);
}

function snapAt(sx, sy, mul) {
  if (!cad.snapIdx || !$('cadSnap').checked) return null;
  const w = toWorld(sx, sy);
  return cadNearestSnap(cad.model, cad.snapIdx, w.x, w.y, (CAD_MECH.aperturePx * mul) / cad.view.s);
}

// ---------- 돋보기 ----------

let loupeOn = false, loupePoint = null;
const LOUPE_PX = 132, LOUPE_ZOOM = 3;
function loupeAt(sx, sy) {
  loupeOn = true;
  const lp = $('cadLoupe');
  const sn = snapAt(sx, sy, 1.5);
  loupePoint = sn || toWorld(sx, sy);
  cad.hover = sn;
  const left = sx + (sx > cadW / 2 ? -LOUPE_PX - 30 : 30), top = Math.max(4, sy - LOUPE_PX - 40);
  lp.style.transform = `translate(${left}px, ${top}px)`;
  show(lp, true);
  const d = Math.min(window.devicePixelRatio || 1, 2);
  lp.width = lp.height = LOUPE_PX * d;
  const g = lp.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.fillStyle = CAD_BG[cad.bg]; g.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
  const v = { cx: loupePoint.x, cy: loupePoint.y, s: cad.view.s * LOUPE_ZOOM }, r = LOUPE_PX / 2 / v.s;
  drawModel(g, cad.model, cad.order, v, { x0: v.cx - r, y0: v.cy - r, x1: v.cx + r, y1: v.cy + r }, LOUPE_PX, LOUPE_PX, cad.bg, false, 1.2);
  g.strokeStyle = sn ? '#2EE6A8' : '#FFC23D'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(LOUPE_PX / 2, 0); g.lineTo(LOUPE_PX / 2, LOUPE_PX); g.moveTo(0, LOUPE_PX / 2); g.lineTo(LOUPE_PX, LOUPE_PX / 2); g.stroke();
  if (sn) { g.strokeRect(LOUPE_PX / 2 - 8, LOUPE_PX / 2 - 8, 16, 16); }
  $('cadLoupeTag').textContent = sn ? sn.name : '';
  cadRender();
}
function loupeHide() { loupeOn = false; cad.hover = null; show($('cadLoupe'), false); $('cadLoupeTag').textContent = ''; cadRender(); }

// ---------- 측정 ----------

const fmtXY = (p) => {
  const u = cad.model.units, k = { 6: 1, 5: 0.01 }[u] ?? (u === 1 ? 0.0254 : u === 2 ? 0.3048 : 0.001);
  const X = (cad.swapXY ? p.y : p.x) * k, Y = (cad.swapXY ? p.x : p.y) * k;
  const f = (v) => v.toLocaleString('ko-KR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return `X ${f(X)} · Y ${f(Y)} m`;
};

function addPick(p) {
  cad.cur.push({ x: p.x, y: p.y });
  const u = cad.model.units;
  if (cad.tool === 'id') {
    pushMeas({ kind: 'id', pts: [...cad.cur], label: fmtXY(p) });
  } else if (cad.tool === 'dist' && cad.cur.length === 2) {
    const r = cadDist(cad.cur[0], cad.cur[1]);
    pushMeas({ kind: 'dist', pts: [...cad.cur], label: cadFmtLen(r.d, u), detail: `거리 ${cadFmtLen(r.d, u)} · 각도 ${r.ang.toFixed(2)}° · ΔX ${cadFmtLen(Math.abs(cad.swapXY ? r.dy : r.dx), u)} · ΔY ${cadFmtLen(Math.abs(cad.swapXY ? r.dx : r.dy), u)}` });
  } else if (cad.tool === 'area') {
    cadInfo(cad.cur.length < 3 ? `면적: 점 ${cad.cur.length}개 · 3개 이상 찍고 [완료]` : `면적(진행 중) ${cadFmtArea(cadArea(cad.cur).area, u)} · 점 ${cad.cur.length}개`);
    show($('cadAreaDone'), cad.cur.length >= 3);
  } else {
    cadInfo('두 번째 점을 찍어 주세요.');
  }
  cadRender();
}

function pushMeas(ms) {
  cad.meas.push(ms);
  cad.cur = [];
  cadInfo(ms.detail || ms.label);
  show($('cadAreaDone'), false);
  cadRender();
}

function finishArea() {
  if (cad.cur.length < 3) return;
  const r = cadArea(cad.cur), u = cad.model.units;
  pushMeas({ kind: 'area', pts: [...cad.cur], label: cadFmtArea(r.area, u), detail: `면적 ${cadFmtArea(r.area, u)} · 둘레 ${cadFmtLen(r.perimeter, u)} · 점 ${cad.cur.length}개` });
}

function cadInfo(text) { $('cadInfo').textContent = text; }

const TOOL_HINT = {
  pan: '한 손가락으로 끌어 이동 · 두 손가락으로 확대 · 두 번 눌러 확대',
  dist: '거리: 꾹 누르면 돋보기가 나옵니다. 손을 떼면 점이 찍힙니다(끝점·중심 등에 자동으로 붙음). 두 점을 찍으세요',
  area: '면적: 꼭짓점을 차례로 찍고 [완료]',
  id: '좌표: 점을 찍으면 X·Y 좌표가 나옵니다(측량 좌표는 X=북쪽)',
  pen: '펜: 손가락으로 표시를 그립니다(PDF 에도 들어갑니다)',
};
function cadSetTool(tool) {
  cad.tool = tool; cad.cur = [];
  for (const b of document.querySelectorAll('#cadTools [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  show($('cadAreaDone'), false);
  cadInfo(TOOL_HINT[tool]);
  cadRender();
}

// ---------- 옆 패널(도면층·찾기·블록·뷰 태그·측정 기록·PDF) ----------

function cadSheet(kind) {
  const sh = $('cadSheet');
  if (!kind || cad.sheet === kind) { cad.sheet = null; show(sh, false); return; }
  cad.sheet = kind;
  show(sh, true);
  const body = $('cadSheetBody');
  body.replaceChildren();
  $('cadSheetTitle').textContent = { layers: '도면층', find: '글자 찾기', blocks: '블록 개수', tags: '뷰 태그', meas: '측정 기록', pdf: 'PDF 만들기' }[kind];
  ({ layers: sheetLayers, find: sheetFind, blocks: sheetBlocks, tags: sheetTags, meas: sheetMeas, pdf: sheetPdf })[kind](body);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (text, onClick, cls = 'btn outline small') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

function sheetLayers(body) {
  const q = el('input', 'list-search'); q.type = 'search'; q.placeholder = '도면층 검색'; q.setAttribute('aria-label', '도면층 검색');
  const row = el('div', 'row');
  row.append(btn('모두 켜기', () => { cad.model.layers.forEach((l) => { l.on = true; }); draw(); cadRender(); }), btn('모두 끄기', () => { cad.model.layers.forEach((l) => { l.on = false; }); draw(); cadRender(); }));
  const ul = el('ul', 'list cad-list');
  const draw = () => {
    const tokens = searchTokens(q.value);
    ul.replaceChildren(...cad.model.layers.map((l, i) => ({ l, i })).filter(({ l }) => l.n > 0 && searchMatch(l.name, tokens)).map(({ l }) => {
      const li = el('li', 'cad-layer');
      const lab = el('label');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = l.on;
      cb.addEventListener('change', () => { l.on = cb.checked; cadRender(); });
      const sw = el('span', 'cad-swatch'); sw.style.background = cadColor(l.color, 'dark', false);
      lab.append(cb, sw, el('span', 'cad-lname', l.name), el('small', 'muted', `${l.n.toLocaleString()}`));
      li.append(lab);
      return li;
    }));
  };
  q.addEventListener('input', debounce(draw));
  draw();
  body.append(q, row, ul);
}

function sheetFind(body) {
  const q = el('input', 'list-search'); q.type = 'search'; q.placeholder = '찾을 글자 (예: SG-3, 지중경사계)'; q.setAttribute('aria-label', '찾을 글자');
  const ul = el('ul', 'list cad-list');
  const note = el('p', 'muted');
  const run = () => {
    const tokens = searchTokens(q.value);
    if (!tokens.length) { ul.replaceChildren(); note.textContent = `도면 글자 ${cad.model.texts.length.toLocaleString()}개`; return; }
    const hits = cad.model.texts.filter((t) => searchMatch(t.s, tokens));
    note.textContent = `${hits.length.toLocaleString()}개 찾음${hits.length > 200 ? ' (앞의 200개만 표시)' : ''}`;
    ul.replaceChildren(...hits.slice(0, 200).map((t) => {
      const li = el('li', 'tap', t.s.replace(/\n/g, ' '));
      li.addEventListener('click', () => {
        const r = Math.max(t.h * 12, 1);
            cadFit({ x: t.x - r, y: t.y - r, w: 2 * r, h: 2 * r }, 1);
        cadInfo(`'${t.s.replace(/\n/g, ' ')}' 위치 · ${fmtXY(t)}`);
      });
      return li;
    }));
  };
  q.addEventListener('input', debounce(run));
  run();
  body.append(q, note, ul);
  setTimeout(() => q.focus(), 50);
}

function sheetBlocks(body) {
  const ul = el('ul', 'list cad-list');
  const rows = cad.model.blocks;
  body.append(el('p', 'muted', `도면에 놓인 블록(계측기 기호 등) ${rows.reduce((a, r) => a + r.n, 0).toLocaleString()}개 · ${rows.length}종류`));
  ul.replaceChildren(...rows.map((r) => { const li = el('li', 'cad-row'); li.append(el('span', '', r.name), el('b', '', `${r.n}개`)); return li; }));
  body.append(ul);
}

function sheetTags(body) {
  const ul = el('ul', 'list cad-list');
  const save = () => store.set(`cad_tags_${cad.name}`, JSON.stringify(cad.tags));
  const draw = () => ul.replaceChildren(...cad.tags.map((t, i) => {
    const li = el('li', 'cad-row tap');
    li.append(el('span', '', `🔖 ${t.name}`), btn('삭제', (e) => { e.stopPropagation(); cad.tags.splice(i, 1); save(); draw(); }, 'close-pin-btn'));
    li.addEventListener('click', () => { cad.view = { ...t.view }; cadRender(); });
    return li;
  }));
  const add = btn('＋ 지금 화면 저장', () => {
    const name = prompt('이 화면의 이름 (예: A구역 지중경사계)', `화면 ${cad.tags.length + 1}`);
    if (!name?.trim()) return;
    cad.tags.push({ name: name.trim().slice(0, 40), view: { ...cad.view } }); save(); draw();
  }, 'btn primary small');
  draw();
  body.append(el('p', 'muted', '자주 보는 위치를 이름 붙여 두면 한 번에 이동합니다.'), add, ul);
}

function sheetMeas(body) {
  const ul = el('ul', 'list cad-list');
  ul.replaceChildren(...cad.meas.map((m, i) => {
    const li = el('li', 'cad-row');
    li.append(el('span', '', `${i + 1}. ${{ dist: '거리', area: '면적', id: '좌표' }[m.kind]} ${m.detail || m.label}`), btn('삭제', () => { cad.meas.splice(i, 1); cadRender(); cadSheet(null); cadSheet('meas'); }, 'close-pin-btn'));
    return li;
  }));
  const sw = el('label', 'keep');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = cad.swapXY;
  cb.addEventListener('change', () => { cad.swapXY = cb.checked; store.set('cad_swapxy', cb.checked ? '1' : '0'); });
  sw.append(cb, el('span', '', '측량 좌표(X=북쪽·Y=동쪽)로 표시'));
  const copy = btn('기록 복사(글자)', async () => {
    const text = cad.meas.map((m, i) => `${i + 1}\t${{ dist: '거리', area: '면적', id: '좌표' }[m.kind]}\t${m.detail || m.label}`).join('\n');
    try { await navigator.clipboard.writeText(text); alert('측정 기록을 복사했습니다. 메모·엑셀에 붙여 넣으세요.'); } catch { prompt('아래 글자를 길게 눌러 복사하세요', text); }
  });
  const clear = btn('모두 지우기', () => { cad.meas = []; cad.ink = []; cadRender(); cadSheet(null); cadSheet('meas'); });
  const row = el('div', 'row'); row.append(copy, clear);
  body.append(sw, row, cad.meas.length ? ul : el('p', 'muted', '아직 측정한 것이 없습니다.'));
}

// ---------- PDF: 도각 추적 ----------

function framesNow() { return cad.frames.length ? cad.frames : cad.clusters; }

function sheetPdf(body) {
  const list = framesNow();
  const track = btn(cad.showFrames ? '🎯 도각 추적 켜짐' : '🎯 도각 추적', () => {
    busyShow('도각(도면 틀)을 찾는 중...');
    setTimeout(() => {
      cad.showFrames = true;
      cad.pick = new Set(framesNow().map((f) => f.n));
      busyHide();
      if (!framesNow().length) { alert('도각을 찾지 못했습니다. [지금 화면 1장]으로 만들어 주세요.'); return; }
      cadFit(unionOf(framesNow()), 1.08);
      cadSheet(null); cadSheet('pdf');
    }, 30);
  }, cad.showFrames ? 'btn primary small' : 'btn outline small');
  const screen = btn('🖼 지금 화면 1장', () => {
    const a = toWorld(0, cadH), b = toWorld(cadW, 0);
    makePdf([{ n: 1, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }]);
  });
  const row = el('div', 'row'); row.append(track, screen);
  const mono = el('label', 'keep');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = cad.mono;
  cb.addEventListener('change', () => { cad.mono = cb.checked; });
  mono.append(cb, el('span', '', '흑백으로 (출력용, 파일이 작음)'));
  body.append(el('p', 'muted', '[도각 추적]을 누르면 도면 틀을 찾아 한 장씩 PDF 쪽으로 만듭니다. 틀을 눌러 빼거나 넣을 수 있습니다.'), row, mono);
  if (!cad.showFrames) return;
  body.append(el('p', 'muted', cad.frames.length ? `도각 ${list.length}장을 찾았습니다.` : `도각 틀이 없어 그림 덩어리 ${list.length}개로 나눴습니다.`));
  const ul = el('ul', 'list cad-list');
  ul.replaceChildren(...list.map((f) => {
    const li = el('li', 'cad-layer');
    const lab = el('label');
    const c = el('input'); c.type = 'checkbox'; c.checked = cad.pick.has(f.n);
    c.addEventListener('change', () => { if (c.checked) cad.pick.add(f.n); else cad.pick.delete(f.n); go.textContent = `PDF 만들기 (${cad.pick.size}장)`; cadRender(); });
    lab.append(c, el('span', 'cad-lname', `${f.n}번 도각${f.label && !/^A\$|^\*/.test(f.label) ? ` · ${f.label}` : ''}`));
    const look = btn('보기', () => cadFit(f, 1.05), 'close-pin-btn');
    li.append(lab, look);
    return li;
  }));
  const go = btn(`PDF 만들기 (${cad.pick.size}장)`, () => makePdf(list.filter((f) => cad.pick.has(f.n))), 'btn primary wide');
  body.append(ul, go);
}

const unionOf = (list) => {
  const x0 = Math.min(...list.map((f) => f.x)), y0 = Math.min(...list.map((f) => f.y));
  const x1 = Math.max(...list.map((f) => f.x + f.w)), y1 = Math.max(...list.map((f) => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

function toggleFrameAt(sx, sy) {
  const w = toWorld(sx, sy);
  const f = [...framesNow()].reverse().find((r) => w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h);
  if (!f) return false;
  if (cad.pick.has(f.n)) cad.pick.delete(f.n); else cad.pick.add(f.n);
  cadRender();
  if (cad.sheet === 'pdf') { cadSheet(null); cadSheet('pdf'); }
  return true;
}

// 틀 하나 → JPEG(긴 변 CAD_PDF_LONG_PX). 펜 표시·측정 기록도 함께
async function frameToJpeg(f) {
  const k = CAD_PDF_LONG_PX / Math.max(f.w, f.h);
  const W = Math.max(1, Math.round(f.w * k)), H = Math.max(1, Math.round(f.h * k));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const v = { cx: f.x + f.w / 2, cy: f.y + f.h / 2, s: k };
  drawModel(g, cad.model, cad.order, v, { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h }, W, H, 'white', cad.mono, CAD_PDF_LINE_PX);
  const P = (p) => [(p.x - v.cx) * k + W / 2, (v.cy - p.y) * k + H / 2];
  g.strokeStyle = CAD_MARK; g.lineWidth = 4; g.lineCap = 'round';
  for (const st of cad.ink) { g.beginPath(); st.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
  for (const m of cad.meas) {
    g.beginPath(); m.pts.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); if (m.kind === 'area') g.closePath(); g.stroke();
    const [x, y] = P(m.pts[0]); g.fillStyle = CAD_MARK; g.font = `bold 28px ${CAD_FONT}`; g.fillText(m.label, x + 8, y - 8);
  }
  const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했습니다(메모리 부족).'))), 'image/jpeg', CAD_PDF_JPEG_Q));
  cv.width = cv.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), W, H };
}

async function makePdf(frames) {
  if (!frames.length) { alert('PDF 로 만들 도각을 하나 이상 골라 주세요.'); return; }
  busyShow('PDF 만들 준비 중...');
  const stem = cad.name.replace(/\.(dwg|dxf)$/i, '');
  let parts = [];
  try {
    const PDFLib = await ensurePdfLib();
    let doc = await PDFLib.PDFDocument.create(), size = 0;
    const flush = async () => { if (doc.getPageCount()) parts.push(await doc.save()); doc = await PDFLib.PDFDocument.create(); size = 0; };
    for (const [i, f] of frames.entries()) {
      busyText(`도각 ${i + 1} / ${frames.length}장을 그리는 중...`);
      await busyYield();
      const { bytes, W, H } = await frameToJpeg(f);
      if (size && size + bytes.length > CAD_PDF_SPLIT_BYTES) await flush();
      const img = await doc.embedJpg(bytes);
      const k = CAD_PDF_LONG_PT / Math.max(W, H);
      doc.addPage([W * k, H * k]).drawImage(img, { x: 0, y: 0, width: W * k, height: H * k });
      size += bytes.length;
    }
    busyText('PDF 파일로 묶는 중...');
    await flush();
  } catch (err) {
    busyHide();
    alert(`PDF 를 만들지 못했습니다: ${friendlyError(err, '메모리가 부족할 수 있습니다. 도각 수를 줄여 다시 해 보세요.')}`);
    return;
  }
  busyHide();
  const files = parts.map((bytes, i) => ({ name: `${stem}${parts.length > 1 ? `_${i + 1}` : ''}(DWG).pdf`, base64: uint8ToBase64(bytes), folder: CAD_SUBDIR }));
  const site = await askCadSite(files);
  if (site === null) return;   // 취소
  let msg = '';
  if (site) {
    busyShow(`'${site}' 현장 클라우드에 올리는 중...`);
    try {
      for (const [i, f] of files.entries()) {
        busyText(`클라우드에 올리는 중... (${i + 1}/${files.length})`);
        await api('drawing_upload', { site, file: { name: f.name, base64: f.base64, subdir: CAD_SUBDIR, replaceSameName: true } }, { timeoutMs: 3 * 60 * 1000 });
      }
      msg = `클라우드 「도면/${site}/${CAD_SUBDIR}」 폴더에 PDF ${files.length}개(${frames.length}쪽)를 올렸습니다.\n도면 탭에서도 열 수 있습니다.`;
      store.remove(`drawings_${site}`);   // 도면 탭이 다음에 새 목록을 받게
    } catch (err) {
      busyHide();
      if (err.isAuth) { signOut(); return; }
      msg = `클라우드에 올리지 못했습니다: ${friendlyError(err, '신호를 확인해 주세요.')}`;
    }
    busyHide();
  }
  await askCadPhoneSave(msg, files, site);
}

// 저장할 현장 고르기: 검색칸 + 목록. 고른 현장 이름, '폰에만'이면 '', 취소면 null
function askCadSite(files) {
  const dlg = $('cadSiteDialog'), q = $('cadSiteSearch'), ul = $('cadSiteList');
  const sites = state.config.sites || [];
  $('cadSiteMsg').textContent = `PDF ${files.length}개를 어느 현장에 저장할까요? (도면/<현장>/${CAD_SUBDIR}/ 폴더)`;
  let chosen = null;
  const draw = () => {
    const tokens = searchTokens(q.value);
    const hits = sites.filter((s) => searchMatch(s, tokens));
    ul.replaceChildren(...(hits.length ? hits.map((s) => {
      const li = el('li', 'tap', `📁 ${s}`);
      li.tabIndex = 0;
      const pick = () => { chosen = s; dlg.close('ok'); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      return li;
    }) : [el('li', 'empty', sites.length ? `'${q.value.trim()}' 현장이 없습니다.` : '등록된 현장이 없습니다.')]));
  };
  q.value = '';
  q.oninput = debounce(draw);
  draw();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    resolve(dlg.returnValue === 'ok' ? chosen : dlg.returnValue === 'phone' ? '' : null);
  }, { once: true }));
}

async function askCadPhoneSave(message, files, site) {
  const dlg = $('phoneSaveDialog');
  $('phoneSaveTitle').textContent = 'PDF 저장';
  $('phoneSaveMsg').textContent = `${message ? `${message}\n\n` : ''}이 폰에도 ${files.length > 1 ? `${files.length}개 모두 ` : ''}저장할까요?`;
  $('phoneSaveYes').textContent = '폰에도 저장';
  show($('phoneSaveAlways').closest('label'), false);
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
  show($('phoneSaveAlways').closest('label'), true);
  $('phoneSaveTitle').textContent = '도면 저장';
  if (dlg.returnValue !== 'yes') { if (message) alert(message); return; }
  busyShow('폰에 저장하는 중...');
  try {
    const { saved, total } = await savePdfsToPhone(files, site || 'CAD', pdfToJpegs);
    busyHide();
    const where = window.AndroidGallery ? `갤러리 「계측사진/${phoneAlbumFolder(site || 'CAD')}/${DRAWING_ALBUM}/${CAD_SUBDIR}」 폴더(쪽마다 JPG)` : '다운로드 폴더';
    alert(`폰에 ${saved}/${total}개 저장했습니다: ${where}`);
  } catch (err) {
    busyHide();
    alert(`폰에 저장하지 못했습니다: ${friendlyError(err, '저장 공간을 확인해 주세요.')}`);
  }
}

// ---------- CADPocket(cadcraft wasm) ----------

const POCKET_JS = `vendor/cadpocket/cadpocket.js?v=${typeof DRAWING_BUILD === 'string' ? DRAWING_BUILD : '0'}`;
let pocket = null, pocketP = null;
// WebGL2 가 없는 폰이면 CADPocket 을 건너뛰고 JS 뷰어만 쓴다
const pocketWanted = () => store.get('cad_pocket') !== '0' && !!document.createElement('canvas').getContext('webgl2');

async function pocketStart() {
  pocketP ??= (async () => {
    const m = await import(`./${POCKET_JS}`);
    try { await m.default(); } catch (err) {
      if (!cadWasmBroken(err)) throw err;
      await cadWasmPurge('cadpocket');   // 깨진 엔진 파일이면 폰 저장분을 지우고 새로 받아 한 번 더
      await cadWasmReady((a, b) => busyText(cadWasmProgressText(a, b)));
      await m.default();
    }
    const h = new m.CadPocket();
    await h.start($('cadPocketCanvas'),
      () => $('cadFile').click(),
      () => { pocketHide(); cadSheet(null); cadSheet('pdf'); },
      () => cadClose());
    return h;
  })().catch((err) => { pocketP = null; throw err; });
  return pocketP;
}

// DXF 바이트 → 글자. 새 DXF(2007+)는 UTF-8, 옛 한글 DXF 는 CP949(euc-kr)
function dxfText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('euc-kr').decode(bytes); }
}

async function pocketShow(name, dxfBytes) {
  try {
    busyText('CADPocket 화면을 여는 중...');
    show($('cadPocket'), true);
    pocket = await pocketStart();
    pocket.open(name, dxfText(dxfBytes));
    show($('cadPocketBtn'), true);
  } catch (err) {
    console.warn('CADPocket 시작 실패', err);
    pocketHide();
    show($('cadPocketBtn'), false);
  }
}

function pocketHide() { show($('cadPocket'), false); }

// ---------- 연결 ----------

function initCad() {
  if (!$('cadViewer')) return;
  cad.bg = CAD_BG[store.get('cad_bg')] ? store.get('cad_bg') : 'dark';
  cad.swapXY = store.get('cad_swapxy') !== '0';
  $('cadOpenBtn').addEventListener('click', () => $('cadFile').click());
  $('cadFile').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; cadPickFile(f); });
  $('cadClose').addEventListener('click', cadClose);
  $('cadPocketBtn').addEventListener('click', () => { if (pocket) { cadSheet(null); show($('cadPocket'), true); } });
  const cv = cadCanvas();
  cv.addEventListener('pointerdown', cadPointerDown);
  cv.addEventListener('pointermove', cadPointerMove);
  cv.addEventListener('pointerup', cadPointerUp);
  cv.addEventListener('pointercancel', cadPointerUp);
  cv.addEventListener('wheel', cadWheel, { passive: false });
  cv.addEventListener('pointerleave', () => { if (cad.hover && !gest.pts.size) { cad.hover = null; cadRender(); } });
  new ResizeObserver(() => { if (cad.model) cadResize(); }).observe(cv.parentElement);
  for (const b of document.querySelectorAll('#cadTools [data-tool]')) b.addEventListener('click', () => cadSetTool(b.dataset.tool));
  for (const b of document.querySelectorAll('[data-sheet]')) b.addEventListener('click', () => cadSheet(b.dataset.sheet));
  $('cadSheetClose').addEventListener('click', () => cadSheet(null));
  $('cadAreaDone').addEventListener('click', finishArea);
  $('cadFit').addEventListener('click', () => cadFit(cad.model?.extents));
  $('cadZoomIn').addEventListener('click', () => cadZoomAt(CAD_MECH.zoomStep));
  $('cadZoomOut').addEventListener('click', () => cadZoomAt(1 / CAD_MECH.zoomStep));
  $('cadUndo').addEventListener('click', () => {
    if (cad.cur.length) cad.cur.pop(); else if (cad.tool === 'pen') cad.ink.pop(); else cad.meas.pop();
    show($('cadAreaDone'), cad.tool === 'area' && cad.cur.length >= 3);
    cadRender();
  });
  $('cadBg').addEventListener('click', () => {
    cad.bg = { dark: 'white', white: 'gray', gray: 'dark' }[cad.bg];
    store.set('cad_bg', cad.bg);
    $('cadBg').querySelector('span').textContent = `배경 ${CAD_BG_NAMES[cad.bg]}`;
    cadRender();
  });
  $('cadBg').querySelector('span').textContent = `배경 ${CAD_BG_NAMES[cad.bg]}`;
  $('cadSiteOnlyPhone').addEventListener('click', () => $('cadSiteDialog').close('phone'));
  $('cadSiteCancel').addEventListener('click', () => $('cadSiteDialog').close(''));
  window.addEventListener('hashchange', () => { if (location.hash !== '#cad' && !$('cadViewer').classList.contains('hidden')) cadClose(); });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initCad);
