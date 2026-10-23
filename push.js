// 안드로이드 앱(APK) 푸시 알림: 이 폰의 푸시 주소를 중계 서버에 등록하고, 입력이 저장되면 다른 폰들에 알려 달라고 요청한다.
// 값·메모·사진은 보내지 않고 "누가 어느 현장에서 무엇을 했는지" 한 줄만 보낸다. 이 파일은 app.js보다 먼저 읽힌다.

// 입력 종류별 알림 문구. 알릴 필요가 없는 동작(조회·수정 등)은 null
function buildNotice(action, payload) {
  const en = payload.entry ?? {};
  const site = en.site || '현장 미지정';
  const who = en.user || '누군가';
  if (action === 'save') {
    return en.issue
      ? { title: `⚠️ 이상보고 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} ${en.issue} 보고` }
      : { title: `계측 입력 · ${site}`, body: `${who}님이 ${site}에서 ${en.id} 계측값 입력` };
  }
  if (action === 'photo') return { title: `사진 등록 · ${site}`, body: `${who}님이 ${site}에서 사진 ${(payload.photos ?? []).length}장 등록` };
  if (action === 'survey') return { title: `측량파일 · ${site}`, body: `${who}님이 ${site}에서 측량파일 등록` };
  return null;
}

const pushToken = () => (window.AndroidPush ? window.AndroidPush.getToken() : '');

async function pushPost(path, body) {
  if (typeof PUSH_URL === 'undefined' || !PUSH_URL) return;   // 중계 서버 주소를 아직 안 넣었으면 알림 기능 꺼짐
  await fetch(PUSH_URL + path, { method: 'POST', body: JSON.stringify({ code: state.code, ...body }) });
}

const REGISTER_RETRY_MS = 3000;
const REGISTER_TRIES = 10;

// 이 폰을 알림 대상으로 등록(앱이 열릴 때마다 해도 같은 폰은 한 줄로 유지된다)
// 앱을 처음 설치한 직후에는 푸시 주소가 몇 초 늦게 만들어지므로, 안드로이드 앱이면 잠시 기다리며 다시 확인한다
function registerPush(triesLeft = REGISTER_TRIES) {
  const token = pushToken();
  if (!token) {
    if (window.AndroidPush && triesLeft > 0) setTimeout(() => registerPush(triesLeft - 1), REGISTER_RETRY_MS);
    return;
  }
  pushPost('/subscribe', { token, user: store.get('user') ?? '' }).catch(() => {});
}

// 입력이 서버에 새로 저장된 직후 호출. 실패해도 입력 저장에는 영향 없다
function announceSaved(action, payload, result) {
  if (result.duplicate) return;
  const notice = buildNotice(action, payload);
  if (!notice) return;
  pushPost('/notify', { ...notice, skipToken: pushToken() }).catch(() => {});
}

if (typeof module !== 'undefined') module.exports = { buildNotice };
