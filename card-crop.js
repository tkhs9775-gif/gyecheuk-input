// 명함 스캔 화면(명함 앱처럼): ① 자동으로 찾은 네 모서리를 손가락으로 맞추고 ② 보정 방식(자동·흑백·원본)과 회전을 골라 ③ 깨끗한 JPEG 로 돌려준다.
// 휴대폰(web/contacts.js)·PC(pc-app/ui/contacts-pc.js)가 같이 쓴다(pc-app/ui/card-crop.js 는 복사본). 화면 부품·모양은 이 파일이 직접 만든다.
// 사용: const r = await cardScan(fileOrBlob)  →  { blob, base64, width, height } 또는 취소면 null
(function (root) {
  const WORK_MAX = 2000;              // 원본을 이 크기로 줄여 다룬다(폰 메모리·속도)
  const OUT_MAX = 1600;               // 결과 명함 긴 변(글씨가 또렷할 만큼)
  const OUT_MAX_BYTES = 450 * 1024;   // 서버 사진 한도(base64 70만 자) 안
  const HANDLE = 22;                  // 모서리 손잡이 크기(px, 손가락)

  const css = `
  .cs-wrap{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#0B0F17;color:#E9EEF7;font-family:inherit;touch-action:none;user-select:none;-webkit-user-select:none}
  .cs-top{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px}
  .cs-top h2{flex:1;margin:0;font-size:17px;font-weight:800;color:#fff}
  .cs-step{font-size:12px;color:#9AA6BC}
  .cs-stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;padding:8px}
  .cs-stage canvas.cs-photo,.cs-stage canvas.cs-result{max-width:100%;max-height:100%;display:block}
  .cs-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
  .cs-svg polygon{fill:rgba(53,127,201,.18);stroke:#5B9CFF;stroke-width:2.5}
  .cs-svg circle{fill:rgba(255,255,255,.95);stroke:#2D68FA;stroke-width:3;cursor:grab}
  .cs-loupe{position:absolute;width:120px;height:120px;border-radius:60px;border:3px solid #fff;box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none;display:none;background:#000}
  .cs-hint{margin:0;padding:8px 16px;text-align:center;font-size:13px;color:#B9C3D6;line-height:1.5;word-break:keep-all}
  .cs-modes{display:flex;gap:8px;justify-content:center;padding:6px 12px;flex-wrap:wrap}
  .cs-modes[hidden]{display:none}
  .cs-modes button{min-height:40px;padding:0 14px;border:1px solid #2A3550;border-radius:20px;background:#151C2B;color:#E9EEF7;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
  .cs-modes button[aria-pressed="true"]{background:#2D68FA;border-color:#2D68FA;color:#fff}
  .cs-bar{display:flex;gap:8px;padding:10px 12px calc(12px + env(safe-area-inset-bottom))}
  .cs-bar button{flex:1;min-height:50px;border:1px solid #2A3550;border-radius:25px;background:#151C2B;color:#E9EEF7;font:inherit;font-size:16px;font-weight:800;cursor:pointer}
  .cs-bar button.cs-go{flex:1.4;background:#2D68FA;border-color:#2D68FA;color:#fff}
  .cs-busy{position:absolute;inset:0;display:none;place-items:center;background:rgba(11,15,23,.55);font-size:15px;font-weight:700;color:#fff}
  .cs-busy.on{display:grid}
  .cs-result{background:#fff;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45)}
  `;
  let styled = false;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  const pause = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // '보정 중' 글자가 먼저 보이게

  async function loadCanvas(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { throw new Error('사진을 열 수 없습니다(HEIC 등 지원되지 않는 형식). 다른 사진을 골라 주세요.'); }
    const k = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c;
  }

  const toCanvas = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0); return c; };
  function rotate(c, quarter) {
    const r = document.createElement('canvas');
    const odd = quarter % 2 === 1;
    r.width = odd ? c.height : c.width; r.height = odd ? c.width : c.height;
    const g = r.getContext('2d');
    g.translate(r.width / 2, r.height / 2); g.rotate((quarter * Math.PI) / 2); g.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }

  async function toJpeg(c) {
    let cur = c;
    for (let tries = 0; tries < 6; tries += 1) {
      for (const q of [0.9, 0.82, 0.74, 0.66]) {
        const blob = await new Promise((r) => cur.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= OUT_MAX_BYTES) return blob;
      }
      const s = document.createElement('canvas');   // 그래도 크면 85% 로 줄여 다시
      s.width = Math.round(cur.width * 0.85); s.height = Math.round(cur.height * 0.85);
      s.getContext('2d').drawImage(cur, 0, 0, s.width, s.height);
      cur = s;
    }
    return new Promise((r) => cur.toBlob(r, 'image/jpeg', 0.6));
  }
  async function toB64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function cardScan(file) {
    if (!styled) { const s = el('style'); s.textContent = css; document.head.append(s); styled = true; }
    return new Promise((resolve, reject) => {
      const wrap = el('div', 'cs-wrap');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', '명함 스캔');
      const title = el('h2', null, '명함 테두리 맞추기');
      const step = el('span', 'cs-step', '1/2');
      const top = el('div', 'cs-top'); top.append(title, step);
      const stage = el('div', 'cs-stage');
      const busy = el('div', 'cs-busy on', '사진 여는 중...');
      const hint = el('p', 'cs-hint');
      const modes = el('div', 'cs-modes'); modes.hidden = true;
      const bar = el('div', 'cs-bar');
      const back = btn('취소'); const mid = btn('전체'); const go = btn('다음 →', 'cs-go');
      bar.append(back, mid, go);
      stage.append(busy);
      wrap.append(top, stage, hint, modes, bar);
      // 열린 모달 <dialog> 는 페이지 맨 위 층이라 이 화면을 가린다 → 부르는 쪽이 창을 닫고 부른다(contacts.js)
      document.body.append(wrap);

      const state = { step: 1, quad: null, src: null, flat: null, mode: 'auto', turn: 0, cache: {}, out: null };
      let svg = null; let poly = null; let dots = []; let loupe = null;
      let done = false;
      const finish = (v) => { if (done) return; done = true; wrap.remove(); window.removeEventListener('popstate', onBack); window.removeEventListener('resize', onResize); resolve(v); };
      // 안드로이드 뒤로가기 = 한 단계 뒤로(1단계면 취소). 주소(#)는 그대로 두고 기록만 하나 쌓는다
      const onBack = () => { if (state.step === 2) { showStep1(); history.pushState(history.state, ''); } else finish(null); };
      history.pushState(history.state, '');
      window.addEventListener('popstate', onBack);
      const leave = (v) => { window.removeEventListener('popstate', onBack); finish(v); history.back(); };
      const onResize = () => { if (state.step === 1 && svg) draw(); };
      window.addEventListener('resize', onResize);

      const box = () => state.src.getBoundingClientRect();
      const toScreen = (p) => { const b = box(); const s = stage.getBoundingClientRect(); return { x: b.left - s.left + p.x * b.width, y: b.top - s.top + p.y * b.height }; };
      function draw() {
        const pts = ['tl', 'tr', 'br', 'bl'].map((k) => toScreen(state.quad[k]));
        poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
        dots.forEach((d, i) => { d.setAttribute('cx', pts[i].x); d.setAttribute('cy', pts[i].y); });
      }
      function showLoupe(p, sx, sy) {
        const g = loupe.getContext('2d');
        const zoom = 2.5; const r = 60;
        const W = state.src.width; const H = state.src.height;
        const k = W / box().width;   // 원본 화소 / 화면 화소
        g.fillStyle = '#000'; g.fillRect(0, 0, 120, 120);
        g.drawImage(state.src, p.x * W - (r / zoom) * k, p.y * H - (r / zoom) * k, (2 * r / zoom) * k, (2 * r / zoom) * k, 0, 0, 120, 120);
        g.strokeStyle = '#2D68FA'; g.lineWidth = 2; g.beginPath(); g.moveTo(60, 46); g.lineTo(60, 74); g.moveTo(46, 60); g.lineTo(74, 60); g.stroke();
        loupe.style.display = 'block';
        loupe.style.left = `${Math.max(4, sx - 60)}px`;
        loupe.style.top = `${sy - 150 < 4 ? sy + 40 : sy - 150}px`;   // 손가락에 가리지 않게 위(자리가 없으면 아래)
      }

      function showStep1() {
        state.step = 1;
        title.textContent = '명함 테두리 맞추기'; step.textContent = '1/2';
        hint.textContent = '파란 동그라미 4개를 명함 네 귀퉁이에 맞춰 주세요. 자동으로 찾아 두었습니다.';
        modes.hidden = true;
        back.textContent = '취소'; mid.textContent = '전체'; go.textContent = '다음 →';
        stage.replaceChildren(state.src, svg, loupe, busy);
        requestAnimationFrame(draw);
      }

      async function render2() {
        busy.textContent = '선명하게 다듬는 중...'; busy.classList.add('on');
        await pause();
        if (!state.flat) {
          const img = state.src.getContext('2d').getImageData(0, 0, state.src.width, state.src.height);
          state.flat = CardEnhance.warpQuad({ width: img.width, height: img.height, data: img.data }, state.quad, OUT_MAX);
          state.cache = {};
        }
        if (!state.cache[state.mode]) state.cache[state.mode] = toCanvas(CardEnhance.enhance(state.flat, state.mode));
        const shown = rotate(state.cache[state.mode], state.turn);
        shown.className = 'cs-result';
        stage.replaceChildren(shown, busy);
        busy.classList.remove('on');
        for (const b of modes.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
        state.out = shown;
      }
      function showStep2() {
        state.step = 2;
        title.textContent = '명함 보정'; step.textContent = '2/2';
        hint.textContent = '빛 반사·그늘을 지우고 글씨를 또렷하게 했습니다. 잘 안 보이면 「흑백 선명」을 눌러 보세요.';
        modes.hidden = false;
        back.textContent = '← 테두리'; mid.textContent = '⟳ 돌리기'; go.textContent = '이 사진 사용';
        render2();
      }

      for (const [mode, label] of [['auto', '자동 보정'], ['bw', '흑백 선명'], ['original', '보정 안 함']]) {
        const b = btn(label); b.dataset.mode = mode; b.setAttribute('aria-pressed', String(mode === 'auto'));
        b.addEventListener('click', () => { state.mode = mode; render2(); });
        modes.append(b);
      }
      back.addEventListener('click', () => { if (state.step === 2) showStep1(); else leave(null); });
      mid.addEventListener('click', () => {
        if (state.step === 1) { state.quad = JSON.parse(JSON.stringify(CardEnhance.DEFAULT_QUAD)); state.flat = null; draw(); } else { state.turn = (state.turn + 1) % 4; render2(); }
      });
      go.addEventListener('click', async () => {
        if (state.step === 1) { showStep2(); return; }
        busy.textContent = '저장 준비 중...'; busy.classList.add('on');
        await pause();
        const blob = await toJpeg(state.out);
        leave({ blob, base64: await toB64(blob), width: state.out.width, height: state.out.height });
      });

      (async () => {
        state.src = await loadCanvas(file);
        await pause();
        const img = state.src.getContext('2d').getImageData(0, 0, state.src.width, state.src.height);
        state.quad = CardEnhance.detectCardQuad({ width: img.width, height: img.height, data: img.data }) || JSON.parse(JSON.stringify(CardEnhance.DEFAULT_QUAD));
        state.src.className = 'cs-photo';
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cs-svg');
        poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        svg.append(poly);
        loupe = el('canvas', 'cs-loupe'); loupe.width = 120; loupe.height = 120;
        dots = ['tl', 'tr', 'br', 'bl'].map((k) => {
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('r', String(HANDLE / 2 + 4));
          c.dataset.corner = k;
          svg.append(c);
          return c;
        });
        // 손가락이 동그라미 근처(HANDLE*1.8)만 닿아도 가장 가까운 모서리를 잡는다
        let drag = null;
        svg.addEventListener('pointerdown', (e) => {
          const s = stage.getBoundingClientRect();
          const x = e.clientX - s.left; const y = e.clientY - s.top;
          let best = null; let bd = Infinity;
          for (const k of ['tl', 'tr', 'br', 'bl']) { const p = toScreen(state.quad[k]); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = k; } }
          if (bd > HANDLE * 1.8) return;
          drag = best; svg.setPointerCapture(e.pointerId); e.preventDefault();
        });
        svg.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const b = box(); const s = stage.getBoundingClientRect();
          const p = { x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)) };
          state.quad[drag] = p; state.flat = null;
          draw(); showLoupe(p, e.clientX - s.left, e.clientY - s.top);
        });
        const end = () => { drag = null; if (loupe) loupe.style.display = 'none'; };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);
        busy.classList.remove('on');
        showStep1();
      })().catch((err) => { leave(null); reject(err); });
    });
  }

  root.cardScan = cardScan;
})(typeof window !== 'undefined' ? window : globalThis);
