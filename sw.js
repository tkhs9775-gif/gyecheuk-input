// 서비스 워커: 앱 화면 파일을 폰에 저장해 두어 신호가 없는 곳에서도 앱이 열리게 한다.
// 서버 통신(Apps Script, 날씨)은 건드리지 않는다. 등록할 때 붙인 ?v=번호가 바뀌면 이 파일이 새로 설치되고 옛 저장분은 지워진다.
const V = new URL(self.location.href).searchParams.get('v') || '0';
const CACHE = `shell-${V}`;
const NET_WAIT_MS = 3000;   // 화면 파일(index.html)을 이만큼 기다려도 안 오면 폰에 저장해 둔 것으로 연다
const SHELL = [
  './', 'index.html', 'logo.png', 'manifest.json',
  `style.css?v=${V}`, `config.js?v=${V}`, `weather.js?v=${V}`, `entries.js?v=${V}`, `push.js?v=${V}`,
  `outbox.js?v=${V}`, `phonecopy.js?v=${V}`, `drawing.js?v=${V}`, `gps.js?v=${V}`, `gallery.js?v=${V}`, `app.js?v=${V}`,
];

// 설치할 때는 브라우저 캐시를 거치지 않고 새로 받는다: 묵은 index.html이 옛 ?v= 파일을 가리키면 오프라인에서 앱이 열리지 않는다
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
  // 나머지(index.html, 로고 등)는 인터넷이 되면 항상 최신을 받고, 안 되면 저장분을 쓴다.
  // 신호가 약해 NET_WAIT_MS 안에 안 오면 저장분으로 먼저 열고(지하 현장에서 하얀 화면으로 오래 멈추지 않게), 받는 것은 뒤에서 마저 받아 다음에 쓴다
  // (주소 문자열로 다시 요청: 화면 이동(navigate) 요청 객체에 옵션을 얹으면 일부 브라우저가 예외를 던진다)
  // 저장분으로 연 경우에는 늦게 온 새 index.html을 저장하지 않는다: 새 index.html은 이 저장 묶음에 없는 새 ?v= 파일을 가리켜서,
  // 그 뒤 신호 없이 열면 하얀 화면이 된다. 다음에 신호가 좋을 때 새로 받아 서비스 워커째 바뀐다
  const net = fetch(req.url, { cache: 'no-cache' });
  net.catch(() => {});   // 저장분으로 이미 열었으면 실패해도 알릴 곳이 없다
  const late = new Promise((resolve) => setTimeout(() => resolve(null), NET_WAIT_MS));
  const shown = Promise.race([net, late]).then((res) => (res
    ? { res, fresh: true }
    : caches.match(req).then((hit) => (hit ? { res: hit, fresh: false } : net.then((r) => ({ res: r, fresh: true }))))));   // 저장분이 없으면 끝까지 기다린다
  event.waitUntil(shown.then(({ res, fresh }) => {
    if (!fresh || !res.ok) return undefined;
    const copy = res.clone();   // 화면이 본문을 읽기 전에 복사해 둔다
    return caches.open(CACHE).then((cache) => cache.put(req, copy));
  }).catch(() => {}));
  event.respondWith(
    shown.then(({ res }) => res)
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
