const OTHER = '기타';
const MAX_DECIMALS = 4;
const STATUS_MS = 3000;
const SPLASH_MIN_MS = 1500; // keep the loading page up long enough to read as intentional, not a flash
const SPLASH_FADE_MS = 300;
const PHOTO_MAX_PX = 1280;
const PHOTO_QUALITY = 0.8;
const PHOTO_MAX_BYTES = 150 * 1024;
const PHOTO_MIN_QUALITY = 0.4;
const PHOTO_QUALITY_STEP = 0.1;
const PHOTO_SHRINK = 0.85;
const MAX_PHOTOS = 10;
const BUILD = new URL(document.currentScript.src).searchParams.get('v') ?? '-';
const TABBED = ['home', 'trend', 'shot', 'info'];
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a']; // categorical slots 1-3 of the dataviz palette (validated)
const SURVEY = '측량';
const MAX_SURVEY_FILES = 10;
const MAX_SURVEY_BYTES = 15 * 1024 * 1024;
const MB = 1024 * 1024;
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
  config: { names: [], sites: [], types: [], instruments: [], valueCounts: {} },
  latest: {},
  site: store.get('site') ?? '',
  type: '',
  clientId: crypto.randomUUID(),
  shotId: crypto.randomUUID(),
  statusTimer: null,
};

const FIELD_LABELS = { date: '날짜', site: '현장', user: '측정자', type: '계측기 종류', id: '계측기 ID', place: '위치', unit: '단위', value: '측정값', memo: '메모', photo: '사진', files: '파일' };
const SERVER_ERRORS = {
  bad_code: '접속 코드가 맞지 않습니다.',
  locked: '시도가 너무 많습니다. 10분 후 다시 해주세요.',
  duplicate: '이미 있습니다.',
  expired: '입력한 지 24시간이 지나 앱에서는 고칠 수 없습니다. 관리자에게 문의해 주세요.',
  forbidden: '본인이 입력한 기록만 고칠 수 있습니다.',
  not_found: '기록을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.',
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
  for (const id of ['gate', 'home', 'input', 'shot', 'trend', 'info']) show($(id), id === name);
  show($('tabbar'), TABBED.includes(name));
  for (const a of $('tabbar').children) a.setAttribute('aria-current', a.dataset.screen === name ? 'page' : 'false');
  window.scrollTo(0, 0);
}

function route() {
  if (!state.config.names.length) return;
  const name = { '#input': 'input', '#shot': 'shot', '#trend': 'trend', '#info': 'info' }[location.hash] ?? 'home';
  showScreen(name);
  if (name === 'trend') loadTrend();
  if (name === 'info') renderInfo();
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
      sub.textContent = `${r.type} · ${r.date}${r.canEdit ? ' · 눌러서 수정' : ''}`;
      meta.append(title, sub);
      li.classList.add('tap');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('click', () => openEdit(r));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEdit(r); });
      const val = document.createElement('div');
      const multi = r.values?.length > 1;
      val.className = multi ? 'val multi' : 'val';
      val.textContent = multi ? r.values.join(' / ') : String(r.value);
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
  box.replaceChildren(...[...siteTypes(), SURVEY, OTHER].map((type) => {
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

  const isSurvey = type === SURVEY;
  const list = type === OTHER || isSurvey ? [] : instrumentsOf(type);
  $('instrument').replaceChildren(...list.map((i) => new Option(i.place ? `${i.id} · ${i.place}` : i.id, i.id)));
  show($('instrumentField'), list.length > 0);
  show($('addInstrument'), !isSurvey);
  show($('otherTypeField'), type === OTHER);
  show($('freeIdField'), list.length === 0 && !isSurvey);
  // Survey files replace the value card and the photos.
  show($('surveyBox'), isSurvey);
  show($('valueCard'), !isSurvey);
  show($('photoField'), !isSurvey);
  updateValueInfo();
}

// Load cells report one value per axis: those types show several inputs, filled in order (no axis names).
const MULTI_IDS = ['mv0', 'mv1', 'mv2'];
const valueCount = (inst) => (inst && state.type !== OTHER ? state.config.valueCounts?.[inst.type] ?? 1 : 1);
const signed = (n, digits) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

function updateValueInfo() {
  const inst = selectedInstrument();
  const count = valueCount(inst);
  show($('singleRow'), count === 1);
  show($('multiRow'), count > 1);
  MULTI_IDS.forEach((id, i) => show($(id).parentElement, i < count));
  const unit = inst && state.type !== OTHER ? inst.unit : '';
  $('unit').textContent = unit;
  for (const u of document.querySelectorAll('#multiRow .unit')) u.textContent = unit;

  const last = inst && state.type !== OTHER ? state.latest[inst.id] : undefined;
  const prev = $('prev');
  if (!last) {
    prev.textContent = inst ? '전회 기록 없음' : '';
    return;
  }
  const lastValues = last.values?.length ? last.values : [last.value];
  let text = `전회 ${lastValues.slice(0, count).join(' / ')} ${unit} (${shortDate(last.date)})`;
  const raws = count > 1 ? MULTI_IDS.slice(0, count).map((id) => $(id).value.trim()) : [$('value').value.trim()];
  if (lastValues.length >= count && raws.every((r) => r !== '' && Number.isFinite(Number(r)))) {
    const deltas = raws.map((r, i) => signed(Number(r) - lastValues[i], Math.max(decimalsOf(r), decimalsOf(lastValues[i]))));
    text += ` · 변화 ${deltas.join(' / ')} ${unit}`;
  }
  prev.textContent = text;
}

function readForm() {
  const isOther = state.type === OTHER;
  const hasList = !$('instrumentField').classList.contains('hidden');
  const raw = $('value').value.trim();
  const count = hasList ? valueCount(selectedInstrument()) : 1;
  const values = count > 1 ? MULTI_IDS.slice(0, count).map((id) => ($(id).value.trim() === '' ? null : Number($(id).value))) : undefined;
  return {
    clientId: state.clientId,
    site: state.site,
    weather: weatherRecord(),
    date: $('date').value,
    user: $('user').value,
    type: isOther ? $('otherType').value.trim() : state.type,
    id: hasList ? $('instrument').value : $('freeId').value.trim(),
    value: values ? values[0] : (raw === '' ? null : Number(raw)),
    values,
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

const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

// Survey file chooser (GPS or QGIS): any file type, several at once, each removable.
function makeFilePicker(box) {
  let files = [];
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn outline small';
  button.textContent = '＋ 파일 선택';
  button.addEventListener('click', () => input.click());
  const list = document.createElement('ul');
  list.className = 'files';

  function render() {
    list.replaceChildren(...files.map((file, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = file.name;
      const size = document.createElement('small');
      size.textContent = fmtSize(file.size);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', `${file.name} 빼기`);
      x.addEventListener('click', () => { files = files.filter((_, j) => j !== i); render(); });
      li.append(name, size, x);
      return li;
    }));
  }

  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    const room = MAX_SURVEY_FILES - files.length;
    if (picked.length > room) alert(`파일은 한 칸에 ${MAX_SURVEY_FILES}개까지 올릴 수 있습니다.`);
    files = files.concat(picked.slice(0, Math.max(room, 0)));
    render();
  });

  box.append(button, input, list);
  return { files: () => files, clear: () => { files = []; render(); } };
}

const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(new Error(`'${file.name}' 파일을 읽을 수 없습니다.`));
  reader.readAsDataURL(file);
});

function surveyProblem() {
  const all = [...pickers.gps.files(), ...pickers.qgis.files()];
  if (all.length === 0) return 'GPS 파일이나 QGIS 파일을 하나 이상 선택해 주세요.';
  if (all.some((f) => f.size === 0)) return '비어 있는 파일이 있습니다. 빼고 다시 저장해 주세요.';
  if (all.reduce((sum, f) => sum + f.size, 0) > MAX_SURVEY_BYTES) return `파일 합계가 ${MAX_SURVEY_BYTES / MB}MB를 넘습니다. 나눠서 저장해 주세요.`;
  return '';
}

async function surveyPayload() {
  const files = {};
  for (const kind of ['gps', 'qgis']) {
    files[kind] = [];
    for (const f of pickers[kind].files()) files[kind].push({ name: f.name, base64: await readFileAsBase64(f) });
  }
  const entry = { clientId: state.clientId, site: state.site, date: $('date').value, user: $('user').value, memo: $('memo').value.trim() };
  return { entry, files };
}

const pickers = {};

function clearEntryFields() {
  for (const id of ['value', 'memo', 'otherType', 'freeId', ...MULTI_IDS]) $(id).value = '';
  pickers.entry.clear();
  pickers.gps.clear();
  pickers.qgis.clear();
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
    values: MULTI_IDS.map((id) => $(id).value),
    memo: $('memo').value,
    date: $('date').value,
  };
  store.set('draft', JSON.stringify(draft));
  setStatus('임시저장됨 (이 휴대폰에만 보관, 사진 제외)', 'ok');
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(store.get('draft') ?? 'null'); } catch { draft = null; }
  if (!draft || ![...siteTypes(), SURVEY, OTHER].includes(draft.type)) return false;
  selectType(draft.type);
  if ([...$('instrument').options].some((o) => o.value === draft.instrument)) $('instrument').value = draft.instrument;
  $('otherType').value = draft.otherType ?? '';
  $('freeId').value = draft.freeId ?? '';
  $('value').value = draft.value ?? '';
  MULTI_IDS.forEach((id, i) => { $(id).value = draft.values?.[i] ?? ''; });
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
function applyConfig({ sites, names, types, instruments, valueCounts }) {
  state.config = { ...state.config, sites, names, types, instruments, valueCounts };
}

function changeSite(site) {
  state.site = site;
  store.set('site', site);
  renderPeople();
  renderTypes();
  selectType(siteTypes()[0] ?? OTHER);
  refreshWeather();
}

const PEOPLE = {
  site: { label: '현장', list: () => state.config.sites, add: 'add_site', remove: 'remove_site', note: '이미 저장된 기록과 사진은 지워지지 않습니다.' },
  user: { label: '측정자', list: () => state.config.names, add: 'add_user', remove: 'remove_user', note: '이미 저장된 기록은 지워지지 않습니다.' },
};
const NAME_RULE = '이름은 100자 이하여야 하고, 쉼표(,)를 쓰거나 = + - @ 로 시작할 수 없습니다.';

function renderManage() {
  for (const [kind, p] of Object.entries(PEOPLE)) {
    const names = p.list();
    $(`${kind}List`).replaceChildren(...(names.length ? names : ['']).map((name) => {
      const li = document.createElement('li');
      if (!name) { li.className = 'empty'; li.textContent = '아직 없습니다.'; return li; }
      const text = document.createElement('span');
      text.textContent = name;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '삭제';
      del.setAttribute('aria-label', `${name} 삭제`);
      del.addEventListener('click', () => managePeople(kind, 'remove', name));
      li.append(text, del);
      return li;
    }));
  }
}

// Removing only takes the name off the list: saved records, photos and instruments stay in the sheet.
async function managePeople(kind, op, name) {
  const p = PEOPLE[kind];
  if (op === 'remove' && !confirm(`${p.label} '${name}'을(를) 목록에서 삭제할까요?\n${p.note}`)) return false;
  $('manageError').textContent = '';
  try {
    applyConfig(await api(p[op], { name }));
  } catch (err) {
    if (err.isAuth) { $('manageDialog').close(); store.remove('code'); showGate(); return false; }
    $('manageError').textContent = err.fields ? NAME_RULE : errorText(err);
    return false;
  }
  if (kind === 'site') {
    changeSite(op === 'add' ? name : state.site);
  } else {
    renderPeople();
    if (op === 'add') $('user').value = name;
    store.set('user', $('user').value);
    loadRecent().catch((err) => setStatus(err.message, 'err'));
  }
  renderManage();
  return true;
}

function openManage() {
  $('manageError').textContent = '';
  renderManage();
  $('manageDialog').showModal();
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

// ---------- info tab ----------

function renderInfo() {
  $('appVersion').textContent = `v${BUILD}`;
  $('adminInfo').textContent = state.config.admin || '등록되지 않음';
}

// ---------- trend tab (line chart of the entered values) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART = { w: 320, h: 220, left: 46, right: 30, top: 12, bottom: 28 };
const GRID_LINES = 4;
const TABLE_ROWS = 8;
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const fmt = (v) => String(Number(v.toPrecision(12))); // drops float noise such as 10.479999999

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function span(text, className) {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

// Date, then one keyed value per series: values lead, the series key is a short stroke in the series color.
function showReadout(point, unit) {
  const items = [Object.assign(document.createElement('b'), { textContent: shortDate(point.date) })];
  point.values.forEach((v, i) => {
    const wrap = document.createElement('span');
    if (point.values.length > 1) {
      const sw = span('', 'sw');
      sw.style.background = SERIES_COLORS[i];
      wrap.append(sw, `${i + 1}: `);
    }
    wrap.append(Object.assign(document.createElement('b'), { textContent: fmt(v) }));
    items.push(wrap);
  });
  if (unit) items.push(span(unit));
  $('trendRead').replaceChildren(...items);
}

function drawTrend(points, unit) {
  const svg = $('trendSvg');
  svg.replaceChildren();
  const seriesCount = Math.max(...points.map((p) => p.values.length));
  const all = points.flatMap((p) => p.values);
  let low = Math.min(...all);
  let high = Math.max(...all);
  if (low === high) { low -= 1; high += 1; }
  // Round axis ends to a 1/2/5 step so the gridline labels read as clean numbers.
  const raw = (high - low) / GRID_LINES;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12);
  const lo = Math.floor(low / step + 1e-9) * step;
  const hi = Math.ceil(high / step - 1e-9) * step;
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const t0 = dayMs(points[0].date);
  const t1 = dayMs(points[points.length - 1].date);
  const plotW = CHART.w - CHART.left - CHART.right;
  const plotH = CHART.h - CHART.top - CHART.bottom;
  const px = (p) => CHART.left + (t1 === t0 ? plotW / 2 : ((dayMs(p.date) - t0) / (t1 - t0)) * plotW);
  const py = (v) => CHART.top + ((hi - v) / (hi - lo)) * plotH;

  for (let i = 0; i <= Math.round((hi - lo) / step); i += 1) {
    const v = lo + i * step;
    svg.append(svgEl('line', { x1: CHART.left, x2: CHART.w - CHART.right, y1: py(v), y2: py(v), stroke: '#E3E8F1', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: CHART.left - 6, y: py(v) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: '#4A5568' }, v.toFixed(digits)));
  }
  const base = CHART.h - 8;
  svg.append(svgEl('text', { x: px(points[0]), y: base, 'text-anchor': t1 === t0 ? 'middle' : 'start', 'font-size': 10, fill: '#4A5568' }, shortDate(points[0].date)));
  if (t1 !== t0) svg.append(svgEl('text', { x: px(points[points.length - 1]), y: base, 'text-anchor': 'end', 'font-size': 10, fill: '#4A5568' }, shortDate(points[points.length - 1].date)));

  for (let s = 0; s < seriesCount; s += 1) {
    const mine = points.filter((p) => p.values[s] !== undefined);
    const color = SERIES_COLORS[s];
    if (mine.length > 1) {
      svg.append(svgEl('polyline', { points: mine.map((p) => `${px(p)},${py(p.values[s])}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    for (const p of mine) svg.append(svgEl('circle', { cx: px(p), cy: py(p.values[s]), r: 3, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
    // Direct label at the line end, in ink (not series color), so identity never depends on color alone.
    const end = mine[mine.length - 1];
    if (seriesCount > 1 && end) svg.append(svgEl('text', { x: px(end) + 7, y: py(end.values[s]) + 3.5, 'font-size': 11, 'font-weight': 700, fill: '#1B2A57' }, String(s + 1)));
  }

  // Hover / touch: a hairline snaps to the nearest date and the readout above lists every series there.
  const line = svgEl('line', { y1: CHART.top, y2: CHART.top + plotH, stroke: '#4A5568', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const marks = Array.from({ length: seriesCount }, (_, s) => svgEl('circle', { r: 5, fill: SERIES_COLORS[s], stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(line, ...marks);
  const pick = (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * CHART.w;
    const nearest = points.reduce((best, p) => (Math.abs(px(p) - x) < Math.abs(px(best) - x) ? p : best));
    line.setAttribute('x1', px(nearest));
    line.setAttribute('x2', px(nearest));
    line.setAttribute('visibility', 'visible');
    marks.forEach((m, s) => {
      const v = nearest.values[s];
      m.setAttribute('visibility', v === undefined ? 'hidden' : 'visible');
      if (v !== undefined) { m.setAttribute('cx', px(nearest)); m.setAttribute('cy', py(v)); }
    });
    showReadout(nearest, unit);
  };
  svg.onpointermove = pick;
  svg.onpointerdown = pick;
  showReadout(points[points.length - 1], unit);
}

function renderTrendTable(points, unit) {
  const rows = points.slice(-TABLE_ROWS).reverse();
  $('trendTable').replaceChildren(...rows.map((p) => {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('b');
    title.textContent = shortDate(p.date);
    meta.append(title);
    const val = document.createElement('div');
    val.className = p.values.length > 1 ? 'val multi' : 'val';
    val.textContent = `${p.values.map(fmt).join(' / ')} ${unit}`.trim();
    li.append(meta, val);
    return li;
  }));
}

function fillTrendSelect() {
  const select = $('trendInst');
  const wanted = select.value;
  select.replaceChildren(...siteTypes().map((type) => {
    const group = document.createElement('optgroup');
    group.label = type;
    group.append(...instrumentsOf(type).map((i) => new Option(i.place ? `${i.id} · ${i.place}` : i.id, i.id)));
    return group;
  }));
  if ([...select.options].some((o) => o.value === wanted)) select.value = wanted;
}

async function loadTrend() {
  fillTrendSelect();
  const id = $('trendInst').value;
  const note = $('trendNote');
  const clear = () => { $('trendSvg').replaceChildren(); $('trendRead').replaceChildren(); $('trendTable').replaceChildren(); };
  if (!id) { clear(); note.textContent = '이 현장에 등록된 계측기가 없습니다.'; return; }
  note.textContent = '불러오는 중...';
  try {
    const { points } = await api('series', { site: state.site, id });
    if ($('trendInst').value !== id) return; // the user picked another instrument meanwhile
    if (points.length === 0) { clear(); note.textContent = '아직 입력된 기록이 없습니다.'; return; }
    const unit = state.config.instruments.find((i) => i.id === id)?.unit ?? '';
    drawTrend(points, unit);
    renderTrendTable(points, unit);
    note.textContent = `${points.length}건 · 그래프를 누르거나 끌면 값이 보입니다.`;
  } catch (err) {
    if (err.isAuth) { store.remove('code'); showGate(); return; }
    clear();
    note.textContent = errorText(err);
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
  refreshWeather();
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
$('manage').addEventListener('click', openManage);
$('weather').addEventListener('click', pickPlace);
$('editForm').addEventListener('submit', saveEdit);
$('editDelete').addEventListener('click', removeEntry);
$('editCancel').addEventListener('click', () => $('editDialog').close());
$('openManage').addEventListener('click', openManage);
$('trendInst').addEventListener('change', loadTrend);
$('reloadApp').addEventListener('click', () => location.reload());
$('manageClose').addEventListener('click', () => $('manageDialog').close());
for (const kind of Object.keys(PEOPLE)) {
  $(`${kind}Form`).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $(`${kind}New`);
    const name = input.value.trim();
    if (name && await managePeople(kind, 'add', name)) input.value = '';
  });
}
$('addInstrument').addEventListener('click', openInstrumentDialog);
$('instCancel').addEventListener('click', () => $('instDialog').close());
$('instForm').addEventListener('submit', addInstrument);
$('shot').addEventListener('submit', saveShot);
$('instrument').addEventListener('change', updateValueInfo);
$('value').addEventListener('input', updateValueInfo);
MULTI_IDS.forEach((id, i) => {
  $(id).addEventListener('input', updateValueInfo);
  // Enter jumps to the next value; on the last one it submits as usual.
  $(id).addEventListener('keydown', (e) => {
    const next = MULTI_IDS[i + 1] && $(MULTI_IDS[i + 1]);
    if (e.key !== 'Enter' || !next || next.parentElement.classList.contains('hidden')) return;
    e.preventDefault();
    next.focus();
  });
});
$('draft').addEventListener('click', saveDraft);

$('input').addEventListener('submit', async (e) => {
  e.preventDefault();
  const isSurvey = state.type === SURVEY;
  const problem = isSurvey ? surveyProblem() : '';
  if (problem) { setStatus(problem, 'err'); return; }
  if (!isSurvey && !confirmUnusual()) return;
  const button = $('save');
  button.disabled = true;
  setStatus(isSurvey ? '파일 올리는 중... (파일이 크면 1분 정도 걸립니다)' : '저장 중...', 'ok');
  try {
    if (isSurvey) await api('survey', await surveyPayload());
    else await api('save', { entry: readForm(), photos: await readPhotos(pickers.entry.files()) });
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
pickers.gps = makeFilePicker($('gpsBox'));
pickers.qgis = makeFilePicker($('qgisBox'));

if (state.code) {
  start();
} else {
  showGate();
  hideSplash();
}
