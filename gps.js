// Pro 앱(키움 Pro) 전용: 휴대폰 GPS로 도면 위에 내 위치(파란 점)를 띄운다.
// 도면 PDF에는 좌표가 없어서, 쪽마다 처음 한 번 '기준점 2개'를 맞춘다:
// 서 있는 곳을 도면에서 터치 → 20m 이상 걸어가 다시 터치. 두 점으로 위경도 → 도면 좌표(이동·회전·축척)를 구한다.
// 폰 GPS 오차는 3~10m라 위치 확인용이다. 측량값 대신 쓰지 않는다.

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;
const GPS_MIN_BASELINE_M = 15;    // 기준점 두 곳이 이보다 가까우면 방향·축척 오차가 커진다
const GPS_MAX_ACCURACY_M = 20;    // 기준점을 찍을 때 GPS가 이보다 부정확하면 기다리게 한다
const GPS_COARSE_M = 100;         // 이보다 크면 '대략적 위치'만 허용된 것으로 보고 설정을 안내한다
const GPS_MIN_TAP_GAP = 0.03;     // 도면에서 두 기준점이 너무 붙어 있으면(도면 폭의 3%) 다시 찍게 한다
const GPS_WATCH = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };

function isProApp() {
  try { return !!window.AndroidPro?.isPro?.(); } catch { return false; }
}

// 기준점 A를 원점으로 한 동쪽·북쪽 거리(m). 현장 크기(수 km 안)에서는 평면으로 봐도 된다
function toLocalMeters(origin, p) {
  return {
    e: (p.lng - origin.lng) * M_PER_DEG_LNG * Math.cos((origin.lat * Math.PI) / 180),
    n: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

const gpsDistanceM = (a, b) => { const g = toLocalMeters(a, b); return Math.hypot(g.e, g.n); };

// cal = { a, b, ar }: a·b는 { lat, lng, x, y }(x·y는 쪽 기준 0~1), ar은 쪽의 세로/가로 비율.
// 도면 좌표를 가로 기준 같은 축척(x, y*ar)으로 놓고, 위경도(동, -북: 화면처럼 아래가 +)와의 닮음 변환을 복소수 한 개 s로 푼다
function gpsToPage(cal, pos) {
  const { a, b, ar } = cal;
  const gb = toLocalMeters(a, b);
  const gx = gb.e, gy = -gb.n;
  const gg = gx * gx + gy * gy;
  if (!gg || !ar) return null;
  const px = b.x - a.x, py = (b.y - a.y) * ar;
  const sr = (px * gx + py * gy) / gg;
  const si = (py * gx - px * gy) / gg;
  const g = toLocalMeters(a, pos);
  const qx = g.e, qy = -g.n;
  return {
    x: a.x + sr * qx - si * qy,
    y: a.y + (sr * qy + si * qx) / ar,
    unitsPerMeter: Math.hypot(sr, si),   // 1m가 도면 가로폭의 몇 배인지(정확도 원 크기용)
  };
}

// step 0: 내 위치 표시 중, 1: 기준점 1 대기, 2: 기준점 2 대기
const gpsState = { on: false, watchId: null, fix: null, step: 0, pendingA: null };

const pageCal = () => drawingState.notes.gps?.[String(drawingState.pageNum)] || null;

// 지금 보이는 쪽의 세로/가로 비율(보기 회전 전 기준)
function pageAspect() {
  const r = $('gpsLayer').getBoundingClientRect();
  if (!r.width || !r.height) return 0;
  return drawingState.rotation % 180 === 0 ? r.height / r.width : r.width / r.height;
}

const gpsMessage = (text) => { $('gpsMsg').textContent = text; };
const accText = () => (gpsState.fix ? ` (GPS 오차 ±${Math.round(gpsState.fix.accuracy)}m)` : '');

function renderGps() {
  if (!gpsState.on) return;
  const { step, fix } = gpsState;
  const dot = $('gpsDot');
  $('gpsLayer').classList.toggle('calibrating', step !== 0);
  if (step === 1) {
    show(dot, false);
    gpsMessage(fix ? `기준점 1: 지금 서 있는 곳을 도면에서 터치하세요${accText()}` : 'GPS 잡는 중... 하늘이 보이는 곳에서 잠시 기다려 주세요.');
    return;
  }
  if (step === 2) {
    show(dot, false);
    const d = fix ? Math.round(gpsDistanceM(gpsState.pendingA, fix)) : 0;
    gpsMessage(`기준점 2: ${GPS_MIN_BASELINE_M + 5}m 이상 걸어간 뒤 서 있는 곳을 터치하세요. 지금 ${d}m 이동${accText()}`);
    return;
  }
  const cal = pageCal();
  if (!fix || !cal) { show(dot, false); gpsMessage('GPS 잡는 중...'); return; }
  const p = gpsToPage(cal, fix);
  const inside = !!p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  show(dot, inside);
  if (!inside) { gpsMessage(`지금 위치가 도면 밖입니다${accText()}`); return; }
  const at = toView(p, drawingState.rotation);
  dot.style.left = `${(at.x * 100).toFixed(2)}%`;
  dot.style.top = `${(at.y * 100).toFixed(2)}%`;
  // 정확도 원 지름 = 오차(m) × 2 × 1m당 쪽 가로폭. 보기를 90·270도 돌리면 화면 가로가 쪽 세로(가로의 ar배)라 ar로 나눈다
  const toScreenWidth = drawingState.rotation % 180 === 0 ? 1 : 1 / cal.ar;
  dot.style.setProperty('--acc', `${Math.min(100, 2 * fix.accuracy * p.unitsPerMeter * toScreenWidth * 100).toFixed(2)}%`);
  gpsMessage(`내 위치 표시 중${accText()}`);
}

function onGpsFix(pos) {
  gpsState.fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  renderGps();
}

function onGpsError(err) {
  if (err.code === 1) {
    gpsMessage('위치 권한이 꺼져 있습니다. 휴대폰 설정 > 애플리케이션 > 키움 Pro > 권한 > 위치를 허용해 주세요.');
    stopWatch();
  } else if (err.code === 2) {
    gpsMessage('GPS 신호를 잡지 못했습니다. 휴대폰 위치(GPS)가 켜져 있는지 확인해 주세요.');
  }
  // 3(시간 초과)은 그대로 기다린다: 지켜보기는 이어서 돈다
}

function stopWatch() {
  if (gpsState.watchId !== null) navigator.geolocation.clearWatch(gpsState.watchId);
  gpsState.watchId = null;
}

function startCalibration() {
  gpsState.step = 1;
  gpsState.pendingA = null;
  setPinMode(false);
  setPenMode(false);
  renderGps();
}

function startGps() {
  if (!navigator.geolocation) { alert('이 휴대폰에서는 위치(GPS)를 쓸 수 없습니다.'); return; }
  gpsState.on = true;
  $('pdfGps').setAttribute('aria-pressed', 'true');
  show($('gpsPanel'), true);
  gpsState.watchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError, GPS_WATCH);
  if (pageCal()) { gpsState.step = 0; renderGps(); } else startCalibration();
}

function stopGps() {
  if (!gpsState.on) return;
  stopWatch();
  Object.assign(gpsState, { on: false, fix: null, step: 0, pendingA: null });
  $('pdfGps').setAttribute('aria-pressed', 'false');
  $('gpsLayer').classList.remove('calibrating');
  show($('gpsPanel'), false);
  show($('gpsDot'), false);
}

// 쪽을 넘기거나 돌렸을 때: 그 쪽에 기준점이 없으면 맞추기부터
function refreshGps() {
  if (!gpsState.on) return;
  if (gpsState.step === 0 && !pageCal()) startCalibration();
  else renderGps();
}

function handleGpsTap(e) {
  if (!gpsState.on || gpsState.step === 0) return;
  e.stopPropagation();
  const { fix } = gpsState;
  if (!fix || fix.accuracy > GPS_MAX_ACCURACY_M) {
    gpsMessage(fix && fix.accuracy > GPS_COARSE_M
      ? `위치가 대략적으로만 잡힙니다${accText()}. 휴대폰 설정 > 애플리케이션 > 키움 Pro > 권한 > 위치에서 '정확한 위치 사용'을 켜 주세요.`
      : `GPS가 아직 부정확합니다${accText()}. 잠시 기다린 뒤 다시 터치하세요.`);
    return;
  }
  const r = $('gpsLayer').getBoundingClientRect();
  const { x, y } = fromView({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, drawingState.rotation);
  const point = { lat: fix.lat, lng: fix.lng, x, y };
  if (gpsState.step === 1) {
    gpsState.pendingA = point;
    gpsState.step = 2;
    renderGps();
    return;
  }
  const a = gpsState.pendingA;
  const walked = gpsDistanceM(a, point);
  if (walked < GPS_MIN_BASELINE_M) {
    gpsMessage(`기준점 1에서 ${Math.round(walked)}m밖에 안 떨어졌습니다. ${GPS_MIN_BASELINE_M + 5}m 이상 걸어간 뒤 터치하세요.`);
    return;
  }
  if (Math.hypot(point.x - a.x, point.y - a.y) < GPS_MIN_TAP_GAP) {
    gpsMessage('도면에서 기준점 1과 너무 가깝게 찍었습니다. 지금 서 있는 곳을 정확히 터치하세요.');
    return;
  }
  // 기준점은 야장 메모와 함께 저장된다: 다른 폰·저장본에서도 다시 맞추지 않아도 된다
  drawingState.notes.gps = { ...(drawingState.notes.gps || {}), [String(drawingState.pageNum)]: { a, b: point, ar: pageAspect() } };
  drawingState.dirty = true;
  saveDrawingNotesQuiet();
  gpsState.step = 0;
  gpsState.pendingA = null;
  renderGps();
}

function initGps() {
  if (!isProApp()) return;
  show($('pdfGps'), true);
  $('pdfGps').addEventListener('click', () => (gpsState.on ? stopGps() : startGps()));
  $('gpsOff').addEventListener('click', stopGps);
  $('gpsRecal').addEventListener('click', startCalibration);
  $('gpsLayer').addEventListener('click', handleGpsTap);
}

if (typeof module !== 'undefined') module.exports = { toLocalMeters, gpsToPage, gpsDistanceM };
