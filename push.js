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
      ? { kind: 'issue', who, title: `⚠️ 이상보고 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} ${en.issue} 보고` }
      : { kind: 'input', who, title: `계측 입력 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} 계측값 입력` };
  }
  if (action === 'photo') return { kind: 'input', who, title: `사진 등록 · ${site}`, body: `${who}님이 ${site}에서 사진 ${(payload.photos ?? []).length}장 등록` };
  if (action === 'survey') return { kind: 'input', who, title: `측량파일 · ${site}`, body: `${who}님이 ${site}에서 측량파일 등록` };
  if (action === 'memo_add') return { kind: 'memo', who, date: payload.date, title: `📌 상황 메모 · ${dayLabel(payload.date)}`, body: clip(`${who}: ${payload.text}`) };
  if (action === 'schedule_add') {
    const items = payload.items ?? [];
    const first = items.map((i) => i.date).sort()[0] || '';
    if (payload.source) return { kind: 'schedule', who, date: first, title: '📅 주간 일정 등록', body: clip(`${who}님이 계획서로 일정 ${items.length}건을 넣었습니다`) };
    return { kind: 'schedule', who, date: first, title: `📅 새 일정 · ${dayLabel(first)}`, body: clip(`${who}: ${items[0]?.title || ''}`) };
  }
  if (action === 'schedule_update') return { kind: 'schedule', who, date: payload.item?.date, title: `✏️ 일정 수정 · ${dayLabel(payload.item?.date)}`, body: clip(`${who}: ${payload.item?.title || ''}`) };
  if (action === 'contact_save') return { kind: 'contact', who, title: `🪪 명함 등록 · ${payload.contact?.site || ''}`, body: clip(`${who}님이 ${payload.contact?.name || '현장 담당자'} 명함을 올렸습니다`) };
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
// 저장이 서버에 새로 들어간 직후 호출(app.js api). 실패해도 저장에는 영향 없다
function announceSaved(action, payload, result) {
  if (result.duplicate) return;
  if (action === 'schedule_add' && !result.added) return;
  const notice = buildNotice(action, payload);
  if (!notice) return;
  if (action === 'schedule_add' && payload.source) {
    if (lastPlanNotice === payload.source) return;
    lastPlanNotice = payload.source;
    setTimeout(() => { lastPlanNotice = ''; }, 60000);
  }
  pushPost('/notify', { ...notice, skipToken: pushToken() }).catch(() => {});
}

// 알림을 눌러 앱이 열렸으면 그 날짜 창을 연다(앱이 켜져 있을 때 누르면 안드로이드가 onPushOpen 을 부른다)
function takePushOpen() {
  let o = null;
  try { o = JSON.parse(window.AndroidPush?.takeOpen?.() || 'null'); } catch { o = null; }
  if (o && /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') && typeof schedOpenDay === 'function') schedOpenDay(o.date);
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

if (typeof module !== 'undefined') module.exports = { buildNotice };
