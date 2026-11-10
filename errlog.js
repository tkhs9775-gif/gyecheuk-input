// 오류 기록: 화면에서 터진 오류(error·unhandledrejection)와 느리거나(8초 넘게) 실패한 서버 요청을 알림 중계 서버(PUSH_URL /log)로 보내 사무실에서 본다.
// 보내는 것은 종류·메시지(경로·숫자·따옴표 안 글자 지움, 200자)·파일:줄·화면 버전·앱 종류·시각뿐이다. 계측값·메모·현장명·파일명·접속 코드는 보내지 않는다.
// 폰당 하루 20건, 같은 오류는 하루 1번. 신호가 없으면 폰(localStorage)에 모았다가 다음에 보낸다. 여기서 무슨 일이 나도 앱은 멈추지 않는다.
// config.js 바로 뒤에 읽어야 뒤에 읽는 파일의 오류까지 잡는다.

const ERRLOG_DAY_MAX = 20;
const ERRLOG_SLOW_MS = 8000;
const ERRLOG_MSG_MAX = 200;
const ERRLOG_SEND_DELAY_MS = 3000;   // 오류가 한꺼번에 여러 개 나도 한 번에 묶어 보낸다(중계 서버 쓰기 횟수 절약)
const ERRLOG_KEYS = { queue: 'errlogQueue', day: 'errlogDay' };
const ERRLOG_OK_RESULTS = new Set(['ok', 'bad_code', 'locked']);   // 코드 틀림·잠금은 앱 고장이 아니다

// 순수 함수: 메시지에서 주소·파일 경로·따옴표 안 글자·숫자를 지우고 200자로 자른다
function errlogScrub(text) {
  return String(text ?? '')
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<주소>')          // https://… blob:… 같은 주소
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s'"`]+){2,}/g, '<경로>')   // C:\a\b, /a/b/c
    .replace(/(['"`“‘«])[^'"`”’»]*['"`”’»]/g, '$1…$1')         // 따옴표 안(현장명·파일명이 자주 들어간다)
    .replace(/\d+(?:[.,]\d+)*/g, '#')                           // 숫자(계측값일 수 있다)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERRLOG_MSG_MAX);
}

// 순수 함수: 스크립트 주소와 줄 번호를 "app.js:118" 처럼(폴더·?v= 는 빼고 우리 .js 파일 이름만)
function errlogWhere(file, line) {
  const m = /([\w.-]+\.(?:js|mjs|html))(?:[?#][^:\s]*)?(?::(\d+))?/.exec(String(file ?? ''));
  if (!m) return '';
  const ln = Number(line) || Number(m[2]) || 0;
  return ln ? `${m[1]}:${ln}` : m[1];
}

// 순수 함수: 서버 요청 기록 하나가 보낼 만한가(8초 넘음·실패). 보낼 거면 { kind, msg } 아니면 null
function errlogApiEvent(action, ms, result) {
  const name = String(action ?? '').replace(/[^\w-]/g, '').slice(0, 30) || '?';
  const res = String(result ?? '');
  if (!ERRLOG_OK_RESULTS.has(res)) return { kind: 'fail', msg: `api:${name} ${res.replace(/[^\w-]/g, '').slice(0, 30)}` };
  if (Number(ms) > ERRLOG_SLOW_MS) return { kind: 'slow', msg: `api:${name} ${Math.round(Number(ms) / 1000)}초` };
  return null;
}

const errlogSig = (e) => `${e.kind}|${e.msg}|${e.where}`;

// 순수 함수: 오늘 상한·중복을 따져 받아들일지. day = { d: '2026-11-10', n: 보낸 수, sig: [본 오류] }. 새 day 와 ok 를 돌려준다
function errlogAdmit(day, entry, today) {
  const cur = day && day.d === today ? day : { d: today, n: 0, sig: [] };
  const sig = errlogSig(entry);
  if (cur.n >= ERRLOG_DAY_MAX || cur.sig.includes(sig)) return { day: cur, ok: false };
  return { day: { d: today, n: cur.n + 1, sig: [...cur.sig, sig] }, ok: true };
}

function errlogApp() {
  try { if (window.AndroidPro?.isPro?.()) return 'Pro'; } catch { /* 브리지 오류 */ }
  return window.AndroidGallery ? 'APK' : '브라우저';
}

const errlogVersion = (() => {
  try { return new URL(document.currentScript.src).searchParams.get('v') ?? '-'; } catch { return '-'; }
})();

function errlogRead(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function errlogWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 못 해도 앱은 그대로 */ }
}

function errlogToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let errlogTimer = 0;
let errlogSending = false;

// isClean: 이 파일이 직접 만든 문구(api:save 9초 등)라 걸러낼 필요가 없을 때
function errlogRecord(kind, message, where, isClean = false) {
  try {
    const msg = isClean ? String(message).slice(0, ERRLOG_MSG_MAX) : errlogScrub(message);
    const entry = { kind, msg: msg || '(내용 없음)', where: where || '', v: errlogVersion, app: errlogApp(), at: Date.now() };
    const { day, ok } = errlogAdmit(errlogRead(ERRLOG_KEYS.day, null), entry, errlogToday());
    if (!ok) return;
    errlogWrite(ERRLOG_KEYS.day, day);
    errlogWrite(ERRLOG_KEYS.queue, [...errlogRead(ERRLOG_KEYS.queue, []), entry].slice(-ERRLOG_DAY_MAX));
    clearTimeout(errlogTimer);
    errlogTimer = setTimeout(errlogFlush, ERRLOG_SEND_DELAY_MS);
  } catch { /* 오류 기록이 앱을 멈추면 안 된다 */ }
}

// 모아 둔 오류를 한 번에 보낸다. 성공하면 보낸 것만 지운다(보내는 사이 새로 생긴 것은 남는다)
async function errlogFlush() {
  if (errlogSending) return;
  try {
    if (typeof PUSH_URL === 'undefined' || !PUSH_URL) return;
    const code = typeof state !== 'undefined' ? state.code : '';
    if (!code || navigator.onLine === false) return;
    const queue = errlogRead(ERRLOG_KEYS.queue, []);
    if (!queue.length) return;
    errlogSending = true;
    const res = await fetch(PUSH_URL + '/log', { method: 'POST', body: JSON.stringify({ code, logs: queue }) });
    if (!res.ok) return;
    const sent = new Set(queue.map((e) => e.at + errlogSig(e)));
    errlogWrite(ERRLOG_KEYS.queue, errlogRead(ERRLOG_KEYS.queue, []).filter((e) => !sent.has(e.at + errlogSig(e))));
  } catch { /* 신호 없음: 다음에 보낸다 */ } finally {
    errlogSending = false;
  }
}

// perf.js 의 perfApi 가 부른다
function errlogApi(action, ms, result) {
  const ev = errlogApiEvent(action, ms, result);
  if (ev) errlogRecord(ev.kind, ev.msg, '', true);
}

// 정보 탭 '오류 기록': 중계 서버에 모인 최근 3일 오류(모든 폰)를 글로
async function errlogFetchReport(days = 3) {
  if (typeof PUSH_URL === 'undefined' || !PUSH_URL) return '알림 중계 서버 주소가 없습니다.';
  const res = await fetch(PUSH_URL + '/logs', { method: 'POST', body: JSON.stringify({ code: state.code, days }) });
  const data = await res.json();
  if (!data.ok) return `불러오지 못했습니다(${data.error || res.status}).`;
  if (!data.logs.length) return `최근 ${days}일 동안 기록된 오류가 없습니다.`;
  return data.logs.map(errlogLine).join('\n');
}

// 순수 함수: 서버 기록 한 줄을 사람이 읽는 글로
function errlogLine(e) {
  const d = new Date(e.at);
  const two = (x) => String(x).padStart(2, '0');
  const kindName = { error: '오류', promise: '오류(비동기)', slow: '느림', fail: '요청 실패' }[e.kind] || e.kind;
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} [${kindName}] ${e.msg}${e.where ? ` (${e.where})` : ''} · v${e.v} ${e.app}${e.n > 1 ? ` ×${e.n}` : ''}`;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('error', (ev) => {
    if (!ev.message && ev.target && ev.target !== window) return;   // 그림·스크립트 못 읽음(리소스 오류)은 빼고 코드 오류만
    errlogRecord('error', ev.message, errlogWhere(ev.filename, ev.lineno));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    const msg = r && typeof r === 'object' ? `${r.name || 'Error'}: ${r.message || ''}` : String(r);
    errlogRecord('promise', msg, errlogWhere(r?.stack));
  });
  window.addEventListener('online', errlogFlush);
  window.addEventListener('load', () => setTimeout(errlogFlush, ERRLOG_SEND_DELAY_MS));
}

if (typeof module !== 'undefined') module.exports = { errlogScrub, errlogWhere, errlogApiEvent, errlogAdmit, errlogLine, ERRLOG_DAY_MAX };
