// 앱 안 카메라: 삼성 카메라 앱을 거치지 않고 화면 안에서 미리보기를 띄워, 누르는 순간 150KB 이하 JPEG로 만든다.
// 원본(수 MB)을 저장했다 다시 줄이는 단계가 없어 빠르다. 줄이는 규칙은 app.js shrinkToJpeg(사진 올리기와 같은 규칙).
// 카메라를 못 쓰면(옛 APK는 권한을 막음, 권한 거부, 카메라 없음) 거부(reject)해서 부른 쪽이 기본 카메라로 대신 열게 한다.
const CAM_CONSTRAINTS = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
};

const camSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

// room: 더 찍을 수 있는 장수. onShot(file): 한 장 찍힐 때마다 바로 부른다(닫기 전에도 목록에 들어감).
// 돌려주는 약속: 카메라가 열리면 닫힐 때 찍은 장수로 끝난다. 못 열면 거부.
async function openInAppCamera({ room, onShot }) {
  const stream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
  const track = stream.getVideoTracks()[0];

  const view = document.createElement('div');
  view.className = 'cam-view';
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-label', '사진 촬영');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  const flash = document.createElement('div');
  flash.className = 'cam-flash';

  const mkBtn = (cls, text, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    return b;
  };
  const closeBtn = mkBtn('cam-close', '✕', '카메라 닫기');
  const torchBtn = mkBtn('cam-torch', '🔦', '손전등');
  torchBtn.hidden = true;
  const count = document.createElement('span');
  count.className = 'cam-count';
  const top = document.createElement('div');
  top.className = 'cam-top';
  top.append(closeBtn, count, torchBtn);

  const last = document.createElement('img');
  last.className = 'cam-last';
  last.alt = '';
  const shutter = mkBtn('cam-shutter', '', '찍기');
  const doneBtn = mkBtn('cam-done', '완료');
  const bottom = document.createElement('div');
  bottom.className = 'cam-bottom';
  bottom.append(last, shutter, doneBtn);

  view.append(video, flash, top, bottom);
  document.body.append(view);
  document.body.classList.add('cam-open');

  let shots = 0;
  let lastUrl = '';
  let closed = false;
  let queue = Promise.resolve();   // 빨리 여러 번 눌러도 한 장씩 차례로 만든다(동시에 하면 메모리가 모자람)
  let pending = 0;
  const showCount = () => { count.textContent = `${shots}장${pending ? ' · 저장 중…' : ''}`; };
  showCount();

  // 기다리지 않는다: 그사이 뒤로가기를 누르면 아직 history 칸이 없어 앱 화면이 뒤로 가 버림
  video.play().catch((err) => console.warn('미리보기 재생 실패', err));

  // 손전등: 카메라가 지원할 때만 버튼을 보인다
  let torchOn = false;
  if (track?.getCapabilities?.().torch) {
    torchBtn.hidden = false;
    torchBtn.addEventListener('click', async () => {
      try {
        await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
        torchOn = !torchOn;
        torchBtn.classList.toggle('on', torchOn);
      } catch (err) { console.warn('손전등 전환 실패', err); }
    });
  }

  return new Promise((resolve) => {
    function finish() {
      if (closed) return;
      closed = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      view.remove();
      document.body.classList.remove('cam-open');
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('visibilitychange', onHidden);
      // 저장 중인 사진까지 넘긴 뒤 끝낸다
      queue.then(() => { if (lastUrl) URL.revokeObjectURL(lastUrl); resolve(shots); });
    }
    // 안드로이드 뒤로가기(history.back)가 화면을 바꾸지 않고 카메라를 닫게 한 칸 넣어 둔다(drawing.js 뷰어와 같은 방식)
    let pushed = false;
    try { history.pushState({ cam: true }, ''); pushed = true; } catch (err) { console.warn('history 사용 불가', err); }
    // 두 번 눌러도 뒤로가기는 한 번만(history.back은 바로 안 끝나서 두 번 가면 앱 화면까지 뒤로 감)
    let closing = false;
    const close = () => {
      if (closing || closed) return;
      closing = true;
      if (pushed && history.state?.cam) history.back(); else finish();
    };
    const onPop = () => { if (!history.state?.cam) finish(); };
    const onHidden = () => { if (document.hidden) close(); };   // 앱을 내리면 카메라를 놓아 준다(찍은 사진은 그대로)
    window.addEventListener('popstate', onPop);
    document.addEventListener('visibilitychange', onHidden);
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);

    shutter.addEventListener('click', () => {
      if (closed) return;
      if (shots + pending >= room) { alert(`사진은 한 번에 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`); return; }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;   // 미리보기가 아직 안 나옴
      // 누른 순간의 화면을 바로 잡아 둔다(줄이기는 그 뒤에 차례로)
      const frame = document.createElement('canvas');
      frame.width = w;
      frame.height = h;
      frame.getContext('2d').drawImage(video, 0, 0, w, h);
      navigator.vibrate?.(30);
      flash.classList.remove('go');
      void flash.offsetWidth;   // 애니메이션 다시 시작
      flash.classList.add('go');
      pending += 1;
      showCount();
      queue = queue.then(async () => {
        try {
          const blob = await shrinkToJpeg(frame, w, h);
          if (!blob) throw new Error('사진을 만들지 못했습니다');
          const file = new File([blob], `cam_${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
          shots += 1;
          onShot(file);
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = URL.createObjectURL(blob);
          last.src = lastUrl;
        } catch (err) {
          console.warn('촬영 실패', err);
          alert('사진을 만들지 못했습니다. 다시 찍어 주세요.');
        } finally {
          frame.width = 0;   // 큰 캔버스 메모리를 바로 돌려준다
          pending -= 1;
          showCount();
        }
      });
    });
  });
}
