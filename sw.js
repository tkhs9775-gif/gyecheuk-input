// 서비스 워커: 앱 화면 파일을 폰에 저장해 두어 신호가 없는 곳에서도 앱이 열리게 한다.
// 서버 통신(Apps Script, 날씨)은 건드리지 않는다. 등록할 때 붙인 ?v=번호가 바뀌면 이 파일이 새로 설치되고 옛 저장분은 지워진다.
const V = new URL(self.location.href).searchParams.get('v') || '0';
const CACHE = `shell-${V}`;
const SHELL = [
  './', 'index.html', 'logo.png', 'manifest.json',
  `style.css?v=${V}`, `config.js?v=${V}`, `weather.js?v=${V}`, `entries.js?v=${V}`, `push.js?v=${V}`,
  `outbox.js?v=${V}`, `phonecopy.js?v=${V}`, `drawing.js?v=${V}`, `app.js?v=${V}`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // ?v= 가 붙은 파일은 번호가 바뀌면 주소가 달라지므로 저장분을 먼저 쓴다
  if (url.searchParams.has('v')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  // 나머지(index.html, 로고 등)는 인터넷이 되면 항상 최신을 받고, 안 되면 저장분을 쓴다
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((cache) => cache.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
