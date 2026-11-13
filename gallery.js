// 갤러리: 클라우드 계측사진/<현장>/ 폴더를 삼성 갤러리처럼 본다.
// 앨범(현장 폴더) 바둑판 → 사진 그리드(날짜별 묶음, 내리면 더 불러옴) → 크게 보기(좌우 넘기기·두 손가락 확대·폰에 저장).
// 서버: photo_albums, photo_page(40장씩, 작은 미리보기 포함), 큰 사진은 drive_download. 이 파일은 app.js보다 먼저 읽히므로 화면 요소는 함수 안에서만 쓴다.

const gallery = { site: '', files: [], total: 0, loading: false, index: -1, seq: 0 };
const G_FULL_CACHE_MAX = 16;   // 크게 본 사진을 몇 장까지 기억할지(메모리)
const G_IDB_NAME = 'gyecheuk_gallery';
const G_IDB_LISTS = 'lists';
const G_IDB_PHOTOS = 'photos';
const G_IDB_PHOTO_MAX = 40;
const fullCache = new Map();   // fileId → { url, base64 }
const fullInflight = new Map();
const G_SWIPE_PX = 60;
const G_MAX_ZOOM = 5;
const G_DOUBLE_TAP_MS = 300;
const G_DOUBLE_TAP_ZOOM = 2.5;
const G_WEEKDAYS = '일월화수목금토';

// 구버전 Code.gs는 PNG, 새 Code.gs는 용량이 1/4 이하인 JPEG 썸네일을 내려주므로 첫 바이트(Base64 '/9j/' = JPEG)로 구분한다
const gThumbMime = (b64) => (String(b64 || '').startsWith('/9j/') ? 'image/jpeg' : 'image/png');
const gThumbUrl = (b64) => (b64 ? `url("data:${gThumbMime(b64)};base64,${b64}")` : '');

let gDbPromise = null;
function openGalleryDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!gDbPromise) {
    gDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(G_IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(G_IDB_LISTS)) db.createObjectStore(G_IDB_LISTS, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(G_IDB_PHOTOS)) db.createObjectStore(G_IDB_PHOTOS, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { gDbPromise = null; resolve(null); };
      } catch { gDbPromise = null; resolve(null); }
    });
  }
  return gDbPromise;
}

async function gIdbGet(storeName, key) {
  const db = await openGalleryDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function gIdbPut(storeName, value) {
  const db = await openGalleryDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    } catch { resolve(); }
  });
}

async function gIdbDel(storeName, key) {
  const db = await openGalleryDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      if (key === null) tx.objectStore(storeName).clear();
      else tx.objectStore(storeName).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    } catch { resolve(); }
  });
}

async function gIdbCachePhoto(id, mime, base64) {
  const db = await openGalleryDb();
  if (!db || !base64) return;
  await gIdbPut(G_IDB_PHOTOS, { id, mime, base64, at: Date.now() });
  try {
    const tx = db.transaction(G_IDB_PHOTOS, 'readwrite');
    const st = tx.objectStore(G_IDB_PHOTOS);
    const req = st.getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      if (list.length <= G_IDB_PHOTO_MAX) return;
      list.sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const old of list.slice(0, list.length - G_IDB_PHOTO_MAX)) st.delete(old.id);
    };
  } catch { /* ignore */ }
}

function invalidateGalleryCache(site = '') {
  gIdbDel(G_IDB_LISTS, 'albums');
  if (site) gIdbDel(G_IDB_LISTS, `page:${site}`);
  else gIdbDel(G_IDB_LISTS, null);
}

const albumsSig = (list) => (list || []).map((a) => `${a.site}|${a.count}|${a.latest}|${a.coverId}|${(a.cover || '').length}`).join('\n');
const pageSig = (files, total) => `${total}:${(files || []).map((f) => `${f.id}|${f.updated}|${(f.thumb || '').length}`).join('\n')}`;

// 파일 이름 '2026-10-28_WL-1_ab12cd34_1.jpg'(계측 입력) 또는 '2026-10-28_김_ab12cd34_1.jpg'(사진만 찍기)에서 계측기ID/측정자
function photoLabel(name) {
  const m = /^\d{4}-\d{2}-\d{2}_(.+)_[0-9A-Za-z]{1,8}_\d+\.\w+$/.exec(String(name || ''));
  return m ? m[1] : '';
}

// 'yyyy-MM-dd HH:mm' → '10월 28일 (화)'
function dayTitle(updated) {
  const [y, mo, d] = String(updated).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return `${mo}월 ${d}일 (${G_WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]})`;
}

function galleryNote(text) {
  $('galleryNote').textContent = text;
}

function galleryFail(err, what) {
  if (err.isAuth) { signOut(); return; }
  if (err.code === 'bad_action') { galleryNote('서버가 아직 옛 버전입니다. 관리자가 Apps Script(Code.gs)를 새 버전으로 배포하면 갤러리가 열립니다.'); return; }
  galleryNote(err.network ? `신호가 약해 ${what}을 불러오지 못했습니다. 신호가 잡히면 다시 열어 주세요.` : `${what}을 불러오지 못했습니다: ${err.message}`);
}

// ---------- 앨범 ----------

async function loadGallery() {
  showAlbums();
  const my = ++gallery.seq;
  galleryNote('앨범을 불러오는 중...');
  let freshDone = false;
  let shownCached = null;
  // 지난번 앨범 목록을 폰(IndexedDB)에서 먼저 띄우고, 뒤에서 최신 목록을 받아 바뀐 것만 반영한다
  gIdbGet(G_IDB_LISTS, 'albums').then((cached) => {
    if (freshDone || my !== gallery.seq || !cached?.albums?.length) return;
    shownCached = cached.albums;
    renderAlbums(cached.albums);
    galleryNote(`현장 앨범 ${cached.albums.length}개 · 새 사진 확인 중...`);
  });
  try {
    const res = await api('photo_albums', {}, { timeoutMs: 45000 });
    if (my !== gallery.seq) return;
    freshDone = true;
    const albums = res.albums || [];
    gIdbPut(G_IDB_LISTS, { key: 'albums', albums, at: Date.now() });
    if (!shownCached || albumsSig(albums) !== albumsSig(shownCached)) renderAlbums(albums);
    else galleryNote(albums.length ? `현장 앨범 ${albums.length}개 · 앨범을 누르면 사진이 열립니다` : '아직 올린 사진이 없습니다. 📷 찍기에서 사진을 올리면 현장별 앨범이 생깁니다.');
  } catch (err) {
    if (my !== gallery.seq) return;
    if (shownCached) galleryNote(`신호가 약해 이전에 불러온 앨범(${shownCached.length}개)을 표시합니다.`);
    else galleryFail(err, '앨범');
  }
}

function showAlbums() {
  gallery.site = '';
  gallery.loading = false;
  $('galleryTitle').textContent = '갤러리';
  show($('galleryAlbums'), true);
  show($('galleryPhotos'), false);
  show($('galleryMore'), false);
}

function renderAlbums(albums) {
  galleryNote(albums.length ? `현장 앨범 ${albums.length}개 · 앨범을 누르면 사진이 열립니다` : '아직 올린 사진이 없습니다. 📷 찍기에서 사진을 올리면 현장별 앨범이 생깁니다.');
  $('galleryAlbums').replaceChildren(...albums.map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'g-album';
    const cover = document.createElement('div');
    cover.className = 'cover';
    if (a.cover) cover.style.backgroundImage = gThumbUrl(a.cover);
    else cover.textContent = '🖼';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.site;
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = `${a.count.toLocaleString('ko-KR')}장 · ${String(a.latest).slice(5, 10).replace('-', '/')}`;
    btn.append(cover, name, count);
    btn.addEventListener('click', () => openAlbum(a.site));
    return btn;
  }));
}

// ---------- 사진 그리드 ----------

function openAlbum(site) {
  history.pushState({ gallery: 'album' }, '');   // 안드로이드 뒤로가기 → 앨범 목록으로
  gallery.site = site;
  gallery.files = [];
  gallery.total = 0;
  gallery.loading = false;
  gallery.seq += 1;
  $('galleryTitle').textContent = site;
  show($('galleryAlbums'), false);
  show($('galleryPhotos'), true);
  show($('galleryMore'), false);
  $('galleryPhotos').replaceChildren();
  window.scrollTo(0, 0);
  loadMorePhotos();
}

async function loadMorePhotos() {
  if (gallery.loading || !gallery.site || (gallery.total && gallery.files.length >= gallery.total)) return;
  gallery.loading = true;
  const my = gallery.seq;
  const site = gallery.site;
  const offset = gallery.files.length;
  galleryNote('사진을 불러오는 중...');
  let freshDone = false;
  let shownCached = null;
  if (offset === 0) {
    gIdbGet(G_IDB_LISTS, `page:${site}`).then((cached) => {
      if (freshDone || my !== gallery.seq || !cached?.files?.length || gallery.files.length) return;
      shownCached = cached;
      gallery.files = cached.files.slice();
      gallery.total = cached.total || cached.files.length;
      appendPhotoTiles(0);
      galleryNote(`사진 ${gallery.total.toLocaleString('ko-KR')}장 · 새 사진 확인 중...`);
      show($('galleryMore'), gallery.files.length < gallery.total);
    });
  }
  try {
    const res = await api('photo_page', { site, offset }, { timeoutMs: 45000 });
    if (my !== gallery.seq) return;
    freshDone = true;
    const freshFiles = res.files || [];
    const freshTotal = res.total || 0;
    if (offset === 0) {
      gIdbPut(G_IDB_LISTS, { key: `page:${site}`, total: freshTotal, files: freshFiles, at: Date.now() });
      const sameAsCache = shownCached && pageSig(shownCached.files, shownCached.total) === pageSig(freshFiles, freshTotal);
      if (!sameAsCache) {
        if (shownCached) $('galleryPhotos').replaceChildren();
        gallery.files = [...freshFiles];
        gallery.total = freshTotal;
        appendPhotoTiles(0);
      }
    } else {
      const start = gallery.files.length;
      gallery.files.push(...freshFiles);
      gallery.total = freshTotal;
      appendPhotoTiles(start);
    }
    galleryNote(gallery.total ? `사진 ${gallery.total.toLocaleString('ko-KR')}장` : '이 앨범에 사진이 없습니다.');
    show($('galleryMore'), gallery.files.length < gallery.total);
  } catch (err) {
    if (my !== gallery.seq) return;
    if (shownCached) galleryNote(`신호가 약해 이전에 불러온 사진(${shownCached.files.length}장)을 표시합니다.`);
    else galleryFail(err, '사진');
  } finally {
    if (my === gallery.seq) gallery.loading = false;
  }
}

// 새로 받은 사진을 날짜 묶음에 붙인다. 같은 날짜 묶음이 이미 있으면 그 그리드에 이어 붙인다
function appendPhotoTiles(start) {
  const box = $('galleryPhotos');
  for (let i = start; i < gallery.files.length; i += 1) {
    const f = gallery.files[i];
    const day = dayTitle(f.updated);
    let grid = box.lastElementChild;
    if (!grid || grid.dataset.day !== day) {
      const h = document.createElement('h2');
      h.className = 'g-day';
      h.textContent = day;
      grid = document.createElement('div');
      grid.className = 'g-grid';
      grid.dataset.day = day;
      box.append(h, grid);
    }
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.setAttribute('aria-label', `${photoLabel(f.name) || f.name} ${f.updated}`);
    if (f.thumb) tile.style.backgroundImage = gThumbUrl(f.thumb);
    else tile.textContent = '🖼';
    tile.addEventListener('click', () => openPhotoViewer(i));
    grid.append(tile);
  }
}

// ---------- 크게 보기 ----------

const gView = { zoom: 1, x: 0, y: 0 };

function applyZoom() {
  $('pvImg').style.transform = `translate(${gView.x}px, ${gView.y}px) scale(${gView.zoom})`;
}

function resetZoom() {
  Object.assign(gView, { zoom: 1, x: 0, y: 0 });
  applyZoom();
}

function openPhotoViewer(i) {
  history.pushState({ gallery: 'viewer' }, '');
  show($('photoViewer'), true);
  showPhoto(i);
}

function closePhotoViewer() {
  if (history.state?.gallery === 'viewer') history.back();
  else hidePhotoViewer();
}

function hidePhotoViewer() {
  show($('photoViewer'), false);
  gallery.index = -1;
}

function rememberFull(id, mime, base64) {
  if (fullCache.has(id)) return fullCache.get(id);
  const entry = { url: URL.createObjectURL(base64ToBlob(base64, mime || 'image/jpeg')), base64 };
  fullCache.set(id, entry);
  if (fullCache.size > G_FULL_CACHE_MAX) {
    const [oldId, old] = fullCache.entries().next().value;
    URL.revokeObjectURL(old.url);
    fullCache.delete(oldId);
  }
  return entry;
}

async function fullPhoto(id) {
  if (fullCache.has(id)) return fullCache.get(id);
  if (fullInflight.has(id)) return fullInflight.get(id);
  const job = (async () => {
    const cached = await gIdbGet(G_IDB_PHOTOS, id);
    if (cached?.base64) return rememberFull(id, cached.mime, cached.base64);
    const res = await api('drive_download', { fileId: id }, { timeoutMs: 60000 });
    const mime = res.mime || 'image/jpeg';
    gIdbCachePhoto(id, mime, res.base64);
    return rememberFull(id, mime, res.base64);
  })().finally(() => fullInflight.delete(id));
  fullInflight.set(id, job);
  return job;
}

async function showPhoto(i) {
  const f = gallery.files[i];
  if (!f) return;
  gallery.index = i;
  resetZoom();
  const img = $('pvImg');
  if (f.thumb) img.src = `data:${gThumbMime(f.thumb)};base64,${f.thumb}`;   // 큰 사진이 올 때까지 작은 그림을 먼저
  else img.removeAttribute('src');
  img.alt = f.name;
  $('pvCount').textContent = `${i + 1} / ${gallery.total}`;
  $('pvInfo').textContent = [photoLabel(f.name), f.updated, f.name].filter(Boolean).join(' · ');
  show($('pvPrev'), i > 0);
  show($('pvNext'), i < gallery.total - 1);
  try {
    const full = await fullPhoto(f.id);
    if (gallery.index === i) img.src = full.url;
  } catch (err) {
    if (err.isAuth) { hidePhotoViewer(); signOut(); return; }
    if (gallery.index === i) $('pvInfo').textContent = `큰 사진을 받지 못했습니다: ${err.message}`;
  }
  if (i + 1 >= gallery.files.length - 4) loadMorePhotos();   // 끝에 가까우면 다음 사진 목록을 미리
  const next = gallery.files[i + 1];
  const prev = gallery.files[i - 1];
  if (next) fullPhoto(next.id).catch(() => {});   // 앞뒤 사진을 미리 받아 넘길 때 바로 보이게
  if (prev) fullPhoto(prev.id).catch(() => {});
}

function stepPhoto(d) {
  const i = gallery.index + d;
  if (i >= 0 && i < gallery.files.length) showPhoto(i);
}

async function savePhotoToPhone() {
  const f = gallery.files[gallery.index];
  if (!f) return;
  const btn = $('pvSave');
  btn.disabled = true;
  try {
    const { base64 } = await fullPhoto(f.id);
    const bridge = window.AndroidGallery;
    if (bridge && typeof bridge.savePhoto === 'function') {
      const ok = bridge.savePhoto(base64, phoneAlbumFolder(gallery.site), f.name);
      alert(ok ? `갤러리 「계측사진/${phoneAlbumFolder(gallery.site)}」에 저장했습니다.` : '폰에 저장하지 못했습니다. 저장 공간을 확인해 주세요.');
    } else {
      downloadBlob(base64ToBlob(base64), f.name);
    }
  } catch (err) {
    alert(`사진을 받지 못했습니다: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// 한 손가락: 확대 안 했으면 좌우로 넘기기, 확대했으면 끌어서 옮기기. 두 손가락: 확대/축소. 두 번 톡: 2.5배 ↔ 원래대로
function initViewerGestures() {
  const stage = $('pvStage');
  const pts = new Map();
  let start = null;   // { x, y, vx, vy, dist, zoom, moved }
  let lastTap = 0;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const begin = () => {
    const [p] = pts.values();
    start = { x: p.x, y: p.y, vx: gView.x, vy: gView.y, dist: pts.size === 2 ? dist() : 0, zoom: gView.zoom, moved: false };
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      gView.zoom = Math.min(G_MAX_ZOOM, Math.max(1, start.zoom * (dist() / start.dist)));
      if (gView.zoom === 1) Object.assign(gView, { x: 0, y: 0 });
      start.moved = true;
      applyZoom();
    } else if (gView.zoom > 1) {
      const p = pts.get(e.pointerId);
      gView.x = start.vx + (p.x - start.x);
      gView.y = start.vy + (p.y - start.y);
      start.moved = true;
      applyZoom();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const wasPinch = pts.size === 2;
    pts.delete(e.pointerId);
    if (pts.size === 1) { begin(); start.moved = true; return; }   // 두 손가락 중 하나만 뗀 경우: 남은 손가락으로 이어서
    if (!start || wasPinch) { start = null; return; }
    const dx = e.clientX - start.x;
    if (gView.zoom === 1 && Math.abs(dx) > G_SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - start.y)) stepPhoto(dx < 0 ? 1 : -1);
    else if (!start.moved && Math.abs(dx) < 10) {
      const now = Date.now();
      if (now - lastTap < G_DOUBLE_TAP_MS) {
        if (gView.zoom > 1) resetZoom();
        else { gView.zoom = G_DOUBLE_TAP_ZOOM; applyZoom(); }
        lastTap = 0;
      } else lastTap = now;
    }
    start = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function initGallery() {
  $('galleryBack').addEventListener('click', (e) => {
    if (!gallery.site) return;   // 앨범 목록에서는 원래대로 홈으로
    e.preventDefault();
    if (history.state?.gallery === 'album') history.back();
    else loadGallery();
  });
  $('galleryMore').addEventListener('click', loadMorePhotos);
  // 맨 아래 '더 보기'가 화면에 들어오면 저절로 더 불러온다
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((list) => { if (list.some((x) => x.isIntersecting)) loadMorePhotos(); }).observe($('galleryMore'));
  }
  $('pvClose').addEventListener('click', closePhotoViewer);
  $('pvPrev').addEventListener('click', () => stepPhoto(-1));
  $('pvNext').addEventListener('click', () => stepPhoto(1));
  $('pvSave').addEventListener('click', savePhotoToPhone);
  initViewerGestures();
  window.addEventListener('popstate', () => {
    if (!$('photoViewer').classList.contains('hidden')) { if (history.state?.gallery !== 'viewer') hidePhotoViewer(); return; }
    if (gallery.site && history.state?.gallery !== 'album' && location.hash === '#gallery') loadGallery();
  });
  document.addEventListener('keydown', (e) => {
    if ($('photoViewer').classList.contains('hidden')) return;
    if (e.key === 'Escape') closePhotoViewer();
    else if (e.key === 'ArrowLeft') stepPhoto(-1);
    else if (e.key === 'ArrowRight') stepPhoto(1);
  });
}

if (typeof module !== 'undefined') module.exports = { photoLabel, dayTitle };
