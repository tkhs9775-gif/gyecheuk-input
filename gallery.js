// 갤러리: 클라우드 계측사진/<현장>/ 폴더를 삼성 갤러리처럼 본다.
// 앨범(현장 폴더) 바둑판 → 사진 그리드(날짜별 묶음, 내리면 더 불러옴) → 크게 보기(좌우 넘기기·두 손가락 확대·폰에 저장).
// 메타데이터(light: true)와 이미지(/thumbs, /photo_view)를 분리하고, 썸네일은 폰 IndexedDB('thumbs')에 영구 보관해
// 사진을 새로 올려도 기존 썸네일·목록을 지우지 않고 0ms 로 먼저 띄운다. 이 파일은 app.js보다 먼저 읽힌다.

const gallery = { site: '', files: [], total: 0, loading: false, index: -1, seq: 0 };
const G_FULL_CACHE_MAX = 16;   // 크게 본 사진을 몇 장까지 기억할지(메모리)
const G_THUMB_URL_MAX = 600;   // 타일 Blob URL 캐시 상한(메모리 누수 방지)
const G_IDB_NAME = 'gyecheuk_gallery';
const G_IDB_VER = 2;
const G_IDB_LISTS = 'lists';
const G_IDB_PHOTOS = 'photos';
const G_IDB_THUMBS = 'thumbs';
const G_IDB_OPT_KEY = 'opt_pending';
const G_IDB_PHOTO_MAX = 40;
const G_IDB_THUMB_MAX = 1000;
const G_COVER_PX = 240;
const G_GRID_PX = 320;
const G_VIEW_PX = 1440;
const G_COVER_BATCH = 12;
const G_TILE_BATCH = 16;
const G_OPT_TTL_MS = 90 * 1000;
const fullCache = new Map();       // fileId → { url, base64, isPreview }
const fullInflight = new Map();
const thumbUrlMap = new Map();     // `${id}:${px}` → { url, css }
const thumbMemData = new Map();    // fileId → base64 (뷰어 즉시 표시용)
const G_SWIPE_PX = 60;
const G_MAX_ZOOM = 5;
const G_DOUBLE_TAP_MS = 300;
const G_DOUBLE_TAP_ZOOM = 2.5;
const G_WEEKDAYS = '일월화수목금토';

let thumbsUnsupported = false;
let photoViewUnsupported = false;
let galleryWarmed = false;

// 구버전 Code.gs는 PNG, 새 Code.gs는 용량이 1/4 이하인 JPEG 썸네일을 내려주므로 첫 바이트(Base64 '/9j/' = JPEG)로 구분한다
const gThumbMime = (b64) => (String(b64 || '').startsWith('/9j/') ? 'image/jpeg' : (String(b64 || '').startsWith('UklG') ? 'image/webp' : 'image/png'));
function gThumbCss(key, b64) {
  if (!b64) return '';
  if (key && thumbUrlMap.has(key)) return thumbUrlMap.get(key).css;
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof base64ToBlob === 'function') {
    try {
      const url = URL.createObjectURL(base64ToBlob(b64, gThumbMime(b64)));
      const css = `url("${url}")`;
      if (key) {
        thumbUrlMap.set(key, { url, css });
        if (thumbUrlMap.size > G_THUMB_URL_MAX) {
          const [oldK, oldV] = thumbUrlMap.entries().next().value;
          thumbUrlMap.delete(oldK);
          try { URL.revokeObjectURL(oldV.url); } catch { /* ignore */ }
        }
      }
      return css;
    } catch { /* data URL 폴백 */ }
  }
  return `url("data:${gThumbMime(b64)};base64,${b64}")`;
}

let gDbPromise = null;
function openGalleryDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!gDbPromise) {
    gDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(G_IDB_NAME, G_IDB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(G_IDB_LISTS)) db.createObjectStore(G_IDB_LISTS, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(G_IDB_PHOTOS)) db.createObjectStore(G_IDB_PHOTOS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(G_IDB_THUMBS)) {
            const st = db.createObjectStore(G_IDB_THUMBS, { keyPath: 'key' });
            st.createIndex('at', 'at');
          }
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

const gThumbKey = (id, px) => `${id}:${px}`;

// 여러 ID의 썸네일을 트랜잭션 한 번으로 읽어 온다. 표지(:240)가 없으면 이미 받은 그리드 썸네일(:320)도 재사용한다
async function gThumbsGetMany(ids, px) {
  const out = {};
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return out;
  const db = await openGalleryDb();
  if (!db || !db.objectStoreNames.contains(G_IDB_THUMBS)) return out;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(G_IDB_THUMBS, 'readonly');
      const st = tx.objectStore(G_IDB_THUMBS);
      for (const id of clean) {
        const req = st.get(gThumbKey(id, px));
        req.onsuccess = () => {
          if (req.result?.data) { out[id] = req.result.data; return; }
          if (px !== G_GRID_PX) {
            const alt = st.get(gThumbKey(id, G_GRID_PX));
            alt.onsuccess = () => { if (alt.result?.data && !out[id]) out[id] = alt.result.data; };
          }
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
      tx.onabort = () => resolve(out);
    } catch { resolve(out); }
  });
}

async function gThumbsPutMany(entries) {
  const valid = (entries || []).filter((e) => e?.id && e.data);
  if (!valid.length) return;
  for (const e of valid) thumbMemData.set(e.id, e.data);
  const db = await openGalleryDb();
  if (!db || !db.objectStoreNames.contains(G_IDB_THUMBS)) return;
  const now = Date.now();
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(G_IDB_THUMBS, 'readwrite');
      const st = tx.objectStore(G_IDB_THUMBS);
      for (const e of valid) st.put({ key: gThumbKey(e.id, e.px), id: e.id, px: e.px, data: e.data, at: now });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    } catch { resolve(); }
  });
  if (Math.random() < 0.2) pruneThumbsDb(db);
}

function pruneThumbsDb(db) {
  try {
    const tx = db.transaction(G_IDB_THUMBS, 'readwrite');
    const st = tx.objectStore(G_IDB_THUMBS);
    const countReq = st.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - G_IDB_THUMB_MAX;
      if (excess <= 50) return;
      let left = excess;
      const curReq = st.index('at').openCursor();
      curReq.onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur || left <= 0) return;
        cur.delete();
        left -= 1;
        cur.continue();
      };
    };
  } catch { /* ignore */ }
}

async function gIdbCachePhoto(id, mime, base64, isPreview = false) {
  const db = await openGalleryDb();
  if (!db || !base64) return;
  await gIdbPut(G_IDB_PHOTOS, { id, mime, base64, preview: !!isPreview, at: Date.now() });
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

const albumsSig = (list) => (list || []).map((a) => `${a.site}|${a.count}|${a.latest}|${a.coverId}`).join('\n');
const pageSig = (files, total) => `${total}:${(files || []).map((f) => `${f.id}|${f.updated}`).join('\n')}`;
const compactAlbums = (list) => (list || []).map(({ site, count, latest, coverId }) => ({ site, count, latest, coverId }));
const compactFiles = (list) => (list || []).map(({ id, name, updated }) => ({ id, name, updated }));

function kstNowParts(date = new Date()) {
  try {
    const s = date.toLocaleString('sv-SE', { timeZone: typeof TZ === 'string' ? TZ : 'Asia/Seoul' }).replace('T', ' ');
    return { ymd: s.slice(0, 10), hm: s.slice(0, 16) };
  } catch {
    const iso = new Date(date.getTime() + 9 * 3600 * 1000).toISOString();
    return { ymd: iso.slice(0, 10), hm: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
  }
}

// 방금 올린 사진이 서버 목록에 반영되기 전에도 갤러리에서 즉시 보이도록 낙관적 항목을 합치고, 서버에 올라온 뒤엔 자연스럽게 바꾼다
function mergeOptimisticAlbums(serverAlbums, pendingBySite, nowMs = Date.now()) {
  const list = (serverAlbums || []).map((a) => ({ ...a }));
  const cleaned = {};
  for (const [site, entries] of Object.entries(pendingBySite || {})) {
    const active = (entries || []).filter((o) => o && nowMs - o.at <= G_OPT_TTL_MS && Array.isArray(o.items) && o.items.length);
    if (!active.length) continue;
    const idx = list.findIndex((a) => a.site === site);
    const existing = idx >= 0 ? list[idx] : null;
    const unconfirmed = active.filter((o) => !(existing && existing.latest >= o.updated && existing.count >= (o.afterCount || 0)));
    if (!unconfirmed.length) continue;
    cleaned[site] = unconfirmed;
    const addCount = unconfirmed.reduce((s, o) => s + o.items.length, 0);
    const newest = unconfirmed[unconfirmed.length - 1];
    if (existing) {
      existing.count += addCount;
      if (newest.updated > existing.latest) {
        existing.latest = newest.updated;
        existing.coverId = newest.items[0].id;
      }
    } else {
      list.push({
        site,
        count: addCount,
        latest: newest.updated,
        coverId: newest.items[0].id,
      });
    }
  }
  list.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  return { albums: list, remainingBySite: cleaned };
}

function mergeOptimisticPage(serverFiles, serverTotal, siteEntries, nowMs = Date.now()) {
  const files = [...(serverFiles || [])];
  let total = Number(serverTotal) || 0;
  const promoted = [];
  const remaining = [];
  const prefixAdds = [];
  const active = (siteEntries || []).filter((o) => o && nowMs - o.at <= G_OPT_TTL_MS && Array.isArray(o.items) && o.items.length);
  for (const opt of active) {
    const matched = files.filter((f) => String(f.name || '').includes(opt.cid8));
    if (matched.length > 0) {
      for (const f of matched) {
        const m = /_(\d+)\.\w+$/.exec(String(f.name || ''));
        const ord = m ? Number(m[1]) : 1;
        const optItem = opt.items.find((x) => x.ord === ord);
        if (optItem) promoted.push({ fromId: optItem.id, toId: f.id });
      }
      continue;
    }
    remaining.push(opt);
    prefixAdds.push(...opt.items);
  }
  if (prefixAdds.length) {
    const existingIds = new Set(files.map((f) => f.id));
    const uniqueNew = prefixAdds.filter((x) => !existingIds.has(x.id));
    files.unshift(...uniqueNew);
    total += uniqueNew.length;
  }
  return { files, total, promoted, remaining };
}

async function loadPendingOpts() {
  const rec = await gIdbGet(G_IDB_LISTS, G_IDB_OPT_KEY);
  return (rec && rec.bySite && typeof rec.bySite === 'object') ? rec.bySite : {};
}

async function savePendingOpts(bySite) {
  await gIdbPut(G_IDB_LISTS, { key: G_IDB_OPT_KEY, bySite, at: Date.now() });
}

// 사진 저장 직후 호출: 기존 캐시를 지우지 않고 새 사진 썸네일·목록만 낙관적으로 끼워 넣는다
async function optimisticGalleryPhoto(site, photos, entry = {}) {
  if (!Array.isArray(photos) || !photos.length) return;
  const albumSite = site || '현장무관';
  const { ymd, hm } = kstNowParts();
  const cid8 = String(entry.clientId || '').slice(0, 8) || Math.random().toString(36).slice(2, 10);
  const tag = String(entry.id || entry.user || 'photo').replace(/[^\w.\-가-힣]/g, '_');
  const now = Date.now();
  const items = [];
  const thumbEntries = [];
  for (let i = photos.length - 1; i >= 0; i -= 1) {
    const p = photos[i];
    if (!p?.base64) continue;
    const ord = i + 1;
    const id = `opt:${cid8}:${ord}`;
    const name = `${entry.date || ymd}_${tag}_${cid8}_${ord}.jpg`.replace(/[^\w.\-가-힣]/g, '_');
    items.push({ id, name, updated: hm, ord });
    thumbEntries.push({ id, px: G_GRID_PX, data: p.base64 });
  }
  if (!items.length) return;
  await gThumbsPutMany(thumbEntries);
  const cachedAlbums = await gIdbGet(G_IDB_LISTS, 'albums');
  const prevAlb = (cachedAlbums?.albums || []).find((a) => a.site === albumSite);
  const afterCount = (prevAlb ? prevAlb.count : 0) + items.length;
  const bySite = await loadPendingOpts();
  const list = (bySite[albumSite] || []).filter((o) => now - o.at <= G_OPT_TTL_MS && o.cid8 !== cid8);
  list.push({ cid8, items, updated: hm, afterCount, at: now });
  bySite[albumSite] = list;
  await savePendingOpts(bySite);
}

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

async function fetchThumbBatch(ids, px) {
  if (!ids.length || thumbsUnsupported) return {};
  try {
    if (typeof postWorker === 'function') {
      const w = await postWorker('/thumbs', { ids, px }).catch(() => null);
      if (w?.thumbs) {
        const rows = Object.entries(w.thumbs).filter(([, d]) => !!d).map(([id, data]) => ({ id, px, data }));
        await gThumbsPutMany(rows);
        return w.thumbs;
      }
    }
    const g = await api('photo_thumbs', { ids, px }, { timeoutMs: 25000 });
    const map = g?.thumbs || {};
    const rows = Object.entries(map).filter(([, d]) => !!d).map(([id, data]) => ({ id, px, data }));
    await gThumbsPutMany(rows);
    return map;
  } catch (err) {
    if (err?.code === 'bad_action') thumbsUnsupported = true;
    return {};
  }
}

async function fillMissingThumbs(targets, px, batchSize, applyFn, isAlive) {
  for (let i = 0; i < targets.length; i += batchSize) {
    if (!isAlive()) return;
    const chunk = targets.slice(i, i + batchSize);
    const map = await fetchThumbBatch(chunk.map((t) => t.id), px);
    if (!isAlive()) return;
    applyFn(chunk, map);
  }
}

// ---------- 앨범 ----------

async function loadGallery() {
  showAlbums();
  galleryWarmed = true;
  const my = ++gallery.seq;
  galleryNote('앨범을 불러오는 중...');
  let freshDone = false;
  let shownSig = '';
  let renderedAlbums = null;

  // 지난번 앨범 목록 + 영구 저장된 표지 썸네일을 0ms 로 먼저 띄운다
  Promise.all([gIdbGet(G_IDB_LISTS, 'albums'), loadPendingOpts()]).then(async ([cached, opts]) => {
    if (freshDone || my !== gallery.seq) return;
    const { albums: localAlbums } = mergeOptimisticAlbums(cached?.albums || [], opts);
    if (!localAlbums.length) return;
    const thumbMap = await gThumbsGetMany(localAlbums.map((a) => a.coverId), G_COVER_PX);
    if (freshDone || my !== gallery.seq) return;
    for (const a of localAlbums) if (a.cover && !thumbMap[a.coverId]) thumbMap[a.coverId] = a.cover;
    shownSig = albumsSig(localAlbums);
    renderedAlbums = renderAlbums(localAlbums, thumbMap);
    galleryNote(`현장 앨범 ${localAlbums.length}개 · 새 사진 확인 중...`);
  });

  try {
    const res = await api('photo_albums', { light: true }, { timeoutMs: 45000 });
    if (my !== gallery.seq) return;
    freshDone = true;
    const rawAlbums = res.albums || [];
    const inlineCovers = [];
    for (const a of rawAlbums) {
      if (a.cover && a.coverId) inlineCovers.push({ id: a.coverId, px: G_COVER_PX, data: a.cover });
    }
    if (inlineCovers.length) await gThumbsPutMany(inlineCovers);
    const compact = compactAlbums(rawAlbums);
    gIdbPut(G_IDB_LISTS, { key: 'albums', albums: compact, at: Date.now() });

    const opts = await loadPendingOpts();
    const { albums, remainingBySite } = mergeOptimisticAlbums(compact, opts);
    if (JSON.stringify(remainingBySite) !== JSON.stringify(opts)) savePendingOpts(remainingBySite);

    const thumbMap = await gThumbsGetMany(albums.map((a) => a.coverId), G_COVER_PX);
    if (my !== gallery.seq) return;
    const serverCoverKnown = new Set();
    for (const a of rawAlbums) {
      if ('cover' in a) {
        serverCoverKnown.add(a.coverId);
        if (a.cover && !thumbMap[a.coverId]) thumbMap[a.coverId] = a.cover;
      }
    }

    const nextSig = albumsSig(albums);
    const albumNote = albums.length ? `현장 앨범 ${albums.length}개 · 앨범을 누르면 사진이 열립니다` : '아직 올린 사진이 없습니다. 📷 찍기에서 사진을 올리면 현장별 앨범이 생깁니다.';
    if (!renderedAlbums || nextSig !== shownSig) {
      renderedAlbums = renderAlbums(albums, thumbMap, serverCoverKnown);
      galleryNote(albumNote);
    } else {
      for (const a of albums) {
        const el = renderedAlbums.get(a.site);
        if (el && thumbMap[a.coverId]) applyThumbStyle(el, a.coverId, G_COVER_PX, thumbMap[a.coverId]);
      }
      galleryNote(albumNote);
    }

    const missing = albums
      .filter((a) => a.coverId && !thumbMap[a.coverId] && !serverCoverKnown.has(a.coverId) && !String(a.coverId).startsWith('opt:'))
      .map((a) => ({ id: a.coverId, key: a.site }));
    if (missing.length) {
      fillMissingThumbs(missing, G_COVER_PX, G_COVER_BATCH, renderedAlbums, () => my === gallery.seq);
    }
  } catch (err) {
    if (my !== gallery.seq) return;
    if (renderedAlbums) galleryNote(`신호가 약해 이전에 불러온 앨범(${renderedAlbums.size}개)을 표시합니다.`);
    else galleryFail(err, '앨범');
  }
}

function applyThumbStyle(el, id, px, b64) {
  if (!b64) return;
  thumbMemData.set(id, b64);
  el.classList.remove('g-loading');
  el.textContent = '';
  el.style.backgroundImage = gThumbCss(gThumbKey(id, px), b64);
}

function fillMissingThumbs(targets, px, batchSize, elMap, isAlive) {
  return (async () => {
    for (let i = 0; i < targets.length; i += batchSize) {
      if (!isAlive()) return;
      const chunk = targets.slice(i, i + batchSize);
      const map = await fetchThumbBatch(chunk.map((t) => t.id), px);
      if (!isAlive()) return;
      for (const t of chunk) {
        const el = elMap.get(t.key);
        if (!el) continue;
        el.classList.remove('g-loading');
        if (map[t.id]) applyThumbStyle(el, t.id, px, map[t.id]);
        else if (!el.style.backgroundImage) el.textContent = '🖼';
      }
    }
  })().catch(() => {});
}

function showAlbums() {
  gallery.site = '';
  gallery.loading = false;
  $('galleryTitle').textContent = '갤러리';
  show($('galleryAlbums'), true);
  show($('galleryPhotos'), false);
  show($('galleryMore'), false);
}

function renderAlbums(albums, thumbMap = {}, knownEmptySet = null) {
  const coverEls = new Map();
  $('galleryAlbums').replaceChildren(...albums.map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'g-album';
    const cover = document.createElement('div');
    cover.className = 'cover';
    const b64 = thumbMap[a.coverId] || a.cover || '';
    if (b64) applyThumbStyle(cover, a.coverId, G_COVER_PX, b64);
    else {
      cover.textContent = '🖼';
      if (a.coverId && !knownEmptySet?.has(a.coverId) && !String(a.coverId).startsWith('opt:')) cover.classList.add('g-loading');
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.site;
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = `${a.count.toLocaleString('ko-KR')}장 · ${String(a.latest).slice(5, 10).replace('-', '/')}`;
    btn.append(cover, name, count);
    btn.addEventListener('click', () => openAlbum(a.site));
    coverEls.set(a.site, cover);
    return btn;
  }));
  return coverEls;
}

// 앱 시작 후 홈이 한가할 때 갤러리 첫 화면(앨범 메타 + 상위 8개 표지)을 조용히 받아 둔다
async function warmGallery() {
  if (galleryWarmed || navigator.onLine === false || (typeof state !== 'undefined' && !state.code)) return;
  galleryWarmed = true;
  try {
    const res = await api('photo_albums', { light: true }, { timeoutMs: 30000 });
    const albums = compactAlbums(res?.albums || []);
    if (!albums.length) return;
    await gIdbPut(G_IDB_LISTS, { key: 'albums', albums, at: Date.now() });
    const topIds = albums.slice(0, 8).map((a) => a.coverId).filter(Boolean);
    const have = await gThumbsGetMany(topIds, G_COVER_PX);
    const need = topIds.filter((id) => !have[id]);
    if (need.length) await fetchThumbBatch(need, G_COVER_PX);
  } catch { /* 백그라운드 예열은 조용히 건너뛴다 */ }
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
  let shownSig = '';
  let shownCached = false;
  const tileEls = new Map();

  if (offset === 0) {
    Promise.all([gIdbGet(G_IDB_LISTS, `page:${site}`), loadPendingOpts()]).then(async ([cached, opts]) => {
      if (freshDone || my !== gallery.seq || gallery.files.length) return;
      const { files: localFiles, total: localTotal } = mergeOptimisticPage(cached?.files || [], cached?.total || 0, opts[site] || []);
      if (!localFiles.length) return;
      const thumbMap = await gThumbsGetMany(localFiles.map((f) => f.id), G_GRID_PX);
      if (freshDone || my !== gallery.seq || gallery.files.length) return;
      for (const f of localFiles) if (f.thumb && !thumbMap[f.id]) thumbMap[f.id] = f.thumb;
      shownCached = true;
      shownSig = pageSig(localFiles, localTotal);
      gallery.files = localFiles;
      gallery.total = localTotal || localFiles.length;
      appendPhotoTiles(0, thumbMap, tileEls);
      galleryNote(`사진 ${gallery.total.toLocaleString('ko-KR')}장 · 새 사진 확인 중...`);
      show($('galleryMore'), gallery.files.length < gallery.total);
    });
  }
  try {
    const res = await api('photo_page', { site, offset, light: true }, { timeoutMs: 45000 });
    if (my !== gallery.seq) return;
    freshDone = true;
    const rawFiles = res.files || [];
    const freshTotal = res.total || 0;
    const inlineThumbs = [];
    const serverKnown = new Set();
    for (const f of rawFiles) {
      if ('thumb' in f) {
        serverKnown.add(f.id);
        if (f.thumb) inlineThumbs.push({ id: f.id, px: G_GRID_PX, data: f.thumb });
      }
    }
    if (inlineThumbs.length) await gThumbsPutMany(inlineThumbs);

    const compact = compactFiles(rawFiles);
    let finalFiles = compact;
    let finalTotal = freshTotal;
    let startIdx = 0;

    if (offset === 0) {
      gIdbPut(G_IDB_LISTS, { key: `page:${site}`, total: freshTotal, files: compact, at: Date.now() });
      const opts = await loadPendingOpts();
      const merged = mergeOptimisticPage(compact, freshTotal, opts[site] || []);
      finalFiles = merged.files;
      finalTotal = merged.total;
      if (merged.promoted.length) {
        const promoSrc = await gThumbsGetMany(merged.promoted.map((p) => p.fromId), G_GRID_PX);
        const promoWrites = merged.promoted
          .filter((p) => promoSrc[p.fromId])
          .map((p) => ({ id: p.toId, px: G_GRID_PX, data: promoSrc[p.fromId] }));
        if (promoWrites.length) await gThumbsPutMany(promoWrites);
      }
      if ((opts[site]?.length || 0) !== merged.remaining.length) {
        if (merged.remaining.length) opts[site] = merged.remaining;
        else delete opts[site];
        savePendingOpts(opts);
      }
    } else {
      startIdx = gallery.files.length;
      gallery.files.push(...compact);
      gallery.total = freshTotal;
      finalFiles = gallery.files;
      finalTotal = freshTotal;
    }

    const activeSlice = offset === 0 ? finalFiles : compact;
    const thumbMap = await gThumbsGetMany(activeSlice.map((f) => f.id), G_GRID_PX);
    if (my !== gallery.seq) return;
    for (const f of rawFiles) if (f.thumb && !thumbMap[f.id]) thumbMap[f.id] = f.thumb;

    if (offset === 0) {
      const nextSig = pageSig(finalFiles, finalTotal);
      if (!shownCached || nextSig !== shownSig) {
        if (shownCached) { $('galleryPhotos').replaceChildren(); tileEls.clear(); }
        gallery.files = [...finalFiles];
        gallery.total = finalTotal;
        appendPhotoTiles(0, thumbMap, tileEls, serverKnown);
      } else {
        for (const f of finalFiles) {
          const btn = tileEls.get(f.id);
          if (btn && thumbMap[f.id]) applyThumbStyle(btn, f.id, G_GRID_PX, thumbMap[f.id]);
        }
      }
    } else {
      appendPhotoTiles(startIdx, thumbMap, tileEls, serverKnown);
    }

    galleryNote(gallery.total ? `사진 ${gallery.total.toLocaleString('ko-KR')}장` : '이 앨범에 사진이 없습니다.');
    show($('galleryMore'), gallery.files.length < gallery.total);

    const missing = activeSlice
      .filter((f) => !thumbMap[f.id] && !serverKnown.has(f.id) && !String(f.id).startsWith('opt:'))
      .map((f) => ({ id: f.id, key: f.id }));
    if (missing.length) {
      fillMissingThumbs(missing, G_GRID_PX, G_TILE_BATCH, tileEls, () => my === gallery.seq && gallery.site === site);
    }
  } catch (err) {
    if (my !== gallery.seq) return;
    if (shownCached) galleryNote(`신호가 약해 이전에 불러온 사진(${gallery.files.length}장)을 표시합니다.`);
    else galleryFail(err, '사진');
  } finally {
    if (my === gallery.seq) gallery.loading = false;
  }
}

// 새로 받은 사진을 날짜 묶음에 붙인다. 같은 날짜 묶음이 이미 있으면 그 그리드에 이어 붙인다
function appendPhotoTiles(start, thumbMap = {}, tileEls = null, knownEmptySet = null) {
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
    const b64 = thumbMap[f.id] || f.thumb || '';
    if (b64) applyThumbStyle(tile, f.id, G_GRID_PX, b64);
    else {
      tile.textContent = '🖼';
      if (!knownEmptySet?.has(f.id) && !String(f.id).startsWith('opt:')) tile.classList.add('g-loading');
    }
    tile.addEventListener('click', () => openPhotoViewer(i));
    tileEls?.set(f.id, tile);
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

function rememberFull(id, mime, base64, isPreview = false) {
  const prev = fullCache.get(id);
  if (prev && (!prev.isPreview || isPreview)) return prev;
  if (prev) {
    try { URL.revokeObjectURL(prev.url); } catch { /* ignore */ }
    fullCache.delete(id);
  }
  const entry = { url: URL.createObjectURL(base64ToBlob(base64, mime || 'image/jpeg')), base64, isPreview: !!isPreview };
  fullCache.set(id, entry);
  if (fullCache.size > G_FULL_CACHE_MAX) {
    const [oldId, old] = fullCache.entries().next().value;
    URL.revokeObjectURL(old.url);
    fullCache.delete(oldId);
  }
  return entry;
}

async function fetchViewOrOriginal(id, requireOriginal) {
  if (!requireOriginal && !photoViewUnsupported) {
    if (typeof postWorker === 'function') {
      const w = await postWorker('/photo_view', { fileId: id, px: G_VIEW_PX }).catch(() => null);
      if (w?.base64) return { mime: w.mime || 'image/jpeg', base64: w.base64, isPreview: w.preview !== false };
    }
    try {
      const g = await api('photo_view', { fileId: id, px: G_VIEW_PX }, { timeoutMs: 30000 });
      if (g?.base64) return { mime: g.mime || 'image/jpeg', base64: g.base64, isPreview: g.preview !== false };
      photoViewUnsupported = true;   // 테스트·구형 모의 서버가 base64 없이 ok만 주면 바로 drive_download 로 전환
    } catch (err) {
      if (err?.code === 'bad_action') photoViewUnsupported = true;
      else throw err;
    }
  }
  const res = await api('drive_download', { fileId: id }, { timeoutMs: 60000 });
  return { mime: res.mime || 'image/jpeg', base64: res.base64, isPreview: false };
}

async function fullPhoto(id, requireOriginal = false) {
  if (String(id).startsWith('opt:')) {
    const m = await gThumbsGetMany([id], G_GRID_PX);
    if (m[id]) return rememberFull(id, 'image/jpeg', m[id], false);
  }
  const memHit = fullCache.get(id);
  if (memHit && (!requireOriginal || !memHit.isPreview)) return memHit;
  const inflightKey = requireOriginal ? `orig:${id}` : id;
  if (fullInflight.has(inflightKey)) return fullInflight.get(inflightKey);
  const job = (async () => {
    const cached = await gIdbGet(G_IDB_PHOTOS, id);
    if (cached?.base64 && (!requireOriginal || !cached.preview)) return rememberFull(id, cached.mime, cached.base64, !!cached.preview);
    const got = await fetchViewOrOriginal(id, requireOriginal);
    gIdbCachePhoto(id, got.mime, got.base64, got.isPreview);
    return rememberFull(id, got.mime, got.base64, got.isPreview);
  })().finally(() => fullInflight.delete(inflightKey));
  fullInflight.set(inflightKey, job);
  return job;
}

async function showPhoto(i) {
  const f = gallery.files[i];
  if (!f) return;
  gallery.index = i;
  resetZoom();
  const img = $('pvImg');
  const previewThumb = thumbMemData.get(f.id) || f.thumb || '';
  if (previewThumb) img.src = `data:${gThumbMime(previewThumb)};base64,${previewThumb}`;   // 큰 사진이 올 때까지 작은 그림을 먼저
  else img.removeAttribute('src');
  img.alt = f.name;
  $('pvCount').textContent = `${i + 1} / ${gallery.total}`;
  $('pvInfo').textContent = [photoLabel(f.name), f.updated, f.name].filter(Boolean).join(' · ');
  show($('pvPrev'), i > 0);
  show($('pvNext'), i < gallery.total - 1);
  try {
    const full = await fullPhoto(f.id, false);
    if (gallery.index === i) img.src = full.url;
  } catch (err) {
    if (err.isAuth) { hidePhotoViewer(); signOut(); return; }
    if (gallery.index === i) $('pvInfo').textContent = `큰 사진을 받지 못했습니다: ${err.message}`;
  }
  if (i + 1 >= gallery.files.length - 4) loadMorePhotos();   // 끝에 가까우면 다음 사진 목록을 미리
  const next = gallery.files[i + 1];
  const prev = gallery.files[i - 1];
  if (next) fullPhoto(next.id, false).catch(() => {});   // 앞뒤 사진을 미리 받아 넘길 때 바로 보이게
  if (prev) fullPhoto(prev.id, false).catch(() => {});
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
    const { base64 } = await fullPhoto(f.id, true);
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

if (typeof window !== 'undefined') {
  window.warmGallery = warmGallery;
  window.optimisticGalleryPhoto = optimisticGalleryPhoto;
}
if (typeof module !== 'undefined') {
  module.exports = { photoLabel, dayTitle, albumsSig, pageSig, mergeOptimisticAlbums, mergeOptimisticPage };
}
