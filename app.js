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
  config: { names: [], types: [], instruments: [], site: '' },
  latest: {},
  type: '',
  clientId: crypto.randomUUID(),
  statusTimer: null,
};

const FIELD_LABELS = { date: '날짜', user: '측정자', type: '계측기 종류', id: '계측기 ID', value: '측정값', memo: '메모' };
const SERVER_ERRORS = {
  bad_code: '접속 코드가 맞지 않습니다.',
  locked: '시도가 너무 많습니다. 10분 후 다시 해주세요.',
};

// ---------- helpers ----------

const show = (el, isOn) => el.classList.toggle('hidden', !isOn);

function setStatus(text, kind) {
  clearTimeout(state.statusTimer);
  const el = $('status');
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
  err.fields = data.fields;
  throw err;
}

const instrumentsOf = (type) => state.config.instruments.filter((i) => i.type === type);
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
  for (const id of ['gate', 'home', 'input']) show($(id), id === name);
  window.scrollTo(0, 0);
}

function route() {
  if (!state.config.names.length) return;
  showScreen(location.hash === '#input' ? 'input' : 'home');
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
  box.replaceChildren(...[...state.config.types, OTHER].map((type) => {
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
async function readPhoto() {
  const file = $('photo').files[0];
  if (!file) return null;
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

function clearEntryFields() {
  for (const id of ['value', 'memo', 'otherType', 'freeId', 'photo']) $(id).value = '';
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
  if (!draft || ![...state.config.types, OTHER].includes(draft.type)) return false;
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
  const { names, site } = state.config;
  $('siteName').textContent = site;
  $('user').replaceChildren(...names.map((n) => new Option(n, n)));
  const savedUser = store.get('user');
  $('user').value = names.includes(savedUser) ? savedUser : names[0];
  $('today').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  $('date').value = new Date().toLocaleDateString('sv-SE');

  renderTypes();
  if (!restoreDraft()) selectType(state.config.types[0]);
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
$('instrument').addEventListener('change', updateValueInfo);
$('value').addEventListener('input', updateValueInfo);
$('draft').addEventListener('click', saveDraft);

$('input').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('save');
  button.disabled = true;
  setStatus('저장 중...', 'ok');
  try {
    await api('save', { entry: readForm(), photo: await readPhoto() });
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

if (state.code) {
  start();
} else {
  showGate();
  hideSplash();
}
