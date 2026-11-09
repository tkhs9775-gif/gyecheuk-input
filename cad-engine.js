'use strict';
// CAD 탭 엔진(화면 코드 없음, node 시험 가능): libredwg 가 읽은 도면(db)을 화면·PDF 가 바로 그릴 수 있는
// 평평한 목록(선 polys · 채움 fills · 글자 texts · 스냅점 snaps)으로 바꾸고, 도각(도면 틀)을 찾고, 거리·면적을 잰다.
// 보기 값의 출처: cadcraft(CADPocket) app/mechanics.json — CADCraft 0.18 엔진에서 읽은 값(열 때 여백 1.1, 전체보기 1.05,
// 확대 단계 2, 휠 1.3, 스냅 반경 10px, 손가락 ×3).
// ponytail: 모형 공간만 그린다(배치/종이 공간 X). 선 종류(점선)·선 굵기는 무시하고 실선 한 굵기. 다중 지시선·표·OLE·그림은 안 그린다.

const CAD_MECH = { openMargin: 1.1, extentsMargin: 1.05, zoomStep: 2, wheelNotch: 1.3, aperturePx: 10, touchMul: 3 };
const CAD_MAX_DEPTH = 8;            // 블록 안 블록 한도
const CAD_MAX_POINTS = 6e6;         // 이보다 많으면 블록 펼치기를 멈춘다(폰 메모리 보호)
const ARC_SEG_PER_TURN = 72;        // 원 한 바퀴를 이만큼의 직선으로
const HATCH_MAX_SEGS = 2500;        // 무늬 해치 한 개의 선 한도(넘으면 옅은 채움으로). 촘촘한 무늬 몇 개가 선을 수십만 개로 불리지 않게
const FG = -1;                      // 색 7(흰/검정): 배경에 따라 바뀌는 글자색

const mMul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
const mPt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const IDENT = [1, 0, 0, 1, 0, 0];
const MIRROR_X = [-1, 0, 0, 1, 0, 0];   // 돌출 방향이 -Z 인 도형(OCS): x 가 뒤집힌다
const isMirrored = (e) => (e.extrusionDirection?.z ?? 1) < 0;
const finite = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

// AutoCAD 색 번호 → 0xRRGGBB (7 은 FG)
function aciRgb(i) {
  const base = [0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, FG, 0x808080, 0xc0c0c0];
  if (i >= 1 && i <= 9) return base[i];
  if (i >= 250 && i <= 255) { const g = Math.round(51 + (i - 250) * 40.8); return (g << 16) | (g << 8) | g; }
  if (i < 10 || i > 249) return FG;
  const hue = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10;
  const sat = k % 2 ? 0.5 : 1, val = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k];
  const c = val * sat, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = val - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60) % 6];
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

// 글자 속 서식 코드({\fKOR;...}, \P 줄바꿈, \S1^2; 겹친 글자, %%c 기호)를 읽을 수 있는 글자로
function cleanCadText(s) {
  return String(s ?? '')
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%')
    .replace(/\\S([^;^#/]*)[\^#/]([^;]*);/g, '$1/$2')
    .replace(/\\[fFHhWwQqTtAaCcp][^;]*;/g, '').replace(/\\[LlOoKkNX]/g, '').replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[{}]/g, '').replace(/\\\\/g, '\\');
}

// ---------- 곡선 → 점 ----------

function arcPts(cx, cy, r, a0, a1, ccw = true) {
  let sweep = ccw ? a1 - a0 : a0 - a1;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const n = Math.max(4, Math.ceil(sweep / (Math.PI * 2) * ARC_SEG_PER_TURN));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (ccw ? 1 : -1) * sweep * i / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

// 볼록(bulge) 한 칸: 끝점은 빼고 중간 점들만 넣는다
function bulgeInto(out, x1, y1, x2, y2, bulge) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (!d || !bulge) return;
  const ang = 4 * Math.atan(bulge), r = d / (2 * Math.sin(Math.abs(ang) / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
  const s = (bulge > 0 ? 1 : -1) * (Math.abs(bulge) > 1 ? -1 : 1);
  const cx = mx - s * h * (y2 - y1) / d, cy = my + s * h * (x2 - x1) / d;
  const pts = arcPts(cx, cy, r, Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), bulge > 0);
  for (let i = 2; i < pts.length - 2; i++) out.push(pts[i]);
}

// 정점 [{x,y,bulge}] → [x,y,...] (닫힌 것이면 처음 점으로 돌아오는 볼록까지)
function vertsPts(v, closed) {
  const out = [];
  const n = v.length;
  for (let i = 0; i < n; i++) {
    out.push(v[i].x, v[i].y);
    const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
    if (j >= 0 && v[i].bulge) bulgeInto(out, v[i].x, v[i].y, v[j].x, v[j].y, v[i].bulge);
  }
  if (closed && n > 1) out.push(v[0].x, v[0].y);
  return out;
}

function ellipsePts(e) {
  const M = e.majorAxisEndPoint, nz = e.extrusionDirection?.z ?? 1, r = e.axisRatio || 1;
  const mx = M.x, my = M.y, nx = -my * nz * r, ny = mx * nz * r;   // 짧은 축 = 비율 × (N × 긴 축)
  let t0 = e.startAngle ?? 0, t1 = e.endAngle ?? Math.PI * 2;
  while (t1 <= t0) t1 += Math.PI * 2;
  const n = Math.max(8, Math.ceil((t1 - t0) / (Math.PI * 2) * ARC_SEG_PER_TURN));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    out.push(e.center.x + mx * Math.cos(t) + nx * Math.sin(t), e.center.y + my * Math.cos(t) + ny * Math.sin(t));
  }
  return out;
}

// 스플라인(de Boor). 조정점이 없고 맞춤점만 있으면 맞춤점을 잇는다
function splinePts(e) {
  const P = e.controlPoints || [], k = e.knots || [], p = e.degree || 3, W = e.weights;
  if (P.length < 2 || k.length !== P.length + p + 1) return (e.fitPoints || []).flatMap((q) => [q.x, q.y]);
  const t0 = k[p], t1 = k[P.length], n = Math.max(16, P.length * 8), out = [];
  for (let s = 0; s <= n; s++) {
    const t = Math.min(t0 + (t1 - t0) * s / n, t1 - 1e-12);
    let span = p;
    while (span < P.length - 1 && t >= k[span + 1]) span++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const q = P[span - p + j], w = W ? W[span - p + j] : 1;
      d.push([q.x * w, q.y * w, w]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j, den = k[i + p - r + 1] - k[i], a = den ? (t - k[i]) / den : 0;
        d[j] = [0, 1, 2].map((c) => (1 - a) * d[j - 1][c] + a * d[j][c]);
      }
    }
    out.push(d[p][0] / d[p][2], d[p][1] / d[p][2]);
  }
  return out;
}

// 해치 경계 한 줄 → 닫힌 [x,y,...]
function hatchLoop(path) {
  if (path.vertices?.length) return vertsPts(path.vertices, true);
  const out = [];
  for (const g of path.edges || []) {
    let pts = [];
    if (g.type === 1) pts = [g.start.x, g.start.y, g.end.x, g.end.y];
    else if (g.type === 2) {
      const ccw = g.isCCW !== false && g.isCCW !== 0;
      pts = ccw ? arcPts(g.center.x, g.center.y, g.radius, g.startAngle, g.endAngle, true)
        : arcPts(g.center.x, g.center.y, g.radius, -g.startAngle, -g.endAngle, false);
    } else if (g.type === 3) pts = ellipsePts({ center: g.center, majorAxisEndPoint: g.end || g.majorAxisEndPoint, axisRatio: g.lengthOfMinorAxis ?? g.axisRatio, startAngle: g.startAngle, endAngle: g.endAngle });
    else if (g.type === 4) pts = splinePts(g);
    for (let i = 0; i < pts.length; i += 2) out.push(pts[i], pts[i + 1]);
  }
  if (out.length >= 4) out.push(out[0], out[1]);
  return out;
}

// 무늬 해치: 정의선마다 평행선을 그어 경계(짝홀 규칙) 안쪽만 남긴다. 점선 무늬는 대시 길이대로 끊는다.
// 돌려주는 값: [[x0,y0,x1,y1], ...] (선이 한도를 넘으면 null)
function hatchPatternSegs(loops, defs) {
  const out = [];
  for (const L of defs || []) {
    const a = L.angle || 0, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const ox = L.offset?.x || 0, oy = L.offset?.y || 0, bx = L.base?.x || 0, by = L.base?.y || 0;
    const s = ox * nx + oy * ny;
    if (!(Math.abs(s) > 1e-9)) continue;
    const shift = ox * dx + oy * dy, b0n = bx * nx + by * ny, b0u = bx * dx + by * dy;
    let tmin = Infinity, tmax = -Infinity;
    for (const lp of loops) for (let i = 0; i < lp.length; i += 2) { const t = lp[i] * nx + lp[i + 1] * ny; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    const kA = Math.ceil((tmin - b0n) / s), kB = Math.floor((tmax - b0n) / s);
    const k0 = Math.min(kA, kB), k1 = Math.max(kA, kB);
    if (k1 - k0 > HATCH_MAX_SEGS) return null;
    const dash = (L.dashLengths || []).filter(Number.isFinite), period = dash.reduce((x, y) => x + Math.abs(y), 0);
    const put = (u0, u1, t) => out.push([u0 * dx + t * nx, u0 * dy + t * ny, u1 * dx + t * nx, u1 * dy + t * ny]);
    for (let k = k0; k <= k1; k++) {
      const t = b0n + k * s, us = [];
      for (const lp of loops) {
        for (let i = 0; i + 3 < lp.length; i += 2) {
          const pn = lp[i] * nx + lp[i + 1] * ny - t, qn = lp[i + 2] * nx + lp[i + 3] * ny - t;
          if ((pn < 0) === (qn < 0)) continue;
          const f = pn / (pn - qn), x = lp[i] + (lp[i + 2] - lp[i]) * f, y = lp[i + 1] + (lp[i + 3] - lp[i + 1]) * f;
          us.push(x * dx + y * dy);
        }
      }
      us.sort((p, q) => p - q);
      for (let i = 0; i + 1 < us.length; i += 2) {
        const u0 = us[i], u1 = us[i + 1];
        if (!(period > 0)) { put(u0, u1, t); continue; }
        const org = b0u + k * shift;
        let u = org + Math.floor((u0 - org) / period) * period;
        for (let j = 0; u < u1 && j < 1e5; j++) {
          const len = dash[j % dash.length], e = u + Math.abs(len);
          if (len >= 0) {
            const a0 = Math.max(u, u0), a1 = Math.min(len === 0 ? u + period * 0.005 : e, u1);
            if (a1 > a0) put(a0, a1, t);
          }
          u = e;
        }
        if (out.length > HATCH_MAX_SEGS) return null;
      }
    }
  }
  return out;
}

// ---------- 도면 → 평평한 목록 ----------

function cadBuild(db) {
  const layerList = (db.tables?.LAYER?.entries || []).map((l) => ({ name: l.name, color: l.colorIndex > 0 && l.colorIndex < 256 ? aciRgb(l.colorIndex) : (Number.isFinite(l.color) ? l.color : FG), on: !l.off && !l.frozen, n: 0 }));
  const layerIdx = new Map(layerList.map((l, i) => [l.name, i]));
  const layerOf = (name) => {
    if (!layerIdx.has(name)) { layerIdx.set(name, layerList.length); layerList.push({ name, color: FG, on: true, n: 0 }); }
    return layerIdx.get(name);
  };
  const blocks = new Map((db.tables?.BLOCK_RECORD?.entries || []).map((b) => [b.name, b]));
  const model = {
    polys: [], fills: [], texts: [], snaps: [], layers: layerList, blockCounts: new Map(), rects: [], insertBoxes: [], hlines: [], vlines: [],
    units: db.header?.INSUNITS ?? 0, truncated: false, skipped: new Map(), points: 0,
  };

  // 색: 진짜색 > 색 번호(0=블록 따라, 256=도면층 따라)
  const colorOf = (e, L, byBlock) => {
    if (Number.isFinite(e.color) && e.color >= 0 && e.color <= 0xffffff && e.colorIndex !== 256 && e.colorIndex !== 0) return e.color;
    const c = e.colorIndex;
    if (c === 0) return byBlock ?? FG;
    if (c === 256 || c == null) return layerList[L].color;
    return aciRgb(Math.abs(c));
  };

  const addPoly = (m, pts, L, c, closed, top) => {
    if (pts.length < 4) return null;
    const out = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) { const [x, y] = mPt(m, pts[i], pts[i + 1]); out[i] = x; out[i + 1] = y; }
    model.polys.push({ L, c, p: out, closed: !!closed, top });
    layerList[L].n++;
    model.points += pts.length / 2;
    return out;
  };
  const snap = (m, x, y, kind) => { const [a, b] = mPt(m, x, y); model.snaps.push(a, b, kind); };
  const SN = { end: 0, mid: 1, cen: 2, ins: 3, node: 4, quad: 5 };

  // 축에 나란한 직사각형이면 도각 후보로 적는다(블록 안이면 그 블록의 맨 위 INSERT 번호와 함께)
  const noteRect = (p, top) => {
    let n = p.length / 2;
    if (n === 5 && Math.abs(p[0] - p[8]) < 1e-6 && Math.abs(p[1] - p[9]) < 1e-6) n = 4;
    if (n !== 4) return;
    const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), tol = Math.max(x1 - x0, y1 - y0) * 1e-4;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
    for (let i = 0; i < 4; i++) {
      const okX = Math.abs(xs[i] - x0) < tol || Math.abs(xs[i] - x1) < tol, okY = Math.abs(ys[i] - y0) < tol || Math.abs(ys[i] - y1) < tol;
      if (!okX || !okY) return;
    }
    model.rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, top });
  };

  function walk(e, m, depth, byBlock, parentL, top) {
    if (!e || e.isVisible === false) return;
    if (model.points > CAD_MAX_POINTS) { model.truncated = true; return; }
    const L = layerOf(e.layer === '0' && parentL != null ? layerList[parentL].name : (e.layer ?? '0'));
    const c = colorOf(e, L, byBlock);
    const mm = isMirrored(e) && !['LINE', 'ELLIPSE', 'SPLINE', 'POLYLINE3D', 'MLINE', 'LEADER', 'DIMENSION', 'HATCH'].includes(e.type) ? mMul(m, MIRROR_X) : m;
    switch (e.type) {
      case 'LINE': {
        if (!finite(e.startPoint) || !finite(e.endPoint)) break;
        const p = addPoly(m, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y], L, c, false, top);
        if (!p) break;
        model.snaps.push(p[0], p[1], SN.end, p[2], p[3], SN.end, (p[0] + p[2]) / 2, (p[1] + p[3]) / 2, SN.mid);
        const len = Math.hypot(p[2] - p[0], p[3] - p[1]);
        if (Math.abs(p[1] - p[3]) < len * 1e-6) model.hlines.push({ y: p[1], x0: Math.min(p[0], p[2]), x1: Math.max(p[0], p[2]) });
        else if (Math.abs(p[0] - p[2]) < len * 1e-6) model.vlines.push({ x: p[0], y0: Math.min(p[1], p[3]), y1: Math.max(p[1], p[3]) });
        break;
      }
      case 'LWPOLYLINE': case 'POLYLINE2D': case 'POLYLINE3D': {
        let v = (e.vertices || []).filter(finite);
        if (e.type !== 'LWPOLYLINE') v = v.filter((q) => !((q.flag ?? 0) & 16));   // 스플라인 맞춤 조정점은 빼고 곡선 점만
        if (v.length < 2) break;
        const closed = (e.flag & 1) === 1;
        const p = addPoly(mm, vertsPts(v, closed), L, c, closed, top);
        if (!p) break;
        v.forEach((q, i) => {
          snap(mm, q.x, q.y, SN.end);
          const nq = v[i + 1] || (closed ? v[0] : null);
          if (nq && !q.bulge) snap(mm, (q.x + nq.x) / 2, (q.y + nq.y) / 2, SN.mid);
        });
        if (!v.some((q) => q.bulge)) noteRect(p, top);
        break;
      }
      case 'CIRCLE': {
        if (!finite(e.center)) break;
        addPoly(mm, arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2), L, c, true, top);
        snap(mm, e.center.x, e.center.y, SN.cen);
        for (let k = 0; k < 4; k++) snap(mm, e.center.x + e.radius * Math.cos(k * Math.PI / 2), e.center.y + e.radius * Math.sin(k * Math.PI / 2), SN.quad);
        break;
      }
      case 'ARC': {
        if (!finite(e.center)) break;
        const pts = arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
        addPoly(mm, pts, L, c, false, top);
        snap(mm, e.center.x, e.center.y, SN.cen);
        snap(mm, pts[0], pts[1], SN.end); snap(mm, pts[pts.length - 2], pts[pts.length - 1], SN.end);
        const h = Math.floor(pts.length / 4) * 2; snap(mm, pts[h], pts[h + 1], SN.mid);
        break;
      }
      case 'ELLIPSE': if (finite(e.center) && finite(e.majorAxisEndPoint)) { addPoly(m, ellipsePts(e), L, c, false, top); snap(m, e.center.x, e.center.y, SN.cen); } break;
      case 'SPLINE': { const pts = splinePts(e); if (pts.length >= 4) { addPoly(m, pts, L, c, false, top); snap(m, pts[0], pts[1], SN.end); snap(m, pts[pts.length - 2], pts[pts.length - 1], SN.end); } break; }
      case 'LEADER': { const v = (e.vertices || []).filter(finite); if (v.length > 1) addPoly(m, v.flatMap((q) => [q.x, q.y]), L, c, false, top); break; }
      case 'MLINE': {
        const V = (e.vertices || []).filter((q) => finite(q.vertex) && finite(q.miterDirection));
        const nl = V[0]?.lines?.length || 0, sc = e.scale || 1, closed = (e.flags & 2) === 2;
        for (let li = 0; li < nl; li++) {
          const pts = [];
          for (const q of V) { const off = (q.lines?.[li]?.segmentParams?.[0] || 0) * sc; pts.push(q.vertex.x + q.miterDirection.x * off, q.vertex.y + q.miterDirection.y * off); }
          if (closed && pts.length) pts.push(pts[0], pts[1]);
          addPoly(m, pts, L, c, false, top);
        }
        for (const q of V) snap(m, q.vertex.x, q.vertex.y, SN.end);
        break;
      }
      case 'SOLID': case 'TRACE': {
        const q = [e.corner1, e.corner2, e.corner4, e.corner3].filter(finite);
        if (q.length < 3) break;
        const pts = []; for (const k of q) { const [x, y] = mPt(mm, k.x, k.y); pts.push(x, y); }
        model.fills.push({ L, c, loops: [pts], alpha: 1 });
        layerList[L].n++;
        break;
      }
      case 'HATCH': {
        const loops = (e.boundaryPaths || []).map(hatchLoop).filter((l) => l.length >= 6);
        if (!loops.length) break;
        const hm = isMirrored(e) ? mMul(m, MIRROR_X) : m;
        const tr = (l) => { const o = []; for (let i = 0; i < l.length; i += 2) { const [x, y] = mPt(hm, l[i], l[i + 1]); o.push(x, y); } return o; };
        layerList[L].n++;
        if (e.solidFill) { model.fills.push({ L, c, loops: loops.map(tr), alpha: 1 }); break; }
        const segs = hatchPatternSegs(loops, e.definitionLines);
        if (!segs) { model.fills.push({ L, c, loops: loops.map(tr), alpha: 0.18 }); break; }
        for (const s of segs) addPoly(hm, s, L, c, false, top);
        break;
      }
      case 'TEXT': case 'ATTRIB': case 'ATTDEF': case 'MTEXT': addText(e, mm, L, c); break;
      case 'POINT': if (finite(e.position)) snap(mm, e.position.x, e.position.y, SN.node); break;
      case 'DIMENSION': {
        const blk = blocks.get(e.name);
        if (blk && depth < CAD_MAX_DEPTH) for (const k of blk.entities || []) walk(k, m, depth + 1, c, L, top);
        break;
      }
      case 'INSERT': walkInsert(e, mm, depth, c, L, top); break;
      default: model.skipped.set(e.type, (model.skipped.get(e.type) || 0) + 1);
    }
  }

  function addText(e, m, L, c) {
    const t = e.type === 'ATTRIB' || e.type === 'ATTDEF' ? { ...(e.text || {}), type: 'TEXT' } : e;
    const s = cleanCadText(t.text);
    if (!s.trim()) return;
    const mt = t.type === 'MTEXT';
    const aligned = !mt && (t.halign || t.valign) && finite(t.endPoint) && (t.endPoint.x || t.endPoint.y);
    const p = mt ? t.insertionPoint : aligned ? t.endPoint : t.startPoint;
    if (!finite(p)) return;
    let rot = mt && t.direction && (t.direction.x || t.direction.y) ? Math.atan2(t.direction.y, t.direction.x) : (t.rotation || 0);
    const [x, y] = mPt(m, p.x, p.y);
    rot += Math.atan2(m[1], m[0]);
    let ha, va;
    if (mt) { const ap = t.attachmentPoint || 1; ha = (ap - 1) % 3; va = ['top', 'top', 'top', 'middle', 'middle', 'middle', 'bottom', 'bottom', 'bottom'][ap - 1] || 'top'; }
    else { ha = t.halign === 1 || t.halign === 4 ? 1 : t.halign === 2 ? 2 : 0; va = t.halign === 4 ? 'middle' : ['alphabetic', 'bottom', 'middle', 'top'][t.valign || 0]; }
    const h = (t.textHeight || 1) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    model.texts.push({ L, c, x, y, h, rot, s, ha, va, xs: t.xScale || 1 });
    layerList[L].n++;
    model.snaps.push(x, y, SN.ins);
  }

  function walkInsert(e, m, depth, c, L, top) {
    const blk = blocks.get(e.name);
    if (!blk || depth >= CAD_MAX_DEPTH || !finite(e.insertionPoint)) return;
    const sx = e.xScale || 1, sy = e.yScale || 1, r = e.rotation || 0, bp = blk.basePoint || { x: 0, y: 0 };
    const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
    const cs = Math.cos(r), sn = Math.sin(r);
    for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
      const ox = ci * (e.columnSpacing || 0), oy = ri * (e.rowSpacing || 0);
      const ix = e.insertionPoint.x + ox * cs - oy * sn, iy = e.insertionPoint.y + ox * sn + oy * cs;
      const local = mMul([cs * sx, sn * sx, -sn * sy, cs * sy, ix, iy], [1, 0, 0, 1, -bp.x, -bp.y]);
      const mm = mMul(m, local);
      let myTop = top;
      if (top == null) { myTop = model.insertBoxes.length; model.insertBoxes.push({ name: e.name, from: model.polys.length, to: model.polys.length }); }
      for (const k of blk.entities || []) walk(k, mm, depth + 1, c, L, myTop);
      if (top == null) model.insertBoxes[myTop].to = model.polys.length;
    }
    for (const a of e.attribs || []) walk(a, m, depth + 1, c, L, top);
    const [x, y] = mPt(m, e.insertionPoint.x, e.insertionPoint.y);
    model.snaps.push(x, y, SN.ins);
    if (depth === 0) model.blockCounts.set(e.name, (model.blockCounts.get(e.name) || 0) + 1);
  }

  for (const e of db.entities || []) walk(e, IDENT, 0, null, null, null);
  finishModel(model);
  return model;
}

function boxOf(p) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < p.length; i += 2) { if (p[i] < a) a = p[i]; if (p[i] > c) c = p[i]; if (p[i + 1] < b) b = p[i + 1]; if (p[i + 1] > d) d = p[i + 1]; }
  return [a, b, c, d];
}

// 범위 계산. 아주 멀리 떨어진 도형 몇 개(0,0 근처 찌꺼기 등) 때문에 전체보기가 점이 되지 않게, 도형 중심의 99% 가 든 범위를 기본 범위(extents)로
function finishModel(model) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (b) => { if (b[0] < x0) x0 = b[0]; if (b[2] > x1) x1 = b[2]; if (b[1] < y0) y0 = b[1]; if (b[3] > y1) y1 = b[3]; };
  for (const p of model.polys) { p.box = boxOf(p.p); grow(p.box); }
  for (const f of model.fills) { f.box = boxOf(f.loops.flat()); grow(f.box); }
  for (const t of model.texts) { t.box = [t.x - t.h, t.y - t.h, t.x + t.h, t.y + t.h]; grow(t.box); }
  if (!(x1 >= x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  model.fullExtents = { x: x0, y: y0, w: Math.max(x1 - x0, 1e-9), h: Math.max(y1 - y0, 1e-9) };
  // 멀리 떨어진 찌꺼기가 없으면(전체 범위가 99% 범위의 2.5배 안) 전체 범위를 쓴다: 가장자리 도면이 잘려 보이지 않게
  const rob = robustExtents(model), full = model.fullExtents;
  model.extents = rob && (full.w > rob.w * 2.5 || full.h > rob.h * 2.5) ? rob : full;
  model.snaps = Float64Array.from(model.snaps);
  for (const ib of model.insertBoxes) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = ib.from; i < ib.to; i++) { const q = model.polys[i].box; a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[2]); d = Math.max(d, q[3]); }
    ib.box = c > a ? { x: a, y: b, w: c - a, h: d - b } : null;
  }
}

function robustExtents(model) {
  if (model.polys.length < 50) return null;
  const xs = [], ys = [];
  for (const p of model.polys) { xs.push((p.box[0] + p.box[2]) / 2); ys.push((p.box[1] + p.box[3]) / 2); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
  const ax = q(xs, 0.005), bx = q(xs, 0.995), ay = q(ys, 0.005), by = q(ys, 0.995);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of model.polys) {
    const cx = (p.box[0] + p.box[2]) / 2, cy = (p.box[1] + p.box[3]) / 2;
    if (cx < ax || cx > bx || cy < ay || cy > by) continue;
    x0 = Math.min(x0, p.box[0]); y0 = Math.min(y0, p.box[1]); x1 = Math.max(x1, p.box[2]); y1 = Math.max(y1, p.box[3]);
  }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ---------- 도각(도면 틀) 추적 ----------

const FRAME_NAME_RE = /sheet|frame|border|title|도각|도곽|표제|외곽|^a[0-4]$|^a[0-4][-_ ]|form|틀/i;
const PAPER_ASPECT = [1.25, 1.62];   // A 계열(1.414)·여백 있는 틀·B 계열까지
const inside = (a, b, tol) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const aspectOf = (r) => Math.max(r.w, r.h) / Math.min(r.w, r.h);

// 낱개 선 4개로 그린 틀(폭발시킨 도각): 길이가 같은 가로선 두 개 + 그 양 끝을 잇는 세로선 두 개
function lineRects(model, minLen) {
  const H = model.hlines.filter((l) => l.x1 - l.x0 >= minLen), V = model.vlines.filter((l) => l.y1 - l.y0 >= minLen * 0.5);
  if (H.length > 4000 || V.length > 4000) return [];
  const out = [];
  const near = (a, b, t) => Math.abs(a - b) <= t;
  for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
    const a = H[i], b = H[j], t = (a.x1 - a.x0) * 0.002;
    if (!near(a.x0, b.x0, t) || !near(a.x1, b.x1, t) || near(a.y, b.y, t)) continue;
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const side = (x) => V.some((v) => near(v.x, x, t) && v.y0 <= y0 + t && v.y1 >= y1 - t);
    if (side(a.x0) && side(a.x1)) out.push({ x: a.x0, y: y0, w: a.x1 - a.x0, h: y1 - y0, top: null });
  }
  return out;
}

// 도각 후보: ① 이름이 틀 같은 블록(INSERT)의 범위 ② 종이 비율의 직사각형(폴리선·낱개 선) ③ 블록 범위와 거의 같은 직사각형을 가진 블록.
// 다른 후보 안에 든 것(안쪽 테두리·상세 상자)은 뺀다. 순서는 위 줄부터, 줄 안에서는 왼쪽부터
function cadFindFrames(model) {
  const ext = model.fullExtents, big = Math.max(ext.w, ext.h);
  const paper = (r) => aspectOf(r) >= PAPER_ASPECT[0] && aspectOf(r) <= PAPER_ASPECT[1];
  const cands = [];
  model.insertBoxes.forEach((ib, i) => {
    if (!ib.box || Math.max(ib.box.w, ib.box.h) < big * 0.02) return;
    const named = FRAME_NAME_RE.test(ib.name);
    const ownRect = model.rects.some((r) => r.top === i && r.w >= ib.box.w * 0.9 && r.h >= ib.box.h * 0.9);
    if (named || (ownRect && paper(ib.box))) cands.push({ ...ib.box, by: named ? 'name' : 'block', label: ib.name });
  });
  for (const r of model.rects) if (r.top == null && paper(r) && Math.max(r.w, r.h) >= big * 0.02) cands.push({ ...r, by: 'rect' });
  for (const r of lineRects(model, big * 0.02)) if (paper(r)) cands.push({ ...r, by: 'lines' });
  if (!cands.length) return [];
  // 너무 작은 것(최대 후보 넓이의 15% 미만)은 도각이 아니라 도면 속 상자
  const maxA = Math.max(...cands.map((r) => r.w * r.h));
  let list = cands.filter((r) => r.w * r.h >= maxA * 0.15);
  // 같은 것은 하나로, 다른 후보 안에 든 것은 뺀다
  list = list.filter((r, i) => !list.some((o, j) => j !== i && inside(r, o, Math.max(o.w, o.h) * 0.003) && (o.w * o.h > r.w * r.h * 1.0001 || j < i)));
  // 내용이 거의 없는 틀(빈 양식)은 뺀다
  list = list.filter((r) => countInside(model, r) >= 8);
  return sortReading(list).map((r, i) => ({ x: r.x, y: r.y, w: r.w, h: r.h, by: r.by, label: r.label || '', n: i + 1 }));
}

function countInside(model, r) {
  let n = 0;
  for (const p of model.polys) {
    const cx = (p.box[0] + p.box[2]) / 2, cy = (p.box[1] + p.box[3]) / 2;
    if (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h && ++n >= 8) break;
  }
  return n;
}

function sortReading(list) {
  const rows = [];
  for (const r of [...list].sort((a, b) => (b.y + b.h) - (a.y + a.h))) {
    const row = rows.find((w) => Math.abs((w[0].y + w[0].h / 2) - (r.y + r.h / 2)) < Math.min(w[0].h, r.h) * 0.5);
    if (row) row.push(r); else rows.push([r]);
  }
  return rows.flatMap((w) => w.sort((a, b) => a.x - b.x));
}

// 틀이 없는 도면: 도형이 모인 덩어리마다 한 장(격자 이웃 3칸 안이면 같은 덩어리)
function cadClusterFrames(model) {
  const ext = model.extents, N = 200, cell = Math.max(ext.w, ext.h) / N, R = 3, cells = new Map();
  for (const p of model.polys) {
    const cx = (p.box[0] + p.box[2]) / 2, cy = (p.box[1] + p.box[3]) / 2;
    if (cx < ext.x || cy < ext.y || cx > ext.x + ext.w || cy > ext.y + ext.h) continue;
    const k = `${Math.floor((cx - ext.x) / cell)},${Math.floor((cy - ext.y) / cell)}`;
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
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) { const k = `${i + a},${j + b}`; if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); } }
    }
    if (n >= 50) out.push({ x: ext.x + i0 * cell, y: ext.y + j0 * cell, w: (i1 - i0 + 1) * cell, h: (j1 - j0 + 1) * cell, by: 'cluster' });
  }
  return sortReading(out).map((r, i) => ({ ...r, n: i + 1 }));
}

// ---------- 스냅·측정 ----------

// 스냅점 격자 찾기표(셀마다 점 번호)
function cadSnapIndex(model) {
  const e = model.fullExtents, cell = Math.max(e.w, e.h) / 1024 || 1, grid = new Map(), s = model.snaps;
  for (let i = 0; i < s.length; i += 3) {
    const k = `${Math.floor((s[i] - e.x) / cell)},${Math.floor((s[i + 1] - e.y) / cell)}`;
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  return { cell, grid, e };
}

const SNAP_NAMES = ['끝점', '중간점', '중심', '삽입점', '점', '사분점'];

// (x, y) 에서 r(도면 단위) 안의 가장 가까운 스냅점
function cadNearestSnap(model, idx, x, y, r) {
  const { cell, grid, e } = idx, s = model.snaps;
  const i0 = Math.floor((x - r - e.x) / cell), i1 = Math.floor((x + r - e.x) / cell), j0 = Math.floor((y - r - e.y) / cell), j1 = Math.floor((y + r - e.y) / cell);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 40000) return null;   // 너무 멀리 축소된 화면에서는 스냅하지 않는다
  let best = null, bd = r * r;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    for (const k of grid.get(`${i},${j}`) || []) {
      const d = (s[k] - x) ** 2 + (s[k + 1] - y) ** 2;
      if (d <= bd) { bd = d; best = { x: s[k], y: s[k + 1], kind: s[k + 2], name: SNAP_NAMES[s[k + 2]] }; }
    }
  }
  return best;
}

function cadDist(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let ang = Math.atan2(dy, dx) * 180 / Math.PI; if (ang < 0) ang += 360;
  return { d: Math.hypot(dx, dy), ang, dx, dy };
}

function cadArea(pts) {
  let a = 0, per = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return { area: Math.abs(a) / 2, perimeter: per };
}

// 단위: INSUNITS 4=mm 5=cm 6=m 1=inch 2=feet, 0(없음)은 우리 도면 관례대로 mm 로 본다
const UNIT_TO_M = { 0: 0.001, 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
const UNIT_LABEL = { 0: 'mm', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const fmtNum = (v, d) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
function cadFmtLen(v, units) {
  const m = v * (UNIT_TO_M[units] ?? 0.001);
  return units === 6 || !(units in UNIT_LABEL) ? `${fmtNum(m, 3)} m` : `${fmtNum(m, 3)} m (${fmtNum(v, 1)} ${UNIT_LABEL[units]})`;
}
function cadFmtArea(v, units) {
  return `${fmtNum(v * (UNIT_TO_M[units] ?? 0.001) ** 2, 3)} m²`;
}

// 블록 개수표: 이름 있는 블록만, 많은 순(익명 *U·*D 는 '이름 없는 블록' 하나로)
function cadBlockTable(model) {
  const rows = new Map();
  for (const [name, n] of model.blockCounts) {
    const key = name.startsWith('*') ? '(이름 없는 블록)' : name;
    rows.set(key, (rows.get(key) || 0) + n);
  }
  return [...rows].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ko'));
}

if (typeof module !== 'undefined') {
  module.exports = { CAD_MECH, FG, aciRgb, cleanCadText, arcPts, vertsPts, ellipsePts, splinePts, hatchLoop, hatchPatternSegs, cadBuild, cadFindFrames, cadClusterFrames, cadSnapIndex, cadNearestSnap, cadDist, cadArea, cadFmtLen, cadFmtArea, cadBlockTable, sortReading };
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.CadEngine = { cadBuild, cadFindFrames, cadClusterFrames, cadBlockTable };
}
