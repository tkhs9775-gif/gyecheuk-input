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
const PHOTO_MIN_PX = 320;  // 이보다 작게는 줄이지 않는다(알아볼 수 없음)
const MAX_PHOTOS = 50;   // 서버(Code.gs) MAX_PHOTOS와 같다
const DRAFT_DELAY_MS = 500;
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const BYTES_PER_MS = 15;   // 느린 신호를 초당 약 15KB로 보고 시간 제한을 잡는다
const BUILD = new URL(document.currentScript.src).searchParams.get('v') ?? '-';
const TABBED = ['home', 'drawing', 'shot', 'gallery', 'info'];
const TZ = 'Asia/Seoul';   // 서버(Code.gs)가 날짜를 한국 시간으로 해석하므로 폰 시간대와 무관하게 맞춘다
const SURVEY = '측량';
const ISSUE_KINDS = ['', '파손', '망실', '접근 불가', '작동 불량'];
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
  issue: '',
  clientId: crypto.randomUUID(),
  shotId: crypto.randomUUID(),
  ready: false,   // 설정을 받아 화면을 그릴 수 있게 된 뒤에만 주소(#)에 따라 화면을 바꾼다
};

const FIELD_LABELS = { date: '날짜', site: '현장', user: '측정자', type: '계측기 종류', id: '계측기 ID', place: '위치', unit: '단위', value: '측정값', issue: '이상 상태', memo: '메모', photo: '사진', files: '파일', clientId: '입력 번호', fileId: '파일', subdir: '폴더', data: '야장 메모(너무 큼)', base64: '이미지' };
const SERVER_ERRORS = {
  bad_code: '접속 코드가 맞지 않습니다.',
  locked: '시도가 너무 많습니다. 10분 후 다시 해주세요.',
  duplicate: '이미 있습니다.',
  expired: '입력한 지 24시간이 지나 앱에서는 고칠 수 없습니다. 관리자에게 문의해 주세요.',
  forbidden: '본인이 입력한 기록만 고칠 수 있습니다.',
  not_found: '기록을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.',
  invalid: '입력 내용을 확인해 주세요.',
  server: '서버가 잠시 바쁩니다. 잠시 후 다시 시도해 주세요.',
  bad_action: '앱과 서버 버전이 맞지 않습니다. 정보 탭에서 새로고침해 주세요.',
};

// ---------- helpers ----------

const show = (el, isOn) => el.classList.toggle('hidden', !isOn);

// 상태 줄은 칸마다(#status, #shotStatus) 따로 지워진다
const statusTimers = {};
function setStatus(text, kind, id = 'status') {
  clearTimeout(statusTimers[id]);
  const el = $(id);
  el.textContent = text;
  el.className = kind;
  if (kind === 'ok') statusTimers[id] = setTimeout(() => { el.className = ''; }, STATUS_MS);
}

// 요청이 진행되는 동안 scope 안의 버튼을 모두 잠근다: 두 번 눌러도 요청은 한 번, 눌린 상태가 눈에 보인다
async function withBusy(scope, work) {
  const buttons = [...scope.querySelectorAll('button')].filter((b) => !b.disabled);
  for (const b of buttons) b.disabled = true;
  scope.setAttribute('aria-busy', 'true');
  try {
    return await work();
  } finally {
    for (const b of buttons) b.disabled = false;
    scope.removeAttribute('aria-busy');
  }
}

// 접속 코드가 틀렸을 때: 열린 창을 닫고 코드를 지워 자동 전송(보관함)이 틀린 코드로 계속 시도해 서버를 잠그지 않게 한다
function signOut() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  store.remove('code');
  state.code = '';
  showGate();
}

const networkError = (message) => Object.assign(new Error(message), { network: true });

// One POST per call. A string body keeps it a "simple" request, so the browser skips the CORS preflight Apps Script cannot answer.
// Network trouble (offline, timeout, non-JSON page) is flagged err.network so callers can keep the input and retry later.
// The time limit grows with the body size: a slow signal needs longer for photos and survey files.
async function api(action, payload = {}) {
  const body = JSON.stringify({ code: state.code, action, ...payload });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, body.length / BYTES_PER_MS)));
  let data;
  try {
    const res = await fetch(API_URL, { method: 'POST', body, signal: ctl.signal });
    try { data = await res.json(); } catch { data = null; }
    // Apps Script answers JSON even for its own errors; an HTML page (sign-in, quota, broken deployment) is not a verdict on the input.
    if (!data || typeof data !== 'object') throw networkError('서버 응답이 올바르지 않습니다(배포 확인).');
  } catch (err) {
    if (err.network) throw err;
    throw networkError(err.name === 'AbortError' ? '서버 응답이 없어 중단했습니다. 신호를 확인하세요.' : '인터넷 연결을 확인하세요.');
  } finally {
    clearTimeout(timer);
  }
  if (data.ok) {
    announceSaved(action, payload, data);
    return data;
  }
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
const todayKst = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });

// ---------- loading page ----------

let splashHideTimer = null;

async function hideSplash() {
  const wait = SPLASH_MIN_MS - (Date.now() - openedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const splash = $('splash');
  splash.classList.add('leaving');
  splashHideTimer = setTimeout(() => show(splash, false), SPLASH_FADE_MS);
}

// 접속 코드를 다시 넣거나 다시 시도할 때도 같은 로딩 화면이 보인다
function showSplashLoading() {
  clearTimeout(splashHideTimer);
  const splash = $('splash');
  splash.classList.remove('leaving');
  show(splash, true);
  show($('splashError'), false);
  show($('splashLoading'), true);
}

function showSplashError(message) {
  showSplashLoading();
  $('splashMessage').textContent = message;
  show($('splashLoading'), false);
  show($('splashError'), true);
}

// ---------- screens ----------

function showScreen(name) {
  for (const id of ['gate', 'home', 'input', 'shot', 'gallery', 'drawing', 'info']) show($(id), id === name);
  show($('tabbar'), TABBED.includes(name));
  for (const a of $('tabbar').children) a.setAttribute('aria-current', a.dataset.screen === (name === 'gallery' ? 'shot' : name) ? 'page' : 'false');
  window.scrollTo(0, 0);
}

function route() {
  if (!state.ready) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();   // 안드로이드 뒤로가기(주소 이동)로 화면이 바뀌면 떠 있던 창도 닫는다
  const name = { '#input': 'input', '#shot': 'shot', '#gallery': 'gallery', '#drawing': 'drawing', '#info': 'info' }[location.hash] ?? 'home';
  hidePhotoViewer();
  showScreen(name);
  if (name === 'drawing') loadDrawingTab();
  if (name === 'info') renderInfo();
  if (name === 'gallery') loadGallery();
}

function showGate() {
  showScreen('gate');
  $('code').focus();
}

// ---------- recent list ----------

function renderRecent(rows, emptyText = '아직 입력한 내역이 없습니다. 아래 「계측·측량 입력」에서 시작해 주세요.') {
  for (const id of ['recentHome', 'recentInput']) {
    const ul = $(id);
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyText;
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
      if (r.issue) {
        val.className = 'val issue';
        val.textContent = `⚠ ${r.issue}`;
      } else {
        const multi = r.values?.length > 1;
        val.className = multi ? 'val multi' : 'val';
        val.textContent = multi ? r.values.join(' / ') : String(r.value ?? '-');
      }
      li.append(meta, val);
      return li;
    }));
  }
}

// 늦게 도착한 옛 응답이 새 목록을 덮어쓰지 않도록 요청마다 번호를 매긴다(측정자를 바꾸는 사이 등)
let recentSeq = 0;
let latestSeq = 0;

async function loadRecent() {
  const user = $('user').value;
  if (!user) {
    renderRecent([], state.config.names.length ? '측정자를 먼저 골라 주세요.' : '측정자가 없습니다. ⚙ 버튼에서 측정자를 추가해 주세요.');
    return;
  }
  const seq = ++recentSeq;
  const { rows } = await api('recent', { user });
  if (seq !== recentSeq) return;
  renderRecent(Array.isArray(rows) ? rows : []);
}

async function loadLatest() {
  const seq = ++latestSeq;
  const { latest } = await api('latest');
  if (seq !== latestSeq) return;
  state.latest = latest ?? {};
  store.set('latest', JSON.stringify(state.latest));
  updateValueInfo();
}

// 목록을 못 받아도 입력은 막지 않는다: 사유를 목록 자리에 보여 주고, 코드가 틀렸으면 접속 화면으로
function listError(err) {
  if (err.isAuth) signOut();
  else renderRecent([], `최근 입력을 불러오지 못했습니다. ${errorText(err)}`);
}

const reloadLists = () => Promise.all([loadRecent(), loadLatest()]).catch(listError);

function readCached(key) {
  try { return JSON.parse(store.get(key) ?? 'null'); } catch { return null; }
}

// ---------- input form ----------

function renderTypes() {
  const box = $('types');
  box.replaceChildren(...[...siteTypes(), SURVEY, OTHER].map((type) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = type;
    b.dataset.type = type;
    b.setAttribute('aria-pressed', String(type === state.type));
    b.addEventListener('click', () => selectType(type));
    return b;
  }));
}

function renderIssues() {
  const box = $('issues');
  box.replaceChildren(...ISSUE_KINDS.map((issue) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = issue ? `⚠ ${issue}` : '정상 측정';
    if (issue) b.className = 'warn';
    b.dataset.issue = issue;
    b.setAttribute('aria-pressed', String(issue === state.issue));
    b.addEventListener('click', () => selectIssue(issue));
    return b;
  }));
}

function selectIssue(issue) {
  state.issue = issue;
  for (const b of $('issues').children) b.setAttribute('aria-pressed', String(b.dataset.issue === issue));
  const isSurvey = state.type === SURVEY;
  show($('valueCard'), !isSurvey && !issue);
  $('memo').placeholder = issue ? `예: ${issue} 상세 사유 또는 현장 상황` : '예: 우천 후 측정';
}

function selectType(type) {
  state.type = type;
  for (const b of $('types').children) b.setAttribute('aria-pressed', String(b.dataset.type === type));

  const isSurvey = type === SURVEY;
  if (isSurvey && state.issue) state.issue = '';
  const list = type === OTHER || isSurvey ? [] : instrumentsOf(type);
  $('instrument').replaceChildren(...list.map((i) => new Option(i.place ? `${i.id} · ${i.place}` : i.id, i.id)));
  show($('instrumentField'), list.length > 0);
  show($('addInstrument'), !isSurvey);
  show($('otherTypeField'), type === OTHER);
  show($('freeIdField'), list.length === 0 && !isSurvey);
  // Survey files replace the value card and the photos.
  show($('surveyBox'), isSurvey);
  show($('issueField'), !isSurvey);
  show($('valueCard'), !isSurvey && !state.issue);
  show($('photoField'), !isSurvey);
  show($('entryKeepField'), !isSurvey);
  for (const b of $('issues').children) b.setAttribute('aria-pressed', String(b.dataset.issue === state.issue));
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
  let text = `전회 ${lastValues.slice(0, count).join(' / ')} ${unit}${last.date ? ` (${shortDate(last.date)})` : ''}`;
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
  const values = state.issue ? undefined : (count > 1 ? MULTI_IDS.slice(0, count).map((id) => ($(id).value.trim() === '' ? null : Number($(id).value))) : undefined);
  return {
    clientId: state.clientId,
    site: state.site,
    weather: weatherRecord(),
    date: $('date').value,
    user: $('user').value,
    type: isOther ? $('otherType').value.trim() : state.type,
    id: hasList ? $('instrument').value : $('freeId').value.trim(),
    value: state.issue ? null : (values ? values[0] : (raw === '' ? null : Number(raw))),
    values,
    issue: state.issue || undefined,
    memo: $('memo').value.trim(),
  };
}

// Phone photos are several MB; shrink to <= PHOTO_MAX_BYTES so a weak signal can still send them.
// Lower quality first; if still too big at the floor, shrink the pixels and start over.
// toBlob encodes off the main thread, so the screen keeps painting while many photos are processed.
const toJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

async function compressPhoto(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`'${file.name}' 사진을 읽을 수 없습니다(HEIC 등 지원되지 않는 형식). 다른 사진을 고르세요.`); }
  try {
    let scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('사진을 처리할 메모리가 부족합니다. 사진 수를 줄여 다시 해 주세요.');
    for (;;) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob = null;
      for (let q = PHOTO_QUALITY; q >= PHOTO_MIN_QUALITY - 1e-9; q -= PHOTO_QUALITY_STEP) {
        blob = await toJpeg(canvas, q);
        if (blob && blob.size <= PHOTO_MAX_BYTES) return { base64: await readFileAsBase64(blob) };
      }
      // ponytail: 더 줄이면 알아볼 수 없으니 최저 품질 결과를 그대로 보낸다. 서버 상한(약 500KB)이 마지막 안전망
      if (Math.max(canvas.width, canvas.height) <= PHOTO_MIN_PX) {
        if (!blob) throw new Error(`'${file.name}' 사진을 변환하지 못했습니다. 다른 사진을 고르세요.`);
        return { base64: await readFileAsBase64(blob) };
      }
      scale *= PHOTO_SHRINK;
    }
  } finally {
    bitmap.close();
  }
}

// One at a time: compressing several full-size phone photos in parallel can exhaust memory.
async function readPhotos(files, onProgress) {
  const photos = [];
  for (const [i, file] of files.entries()) {
    onProgress?.(i + 1, files.length);
    photos.push(await compressPhoto(file));
  }
  return photos;
}

// 미리보기는 작게 줄인 사본으로: 원본 사진(장당 수 MB) 50장을 그대로 띄우면 폰 메모리가 모자라 화면이 멈춘다
const THUMB_PX = 176;   // 88px 칸 × 2(고해상도 화면)
async function thumbUrl(file) {
  try {
    const bitmap = await createImageBitmap(file, { resizeWidth: THUMB_PX, resizeQuality: 'medium' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await toJpeg(canvas, PHOTO_QUALITY);
    if (blob) return URL.createObjectURL(blob);
  } catch (err) {
    console.warn('미리보기 줄이기 실패, 원본으로 보여 줌', err);
  }
  return URL.createObjectURL(file);
}
// 한 장씩 차례로 줄인다: 50장을 한꺼번에 풀면 그 순간 메모리가 모자란다
let thumbQueue = Promise.resolve();
const queueThumb = (file) => (thumbQueue = thumbQueue.then(() => thumbUrl(file)));

// Photo chooser: camera button + gallery/file button (many at once).
// 안드로이드 앱에서는 촬영 버튼이 연속 촬영: 찍을 때마다 카메라가 다시 열리고, 뒤로가기를 누르면 찍은 사진이 한꺼번에 들어온다(MainActivity).
// 브라우저에서는 한 번에 한 장. The browser's own picker is what asks the phone for storage/gallery access; a web page cannot request it directly.
function makePicker(box) {
  let files = [];
  const previews = new Map();   // 사진 파일 → 줄인 미리보기 주소(약속). 사진을 빼도 남은 사진은 다시 줄이지 않는다
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
  const cam = makeInput({ multiple: true });   // 연속 촬영한 여러 장을 한 번에 받는다
  cam.setAttribute('capture', 'environment');
  const gallery = makeInput({ multiple: true });

  function add(picked) {
    const room = MAX_PHOTOS - files.length;
    if (picked.length > room) alert(`사진은 한 번에 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`);
    files = files.concat(picked.slice(0, Math.max(room, 0)));
    render();
  }

  function render() {
    for (const [file, url] of previews) {
      if (!files.includes(file)) { url.then((u) => URL.revokeObjectURL(u)); previews.delete(file); }
    }
    thumbs.replaceChildren(...files.map((file, i) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.alt = file.name;
      if (!previews.has(file)) previews.set(file, queueThumb(file));
      previews.get(file).then((u) => { img.src = u; });
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
  reader.onerror = () => reject(new Error(`'${file.name ?? '사진'}' 파일을 읽을 수 없습니다. 파일을 다시 골라 주세요.`));
  reader.readAsDataURL(file);
});

function surveyProblem() {
  const all = [...pickers.gps.files(), ...pickers.qgis.files()];
  if (all.length === 0) return 'GPS 파일이나 QGIS 파일을 하나 이상 선택해 주세요.';
  if (all.some((f) => f.size === 0)) return '비어 있는 파일이 있습니다. 빼고 다시 저장해 주세요.';
  if (all.reduce((sum, f) => sum + f.size, 0) > MAX_SURVEY_BYTES) return `파일 합계가 ${MAX_SURVEY_BYTES / MB}MB를 넘습니다. 나눠서 저장해 주세요.`;
  return '';
}

function surveyRequest() {
  const entry = { clientId: state.clientId, site: state.site, date: $('date').value, user: $('user').value, memo: $('memo').value.trim() };
  const rawFiles = { gps: [...pickers.gps.files()], qgis: [...pickers.qgis.files()] };
  const count = rawFiles.gps.length + rawFiles.qgis.length;
  return { id: entry.clientId, action: 'survey', label: `측량 파일 ${count}개 · ${state.site}`, entry, rawFiles };
}

const pickers = {};

function clearEntryFields() {
  for (const id of ['value', 'memo', 'otherType', 'freeId', ...MULTI_IDS]) $(id).value = '';
  selectIssue('');
  pickers.entry.clear();
  pickers.gps.clear();
  pickers.qgis.clear();
  updateValueInfo();
}

// ---------- draft (this phone only) ----------

let draftTimer = null;

function persistDraft() {
  const draft = {
    type: state.type,
    issue: state.issue,
    instrument: $('instrument').value,
    otherType: $('otherType').value,
    freeId: $('freeId').value,
    value: $('value').value,
    values: MULTI_IDS.map((id) => $(id).value),
    memo: $('memo').value,
    date: $('date').value,
  };
  store.set('draft', JSON.stringify(draft));
}

function saveDraft() {
  persistDraft();
  setStatus('임시저장됨 (이 휴대폰에만 보관, 사진 제외)', 'ok');
}

// Every edit is kept on this phone, so closing the app or losing the page never loses typed values.
function autosaveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(persistDraft, DRAFT_DELAY_MS);
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(store.get('draft') ?? 'null'); } catch { draft = null; }
  if (!draft || ![...siteTypes(), SURVEY, OTHER].includes(draft.type)) return false;
  selectType(draft.type);
  selectIssue(ISSUE_KINDS.includes(draft.issue) ? draft.issue : '');
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
  return err.message;
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
  store.set('cfg', JSON.stringify(state.config));
}

function changeSite(site) {
  state.site = site;
  renderPeople();                 // 목록에 없는 이름이면 첫 현장으로 바로잡힌다
  store.set('site', state.site);
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
  return withBusy($('manageDialog'), async () => {
    try {
      applyConfig(await api(p[op], { name }));
    } catch (err) {
      if (err.isAuth) { signOut(); return false; }
      $('manageError').textContent = err.fields ? NAME_RULE : errorText(err);
      return false;
    }
    if (kind === 'site') {
      changeSite(op === 'add' ? name : state.site);
    } else {
      renderPeople();
      if (op === 'add') $('user').value = name;
      store.set('user', $('user').value);
      loadRecent().catch(listError);
    }
    renderManage();
    return true;
  });
}

// Drive에 폴더만 만들고 현장 목록에 없는 이름을 찾아 눌러서 추가하게 한다
async function scanDriveSites() {
  $('manageError').textContent = '';
  $('siteFound').replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Drive 폴더를 확인하는 중...' }));
  let sites;
  try {
    ({ sites } = await withBusy($('manageDialog'), () => api('drive_sites')));
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('siteFound').replaceChildren();
    $('manageError').textContent = errorText(err);
    return;
  }
  if (!Array.isArray(sites)) sites = [];
  $('siteFound').replaceChildren(...(sites.length ? sites : ['']).map((name) => {
    const li = document.createElement('li');
    if (!name) { li.className = 'empty'; li.textContent = '새로 가져올 폴더가 없습니다.'; return li; }
    const text = document.createElement('span');
    text.textContent = name;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn primary small';
    add.textContent = '추가';
    add.addEventListener('click', async () => { if (await managePeople('site', 'add', name)) scanDriveSites(); });
    li.append(text, add);
    return li;
  }));
}

function openManage() {
  $('siteFound').replaceChildren();
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
  if (!item.id || !item.type) { $('instError').textContent = '계측기 ID와 종류를 넣어 주세요.'; return; }
  $('instError').textContent = '';
  await withBusy($('instForm'), async () => {
    try {
      applyConfig(await api('add_instrument', { item }));
    } catch (err) {
      if (err.isAuth) { signOut(); return; }
      $('instError').textContent = err.fields ? `${errorText(err)} (${NAME_RULE})` : errorText(err);
      return;
    }
    $('instDialog').close();
    for (const id of ['iId', 'iPlace', 'iUnit']) $(id).value = '';
    renderPeople();
    renderTypes();
    selectType(item.type);
    $('instrument').value = item.id;
    updateValueInfo();
  });
}

// 폰 사본은 덤이라 실패해도 저장 결과를 바꾸지 않는다. 사유는 콘솔에만 남긴다
const keepCopies = (photos, site) => saveCopiesToPhone(photos, site).catch((err) => console.warn('폰 사본 저장 실패', err));

// Photo without a measurement: any site, or none.
async function saveShot(e) {
  e.preventDefault();
  if ($('shotSave').disabled) return;
  const status = (text, kind) => setStatus(text, kind, 'shotStatus');
  if (pickers.shot.files().length === 0) { status('사진을 먼저 고르거나 찍어 주세요.', 'err'); return; }
  await withBusy($('shot').querySelector('.bar-bottom'), async () => {
    status('저장 중...', 'ok');
    try {
      const files = [...pickers.shot.files()];
      const entry = { clientId: state.shotId, site: $('shotSite').value, user: $('user').value, memo: $('shotMemo').value.trim() };
      const label = `사진 ${files.length}장 · ${entry.site || '현장 무관'}`;
      const photos = await readPhotos(files, (i, n) => status(`사진 줄이는 중... (${i}/${n})`, 'ok'));   // 150KB 이하로 줄인 사진: 클라우드와 폰 사본이 같은 파일
      status('저장 중...', 'ok');
      const result = await submitOrQueue({ id: entry.clientId, action: 'photo', label, payload: { entry, photos } });
      store.set('shotKeep', $('shotKeep').checked ? '1' : '0');
      if ($('shotKeep').checked) keepCopies(photos, entry.site);
      status(result === 'sent' ? '저장됨 ✓' : '신호가 약해 이 폰에 보관했습니다. 잡히면 자동으로 보냅니다.', 'ok');
      state.shotId = crypto.randomUUID();
      pickers.shot.clear();
      $('shotMemo').value = '';
    } catch (err) {
      if (err.isAuth) { signOut(); return; }
      status(`저장 실패: ${errorText(err)} 입력한 내용은 그대로 있습니다. 다시 저장을 눌러주세요.`, 'err');
    }
  });
}

// ---------- info tab ----------

function renderInfo() {
  $('appVersion').textContent = `v${BUILD}${window.AndroidGallery ? ` (안드로이드 앱${isProApp() ? ' Pro' : ''})` : ''}`;
  $('adminInfo').textContent = state.config.admin || '과장 정준업(Master)';
  show($('downloadApk'), !window.AndroidGallery);
}

// ---------- start ----------

async function start() {
  showSplashLoading();
  try {
    state.config = await api('config');
    registerPush();
    state.offline = false;
    store.set('cfg', JSON.stringify(state.config));
  } catch (err) {
    if (err.isAuth) {
      signOut();
      hideSplash();
      alert(err.message);
      $('code').select();
      return;
    }
    // No signal: open with the lists saved last time so the work can still be typed in and kept on the phone.
    const cached = err.network ? readCached('cfg') : null;
    if (!cached) {
      showSplashError(err.network ? '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.' : err.message);
      return;
    }
    state.config = cached;
    state.offline = true;
  }
  state.ready = true;
  renderPeople();
  refreshWeather();
  $('today').textContent = new Date().toLocaleDateString('ko-KR', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'short' });
  $('date').value = todayKst();

  renderTypes();
  renderIssues();
  if (!restoreDraft()) selectType(siteTypes()[0] ?? OTHER);
  route();
  if (state.offline) {
    state.latest = readCached('latest') ?? {};
    updateValueInfo();
    renderRecent([], '신호가 없어 최근 입력을 불러오지 못했습니다. 신호가 잡히면 새로고침해 주세요.');
  } else {
    await reloadLists();
  }
  await hideSplash();
  renderOutbox();
  flushOutbox();
}

// ---------- events ----------

$('gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  if (!code) { $('code').focus(); return; }
  state.code = code;
  store.set('code', code);
  withBusy($('gateForm'), start);
});

$('retry').addEventListener('click', () => withBusy($('splashError'), start));
window.addEventListener('hashchange', route);
// 바탕(어두운 부분)을 누르면 창이 닫힌다. Esc와 포커스 이동은 <dialog>가 알아서 한다
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
$('user').addEventListener('change', () => { store.set('user', $('user').value); loadRecent().catch(listError); });
$('site').addEventListener('change', () => changeSite($('site').value));
$('manage').addEventListener('click', openManage);
$('weather').addEventListener('click', pickPlace);
$('editForm').addEventListener('submit', saveEdit);
$('editDelete').addEventListener('click', removeEntry);
$('editCancel').addEventListener('click', () => $('editDialog').close());
$('openManage').addEventListener('click', openManage);
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
$('siteScan').addEventListener('click', scanDriveSites);
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
$('input').addEventListener('input', autosaveDraft);
$('input').addEventListener('change', autosaveDraft);

$('input').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('save').disabled) return;   // 저장 중에 다시 눌림
  const isSurvey = state.type === SURVEY;
  const problem = isSurvey ? surveyProblem() : '';
  if (problem) { setStatus(problem, 'err'); return; }
  if (!isSurvey && !confirmUnusual()) return;
  await withBusy($('input').querySelector('.bar-bottom'), async () => {
    setStatus(isSurvey ? '파일 올리는 중... (파일이 크면 1분 정도 걸립니다)' : '저장 중...', 'ok');
    let result;
    try {
      if (isSurvey) {
        result = await submitOrQueue(surveyRequest());
      } else {
        const entry = readForm();
        const photos = await readPhotos(pickers.entry.files(), (i, n) => setStatus(`사진 줄이는 중... (${i}/${n})`, 'ok'));
        setStatus('저장 중...', 'ok');
        const label = entry.issue ? `⚠ ${entry.issue} · ${entry.id}` : `${entry.date} ${entry.id}`;
        result = await submitOrQueue({ id: entry.clientId, action: 'save', label, payload: { entry, photos } });
        store.set('entryKeep', $('entryKeep').checked ? '1' : '0');
        if (photos.length > 0 && $('entryKeep').checked) keepCopies(photos, entry.site);
        // Not on the server yet: show this reading as the previous one so the next change is measured against it.
        if (result === 'queued' && !entry.issue) state.latest[entry.id] = { value: entry.value, values: entry.values ?? [entry.value], date: entry.date };
      }
    } catch (err) {
      if (err.isAuth) { signOut(); return; }
      setStatus(err.fields ? errorText(err) : `저장 실패: ${errorText(err)} 입력한 값은 그대로 있습니다. 다시 저장을 눌러주세요.`, 'err');
      return;
    }
    // 저장은 끝났다: 아래는 뒷정리라 목록 갱신이 실패해도 '저장 실패'로 보이지 않는다
    setStatus(result === 'sent' ? '저장됨 ✓' : '신호가 약해 이 폰에 보관했습니다. 잡히면 자동으로 보냅니다.', 'ok');
    state.clientId = crypto.randomUUID();
    clearTimeout(draftTimer);
    store.remove('draft');
    clearEntryFields();
    if (result === 'sent') await reloadLists();
  });
});

pickers.entry = makePicker($('photoBoxEntry'));
pickers.shot = makePicker($('photoBoxShot'));
pickers.gps = makeFilePicker($('gpsBox'));
pickers.qgis = makeFilePicker($('qgisBox'));
$('shotKeep').checked = store.get('shotKeep') !== '0';
$('entryKeep').checked = store.get('entryKeep') !== '0';
if (window.AndroidGallery) {
  $('shotKeepNote').textContent = '150KB 이하로 줄인 사진이 갤러리 「계측사진/현장이름」 폴더에 저장됩니다';
  $('entryKeepNote').textContent = '150KB 이하로 줄인 사진이 갤러리 「계측사진/현장이름」 폴더에 저장됩니다';
}
initOutbox();
if (typeof initDrawingModule === 'function') initDrawingModule();
initGps();
initGallery();
// file:// (앱 안의 오프라인 사본)에서는 서비스 워커를 쓸 수 없다. 그래도 앱은 그대로 동작한다
if ('serviceWorker' in navigator) navigator.serviceWorker.register(`sw.js?v=${BUILD}`).catch((err) => console.warn('서비스 워커 등록 실패', err));

if (state.code) {
  start();
} else {
  showGate();
  hideSplash();
}
