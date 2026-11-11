// 명함 사진 보정(명함 앱의 '스캔' 기능): 그림 데이터({ data, width, height }, RGBA)만 받는 순수 함수 모음.
// 휴대폰(web/card-crop.js)과 PC(pc-app/ui/card-enhance.js 복사본)가 같이 쓴다. 바꾸면 두 곳 다.
//  1) detectCardQuad: 바탕과 색이 다른 가장 큰 덩어리 = 명함 → 네 모서리(0~1 비율)
//  2) warpQuad: 비스듬히 찍힌 명함을 반듯한 직사각형으로 편다(투시 변환)
//  3) enhance: 빛 반사·그늘을 고르게(배경 밝기로 나누기) → 대비 늘이기 → 선명하게. 어두운 명함은 나누기 없이 대비만
(function (root) {
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const lumAt = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const make = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

  // 작게 줄이기(평균): 모서리 찾기는 400px 정도면 충분하고 빠르다
  function downscale(img, maxSide) {
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (k === 1) return img;
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const out = make(w, h);
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.floor(y / k);
      const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) / k)));
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.floor(x / k);
        const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) / k)));
        let r = 0; let g = 0; let b = 0; let n = 0;
        for (let yy = y0; yy < y1; yy += 1) {
          for (let xx = x0; xx < x1; xx += 1) {
            const i = (yy * img.width + xx) * 4;
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n += 1;
          }
        }
        const o = (y * w + x) * 4;
        out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
      }
    }
    return out;
  }

  function otsu(values) {
    const hist = new Array(256).fill(0);
    for (const v of values) hist[Math.min(255, Math.max(0, Math.round(v)))] += 1;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumB = 0; let wB = 0; let best = 0; let t = 0;
    for (let i = 0; i < 256; i += 1) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i += 1) { const p = pts[i]; const q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }

  // 결과: { tl, tr, br, bl } 각 {x,y} 0~1, 못 찾으면 null(화면이 사방 3% 안쪽 사각형을 대신 준다)
  function detectCardQuad(img) {
    const s = downscale(img, 400);
    const { width: w, height: h, data: d } = s;
    // 바탕색 = 가장자리 띠(4%)의 가운데값
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    const edge = [[], [], []];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 4;
        edge[0].push(d[i]); edge[1].push(d[i + 1]); edge[2].push(d[i + 2]);
      }
    }
    const med = edge.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
    const dist = new Float32Array(w * h);
    for (let p = 0; p < w * h; p += 1) {
      const i = p * 4;
      dist[p] = Math.min(255, Math.hypot(d[i] - med[0], d[i + 1] - med[1], d[i + 2] - med[2]));
    }
    // 두 단계 문턱: 확실한 곳(Otsu 위)에서 시작해 약하게 다른 곳(그늘진 명함 가장자리)까지 이어지면 넓힌다
    const t = Math.max(25, otsu(dist));
    const weak = Math.max(18, t * 0.35);
    const on = new Uint8Array(w * h);
    {
      const st = new Int32Array(w * h);
      let top = 0;
      for (let p = 0; p < w * h; p += 1) if (dist[p] > t) { on[p] = 1; st[top++] = p; }
      while (top) {
        const p = st[--top];
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= w * h || on[q] || dist[q] <= weak) continue;
          on[q] = 1; st[top++] = q;
        }
      }
    }
    // 명함 안 글씨 구멍을 메우려고 한 번 넓혔다 좁힌다(닫기)
    const grow = (src, val) => {
      const o = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        let hit = !val;
        for (let dy = -1; dy <= 1 && hit !== val; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const X = x + dx; const Y = y + dy;
          if (X >= 0 && Y >= 0 && X < w && Y < h && src[Y * w + X] === (val ? 1 : 0)) { hit = val; break; }
        }
        o[y * w + x] = hit ? 1 : 0;
      }
      return o;
    };
    const mask = grow(grow(on, true), false);
    // 가장 큰 덩어리(4방향 이웃)
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let bestPix = null;
    for (let p0 = 0; p0 < w * h; p0 += 1) {
      if (!mask[p0] || seen[p0]) continue;
      let top = 0; stack[top++] = p0; seen[p0] = 1;
      const pix = [];
      while (top) {
        const p = stack[--top];
        pix.push(p);
        const x = p % w; const y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
      }
      if (!bestPix || pix.length > bestPix.length) bestPix = pix;
    }
    if (!bestPix || bestPix.length < w * h * 0.12 || bestPix.length > w * h * 0.97) return null;
    let tl = null; let tr = null; let br = null; let bl = null;
    for (const p of bestPix) {
      const x = p % w; const y = (p / w) | 0;
      if (!tl || x + y < tl.x + tl.y) tl = { x, y };
      if (!br || x + y > br.x + br.y) br = { x, y };
      if (!tr || x - y > tr.x - tr.y) tr = { x, y };
      if (!bl || x - y < bl.x - bl.y) bl = { x, y };
    }
    const n = (q) => ({ x: (q.x + 0.5) / w, y: (q.y + 0.5) / h });
    const quad = { tl: n(tl), tr: n(tr), br: n(br), bl: n(bl) };
    return polyArea([quad.tl, quad.tr, quad.br, quad.bl]) > 0.1 ? quad : null;   // 너무 납작하거나 꼬인 사각형은 믿지 않는다
  }

  // 4점 → 4점 투시 변환 행렬(3x3, 마지막 1). 가우스 소거
  function homography(src, dst) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i += 1) {
      const { x, y } = src[i]; const { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (let c = 0; c < 8; c += 1) {
      let piv = c;
      for (let r = c + 1; r < 8; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [B[c], B[piv]] = [B[piv], B[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < 8; r += 1) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k += 1) A[r][k] -= f * A[c][k];
        B[r] -= f * B[c];
      }
    }
    return [...B.map((b, i) => b / A[i][i]), 1];
  }

  // 사각형의 변 길이로 결과 크기를 정한다(가로가 길면 가로 명함). 긴 변 maxSide
  function outputSize(img, quad, maxSide) {
    const P = (q) => ({ x: q.x * img.width, y: q.y * img.height });
    const [a, b, c, e] = [P(quad.tl), P(quad.tr), P(quad.br), P(quad.bl)];
    const len = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const wq = Math.max(len(a, b), len(e, c));
    const hq = Math.max(len(a, e), len(b, c));
    const k = Math.min(maxSide / Math.max(wq, hq), 2);   // 원본보다 두 배 넘게 키우지는 않는다
    return { width: Math.max(1, Math.round(wq * k)), height: Math.max(1, Math.round(hq * k)) };
  }

  function warpQuad(img, quad, maxSide = 1600) {
    const { width: W, height: H } = outputSize(img, quad, maxSide);
    const P = (q) => ({ x: q.x * img.width, y: q.y * img.height });
    // 결과 좌표 → 원본 좌표(거꾸로 찾아 빈틈 없이), 두 점 사이는 이어 그리기(bilinear)
    const m = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], [P(quad.tl), P(quad.tr), P(quad.br), P(quad.bl)]);
    const out = make(W, H);
    if (!m) return out;
    const sw = img.width; const sh = img.height; const s = img.data; const o = out.data;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const X = x + 0.5; const Y = y + 0.5;
        const z = m[6] * X + m[7] * Y + m[8];
        const u = Math.max(0, Math.min(sw - 1.001, (m[0] * X + m[1] * Y + m[2]) / z - 0.5));
        const v = Math.max(0, Math.min(sh - 1.001, (m[3] * X + m[4] * Y + m[5]) / z - 0.5));
        const x0 = u | 0; const y0 = v | 0; const fx = u - x0; const fy = v - y0;
        const i00 = (y0 * sw + x0) * 4; const i10 = i00 + 4; const i01 = i00 + sw * 4; const i11 = i01 + 4;
        const oi = (y * W + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          o[oi + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy) + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
        }
        o[oi + 3] = 255;
      }
    }
    return out;
  }

  // 밝기 지도: 칸마다 q 위치 값(0.9 = 종이, 0.08 = 잉크) → 3x3 흐림 → 칸 사이 보간. 종이 지도에는 글씨가 빠지고 종이·반사·그늘만 남는다
  function levelMap(img, cell, q) {
    const { width: w, height: h, data: d } = img;
    const gw = Math.ceil(w / cell); const gh = Math.ceil(h / cell);
    const grid = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
    for (let gy = 0; gy < gh; gy += 1) {
      for (let gx = 0; gx < gw; gx += 1) {
        const vals = [[], [], []];
        for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) {
          for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) {
            const i = (y * w + x) * 4;
            vals[0].push(d[i]); vals[1].push(d[i + 1]); vals[2].push(d[i + 2]);
          }
        }
        for (let c = 0; c < 3; c += 1) { const a = vals[c].sort((p, q) => p - q); grid[c][gy * gw + gx] = a.length ? a[Math.floor(a.length * q)] : 255; }
      }
    }
    const blur = grid.map((g) => {
      const o = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y += 1) {
        for (let x = 0; x < gw; x += 1) {
          let s = 0; let n = 0;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
            const X = x + dx; const Y = y + dy;
            if (X >= 0 && Y >= 0 && X < gw && Y < gh) { s += g[Y * gw + X]; n += 1; }
          }
          o[y * gw + x] = s / n;
        }
      }
      return o;
    });
    return (x, y, c) => {
      const gx = Math.max(0, Math.min(gw - 1, x / cell - 0.5)); const gy = Math.max(0, Math.min(gh - 1, y / cell - 0.5));
      const x0 = Math.floor(gx); const y0 = Math.floor(gy); const fx = gx - x0; const fy = gy - y0;
      const g = blur[c]; const x1 = Math.min(gw - 1, x0 + 1); const y1 = Math.min(gh - 1, y0 + 1);
      return (g[y0 * gw + x0] * (1 - fx) + g[y0 * gw + x1] * fx) * (1 - fy) + (g[y1 * gw + x0] * (1 - fx) + g[y1 * gw + x1] * fx) * fy;
    };
  }

  function percentile(arr, p) { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }

  // 언샵 마스크(3x3 평균과의 차이를 더한다): 흐린 글씨 가장자리를 또렷하게
  function sharpen(img, amount) {
    const { width: w, height: h, data: d } = img;
    const src = Uint8ClampedArray.from(d);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += src[i + (dy * w + dx) * 4 + c];
          d[i + c] = clamp(src[i + c] + amount * (src[i + c] - s / 9));
        }
      }
    }
  }

  // mode: 'auto'(색 유지 스캔) | 'bw'(흑백 선명) | 'original'(펴기만)
  function enhance(img, mode = 'auto') {
    const { width: w, height: h } = img;
    const out = make(w, h);
    out.data.set(img.data);
    if (mode === 'original') return out;
    const o = out.data;
    const lums = new Float32Array(w * h);
    for (let p = 0; p < w * h; p += 1) lums[p] = lumAt(o, p * 4);
    const dark = percentile(lums, 0.5) < 110;   // 남색·검정 명함: 종이가 어두워 나누면 망가진다
    if (!dark) {
      // 곳마다 그 자리의 종이 밝기(paper)로 나눠 그늘·누런 조명을 지운다(색은 그대로).
      // 빛 반사·그늘로 종이와 글씨 차이가 좁아진 곳(초록 채널 차이 < TARGET)만 차이를 더 벌린다(최대 MAX_GAIN 배): 반사 속 흐린 글씨가 살아난다
      const cell = Math.max(16, Math.round(Math.max(w, h) / 24));
      const paper = levelMap(img, cell, 0.9);
      const ink = levelMap(img, cell, 0.08);
      const TARGET = 150;
      const MAX_GAIN = 3;
      const LOCAL_MIN = 50;   // 빈 종이(차이가 거의 없음)는 잡음을 키우지 않게 이 이하로 보지 않는다
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const range = Math.max(LOCAL_MIN, paper(x, y, 1) - ink(x, y, 1));
          const gain = Math.min(MAX_GAIN, Math.max(1, TARGET / range));
          for (let c = 0; c < 3; c += 1) {
            const pv = Math.max(40, paper(x, y, c));
            o[i + c] = clamp(250 - ((pv - o[i + c]) * 250 * gain) / pv);
          }
        }
      }
    }
    // 대비 늘이기(밝기 기준 0.5%~99.5%), 색은 같은 비율로
    for (let p = 0; p < w * h; p += 1) lums[p] = lumAt(o, p * 4);
    const lo = percentile(lums, 0.005); const hi = percentile(lums, 0.995);
    const span = Math.max(30, hi - lo);
    for (let i = 0; i < o.length; i += 4) for (let c = 0; c < 3; c += 1) o[i + c] = clamp(((o[i + c] - lo) / span) * 255);
    if (mode === 'bw') {
      for (let i = 0; i < o.length; i += 4) {
        const g = clamp(255 * (lumAt(o, i) / 255) ** 1.6);   // 글씨는 더 진하게, 종이는 하얗게
        o[i] = g; o[i + 1] = g; o[i + 2] = g;
      }
    }
    sharpen(out, mode === 'bw' ? 0.8 : 0.5);
    return out;
  }

  const DEFAULT_QUAD = { tl: { x: 0.03, y: 0.03 }, tr: { x: 0.97, y: 0.03 }, br: { x: 0.97, y: 0.97 }, bl: { x: 0.03, y: 0.97 } };
  const api = { detectCardQuad, warpQuad, enhance, homography, downscale, polyArea, DEFAULT_QUAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardEnhance = api;
})(typeof window !== 'undefined' ? window : globalThis);
