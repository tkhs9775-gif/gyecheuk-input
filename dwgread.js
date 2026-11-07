'use strict';
// DWG·DXF 도면을 폰 안에서 읽어 시트별 PNG 파일로 바꾼다. 이후는 JPG·PNG 도면과 같은 길(PDF로 감싸 올리기)을 탄다.
// 읽기: vendor/libredwg (libredwg-web, GPL-3.0, wasm). 그리기: 아래 Canvas2D 간이 렌더러(선·폴리선·원·호·글자·블록·단색 채움만).
// ponytail: 치수·타원·패턴 해치·이미지는 안 그린다. 필요해지면 renderEntity 에 종류를 추가한다.

const CAD_DRAWING_RE = /\.(dwg|dxf)$/i;
const CAD_LONG_SIDE_PX = 4000;      // 시트 한 장 그림의 긴 변
const CAD_MAX_DEPTH = 4;            // 블록 안 블록 한도
const CAD_LINE_PX = 1.4;            // 선 굵기(픽셀)
const CAD_FONT = '"Malgun Gothic","Noto Sans KR","Apple SD Gothic Neo",sans-serif';
let cadLibPromise = null;

function loadCadLib() {
  if (!cadLibPromise) {
    cadLibPromise = import('./vendor/libredwg/lib/index.js').then((m) => m.LibreDwg.create().then((lib) => ({ lib, m })));
    cadLibPromise.catch(() => { cadLibPromise = null; });
  }
  return cadLibPromise;
}

// AutoCAD 색 번호 → RGB. 흰 종이라서 7(흰/검정)은 검정으로 그린다.
function aciToRgb(i) {
  const base = ['#000', '#f00', '#e6b800', '#0a0', '#0bb', '#00f', '#d0d', '#000', '#808080', '#a0a0a0'];
  if (i >= 1 && i <= 9) return base[i];
  if (i >= 250 && i <= 255) { const g = 51 + (i - 250) * 41; return `rgb(${g},${g},${g})`; }
  if (i < 10 || i > 249) return '#000';
  const hue = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10;
  const sat = k % 2 ? 0.5 : 1, val = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k] * 0.85;
  const c = val * sat, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = val - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60) % 6];
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

function cadMakeCtx(db) {
  const layers = new Map(db.tables.LAYER.entries.map((l) => [l.name, l]));
  const blocks = new Map(db.tables.BLOCK_RECORD.entries.map((b) => [b.name, b]));
  return { layers, blocks, unknown: new Map() };
}

function entityColor(e, ctx, byBlock) {
  let c = e.colorIndex;
  if (c === 0) return byBlock || '#000';
  if (c === 256 || c == null) c = (ctx.layers.get(e.layer) || {}).colorIndex;
  return aciToRgb(Math.abs(c || 7));
}

// 글자 속 서식 코드({\fKOR;...}, \P 줄바꿈, %%c 기호)를 읽을 수 있는 글자로
function cleanCadText(s) {
  return String(s || '')
    .replace(/\\P/gi, '\n').replace(/\\~/g, ' ').replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/\\[fFHhWwQqTtAaCc][^;]*;/g, '').replace(/\\[LlOoKk]/g, '').replace(/[{}]/g, '').replace(/\\\\/g, '\\');
}

// 행렬 [a,b,c,d,e,f] (캔버스 setTransform 과 같은 모양)
const mMul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
const mPt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bulgeArc(g, x1, y1, x2, y2, bulge) {
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  if (!d) return;
  const ang = 4 * Math.atan(bulge), r = d / (2 * Math.sin(Math.abs(ang) / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
  const sgn = bulge > 0 ? 1 : -1, cx = mx - sgn * h * (dy / d), cy = my + sgn * h * (dx / d);
  g.arc(cx, cy, r, Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), bulge < 0);
}

function drawEntity(g, e, ctx, m, depth, byBlock) {
  if (e.isVisible === false) return;
  const layer = ctx.layers.get(e.layer);
  if (layer && (layer.off || layer.frozen)) return;
  const col = entityColor(e, ctx, byBlock);
  g.strokeStyle = g.fillStyle = col;
  g.setTransform(...m);
  g.lineWidth = CAD_LINE_PX / Math.hypot(m[0], m[1]);   // 블록 배율과 상관없이 화면에서 늘 같은 굵기
  switch (e.type) {
    case 'LINE': g.beginPath(); g.moveTo(e.startPoint.x, e.startPoint.y); g.lineTo(e.endPoint.x, e.endPoint.y); g.stroke(); break;
    case 'LWPOLYLINE': {
      const v = e.vertices || [];
      if (v.length < 2) break;
      g.beginPath(); g.moveTo(v[0].x, v[0].y);
      const closed = (e.flag & 1) === 1, n = closed ? v.length : v.length - 1;
      for (let i = 0; i < n; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        if (a.bulge) bulgeArc(g, a.x, a.y, b.x, b.y, a.bulge); else g.lineTo(b.x, b.y);
      }
      if (closed) g.closePath();
      g.stroke(); break;
    }
    case 'CIRCLE': g.beginPath(); g.arc(e.center.x, e.center.y, e.radius, 0, Math.PI * 2); g.stroke(); break;
    case 'ARC': g.beginPath(); g.arc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle); g.stroke(); break;
    case 'HATCH':
      if (!e.solidFill) break;
      g.globalAlpha = 0.35;
      for (const p of e.boundaryPaths || []) {
        if (!p.vertices || p.vertices.length < 3) continue;
        g.beginPath(); p.vertices.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath(); g.fill();
      }
      g.globalAlpha = 1; break;
    case 'TEXT': case 'MTEXT': drawText(g, e, m); break;
    case 'INSERT': drawInsert(g, e, ctx, m, depth, col); break;
    default: ctx.unknown.set(e.type, (ctx.unknown.get(e.type) || 0) + 1);
  }
}

function drawText(g, e, m) {
  const mt = e.type === 'MTEXT';
  const p = mt ? e.insertionPoint : (e.halign || e.valign) && e.endPoint && (e.endPoint.x || e.endPoint.y) ? e.endPoint : e.startPoint;
  const h = e.textHeight || 1, rot = e.rotation || 0;
  const lines = cleanCadText(e.text).split('\n');
  const hAlign = mt ? [0, 0, 1, 2, 0, 1, 2, 0, 1, 2][e.attachmentPoint] || 0 : e.halign === 1 || e.halign === 4 ? 1 : e.halign === 2 ? 2 : 0;
  g.save();
  g.setTransform(...mMul(m, [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), p.x, p.y]));
  g.scale(1, -1);   // 글자는 위가 위로 서야 해서 뒤집는다
  g.font = `${h}px ${CAD_FONT}`;
  g.textAlign = ['left', 'center', 'right'][hAlign];
  g.textBaseline = mt && [1, 2, 3].includes(e.attachmentPoint) ? 'top' : mt && [7, 8, 9].includes(e.attachmentPoint) ? 'bottom' : 'alphabetic';
  lines.forEach((t, i) => g.fillText(t, 0, i * h * 1.3));
  g.restore();
}

function drawInsert(g, e, ctx, m, depth, col) {
  const blk = ctx.blocks.get(e.name);
  if (!blk || !blk.entities || depth >= CAD_MAX_DEPTH) return;
  const sx = e.xScale || 1, sy = e.yScale || 1, r = e.rotation || 0, bp = blk.basePoint || { x: 0, y: 0 };
  const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
  for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
    const ox = e.insertionPoint.x + ci * (e.columnSpacing || 0), oy = e.insertionPoint.y + ri * (e.rowSpacing || 0);
    const local = mMul([Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, ox, oy], [1, 0, 0, 1, -bp.x, -bp.y]);
    const mm = mMul(m, local);
    for (const c of blk.entities) drawEntity(g, c, ctx, mm, depth + 1, col);
  }
  for (const a of e.attribs || []) drawEntity(g, a, ctx, m, depth + 1, col);
}

// 시트 틀(INSERT) 찾기: 이름에 sheet 가 들어간 블록. 폭·높이는 블록 안 도형의 범위 × 배율
function findSheets(db, ctx) {
  const out = [];
  for (const e of db.entities) {
    if (e.type !== 'INSERT' || !/sheet/i.test(e.name)) continue;
    const blk = ctx.blocks.get(e.name);
    if (!blk) continue;
    let w = 0, h = 0;
    for (const c of blk.entities || []) for (const p of [c.startPoint, c.endPoint, ...(c.vertices || [])]) if (p) { w = Math.max(w, p.x); h = Math.max(h, p.y); }
    if (w < 1 || h < 1) continue;
    const x = e.insertionPoint.x, y = e.insertionPoint.y;
    out.push({ x, y, w: w * (e.xScale || 1), h: h * (e.yScale || 1), scale: e.xScale || 1 });
  }
  return out;
}

const inRect = (p, r) => p && p.x >= r.x - 1 && p.x <= r.x + r.w + 1 && p.y >= r.y - 1 && p.y <= r.y + r.h + 1;
const anchor = (e) => e.insertionPoint || e.startPoint || e.center || e.position || (e.vertices && e.vertices[0]);

// 사진 시트(그림 참조가 있고 도형은 거의 없음)는 도면이 아니라서 뺀다
function isPhotoSheet(db, r) {
  let img = 0, lines = 0;
  for (const e of db.entities) {
    if (!inRect(anchor(e), r)) continue;
    if (e.type === 'IMAGE') img++; else if (e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'CIRCLE') lines++;
  }
  return img > 0 && lines < 30;
}

function extentsOf(db) {
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  for (const e of db.entities) {
    if (e.type === 'IMAGE') continue;
    for (const p of [e.startPoint, e.endPoint, e.center, e.insertionPoint, ...(e.vertices || [])]) {
      if (p && isFinite(p.x) && isFinite(p.y) && (p.x || p.y)) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    }
  }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// 시트 틀이 없는 도면: 도형이 모여 있는 덩어리마다 한 장(칸 격자에서 이웃 3칸 안이면 같은 덩어리)
function clusterRects(db) {
  const all = extentsOf(db);
  if (!all) return [];
  const N = 200, cell = Math.max(all.w, all.h) / N, R = 3;
  const cells = new Map();   // "i,j" → 도형 개수
  for (const e of db.entities) {
    const p = e.type === 'IMAGE' ? null : anchor(e);
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    const k = `${Math.floor((p.x - all.x) / cell)},${Math.floor((p.y - all.y) / cell)}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  const seen = new Set(), out = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    const stack = [start]; seen.add(start);
    let n = 0, i0 = 1e9, j0 = 1e9, i1 = -1e9, j1 = -1e9;
    while (stack.length) {
      const [i, j] = stack.pop().split(',').map(Number);
      n += cells.get(`${i},${j}`);
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
        const k = `${i + a},${j + b}`;
        if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    if (n >= 50) out.push({ x: all.x + i0 * cell, y: all.y + j0 * cell, w: (i1 - i0 + 1) * cell, h: (j1 - j0 + 1) * cell });
  }
  return out;
}

function renderRect(db, ctx, r) {
  const k = CAD_LONG_SIDE_PX / Math.max(r.w, r.h);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(r.w * k); cv.height = Math.ceil(r.h * k);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.lineJoin = 'round';
  const m = [k, 0, 0, -k, -r.x * k, (r.y + r.h) * k];
  const pad = Math.max(r.w, r.h) * 0.02;
  const box = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
  for (const e of db.entities) {
    const a = anchor(e);
    if (a && !inRect(a, box) && e.type !== 'LWPOLYLINE') continue;
    if (e.type === 'LWPOLYLINE' && !(e.vertices || []).some((v) => inRect(v, box))) continue;
    drawEntity(g, e, ctx, m, 0, null);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return cv;
}

const canvasToPng = (cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했습니다.'))), 'image/png'));

// 파일 하나 → [PNG File, ...] (시트가 여럿이면 시트마다 한 장, 사진 시트는 제외)
async function cadToImageFiles(file, onStatus) {
  const say = onStatus || (() => {});
  say('도면 읽는 도구를 준비하는 중... (처음 한 번은 몇 초 걸립니다)');
  const { lib, m } = await loadCadLib();
  say('도면을 읽는 중...');
  const buf = await file.arrayBuffer();
  const isDxf = /\.dxf$/i.test(file.name);
  const ptr = lib.dwg_read_data(buf, isDxf ? m.Dwg_File_Type.DXF : m.Dwg_File_Type.DWG);
  if (ptr == null) throw new Error('도면 파일을 읽지 못했습니다. 파일이 손상됐거나 지원하지 않는 버전일 수 있습니다.');
  let db;
  try { db = lib.convert(ptr); } finally { try { lib.dwg_free(ptr); } catch { /* 해제 실패는 무시 */ } }
  const ctx = cadMakeCtx(db);
  let rects = findSheets(db, ctx).filter((r) => !isPhotoSheet(db, r)).sort((a, b) => a.x - b.x || b.y - a.y);
  if (!rects.length) rects = clusterRects(db).filter((r) => !isPhotoSheet(db, r)).sort((a, b) => a.x - b.x || b.y - a.y);
  if (!rects.length) throw new Error('도면에 그릴 내용이 없습니다.');
  const base = file.name.replace(CAD_DRAWING_RE, '');
  const files = [];
  for (let i = 0; i < rects.length; i++) {
    say(`도면을 그리는 중... (${i + 1}/${rects.length})`);
    await new Promise((r) => setTimeout(r, 0));   // 화면 문구가 먼저 갱신되게
    const blob = await canvasToPng(renderRect(db, ctx, rects[i]));
    files.push(new File([blob], rects.length === 1 ? `${base}.png` : `${base}_${i + 1}.png`, { type: 'image/png' }));
  }
  return files;
}
