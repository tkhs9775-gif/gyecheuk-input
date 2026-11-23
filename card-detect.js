// 명함 모서리 찾기(직선 방식): 그림 데이터({ width, height, data(RGBA) })만 받는 순수 함수. 화면·작업 스레드(card-live-worker.js)·노드 시험이 같이 쓴다.
// 사용: CardDetect.detectQuad(img) → { tl, tr, br, bl }(0~1 비율) 또는 null. 입력은 긴 변 약 256px 로 줄인 그림.
(function (root) {
  const KEYS = ['tl', 'tr', 'br', 'bl'];
  // ---- 모서리 찾기(직선 방식): 색 덩어리 방식(CardEnhance.detectCardQuad)은 흰 책상·무늬 배경·손에 약했다(2026-11-23 폰 사용자 지적) ----
  // 1) 글자 밝기의 경계(Sobel)를 모으고 2) 경계 점마다 '그 점을 지나는 직선'에 표를 던져(Hough) 3) 표가 많은 직선들 중 마주 보는 두 쌍으로
  // 사각형을 만들어 4) 네 변이 실제 경계와 얼마나 겹치는지(덮임) × 크기로 가장 명함다운 것을 고른다. 손·그림자가 한 변을 가려도 나머지 세 변으로 잡는다.
  const NT = 90;                  // 각도 칸(2도)
  const VOTE_W = [0.4, 0.7, 1, 0.7, 0.4];   // 경계 방향이 ±4도 흔들려도(계단·손떨림) 같은 직선에 표가 모이게
  const PEAKS = 16;               // 후보 직선 수
  const EDGE_FLOOR = 40;          // 경계로 칠 최소 세기(밝기 차 10 정도, Sobel 합 4배)
  const EDGE_KEEP = 0.1;          // 세기 상위 10% 를 경계로(바닥값 이상일 때)
  const MIN_SIDE_COVER = 0.25;    // 네 변 각각 최소 덮임
  const MIN_MEAN_COVER = 0.55;    // 네 변 평균 최소 덮임
  const PAR_DEG = 14;             // 마주 보는 변으로 칠 각도 차
  const PERP_MIN_DEG = 52;        // 이웃 변 사이 최소 각도(원근으로 직각이 찌그러져도 허용)
  const SAMPLES = 22;             // 한 변에서 덮임을 보는 점 수

  const polyArea = (P) => { let a = 0; for (let i = 0; i < P.length; i += 1) { const p = P[i]; const q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };

  function edgeMap(img) {
    const { width: w, height: h, data: d } = img;
    const n = w * h;
    const gray = new Float32Array(n);
    for (let p = 0; p < n; p += 1) { const i = p * 4; gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; }
    const bl = new Float32Array(n);
    for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      bl[p] = (gray[p - w - 1] + gray[p - w] + gray[p - w + 1] + gray[p - 1] + gray[p] + gray[p + 1] + gray[p + w - 1] + gray[p + w] + gray[p + w + 1]) / 9;
    }
    const gx = new Float32Array(n); const gy = new Float32Array(n); const mag = new Float32Array(n);
    let top = 0;
    for (let y = 2; y < h - 2; y += 1) for (let x = 2; x < w - 2; x += 1) {
      const p = y * w + x;
      const sx = (bl[p - w + 1] + 2 * bl[p + 1] + bl[p + w + 1]) - (bl[p - w - 1] + 2 * bl[p - 1] + bl[p + w - 1]);
      const sy = (bl[p + w - 1] + 2 * bl[p + w] + bl[p + w + 1]) - (bl[p - w - 1] + 2 * bl[p - w] + bl[p - w + 1]);
      gx[p] = sx; gy[p] = sy; mag[p] = Math.abs(sx) + Math.abs(sy);
      if (mag[p] > top) top = mag[p];
    }
    const bins = new Uint32Array(256);
    for (let p = 0; p < n; p += 1) if (mag[p] > 0) bins[Math.min(255, Math.floor((mag[p] / (top || 1)) * 255))] += 1;
    let acc = 0; let cut = 0;   // 경계가 10% 도 안 되는 깨끗한 배경이면 바닥값(EDGE_FLOOR)만 쓴다
    for (let b = 255; b >= 0; b -= 1) { acc += bins[b]; if (acc >= n * EDGE_KEEP) { cut = b; break; } }
    const t = Math.max(EDGE_FLOOR, (cut / 255) * top);
    const on = new Uint8Array(n);
    for (let p = 0; p < n; p += 1) if (mag[p] >= t) on[p] = 1;
    return { w, h, on, gx, gy };
  }

  function houghLines(e) {
    const { w, h, on, gx, gy } = e;
    const R = Math.ceil(Math.hypot(w, h));
    const W2 = 2 * R + 1;
    const votes = new Float32Array(NT * W2);
    const cs = new Float32Array(NT); const sn = new Float32Array(NT);
    for (let t = 0; t < NT; t += 1) { cs[t] = Math.cos((t * Math.PI) / NT); sn[t] = Math.sin((t * Math.PI) / NT); }
    for (let y = 2; y < h - 2; y += 1) for (let x = 2; x < w - 2; x += 1) {
      const p = y * w + x;
      if (!on[p]) continue;
      let th = Math.atan2(gy[p], gx[p]); if (th < 0) th += Math.PI;
      const ti = Math.round((th / Math.PI) * NT) % NT;
      for (let dt = -2; dt <= 2; dt += 1) {
        const tj = (ti + dt + NT) % NT;
        votes[tj * W2 + Math.round(x * cs[tj] + y * sn[tj]) + R] += VOTE_W[dt + 2];
      }
    }
    // 표가 이웃 칸(±2px)으로 갈라지므로 ρ 방향으로 5칸 합쳐서 본다(선이 두껍거나 계단져도 한 봉우리가 되게)
    const sv = new Float32Array(NT * W2);
    for (let t = 0; t < NT; t += 1) for (let r = 2; r < W2 - 2; r += 1) {
      const o = t * W2 + r;
      sv[o] = votes[o - 2] + votes[o - 1] + votes[o] + votes[o + 1] + votes[o + 2];
    }
    const minV = Math.max(20, Math.min(w, h) * 0.2);
    const found = [];
    for (let t = 0; t < NT; t += 1) for (let r = 1; r < W2 - 1; r += 1) {
      const v = sv[t * W2 + r];
      if (v < minV) continue;
      let best = true;
      for (let dt = -4; dt <= 4 && best; dt += 1) {
        const tt = t + dt; if (tt < 0 || tt >= NT) continue;
        for (let dr = -6; dr <= 6; dr += 1) {
          const rr = r + dr; if (rr < 0 || rr >= W2 || (dt === 0 && dr === 0)) continue;
          const o = sv[tt * W2 + rr];
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) { best = false; break; }
        }
      }
      if (best) found.push({ th: (t * Math.PI) / NT, rho: r - R, v });
    }
    return found.sort((a, b) => b.v - a.v).slice(0, PEAKS);
  }

  const angDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  function cross(a, b) {
    const ca = Math.cos(a.th); const sa = Math.sin(a.th); const cb = Math.cos(b.th); const sb = Math.sin(b.th);
    const det = ca * sb - sa * cb;
    if (Math.abs(det) < 0.25) return null;
    return { x: (a.rho * sb - sa * b.rho) / det, y: (ca * b.rho - a.rho * cb) / det };
  }
  const sepOf = (a, b) => Math.abs(a.rho - (Math.cos(a.th - b.th) >= 0 ? 1 : -1) * b.rho);

  // 변(두 끝점) 위 점들 가까이(3x3)에 경계가 있는 비율
  function cover(e, p, q) {
    let hit = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const f = 0.06 + (0.88 * i) / (SAMPLES - 1);
      const x = Math.round(p.x + (q.x - p.x) * f); const y = Math.round(p.y + (q.y - p.y) * f);
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const X = x + dx; const Y = y + dy;
        if (X >= 0 && Y >= 0 && X < e.w && Y < e.h && e.on[Y * e.w + X]) { ok = true; break; }
      }
      if (ok) hit += 1;
    }
    return hit / SAMPLES;
  }

  // 입력: { width, height, data(RGBA) } 긴 변 약 256. 결과: { tl, tr, br, bl }(0~1 비율) 또는 null
  function detectQuad(img) {
    if (!img || img.width < 40 || img.height < 40) return null;
    const e = edgeMap(img);
    const lines = houghLines(e);
    if (lines.length < 4) return null;
    const { w, h } = e;
    const minSep = Math.min(w, h) * 0.18;
    const pairs = [];
    for (let i = 0; i < lines.length; i += 1) for (let j = i + 1; j < lines.length; j += 1) {
      if (angDiff(lines[i].th, lines[j].th) <= (PAR_DEG * Math.PI) / 180 && sepOf(lines[i], lines[j]) >= minSep) pairs.push([lines[i], lines[j]]);
    }
    let best = null;
    for (let i = 0; i < pairs.length; i += 1) for (let j = i + 1; j < pairs.length; j += 1) {
      const [a, b] = pairs[i]; const [c, d] = pairs[j];
      if (angDiff(a.th, c.th) < (PERP_MIN_DEG * Math.PI) / 180) continue;
      const P = [cross(a, c), cross(a, d), cross(b, d), cross(b, c)];
      if (P.some((p) => !p || p.x < -0.04 * w || p.x > 1.04 * w || p.y < -0.04 * h || p.y > 1.04 * h)) continue;
      const share = polyArea(P) / (w * h);
      if (share < 0.05 || share > 0.97) continue;
      const side = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const s1 = (side(P[0], P[1]) + side(P[3], P[2])) / 2; const s2 = (side(P[0], P[3]) + side(P[1], P[2])) / 2;
      const ratio = Math.max(s1, s2) / Math.max(1, Math.min(s1, s2));
      if (ratio < 1.15 || ratio > 2.9) continue;
      const cov = [cover(e, P[0], P[1]), cover(e, P[1], P[2]), cover(e, P[2], P[3]), cover(e, P[3], P[0])];
      const mean = (cov[0] + cov[1] + cov[2] + cov[3]) / 4; const min = Math.min(...cov);
      if (min < MIN_SIDE_COVER || mean < MIN_MEAN_COVER) continue;
      const score = mean * (0.6 + 0.4 * min) * (0.55 + share);
      if (!best || score > best.score) best = { score, P };
    }
    if (!best) return null;
    const pts = best.P.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) }));
    const pick = (f, dir) => pts.reduce((m, p) => (dir * f(p) < dir * f(m) ? p : m));
    return { tl: pick((p) => p.x + p.y, 1), tr: pick((p) => p.x - p.y, -1), br: pick((p) => p.x + p.y, -1), bl: pick((p) => p.x - p.y, 1) };
  }


  root.CardDetect = { detectQuad };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CardDetect;
})(typeof self !== 'undefined' ? self : globalThis);
