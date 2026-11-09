'use strict';
// 작업 중 표시: 키움이엔씨 로고 색(파랑 #3781C9 · 남색 #1B2A57)의 모래시계가 돌며 모래가 떨어진다.
// busyShow('도면을 읽는 중...') / busyText('...') / busyHide(). 여러 곳이 겹쳐 불러도 마지막 busyHide 까지 떠 있다.
// 움직임은 CSS transform 만 써서(합성기에서 돈다) 도면 계산으로 화면 스레드가 바빠도 멈추지 않는다.
let busyDepth = 0;

function busyEl() {
  let el = document.getElementById('busyOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'busyOverlay';
  el.className = 'busy hidden';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="busy-card">
      <div class="hg" aria-hidden="true">
        <div class="hg-flip">
          <svg viewBox="0 0 64 96" width="64" height="96">
            <defs>
              <clipPath id="hgTop"><path d="M14 12 H50 C50 30 38 38 33 46 H31 C26 38 14 30 14 12 Z"/></clipPath>
              <clipPath id="hgBot"><path d="M31 50 H33 C38 58 50 66 50 84 H14 C14 66 26 58 31 50 Z"/></clipPath>
              <linearGradient id="hgSand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5A9BDB"/><stop offset="1" stop-color="#2F6FB3"/></linearGradient>
            </defs>
            <rect x="8" y="4" width="48" height="8" rx="4" fill="#1B2A57"/>
            <rect x="8" y="84" width="48" height="8" rx="4" fill="#1B2A57"/>
            <path d="M14 12 C14 32 28 40 30 48 C28 56 14 64 14 84 M50 12 C50 32 36 40 34 48 C36 56 50 64 50 84" fill="none" stroke="#1B2A57" stroke-width="3" stroke-linecap="round"/>
            <g clip-path="url(#hgTop)"><rect class="hg-top" x="12" y="12" width="40" height="36" fill="url(#hgSand)"/></g>
            <g clip-path="url(#hgBot)"><rect class="hg-bot" x="12" y="48" width="40" height="36" fill="url(#hgSand)"/></g>
            <rect class="hg-stream" x="31.2" y="46" width="1.6" height="34" rx=".8" fill="#3781C9"/>
          </svg>
        </div>
      </div>
      <p class="busy-brand">KIEUM E&amp;C</p>
      <p id="busyMsg" class="busy-msg"></p>
    </div>`;
  document.body.append(el);
  return el;
}

function busyShow(msg = '처리하는 중...') {
  busyDepth += 1;
  const el = busyEl();
  document.getElementById('busyMsg').textContent = msg;
  el.classList.remove('hidden');
}

function busyText(msg) {
  const m = document.getElementById('busyMsg');
  if (m) m.textContent = msg;
}

function busyHide(force = false) {
  busyDepth = force ? 0 : Math.max(0, busyDepth - 1);
  if (busyDepth === 0) document.getElementById('busyOverlay')?.classList.add('hidden');
}

// 화면이 한 번 그려지게 잠깐 양보(긴 계산 앞에서 문구가 먼저 보이게)
const busyYield = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
