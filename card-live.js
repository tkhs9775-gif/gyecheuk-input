// 명함 실시간 카메라(명함 앱처럼): 카메라 화면에서 명함 테두리를 실시간으로 따라 잡고, 모양이 맞고 가만히 있으면 자동으로 찍는다.
// 찍을 때는 지금 보이는 영상 화면(최대 4K)을 그대로 딴다. 결과 File 에는 잡아 둔 명함 사각형(file.cardQuad)이 붙어, cardScan(card-crop.js)이 그것을 처음 모서리로 쓴다.
// 사용: const file = await cardLiveCamera()  →  JPEG File, 취소면 null, 카메라를 못 열면 거부(부른 쪽이 예전 방식으로 대신 연다)
// 순수 함수(cardLiveCheck·cardLiveSteady)는 시험용으로 CardLive 에 내보낸다. 모서리 찾기는 card-detect.js(직선 방식)를 작업 스레드(card-live-worker.js)에서 돌려 화면이 끊기지 않게 하고, 사각형 그리기는 화면 주사율로 따로 돌린다.
(function (root) {
  const LIVE_SIDE = 256;          // 분석용으로 줄인 긴 변(px). 크면 폰이 느리다
  const MAIN_DETECT_MS = 120;     // 작업 스레드를 못 쓸 때만: 이 화면에서 계산하는 간격(끊김 방지)
  const STILL_MAX = 4096;         // 찍는 사진의 긴 변 상한(px)
  const STEADY_MS = 700;          // 모양이 맞고 이만큼 가만히 있으면 초점 확인 후 자동으로 찍는다
  const SMOOTH_TAU = 0.045;       // 그리는 사각형이 인식 결과를 따라가는 시간 상수(초). 작을수록 빠릿, 클수록 부드럽다
  const NULL_GRACE_MS = 300;      // 인식이 잠깐 끊겨도 사각형을 이만큼은 유지(깜빡임 방지)
  const SHARP_SIDE = 480;         // 초점 확인용으로 줄인 명함 부분의 긴 변(px)
  const SHARP_EVERY_MS = 120;     // 초점 확인 간격
  const SHARP_OK = 0.9;           // 지금 선명도가 이번에 본 최고의 이 비율 이상이면 초점이 맞은 것
  const FOCUS_WAIT_MS = 1800;     // 초점이 안 맞아도 이만큼 기다리면 그냥 찍는다
  const SCRIPT_V = (typeof document !== 'undefined' && document.currentScript && new URL(document.currentScript.src).searchParams.get('v')) || '';   // 작업 스레드 파일에 같은 판 번호를 붙인다
  const STEADY_MOVE = 0.025;       // 이보다 덜 움직이면 '가만히'(모서리 위치 변화, 화면 비율)
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
  .cl-stat{position:absolute;left:0;right:0;bottom:calc(96px + env(safe-area-inset-bottom));text-align:center;font-size:12px;color:#9AA6BC;pointer-events:none}
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

  // 초점이 맞았는지 보는 숫자: 명함 부분의 라플라시안 분산(선명할수록 큼). 절대값은 폰·밝기마다 달라서 '이번에 본 최고값'과 비교해 쓴다
  const sharpCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  function sharpness(video, q) {
    const xs = KEYS.map((k) => q[k].x); const ys = KEYS.map((k) => q[k].y);
    const sx = Math.max(0, Math.min(...xs)) * video.videoWidth; const sy = Math.max(0, Math.min(...ys)) * video.videoHeight;
    const sw = Math.max(8, (Math.min(1, Math.max(...xs)) * video.videoWidth) - sx); const sh = Math.max(8, (Math.min(1, Math.max(...ys)) * video.videoHeight) - sy);
    const k = Math.min(1, SHARP_SIDE / Math.max(sw, sh));
    const cw = Math.max(8, Math.round(sw * k)); const ch = Math.max(8, Math.round(sh * k));
    sharpCanvas.width = cw; sharpCanvas.height = ch;
    const g = sharpCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data;
    const gray = new Float32Array(cw * ch);
    for (let p = 0; p < gray.length; p += 1) { const i = p * 4; gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; }
    let sum = 0; let sum2 = 0; let n = 0;
    for (let y = 1; y < ch - 1; y += 1) for (let x = 1; x < cw - 1; x += 1) {
      const p = y * cw + x;
      const l = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - cw] - gray[p + cw];
      sum += l; sum2 += l * l; n += 1;
    }
    return n ? sum2 / n - (sum / n) ** 2 : 0;
  }

  async function cardLiveCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unsupported');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } },
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
      const stat = el('div', 'cl-stat');
      frame.append(video, svg, guide, flash);
      const stage = el('div', 'cl-stage'); stage.append(frame);
      const msg = el('p', 'cl-msg', '명함을 틀 안에 놓아 주세요');
      const cancel = el('button', null, '취소'); cancel.type = 'button';
      const shutter = el('button', 'cl-shutter'); shutter.type = 'button'; shutter.setAttribute('aria-label', '직접 찍기');
      const spacer = el('span'); spacer.style.minWidth = '76px';
      const bar = el('div', 'cl-bar'); bar.append(cancel, shutter, spacer);
      wrap.append(top, stage, msg, stat, bar);
      document.body.append(wrap);

      let done = false;
      let raf = 0;
      let shooting = false;
      let shown = null;        // 화면에 그리는(부드럽게 따라가는) 모서리
      let target = null;       // 가장 최근 인식 결과(없어져도 NULL_GRACE_MS 동안은 유지해 깜빡이지 않게)
      let latest = null;       // 가장 최근에 찾은 모서리(찍을 때 다음 화면으로 넘긴다)
      let lostAt = 0;
      let anchor = null;       // '가만히' 판정의 기준 모서리
      let steadySince = 0;
      let bestSharp = 0;
      let sharpSamples = 0;
      let lastSharpAt = 0;
      let busy = false;        // 작업 스레드가 계산 중
      let reqId = 0;
      let fps = { frames: 0, detects: 0, at: performance.now() };
      let showStat = false;
      try { showStat = localStorage.getItem('cardLiveFps') === '1'; } catch { showStat = false; }
      stat.style.display = showStat ? '' : 'none';
      let taps = 0;
      top.addEventListener('click', () => {   // 제목을 다섯 번 누르면 초당 그림 수 표시를 켜고 끈다(속도 확인용)
        taps += 1;
        if (taps < 5) return;
        taps = 0; showStat = !showStat; stat.style.display = showStat ? '' : 'none';
        try { localStorage.setItem('cardLiveFps', showStat ? '1' : '0'); } catch { /* 저장 못 해도 이번만 */ }
      });

      const work = document.createElement('canvas');
      const g = work.getContext('2d', { willReadFrequently: true });
      let worker = null;
      try { worker = new Worker(new URL(`card-live-worker.js${SCRIPT_V ? `?v=${SCRIPT_V}` : ''}`, document.baseURI).href); } catch { worker = null; }
      let lastMainDetect = 0;

      const finish = (v) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        worker?.terminate();
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

      // 인식 결과 한 건을 받았을 때: 안내 글·'가만히'·초점 확인·자동 촬영
      function onResult(quad) {
        if (done || shooting) return;
        fps.detects += 1;
        const now = performance.now();
        const chk = cardLiveCheck(quad, video.videoWidth, video.videoHeight);
        latest = quad;
        if (quad) { target = quad; lostAt = 0; } else if (!lostAt) lostAt = now; else if (now - lostAt > NULL_GRACE_MS) target = null;
        poly.setAttribute('class', chk.ok ? 'ok' : '');
        guide.style.display = target ? 'none' : '';
        let text = chk.msg;
        if (chk.ok) {
          if (!anchor || !cardLiveSteady(anchor, quad)) { anchor = quad; steadySince = now; bestSharp = 0; sharpSamples = 0; } else if (now - steadySince >= STEADY_MS) {
            text = '초점 맞추는 중... 그대로 잡고 계세요';
            if (now - lastSharpAt >= SHARP_EVERY_MS) {
              lastSharpAt = now;
              const s = sharpness(video, quad);
              bestSharp = Math.max(bestSharp, s); sharpSamples += 1;
              const focused = sharpSamples >= 2 && s >= bestSharp * SHARP_OK;
              if (focused || now - steadySince >= STEADY_MS + FOCUS_WAIT_MS) { shoot(); return; }   // 초점이 안 맞아도 이만큼 기다렸으면 찍는다
            }
          }
        } else { anchor = null; steadySince = 0; }
        msg.textContent = text; msg.className = chk.ok ? 'cl-msg ok' : 'cl-msg';
      }

      // 영상 한 장면을 줄여서 작업 스레드에 보낸다(작업 스레드가 쉬는 동안에만). 작업 스레드를 못 쓰면 이 화면에서 계산하되 간격을 둔다(끊김 방지)
      function pump(now) {
        if (done || shooting || busy || video.readyState < 2 || !video.videoWidth) return;
        if (!worker && now - lastMainDetect < MAIN_DETECT_MS) return;
        const k = LIVE_SIDE / Math.max(video.videoWidth, video.videoHeight);
        work.width = Math.max(32, Math.round(video.videoWidth * k));
        work.height = Math.max(32, Math.round(video.videoHeight * k));
        g.drawImage(video, 0, 0, work.width, work.height);
        const img = g.getImageData(0, 0, work.width, work.height);
        if (worker) {
          busy = true; reqId += 1;
          worker.postMessage({ id: reqId, width: img.width, height: img.height, buf: img.data.buffer }, [img.data.buffer]);
        } else {
          lastMainDetect = now;
          let quad = null;
          try { quad = root.CardDetect.detectQuad({ width: img.width, height: img.height, data: img.data }); } catch { quad = null; }
          onResult(quad);
        }
      }
      if (worker) {
        worker.onmessage = (e) => { busy = false; onResult(e.data.quad || null); };
        worker.onerror = () => { worker?.terminate(); worker = null; busy = false; };   // 작업 스레드가 안 돌면 이 화면에서 계산으로 바꾼다
      }

      // 그리기는 화면 주사율(60·90·120Hz)로 돌고, 인식 결과 사이는 부드럽게 따라간다(시간 기준이라 주사율이 달라도 같은 속도)
      let prev = performance.now();
      function frameLoop(t) {
        if (done) return;
        const dt = Math.min(0.1, Math.max(0, (t - prev) / 1000)); prev = t;
        if (target) {
          const a = 1 - Math.exp(-dt / SMOOTH_TAU);
          shown = shown ? Object.fromEntries(KEYS.map((k) => [k, { x: shown[k].x + (target[k].x - shown[k].x) * a, y: shown[k].y + (target[k].y - shown[k].y) * a }])) : JSON.parse(JSON.stringify(target));
          poly.setAttribute('points', KEYS.map((key) => `${shown[key].x},${shown[key].y}`).join(' '));
        } else { shown = null; poly.setAttribute('points', ''); }
        fps.frames += 1;
        if (t - fps.at >= 1000) {
          const s = (t - fps.at) / 1000;
          const r = { render: Math.round(fps.frames / s), detect: Math.round(fps.detects / s) };
          root.cardLiveStats = r;
          if (showStat) stat.textContent = `그리기 ${r.render}fps · 인식 ${r.detect}fps${worker ? '' : ' (작업 스레드 없음)'}`;
          fps = { frames: 0, detects: 0, at: t };
        }
        pump(t);
        raf = requestAnimationFrame(frameLoop);
      }

      video.addEventListener('loadedmetadata', () => {
        frame.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        frame.style.height = '100%';
        tuneTrack(track);
      });
      video.play().catch(() => {});
      raf = requestAnimationFrame(frameLoop);
      cancel.addEventListener('click', () => leave(null));
      shutter.addEventListener('click', shoot);
    });
  }

  root.cardLiveCamera = cardLiveCamera;
  root.CardLive = { cardLiveCheck, cardLiveSteady };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CardLive;
})(typeof window !== 'undefined' ? window : globalThis);
