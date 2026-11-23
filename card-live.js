// 명함 실시간 카메라(명함 앱처럼): 카메라 화면에서 명함 테두리를 실시간으로 따라 잡고, 모양이 맞고 가만히 있으면 자동으로 찍는다.
// 찍을 때는 센서 최대 해상도 사진(ImageCapture.takePhoto)을 쓰고, 못 쓰면 영상 한 장면을 쓴다. 결과 File 은 cardScan(card-crop.js)이 받아 모서리 맞추기·보정을 한다.
// 사용: const file = await cardLiveCamera()  →  JPEG File, 취소면 null, 카메라를 못 열면 거부(부른 쪽이 예전 방식으로 대신 연다)
// 순수 함수(cardLiveCheck·cardLiveSteady)는 시험용으로 CardLive 에 내보낸다. 모서리 찾기는 card-enhance.js(CardEnhance.detectCardQuad)를 그대로 쓴다.
(function (root) {
  const LIVE_SIDE = 256;          // 분석용으로 줄인 긴 변(px). 크면 폰이 느리다
  const LIVE_TICK_MS = 160;       // 분석 간격
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

  async function grabStill(video, track) {
    if (typeof ImageCapture === 'function') {
      try {
        const cap = new ImageCapture(track);
        const caps = await cap.getPhotoCapabilities?.().catch(() => null);
        const opt = {};
        if (caps?.imageWidth?.max) { opt.imageWidth = caps.imageWidth.max; opt.imageHeight = caps.imageHeight?.max; }
        if (caps?.fillLightMode?.includes?.('off')) opt.fillLightMode = 'off';   // 켜지면 명함이 번쩍여 글씨가 날아간다
        const blob = await cap.takePhoto(opt);
        if (blob?.size > 20000) return blob;
      } catch { /* 영상 장면으로 대신 */ }
    }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    c.width = 0;
    return blob;
  }

  async function cardLiveCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unsupported');
    if (!root.CardEnhance) throw new Error('card-enhance missing');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
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
          const blob = await grabStill(video, track);
          if (!blob) throw new Error('empty');
          leave(new File([blob], 'card.jpg', { type: blob.type || 'image/jpeg' }));
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
        try { quad = root.CardEnhance.detectCardQuad({ width: img.width, height: img.height, data: img.data }); } catch { quad = null; }
        const chk = cardLiveCheck(quad, video.videoWidth, video.videoHeight);
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
  root.CardLive = { cardLiveCheck, cardLiveSteady };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CardLive;
})(typeof window !== 'undefined' ? window : globalThis);
