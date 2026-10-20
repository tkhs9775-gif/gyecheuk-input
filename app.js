const OTHER = '기타';
const MAX_DECIMALS = 4;
const STATUS_MS = 3000;
const SPLASH_MIN_MS = 800; // keep the loading page up long enough to read as intentional, not a flash
const SPLASH_FADE_MS = 300;
const PHOTO_MAX_PX = 1280;
const PHOTO_QUALITY = 0.8;
const PHOTO_MAX_BYTES = 150 * 1024;
const PHOTO_MIN_QUALITY = 0.4;
const PHOTO_QUALITY_STEP = 0.1;
const PHOTO_SHRINK = 0.85;
const MAX_PHOTOS = 10;
const $ = (id) => document.getElementById(id);
const openedAt = Date.now();

// localStorage can throw (private mode, blocked data): the app must still work without it.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const state = {
  code: store.get('code') ?? '',
  config: { names: [], sites: [], types: [], instruments: [] },
  latest: {},
  site: store.get('site') ?? '',
  type: '',
  clientId: crypto.randomUUID(),
  shotId: crypto.randomUUID(),
  statusTimer: null,
};

const FIELD_LABELS = { date: '날짜', site: '현장', user: '측정자', type: '계측기 종류', id: '계측기 ID', place: '위치', unit: '단위', value: '측정값', memo: '메모', photo: '사진' };
const SERVER_ERRORS = {
  bad_code: '접속 코드가 맞지 않습니다.',
  locked: '시도가 너무 많습니다. 10분 후 다시 해주세요.',
  duplicate: '이미 있습니다.',
};

// ---------- helpers ----------

const show = (el, isOn) => el.classList.toggle('hidden', !isOn);

function setStatus(text, kind, id = 'status') {
  clearTimeout(state.statusTimer);
  const el = $(id);
  el.textContent = text;
  el.className = kind;
  if (kind === 'ok') state.statusTimer = setTimeout(() => { el.className = ''; }, STATUS_MS);
}

// One POST per call. A string body keeps it a "simple" request, so the browser skips the CORS preflight Apps Script cannot answer.
async function api(action, payload = {}) {
  const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ code: state.code, action, ...payload }) });
  let data;
  try { data = await res.json(); } catch { throw new Error('서버 응답을 읽을 수 없습니다.'); }
  if (data.ok) return data;
  const err = new Error(SERVER_ERRORS[data.error] ?? '서버 오류');
  err.isAuth = data.error === 'bad_code';
  err.code = data.error;
  err.fields = data.fields;
  throw err;
}

// An instrument with no site is shared by every site.
const siteInstruments = () => state.config.instruments.filter((i) => !i.site || i.site === state.site);
const siteTypes = () => [...new Set(siteInstruments().map((i) => i.type))];
const instrumentsOf = (type) => siteInstruments().filter((i) => i.type === type);
const selectedInstrument = () => state.config.instruments.find((i) => i.id === $('instrument').value);
const decimalsOf = (n) => Math.min((String(n).split('.')[1] ?? '').length, MAX_DECIMALS);
const shortDate = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

// ---------- loading page ----------

async function hideSplash() {
  const wait = SPLASH_MIN_MS - (Date.now() - openedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const splash = $('splash');
  splash.classList.add('leaving');
  setTimeout(() => show(splash, false), SPLASH_FADE_MS);
}

function showSplashError(message) {
  const splash = $('splash');
  splash.classList.remove('leaving');
  show(splash, true);
  $('splashMessage').textContent = message;
  show($('splashLoading'), false);
  show($('splashError'), true);
}

function showSplashLoading() {
  show($('splashError'), false);
  show($('splashLoading'), true);
}

// ---------- screens ----------

function showScreen(name) {
  for (const id of ['gate', 'home', 'input', 'shot']) show($(id), id === name);
  window.scrollTo(0, 0);
}

function route() {
  if (!state.config.names.length) return;
  showScreen({ '#input': 'input', '#shot': 'shot' }[location.hash] ?? 'home');
}

function showGate() {
  showScreen('gate');
}

// ---------- recent list ----------

function renderRecent(rows) {
  for (const id of ['recentHome', 'recentInput']) {
    const ul = $(id);
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '아직 입력한 내역이 없습니다.';
      ul.replaceChildren(li);
      continue;
    }
    ul.replaceChildren(...rows.map((r) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('b');
      title.textContent = r.id;
      const sub = document.createElement('small');
      sub.textContent = `${r.type} · ${r.date}`;
      meta.append(title, sub);
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = String(r.value);
      li.append(meta, val);
      return li;
    }));
  }
}

async function loadRecent() {
  const user = $('user').value;
  if (!user) return;
  renderRecent((await api('recent', { user })).rows);
}

async function loadLatest() {
  state.latest = (await api('latest')).latest;
  updateValueInfo();
}

// ---------- input form ----------

function renderTypes() {
  const box = $('types');
  box.replaceChildren(...[...siteTypes(), OTHER].map((type) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = type;
    b.dataset.type = type;
    b.addEventListener('click', () => selectType(type));
    return b;
  }));
}

function selectType(type) {
  state.type = type;
  for (const b of $('types').children) b.setAttribute('aria-pressed', String(b.dataset.type === type));

  const list = type === OTHER ? [] : instrumentsOf(type);
  $('instrument').replaceChildren(...list.map((i) => new Option(i.place ? `${i.id} · ${i.place}` : i.id, i.id)));
  show($('instrumentField'), list.length > 0);
  show($('otherTypeField'), type === OTHER);
  show($('freeIdField'), list.length === 0);
  updateValueInfo();
}

function updateValueInfo() {
  const inst = selectedInstrument();
  const unit = inst && state.type !== OTHER ? inst.unit : '';
  $('unit').textContent = unit;

  const last = inst && state.type !== OTHER ? state.latest[inst.id] : undefined;
  const prev = $('prev');
  if (!last) {
    prev.textContent = inst ? '전회 기록 없음' : '';
    return;
  }
  let text = `전회 ${last.value} ${unit} (${shortDate(last.date)})`;
  const raw = $('value').value.trim();
  if (raw !== '' && Number.isFinite(Number(raw))) {
    const delta = Number(raw) - last.value;
    const digits = Math.max(decimalsOf(raw), decimalsOf(last.value));
    text += ` · 변화 ${delta > 0 ? '+' : ''}${delta.toFixed(digits)} ${unit}`;
  }
  prev.textContent = text;
}

function readForm() {
  const isOther = state.type === OTHER;
  const hasList = !$('instrumentField').classList.contains('hidden');
  const raw = $('value').value.trim();
  return {
    clientId: state.clientId,
    site: state.site,
    date: $('date').value,
    user: $('user').value,
    type: isOther ? $('otherType').value.trim() : state.type,
    id: hasList ? $('instrument').value : $('freeId').value.trim(),
    value: raw === '' ? null : Number(raw),
    memo: $('memo').value.trim(),
  };
}

// Phone photos are several MB; shrink to <= PHOTO_MAX_BYTES so a weak signal can still send them.
// Lower quality first; if still too big at the floor, shrink the pixels and start over.
async function compressPhoto(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('사진을 읽을 수 없습니다. 다른 사진을 고르세요.'); }
  let scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  for (;;) {
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (let q = PHOTO_QUALITY; q >= PHOTO_MIN_QUALITY - 1e-9; q -= PHOTO_QUALITY_STEP) {
      const base64 = canvas.toDataURL('image/jpeg', q).split(',')[1];
      if (base64.length * 0.75 <= PHOTO_MAX_BYTES) return { base64 };
    }
    scale *= PHOTO_SHRINK;
  }
}

// One at a time: compressing several full-size phone photos in parallel can exhaust memory.
async function readPhotos(files) {
  const photos = [];
  for (const file of files) photos.push(await compressPhoto(file));
  return photos;
}

// Photo chooser: camera button (one shot per tap, tap again for more) + gallery/file button (many at once).
// The browser's own picker is what asks the phone for storage/gallery access; a web page cannot request it directly.
function makePicker(box) {
  let files = [];
  const thumbs = document.createElement('ul');
  thumbs.className = 'thumbs';

  const button = (text, input) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn outline small';
    b.textContent = text;
    b.addEventListener('click', () => input.click());
    return b;
  };
  const makeInput = (extra) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    Object.assign(input, extra);
    input.addEventListener('change', () => {
      add([...input.files]);
      input.value = '';
    });
    return input;
  };
  const cam = makeInput({});
  cam.setAttribute('capture', 'environment');
  const gallery = makeInput({ multiple: true });

  function add(picked) {
    const room = MAX_PHOTOS - files.length;
    if (picked.length > room) alert(`사진은 한 번에 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`);
    files = files.concat(picked.slice(0, Math.max(room, 0)));
    render();
  }

  function render() {
    for (const img of thumbs.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    thumbs.replaceChildren(...files.map((file, i) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.alt = file.name;
      img.src = URL.createObjectURL(file);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', '사진 빼기');
      x.addEventListener('click', () => { files = files.filter((_, j) => j !== i); render(); });
      li.append(img, x);
      return li;
    }));
  }

  const row = document.createElement('div');
  row.className = 'row';
  row.append(button('📷 촬영', cam), button('🖼 갤러리·파일', gallery));
  box.append(row, cam, gallery, thumbs);
  return { files: () => files, clear: () => { files = []; render(); } };
}

const pickers = {};

function clearEntryFields() {
  for (const id of ['value', 'memo', 'otherType', 'freeId']) $(id).value = '';
  pickers.entry.clear();
  updateValueInfo();
}

// ---------- draft (this phone only) ----------

function saveDraft() {
  const draft = {
    type: state.type,
    instrument: $('instrument').value,
    otherType: $('otherType').value,
    freeId: $('freeId').value,
    value: $('value').value,
    memo: $('memo').value,
    date: $('date').value,
  };
  store.set('draft', JSON.stringify(draft));
  setStatus('임시저장됨 (이 휴대폰에만 보관, 사진 제외)', 'ok');
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(store.get('draft') ?? 'null'); } catch { draft = null; }
  if (!draft || ![...siteTypes(), OTHER].includes(draft.type)) return false;
  selectType(draft.type);
  if ([...$('instrument').options].some((o) => o.value === draft.instrument)) $('instrument').value = draft.instrument;
  $('otherType').value = draft.otherType ?? '';
  $('freeId').value = draft.freeId ?? '';
  $('value').value = draft.value ?? '';
  $('memo').value = draft.memo ?? '';
  if (draft.date) $('date').value = draft.date;
  updateValueInfo();
  return true;
}

// ---------- sites, people, instruments ----------

function errorText(err) {
  if (err.fields) return '확인해 주세요: ' + err.fields.map((f) => FIELD_LABELS[f] ?? f).join(', ');
  return err.message === 'Failed to fetch' ? '인터넷 연결을 확인하세요.' : err.message;
}

function fillSelect(el, items, wanted) {
  el.replaceChildren(...items.map((n) => new Option(n, n)));
  el.value = items.includes(wanted) ? wanted : (items[0] ?? '');
}

function renderPeople() {
  const { names, sites, types } = state.config;
  fillSelect($('site'), sites, state.site);
  state.site = $('site').value;
  fillSelect($('user'), names, $('user').value || store.get('user'));
  $('shotSite').replaceChildren(new Option('현장 무관', ''), ...sites.map((s) => new Option(s, s)));
  $('shotSite').value = state.site;
  $('typeList').replaceChildren(...types.map((t) => new Option(t)));
}

// The add_* replies carry the refreshed lists.
function applyConfig({ sites, names, types, instruments }) {
  state.config = { sites, names, types, instruments };
}

function changeSite(site) {
  state.site = site;
  store.set('site', site);
  renderPeople();
  renderTypes();
  selectType(siteTypes()[0] ?? OTHER);
}

async function addName(action, label) {
  const name = prompt(`추가할 ${label} 이름`)?.trim();
  if (!name) return;
  try {
    applyConfig(await api(action, { name }));
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    alert(err.fields ? '이름은 100자 이하여야 하고, 쉼표(,)를 쓰거나 = + - @ 로 시작할 수 없습니다.' : errorText(err));
    return;
  }
  if (action === 'add_site') {
    changeSite(name);
    return;
  }
  renderPeople();
  $('user').value = name;
  store.set('user', name);
  loadRecent().catch((err) => setStatus(err.message, 'err'));
}

// Only takes the site off the list: saved records, photos and instruments stay in the sheet.
async function removeSite() {
  const site = state.site;
  if (!site) return;
  if (!confirm(`'${site}' 현장을 목록에서 삭제할까요?\n이미 저장된 기록과 사진은 지워지지 않습니다.`)) return;
  try {
    applyConfig(await api('remove_site', { name: site }));
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    alert(errorText(err));
    return;
  }
  changeSite('');
}

async function removeUser() {
  const name = $('user').value;
  if (!name) return;
  if (!confirm(`'${name}' 측정자를 목록에서 삭제할까요?\n이미 저장된 기록은 지워지지 않습니다.`)) return;
  try {
    applyConfig(await api('remove_user', { name }));
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    alert(errorText(err));
    return;
  }
  store.remove('user');
  renderPeople();
  loadRecent().catch((err) => setStatus(err.message, 'err'));
}

function openInstrumentDialog() {
  $('instSite').textContent = state.site ? `${state.site} 현장에 추가됩니다.` : '';
  $('iType').value = state.type !== OTHER ? state.type : '';
  $('instError').textContent = '';
  $('instDialog').showModal();
}

async function addInstrument(e) {
  e.preventDefault();
  const item = {
    site: state.site,
    id: $('iId').value.trim(),
    place: $('iPlace').value.trim(),
    type: $('iType').value.trim(),
    unit: $('iUnit').value.trim(),
  };
  try {
    applyConfig(await api('add_instrument', { item }));
  } catch (err) {
    if (err.isAuth) { $('instDialog').close(); store.remove('code'); showGate(); return; }
    $('instError').textContent = errorText(err);
    return;
  }
  $('instDialog').close();
  for (const id of ['iId', 'iPlace', 'iUnit']) $(id).value = '';
  renderPeople();
  renderTypes();
  selectType(item.type);
  $('instrument').value = item.id;
  updateValueInfo();
}

// Photo without a measurement: any site, or none.
async function saveShot(e) {
  e.preventDefault();
  const status = (text, kind) => setStatus(text, kind, 'shotStatus');
  if (pickers.shot.files().length === 0) { status('사진을 먼저 고르거나 찍어 주세요.', 'err'); return; }
  const button = $('shotSave');
  button.disabled = true;
  status('저장 중...', 'ok');
  try {
    const entry = { clientId: state.shotId, site: $('shotSite').value, user: $('user').value, memo: $('shotMemo').value.trim() };
    await api('photo', { entry, photos: await readPhotos(pickers.shot.files()) });
    status('저장됨 ✓', 'ok');
    state.shotId = crypto.randomUUID();
    pickers.shot.clear();
    $('shotMemo').value = '';
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    status(`저장 실패: ${errorText(err)} 입력한 내용은 그대로 있습니다. 다시 저장을 눌러주세요.`, 'err');
  } finally {
    button.disabled = false;
  }
}

// ---------- start ----------

async function start() {
  showSplashLoading();
  try {
    state.config = await api('config');
  } catch (err) {
    if (!err.isAuth) {
      // Offline or server down: keep the saved code and let the user retry.
      const reason = err.message === 'Failed to fetch' ? '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.' : err.message;
      showSplashError(reason);
      return;
    }
    store.remove('code');
    showGate();
    hideSplash();
    alert(err.message);
    return;
  }
  renderPeople();
  $('today').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  $('date').value = new Date().toLocaleDateString('sv-SE');

  renderTypes();
  if (!restoreDraft()) selectType(siteTypes()[0] ?? OTHER);
  route();
  try {
    await Promise.all([loadRecent(), loadLatest()]);
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    await hideSplash();
  }
}

// ---------- events ----------

$('gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.code = $('code').value;
  store.set('code', state.code);
  start();
});

$('retry').addEventListener('click', start);
window.addEventListener('hashchange', route);
$('user').addEventListener('change', () => { store.set('user', $('user').value); loadRecent().catch((err) => setStatus(err.message, 'err')); });
$('site').addEventListener('change', () => changeSite($('site').value));
$('addSite').addEventListener('click', () => addName('add_site', '현장'));
$('addUser').addEventListener('click', () => addName('add_user', '측정자'));
$('removeSite').addEventListener('click', removeSite);
$('removeUser').addEventListener('click', removeUser);
$('addInstrument').addEventListener('click', openInstrumentDialog);
$('instCancel').addEventListener('click', () => $('instDialog').close());
$('instForm').addEventListener('submit', addInstrument);
$('shot').addEventListener('submit', saveShot);
$('instrument').addEventListener('change', updateValueInfo);
$('value').addEventListener('input', updateValueInfo);
$('draft').addEventListener('click', saveDraft);

$('input').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('save');
  button.disabled = true;
  setStatus('저장 중...', 'ok');
  try {
    await api('save', { entry: readForm(), photos: await readPhotos(pickers.entry.files()) });
    setStatus('저장됨 ✓', 'ok');
    state.clientId = crypto.randomUUID();
    store.remove('draft');
    clearEntryFields();
    await Promise.all([loadRecent(), loadLatest()]);
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    if (err.fields) {
      setStatus('확인해 주세요: ' + err.fields.map((f) => FIELD_LABELS[f] ?? f).join(', '), 'err');
      return;
    }
    const reason = err.message === 'Failed to fetch' ? '인터넷 연결을 확인하세요.' : err.message;
    setStatus(`저장 실패: ${reason} 입력한 값은 그대로 있습니다. 다시 저장을 눌러주세요.`, 'err');
  } finally {
    button.disabled = false;
  }
});

pickers.entry = makePicker($('photoBoxEntry'));
pickers.shot = makePicker($('photoBoxShot'));

if (state.code) {
  start();
} else {
  showGate();
  hideSplash();
}
