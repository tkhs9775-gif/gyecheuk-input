// 안드로이드 앱(APK) 푸시 알림: 이 폰의 푸시 주소를 중계 서버에 등록하고, 저장이 끝나면 다른 기기(폰·PC)에 알려 달라고 요청한다.
// 값·사진은 보내지 않고 "누가 무엇을 했는지" 한 줄(메모는 앞부분)만 보낸다. 이 파일은 app.js보다 먼저 읽힌다.
// kind: 앱이 알림 모양(색·채널)과 눌렀을 때 열 화면을 고르는 값. date: 눌렀을 때 그 날짜 창을 연다.

const NOTICE_BODY_MAX = 110;
const clip = (s, n = NOTICE_BODY_MAX) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dayLabel = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일(${'일월화수목금토'[new Date(`${iso}T00:00:00Z`).getUTCDay()]})` : '');

// 저장 종류별 알림 문구. 알릴 필요가 없는 동작(조회·읽음 표시·삭제 등)은 null
function buildNotice(action, payload) {
  const en = payload.entry ?? {};
  const site = en.site || '현장 미지정';
  const who = payload.user || en.user || '누군가';
  if (action === 'save') {
    return en.issue
      ? { kind: 'issue', who, site: en.site, title: `⚠️ 이상보고 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} ${en.issue} 보고` }
      : { kind: 'input', who, site: en.site, title: `계측 입력 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} 계측값 입력` };
  }
  // kind 를 photo·survey·drawing 으로 나눠야 알림을 눌렀을 때 그 화면(갤러리·도면)으로 간다. PC 팝업은 모르는 kind 를 '현장 입력'으로 보여 준다
  if (action === 'photo') return { kind: 'photo', who, site: en.site, title: `사진 등록 · ${site}`, body: `${who}님이 ${site}에서 사진 ${(payload.photos ?? []).length}장 등록` };
  if (action === 'survey') return { kind: 'survey', who, site: en.site, title: `측량파일 · ${site}`, body: `${who}님이 ${site}에서 측량파일 등록` };
  if (action === 'memo_add') return { kind: 'memo', who, date: payload.date, title: `📌 상황 메모 · ${dayLabel(payload.date)}`, body: `${who} 님이 새 보고를 남겼습니다 · 눌러서 확인해 주세요` }   // 내용은 알림에 안 보이게(앱에서 열어야 확인 기록이 남는다);
  if (action === 'schedule_add') {
    const items = payload.items ?? [];
    const first = items.map((i) => i.date).sort()[0] || '';
    if (payload.source) return { kind: 'schedule', who, date: first, title: '📅 주간 일정 등록', body: clip(`${who}님이 계획서로 일정 ${items.length}건을 넣었습니다`) };
    return { kind: 'schedule', who, date: first, title: `📅 새 일정 · ${dayLabel(first)}`, body: clip(`${who}: ${items[0]?.title || ''}`) };
  }
  if (action === 'schedule_update') return { kind: 'schedule', who, date: payload.item?.date, title: `✏️ 일정 수정 · ${dayLabel(payload.item?.date)}`, body: clip(`${who}: ${payload.item?.title || ''}`) };
  // 도면 메모: 보낼지 말지(실시간 저장 빼기·10분 간격)는 announceSaved 에서 Rust 코어가 정한다
  if (action === 'drawing_notes_save') return { kind: 'drawing', who, site: payload.site, fileId: payload.fileId, title: `📐 도면 저장 · ${payload.site || '현장 미지정'}`, body: clip(`${who}님이 ${payload.fileName || '도면'}에 기록을 저장했습니다`) };
  if (action === 'contact_save') return { kind: 'contact', who, site: payload.contact?.site, title: `🪪 명함 등록 · ${payload.contact?.site || ''}`, body: clip(`${who}님이 ${payload.contact?.name || '현장 담당자'} 명함을 올렸습니다`) };
  return null;
}

const pushToken = () => (window.AndroidPush ? window.AndroidPush.getToken() : '');

async function pushPost(path, body) {
  if (typeof PUSH_URL === 'undefined' || !PUSH_URL) return null;   // 중계 서버 주소를 아직 안 넣었으면 알림 기능 꺼짐
  const res = await fetch(PUSH_URL + path, { method: 'POST', body: JSON.stringify({ code: state.code, ...body }) });
  return res.json().catch(() => ({ ok: res.ok }));
}

const REGISTER_RETRY_MS = 3000;
const REGISTER_TRIES = 20;
// 정보 탭 「알림 상태」에 보여 줄 마지막 등록 결과
const pushState = { status: '', at: '' };
function setPushState(status) {
  pushState.status = status;
  pushState.at = new Date().toLocaleString('ko-KR');
  store.set('push:state', JSON.stringify(pushState));
  window.renderPushStatus?.();
}

// 이 폰을 알림 대상으로 등록(앱이 열릴 때마다 해도 같은 폰은 한 줄로 유지된다)
// 푸시 주소가 아직 없으면(설치 직후·구글 서비스 늦음) 폰에 다시 만들어 달라고 하고 잠시 뒤 다시 본다
function registerPush(triesLeft = REGISTER_TRIES) {
  if (!window.AndroidPush) return;
  const token = pushToken();
  if (!token) {
    window.AndroidPush.refreshToken?.();
    if (triesLeft > 0) setTimeout(() => registerPush(triesLeft - 1), REGISTER_RETRY_MS);
    else setPushState('no_token');
    return;
  }
  pushPost('/subscribe', { token, user: store.get('user') ?? '' })
    .then((r) => setPushState(r && r.ok ? 'ok' : `error:${r?.error || 'server'}`))
    .catch(() => setPushState('error:network'));
}

// 같은 계획서를 나눠 보내면(250건씩) 알림은 한 번만
let lastPlanNotice = '';
// 같은 도면은 10분에 한 번만, 실시간 저장은 안 알린다(판단은 Rust 코어 drawing_notice_due, 이 기기 기준)
const lastDrawingNotice = {};
function drawingNoticeDue(payload, now = Date.now()) {
  const isLive = !!payload.data?.live;
  const last = lastDrawingNotice[payload.fileId] || 0;
  let due = window.RustCore?.drawingNoticeDue?.(isLive, now, last);
  if (due == null) due = !isLive && now - last >= 10 * 60 * 1000;   // wasm 을 못 읽은 기기(PC 화면 등)용 같은 규칙
  if (due) lastDrawingNotice[payload.fileId] = now;
  return due;
}
// 저장이 서버에 새로 들어간 직후 호출(app.js api). 실패해도 저장에는 영향 없다
function announceSaved(action, payload, result) {
  if (result.duplicate) return;
  if (action === 'schedule_add' && !result.added) return;
  const notice = buildNotice(action, payload);
  if (!notice) return;
  if (action === 'drawing_notes_save' && !drawingNoticeDue(payload)) return;
  if (action === 'schedule_add' && payload.source) {
    if (lastPlanNotice === payload.source) return;
    lastPlanNotice = payload.source;
    setTimeout(() => { lastPlanNotice = ''; }, 60000);
  }
  pushPost('/notify', { ...notice, skipToken: pushToken() }).catch(() => {});
}

// 알림을 누르면 그 알림이 가리키는 곳을 연다: 메모·일정 = 그 날짜 창, 사진 = 그 현장 갤러리, 도면 = 그 도면, 명함 = 그 현장 도면 폴더(명함이 위에 보인다).
// APK 는 종류(kind)·날짜만 넘겨주므로(재설치 없이 되게), 현장·도면은 중계 서버의 최근 알림 목록에서 같은 종류의 가장 최근 것으로 찾는다.
// 새 APK(1.33~)는 알림마다 제 목적지(site·fileId·ts)를 들고 온다(Rust pushopen.rs) → 앱이 켜져 있을 때 다른 알림을 눌러도 그 알림의 곳으로 간다.
// 옛 APK 는 종류·날짜만 주므로 예전처럼 같은 종류의 가장 최근 알림으로 찾는다
const PUSH_OPEN_HASH = { photo: '#gallery', drawing: '#drawing', contact: '#drawing' };
function pushGoHash(hash) {
  if (location.hash === hash) return Promise.resolve();
  const moved = new Promise((resolve) => window.addEventListener('hashchange', resolve, { once: true }));
  location.hash = hash;
  return moved;   // route()가 탭을 먼저 그린 뒤에 그 안을 연다
}
// 순수 함수: 누른 알림(o)의 목적지. site 가 있으면 그대로, 번호(ts)만 있으면 그 번호의 알림, 둘 다 없으면 같은 종류의 가장 최근 것
function pickPushNotice(o, notices) {
  if (o?.site) return { site: o.site, fileId: o.fileId || '' };
  const list = (Array.isArray(notices) ? notices : []).filter((n) => n && n.kind === o?.kind && n.site);
  return (o?.ts && list.find((n) => String(n.ts) === String(o.ts))) || list.pop() || null;
}
async function pushNoticeFor(o) {
  if (o?.site) return pickPushNotice(o, []);   // 서버에 묻지 않는다(신호가 약해도 바로 연다)
  try {
    const r = await pushPost('/recent', { since: 0 });
    return pickPushNotice(o, r?.notices);
  } catch { return null; }   // 신호가 없으면 탭까지만 연다
}
// 도면을 보는 중에 사진·일정 알림을 누르면 도면을 닫고 간다(적던 값은 closePdfViewer 가 폰에 남긴다). 도면 알림은 openPdfFieldbook 이 바꿔 연다
function pushLeaveViewer() {
  const viewer = typeof document !== 'undefined' ? document.getElementById('pdfViewer') : null;
  if (viewer && !viewer.classList.contains('hidden') && typeof closePdfViewer === 'function') closePdfViewer();
}
async function pushOpenTarget(o) {
  if (o.kind !== 'drawing') pushLeaveViewer();
  await pushGoHash(PUSH_OPEN_HASH[o.kind]);   // 탭은 바로 연다(찾는 동안 첫 화면에 머물지 않게)
  const n = await pushNoticeFor(o);
  if (!n) return;
  if (o.kind === 'photo') { if (typeof openAlbum === 'function') openAlbum(n.site); return; }
  if (typeof openRecentDrawing === 'function') openRecentDrawing({ site: n.site, fileId: o.kind === 'drawing' ? n.fileId || '' : '' });
}
// 앱이 꺼져 있던 때는 첫 화면이 다 뜬 뒤(schedule.js), 켜져 있을 때 누르면 안드로이드가 onPushOpen 을 부른다
function takePushOpen() {
  let o = null;
  try { o = JSON.parse(window.AndroidPush?.takeOpen?.() || 'null'); } catch { o = null; }
  if (!o) return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(o.date || '') && typeof schedOpenDay === 'function') { pushLeaveViewer(); schedOpenDay(o.date); }
  else if (PUSH_OPEN_HASH[o.kind]) pushOpenTarget(o).catch(() => {});
}
if (typeof window !== 'undefined') window.onPushOpen = () => takePushOpen();

// ---------- 정보 탭 「알림」 카드: 이 기기 상태 + 시험 알림 ----------
const PUSH_STATUS_TEXT = {
  ok: ['켜짐 · 알림 받는 중', 'ok'],
  no_token: ['알림 주소를 아직 못 받았습니다', 'warn'],
  off: ['휴대폰 설정에서 알림이 꺼져 있습니다', 'bad'],
};
function renderPushStatus() {
  const card = document.getElementById('pushCard');
  if (!card) return;
  card.hidden = !window.AndroidPush;   // 브라우저로 연 화면은 푸시를 받을 수 없다(앱 APK 만)
  if (card.hidden) return;
  let saved = pushState;
  if (!saved.status) { try { saved = JSON.parse(store.get('push:state') || 'null') || saved; } catch { /* 저장분 없음 */ } }
  const enabled = window.AndroidPush.notificationsEnabled ? window.AndroidPush.notificationsEnabled() : true;
  const key = !enabled ? 'off' : (saved.status || 'no_token');
  const [text, tone] = PUSH_STATUS_TEXT[key] || [`등록 실패(${String(key).replace('error:', '')})`, 'bad'];
  const st = document.getElementById('pushStatus');
  st.textContent = text;
  st.dataset.tone = tone;
  document.getElementById('pushHint').textContent = !enabled
    ? '「알림 설정 열기」를 눌러 알림을 허용해 주세요. 허용해야 메모·일정 알림이 옵니다.'
    : tone === 'ok' ? '다른 사람이 메모·일정·입력을 저장하면 이 기기로 알림이 옵니다.' : '앱을 다시 열거나 「최신 버전으로 새로고침」 뒤에도 그대로면 관리자에게 알려 주세요.';
  document.getElementById('pushSettings').hidden = enabled || !window.AndroidPush.openSettings;
}

async function pushSelfTest() {
  const btn = document.getElementById('pushTest');
  const token = pushToken();
  if (!token) { registerPush(); alert('이 기기의 알림 주소를 받는 중입니다. 잠시 뒤 다시 눌러 주세요.'); return; }
  btn.disabled = true;
  try {
    const r = await pushPost('/selftest', { token });
    flash(r && r.ok ? '시험 알림을 보냈습니다. 잠시 뒤 알림창을 보세요' : `보내지 못했습니다(${r?.error || r?.result || '서버'})`);
    if (r && r.ok) registerPush();
  } catch {
    flash('신호가 없어 보내지 못했습니다');
  } finally {
    btn.disabled = false;
  }
}
if (typeof document !== 'undefined') {
  window.renderPushStatus = renderPushStatus;
  document.getElementById('pushTest')?.addEventListener('click', pushSelfTest);
  document.getElementById('pushSettings')?.addEventListener('click', () => window.AndroidPush?.openSettings?.());
}

if (typeof module !== 'undefined') module.exports = { buildNotice, pickPushNotice };
