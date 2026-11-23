// 명함 실시간 카메라(명함 앱처럼): 카메라 화면에서 명함 테두리를 실시간으로 따라 잡고, 모양이 맞고 가만히 있으면 자동으로 찍는다.
// 찍을 때는 지금 보이는 영상 화면(최대 4K)을 그대로 딴다. 결과 File 에는 잡아 둔 명함 사각형(file.cardQuad)이 붙어, cardScan(card-crop.js)이 그것을 처음 모서리로 쓴다.
// 사용: const file = await cardLiveCamera()  →  JPEG File, 취소면 null, 카메라를 못 열면 거부(부른 쪽이 예전 방식으로 대신 연다)
// 순수 함수(cardLiveCheck·cardLiveSteady)는 시험용으로 CardLive 에 내보낸다. 모서리 찾기(detectQuad)는 직선(Hough) 방식이다.
(function (root) {
  const LIVE_SIDE = 256;          // 분석용으로 줄인 긴 변(px). 크면 폰이 느리다
  const LIVE_TICK_MS = 160;       // 분석 간격
  const STILL_MAX = 4096;         // 찍는 사진의 긴 변 상한(px)
  const STEADY_MS = 900;          // 모양이 맞고 이만큼 가만히 있으면 자동으로 찍는다
  const STEADY_MOVE = 0.02;       // 이보다 덜 움직이면 '가만히'(모서리 위치 변화, 화면 비율)
  const AREA_MIN = 0.14;          // 명함이 화면의 이 비율보다 작으면 "더 가까이"
  const AREA_MAX = 0.92;          // 이보다 크면 "조금 멀리"
  const RATIO_MIN = 1.3;          // 명함 긴변/짧은변(90x50 = 1.8, 비스듬히 찍혀도 이 안)
  const RATIO_MAX = 2.3;
  const EDGE_PAD = 0.012;         // 모서리가 화면 끝에 닿으면 명함이 잘린 것
  const FILL_MIN = 0.82;          // 네 점 사각형이 직사각형에 얼마나 가까운가(면적 / 가로×세로)
  const KEYS = ['tl', 'tr', 'br', 'bl'];

  // 순수 함수: 찾은 모서리(0~1 비율)가 '명함으로 찍어도 되는 모양'인가. { ok, msg }
  function cardLiveCheck(quad, vw, vh) {
    if (!quad) return { ok: false, msg: '명함을 화면 가운데에 놓아 주세요' };
    const P = KEYS.map((k) => ({ x: quad[k].x * vw, y: quad[k].y * vh }));
    const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const wq = (len(P[0], P[1]) + len(P[3], P[2])) / 2;
    const hq = (len(P[0], P[3]) + len(P[1], P[2])) / 2;
    if (!wq || !hq) return { ok: false, msg: '명함을 화면 가운데에 놓아 주세요' };
    let area = 0;
    for (let i = 0; i < 4; i += 1) { const a = P[i]; const b = P[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
    area = Math.abs(area) / 2;
    const share = area / (vw * vh);
    const ratio = Math.max(wq, hq) / Math.min(wq, hq);
    const cut = KEYS.some((k) => quad[k].x < EDGE_PAD || quad[k].x > 1 - EDGE_PAD || quad[k].y < EDGE_PAD || quad[k].y > 1 - EDGE_PAD);
    if (share < AREA_MIN) return { ok: false, msg: '더 가까이 가져가 주세요' };
    if (cut || share > AREA_MAX) return { ok: false, msg: '명함이 잘립니다. 조금 멀리 해 주세요' };
    if (area / (wq * hq) < FILL_MIN || ratio < RATIO_MIN || ratio > RATIO_MAX) return { ok: false, msg: '명함 전체가 보이게, 똑바로 놓아 주세요' };
    return { ok: true, msg: '인식됨 — 그대로 잡고 계세요' };
  }

  // 순수 함수: 앞 모서리와 지금 모서리가 거의 같은가(가만히 있는가)
  function cardLiveSteady(prev, cur) {
    if (!prev || !cur) return false;
    return KEYS.every((k) => Math.hypot(prev[k].x - cur[k].x, prev[k].y - cur[k].y) < STEADY_MOVE);
  }

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

  const css = `
  .cl-wrap{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#000;color:#fff;font-family:inherit;touch-action:none;user-select:none;-webkit-user-select:none}
  .cl-top{padding:calc(12px + env(safe-area-inset-top)) 16px 8px;text-align:center;font-size:17px;font-weight:800}
  .cl-stage{flex:1;min-height:0;display:grid;place-items:center;overflow:hidden}
  .cl-frame{position:relative;max-width:100%;max-height:100%}
  .cl-frame video{display:block;width:100%;height:100%;background:#000}
  .cl-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .cl-svg polygon{fill:rgba(255,255,255,.12);stroke:#fff;stroke-width:3;stroke-linejoin:round;vector-effect:non-scaling-stroke}
  .cl-svg polygon.ok{fill:rgba(52,211,153,.22);stroke:#34D399}
  .cl-guide{position:absolute;left:8%;right:8%;top:50%;aspect-ratio:1.8;transform:translateY(-50%);border:2px dashed rgba(255,255,255,.45);border-radius:10px;pointer-events:none}
  .cl-msg{margin:0;padding:10px 16px;text-align:center;font-size:15px;font-weight:700;min-height:44px;box-sizing:border-box}
  .cl-msg.ok{color:#34D399}
  .cl-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 22px calc(18px + env(safe-area-inset-bottom))}
  .cl-bar button{min-width:76px;min-height:48px;border:0;border-radius:24px;background:#1b2232;color:#fff;font:inherit;font-size:15px;font-weight:700;cursor:pointer}
  .cl-bar button.cl-shutter{width:72px;height:72px;min-width:72px;border-radius:36px;background:#fff;border:5px solid #9AA6BC}
  .cl-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .25s}
  .cl-flash.on{opacity:.9;transition:none}
  `;
  let styled = false;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // 가능하면 연속 초점·연속 노출로(명함처럼 가까운 글씨가 또렷하게). 지원 안 하는 폰은 조용히 넘어간다
  async function tuneTrack(track) {
    for (const adv of [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }, { whiteBalanceMode: 'continuous' }]) {
      try { await track.applyConstraints({ advanced: [adv] }); } catch { /* 지원 안 함 */ }
    }
  }

  // 찍는 사진은 '지금 보이는 영상 화면' 그대로 딴다. 폰 카메라의 촬영(takePhoto)은 미리보기와 화각이 달라서 실시간으로 잡은 명함 사각형이 사진에서 어긋난다
  // (2026-11-23 폰 사용자 지적: 초록 사각형은 맞았는데 다음 화면에 다른 사각형이 떴다). 영상 해상도는 getUserMedia 에서 4K 까지 요청한다
  async function grabStill(video) {
    const k = Math.min(1, STILL_MAX / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    c.width = 0;
    return blob;
  }

  async function cardLiveCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unsupported');
    if (!root.CardEnhance) throw new Error('card-enhance missing');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    const track = stream.getVideoTracks()[0];
    if (!styled) { const s = el('style'); s.textContent = css; document.head.append(s); styled = true; }

    return new Promise((resolve) => {
      const wrap = el('div', 'cl-wrap');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', '명함 촬영');
      const top = el('div', 'cl-top', '명함 촬영');
      const frame = el('div', 'cl-frame');
      const video = el('video');
      video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.srcObject = stream;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'cl-svg'); svg.setAttribute('viewBox', '0 0 1 1'); svg.setAttribute('preserveAspectRatio', 'none');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      svg.append(poly);
      const guide = el('div', 'cl-guide');
      const flash = el('div', 'cl-flash');
      frame.append(video, svg, guide, flash);
      const stage = el('div', 'cl-stage'); stage.append(frame);
      const msg = el('p', 'cl-msg', '명함을 틀 안에 놓아 주세요');
      const cancel = el('button', null, '취소'); cancel.type = 'button';
      const shutter = el('button', 'cl-shutter'); shutter.type = 'button'; shutter.setAttribute('aria-label', '직접 찍기');
      const spacer = el('span'); spacer.style.minWidth = '76px';
      const bar = el('div', 'cl-bar'); bar.append(cancel, shutter, spacer);
      wrap.append(top, stage, msg, bar);
      document.body.append(wrap);

      let done = false;
      let timer = null;
      let shooting = false;
      let shown = null;      // 화면에 그리는(부드럽게 따라가는) 모서리
      let last = null;       // 앞 분석의 모서리
      let latest = null;     // 가장 최근에 찾은 모서리(찍을 때 다음 화면으로 넘긴다)
      let steadySince = 0;
      const work = document.createElement('canvas');
      const g = work.getContext('2d', { willReadFrequently: true });

      const finish = (v) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        window.removeEventListener('popstate', onBack);
        stream.getTracks().forEach((t) => t.stop());
        wrap.remove();
        resolve(v);
      };
      const onBack = () => finish(null);
      history.pushState(history.state, '');
      window.addEventListener('popstate', onBack);
      // 쌓아 둔 기록 한 칸을 되돌린 '뒤에' 결과를 돌려준다: 먼저 돌려주면 이어서 열리는 스캔 화면이 이 뒤로가기를 자기 취소로 받아 바로 닫힌다
      const leave = (v) => {
        window.removeEventListener('popstate', onBack);
        const settle = () => finish(v);
        window.addEventListener('popstate', settle, { once: true });
        setTimeout(settle, 500);
        history.back();
      };

      async function shoot() {
        if (shooting || done) return;
        shooting = true;
        msg.textContent = '찍는 중... 움직이지 마세요'; msg.className = 'cl-msg ok';
        flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
        try {
          const blob = await grabStill(video);
          if (!blob) throw new Error('empty');
          const file = new File([blob], 'card.jpg', { type: blob.type || 'image/jpeg' });
          if (latest) file.cardQuad = JSON.parse(JSON.stringify(latest));   // 같은 영상 화면에서 잡은 사각형을 다음 화면(card-crop.js)이 그대로 쓴다
          leave(file);
        } catch (err) {
          console.warn('명함 촬영 실패', err);
          shooting = false;
          msg.textContent = '찍지 못했습니다. 다시 눌러 주세요'; msg.className = 'cl-msg';
        }
      }

      function ease(cur) {
        if (!cur) { shown = null; return; }
        shown = shown ? Object.fromEntries(KEYS.map((k) => [k, { x: shown[k].x + (cur[k].x - shown[k].x) * 0.55, y: shown[k].y + (cur[k].y - shown[k].y) * 0.55 }])) : cur;
      }

      function tick() {
        if (done || shooting || video.readyState < 2 || !video.videoWidth) return;
        const k = LIVE_SIDE / Math.max(video.videoWidth, video.videoHeight);
        work.width = Math.max(32, Math.round(video.videoWidth * k));
        work.height = Math.max(32, Math.round(video.videoHeight * k));
        g.drawImage(video, 0, 0, work.width, work.height);
        const img = g.getImageData(0, 0, work.width, work.height);
        let quad = null;
        try { quad = detectQuad({ width: img.width, height: img.height, data: img.data }); } catch { quad = null; }
        const chk = cardLiveCheck(quad, video.videoWidth, video.videoHeight);
        latest = quad;
        ease(quad);
        poly.setAttribute('points', shown ? KEYS.map((key) => `${shown[key].x},${shown[key].y}`).join(' ') : '');
        poly.setAttribute('class', chk.ok ? 'ok' : '');
        guide.style.display = quad ? 'none' : '';
        msg.textContent = chk.msg; msg.className = chk.ok ? 'cl-msg ok' : 'cl-msg';
        if (chk.ok && cardLiveSteady(last, quad)) {
          if (!steadySince) steadySince = Date.now();
          if (Date.now() - steadySince >= STEADY_MS) { shoot(); return; }
        } else steadySince = 0;
        last = chk.ok ? quad : null;
      }

      video.addEventListener('loadedmetadata', () => {
        frame.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        frame.style.height = '100%';
        tuneTrack(track);
      });
      video.play().catch(() => {});
      timer = setInterval(tick, LIVE_TICK_MS);
      cancel.addEventListener('click', () => leave(null));
      shutter.addEventListener('click', shoot);
    });
  }

  root.cardLiveCamera = cardLiveCamera;
  root.CardLive = { cardLiveCheck, cardLiveSteady, detectQuad };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CardLive;
})(typeof window !== 'undefined' ? window : globalThis);
