// Pro 앱(키움 Pro) 전용: 도면 화면의 📍 → 지도(위성·일반) 위에 휴대폰 GPS로 내 위치를 바로 띄운다. 맞추는 단계 없음.
// 지도 그림은 인터넷으로 받는다(신호가 없으면 점과 좌표만 보인다). 폰 GPS 오차는 3~10m라 위치 확인용이다.

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const MAP_ZOOM = 18;
const MAP_MAX_ZOOM = 19;
const KOREA_CENTER = [36.5, 127.8];
const GPS_WATCH = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };

const gpsState = { map: null, dot: null, ring: null, watchId: null, fix: null, follow: true };

function isProApp() {
  try { return !!window.AndroidPro?.isPro?.(); } catch { return false; }
}

function ensureLeaflet() {
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LEAFLET_CSS, integrity: LEAFLET_CSS_SRI, crossOrigin: 'anonymous' }));
  }
  return ensureLib(LEAFLET_JS, 'L', LEAFLET_JS_SRI);
}

const gpsMessage = (text) => { $('gpsMsg').textContent = text; };
const fixText = ({ lat, lng, accuracy }) => `위도 ${lat.toFixed(6)} · 경도 ${lng.toFixed(6)} · 오차 ±${Math.round(accuracy)}m`;

function createMap() {
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: MAP_MAX_ZOOM, attribution: 'Esri' });
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: MAP_MAX_ZOOM, attribution: '© OpenStreetMap' });
  const map = L.map('gpsMapView', { layers: [sat] }).setView(KOREA_CENTER, 7);
  L.control.layers({ '위성': sat, '일반 지도': street }).addTo(map);
  map.on('dragstart', () => { gpsState.follow = false; });   // 손으로 옮기면 따라가기를 멈춘다. [내 위치로]로 다시 켠다
  gpsState.ring = L.circle(KOREA_CENTER, { radius: 1, color: '#1E88E5', weight: 1, fillOpacity: 0.15 });
  gpsState.dot = L.circleMarker(KOREA_CENTER, { radius: 8, color: '#FFFFFF', weight: 3, fillColor: '#1E88E5', fillOpacity: 1 });
  gpsState.map = map;
}

function onGpsFix(pos) {
  const first = !gpsState.fix;
  gpsState.fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  const at = [gpsState.fix.lat, gpsState.fix.lng];
  gpsState.ring.setLatLng(at).setRadius(gpsState.fix.accuracy).addTo(gpsState.map);
  gpsState.dot.setLatLng(at).addTo(gpsState.map);
  if (first) gpsState.map.setView(at, MAP_ZOOM);
  else if (gpsState.follow) gpsState.map.panTo(at);
  gpsMessage(fixText(gpsState.fix));
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

async function openGpsMap() {
  if (!navigator.geolocation) { alert('이 휴대폰에서는 위치(GPS)를 쓸 수 없습니다.'); return; }
  show($('gpsMap'), true);
  // 안드로이드 뒤로가기가 도면까지 닫지 않고 지도만 닫게 한 칸 넣어 둔다
  try { history.pushState({ pdfViewer: true, gpsMap: true }, ''); } catch (err) { console.warn('history 사용 불가', err); }
  gpsMessage('지도 불러오는 중...');
  try {
    await ensureLeaflet();
  } catch (err) {
    gpsMessage(friendlyError(err, '지도 기능 파일을 받지 못했습니다. 신호를 확인해 주세요.'));
    return;
  }
  if ($('gpsMap').classList.contains('hidden')) return;   // 받는 사이 닫았다
  if (!gpsState.map) createMap();
  gpsState.map.invalidateSize();
  gpsState.follow = true;
  gpsState.fix = null;
  gpsMessage('GPS 잡는 중... 하늘이 보이는 곳에서 잠시 기다려 주세요.');
  gpsState.watchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError, GPS_WATCH);
}

// 지도를 실제로 닫는다(GPS도 끈다). 도면 뷰어를 닫을 때도 불린다
function stopGps() {
  stopWatch();
  show($('gpsMap'), false);
}

function closeGpsMap() {
  if (history.state?.gpsMap) history.back(); else stopGps();
}

function recenterGps() {
  gpsState.follow = true;
  if (gpsState.fix) gpsState.map.setView([gpsState.fix.lat, gpsState.fix.lng], Math.max(gpsState.map.getZoom(), MAP_ZOOM));
}

function initGps() {
  if (!isProApp()) return;
  show($('pdfGps'), true);
  $('pdfGps').addEventListener('click', openGpsMap);
  $('gpsMapClose').addEventListener('click', closeGpsMap);
  $('gpsRecenter').addEventListener('click', recenterGps);
  window.addEventListener('popstate', () => { if (!history.state?.gpsMap && !$('gpsMap').classList.contains('hidden')) stopGps(); });
}

if (typeof module !== 'undefined') module.exports = { fixText };
