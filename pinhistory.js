// 동그라미 메모(pin)의 전회값·초기치 비교. 순수 함수만(화면·전역 상태 안 건드림).
// pin.date: text를 마지막으로 적은 날 'YYYY-MM-DD', pin.history: [{ date, text }] 오래된 것부터.
const MAX_PIN_HISTORY = 20;
const MAX_PIN_LIST = 60;   // 메모 상자 '지난 기록' 목록에 보이는 최대 줄 수(저장본 여러 개를 합친 것)
const PIN_READING_RE = /[+-]?\d*\.?\d+/;

function readingNumber(text) {
  const m = String(text ?? '').match(PIN_READING_RE);
  return m ? Number(m[0]) : null;
}

// 숫자 부분의 소수 자릿수
function pinReadingDecimals(text) {
  const m = String(text ?? '').match(PIN_READING_RE);
  const dot = m ? m[0].indexOf('.') : -1;
  return dot < 0 ? 0 : m[0].length - dot - 1;
}

const samePinEntry = (a, b) => !!a && !!b && a.date === b.date && a.text === b.text;

function pushPinHistory(pin, newText, today) {
  const history = Array.isArray(pin.history) ? pin.history.slice() : [];
  if (pin.text && (pin.date || '') !== today) {
    const entry = { date: pin.date || '', text: pin.text, ...(pin.author ? { author: pin.author } : {}) };
    if (!samePinEntry(history[history.length - 1], entry)) history.push(entry);
  }
  return { ...pin, history: history.slice(-MAX_PIN_HISTORY), text: newText, date: today };
}

function pinReadings(pin, today) {
  const history = Array.isArray(pin.history) ? pin.history : [];
  const last = history[history.length - 1] || null;
  const isToday = pin.date === today;
  const own = pin.text ? { date: pin.date || '', text: pin.text } : null;
  return {
    initial: history[0] || (isToday ? null : own),
    prev: isToday ? last : (own || last),
    current: isToday ? pin.text : '',
  };
}

const pinDateLabel = (date) => (date ? ` (${date.slice(5).replace('-', '/')})` : '');

// 두 값의 차이를 자릿수 맞춰 부호와 함께. 0이면 부호 없이.
function pinSignedDiff(a, b) {
  const dp = Math.min(Math.max(pinReadingDecimals(a), pinReadingDecimals(b)), 4);
  const diff = readingNumber(a) - readingNumber(b);
  const fixed = Math.abs(diff).toFixed(dp);
  if (Number(fixed) === 0) return fixed;
  return (diff > 0 ? '+' : '-') + fixed;
}

function readingSummary(pin, today) {
  const { initial, prev, current } = pinReadings(pin, today);
  if (!prev) return { line1: '', line2: '' };
  const hasInitial = !!initial && !samePinEntry(initial, prev);
  const prevPart = `전회 ${prev.text}${pinDateLabel(prev.date)}`;
  const line1 = hasInitial ? `초기치 ${initial.text}${pinDateLabel(initial.date)} · ${prevPart}` : prevPart;
  if (readingNumber(current) === null || readingNumber(prev.text) === null) return { line1, line2: '' };
  let line2 = `변화 ${pinSignedDiff(current, prev.text)}`;
  if (hasInitial && readingNumber(initial.text) !== null) line2 += ` · 누적 ${pinSignedDiff(current, initial.text)}`;
  return { line1, line2 };
}

// 같은 계측기인지: 같은 쪽·종류·번호(W1, L1-1단 …). 번호 없는 동그라미는 다른 파일과 짝짓지 않는다
const pinKeyOf = (p) => (p && p.num ? `${p.page || 1}|${p.type || ''}|${p.num}` : '');

// 같은 도면 묶음의 저장본들(sources: [{ date: 파일 이름의 날짜, user: 저장한 사람, pins }])에서 이 계측기의 지난 기록을 모은다.
// 직원이 측정할 때마다 원본에서 새 저장본을 만들어 동그라미의 history 사슬이 끊겨도, 저장본마다 남은 값으로 '언제·무슨 값·누가'를 되살린다.
// 동그라미에 적은 날(date)이 없으면(옛 판·PC 에서 적은 값) 그 저장본 파일의 날짜를 쓴다
function familyPinHistory(pin, sources) {
  const key = pinKeyOf(pin);
  if (!key || !Array.isArray(sources)) return [];
  const out = [];
  for (const s of sources) {
    for (const p of (s && Array.isArray(s.pins) ? s.pins : [])) {
      if (pinKeyOf(p) !== key) continue;
      for (const h of Array.isArray(p.history) ? p.history : []) {
        if (h && typeof h === 'object' && h.text) out.push({ date: h.date || '', text: String(h.text), author: h.author || '' });
      }
      if (p.text) out.push({ date: p.date || s.date || '', text: String(p.text), author: p.author || s.user || '' });
    }
  }
  return out;
}

// 지난 기록 합치기: 날짜·값이 같은 것은 하나로(사람 이름이 있는 쪽을 남김), 오래된 것부터(날짜 모르는 것은 맨 앞)
function mergePinPast(list) {
  const byKey = new Map();
  for (const h of list) {
    if (!h || !h.text) continue;
    const k = `${h.date || ''}|${h.text}`;
    const had = byKey.get(k);
    if (!had || (!had.author && h.author)) byKey.set(k, { date: h.date || '', text: h.text, ...(h.author ? { author: h.author } : {}) });
  }
  const dated = new Set([...byKey.values()].filter((h) => h.date).map((h) => h.text));
  return [...byKey.values()]
    .filter((h) => h.date || !dated.has(h.text))   // 날짜 모르는 값이 다른 저장본에 날짜와 함께 있으면 그쪽만
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-MAX_PIN_LIST);
}

// 메모 상자 카드용 값: 지난 값 전부(past, 오래된 것부터)와 오늘 값, 전회·초기치 대비 변화.
// extra: 같은 묶음 다른 저장본에서 모은 이 계측기의 기록(familyPinHistory). 오늘 날짜 것은 '오늘' 칸과 겹치므로 뺀다
function readingTiles(pin, today, extra = []) {
  const history = Array.isArray(pin?.history) ? pin.history.filter((h) => h && typeof h === 'object') : [];
  const isToday = pin?.date === today;
  const own = !isToday && pin?.text ? [{ date: pin.date || '', text: pin.text, author: pin.author || '' }] : [];
  const others = (Array.isArray(extra) ? extra : []).filter((h) => h && h.date !== today);
  const past = mergePinPast([...history, ...others, ...own]);
  const initial = past[0] || null;
  const prev = past[past.length - 1] || null;
  const sameInitialPrev = past.length === 1;
  const current = isToday ? String(pin.text ?? '') : '';
  const numeric = (t) => readingNumber(t) !== null;
  const delta = prev && numeric(current) && numeric(prev.text) ? pinSignedDiff(current, prev.text) : null;
  const cumulative = initial && !sameInitialPrev && numeric(current) && numeric(initial.text)
    ? pinSignedDiff(current, initial.text) : null;
  return { past, initial, prev, sameInitialPrev, current, delta, cumulative };
}

// 계측용(번호만) 도면 메모: 지난 측정일의 값은 history 로 넘기고 비운다. 오늘 적은 값은 그대로, 펜 필기는 뺀다
function templateNotes(notes, today) {
  const src = notes && typeof notes === 'object' ? notes : {};
  const pins = Array.isArray(src.pins)
    ? src.pins.map((p) => (p && p.text && (p.date || '') !== today ? pushPinHistory(p, '', today) : p))
    : [];
  const out = { pins, strokes: {} };
  if (src.sourceId) out.sourceId = src.sourceId;
  if (src.gps) out.gps = src.gps;
  return out;
}

// 셀 한 칸 글자 수 제한에 맞게 history를 줄인다 → { notes, dropped }(뺀 지난 기록 수). 입력은 안 바꾼다.
// 어떤 기록을 뺄지는 Rust trim.rs(가장 오래된 것부터)가 정한다. 여기는 그 목록대로 빼기만 한다
function trimNotesForCellInfo(notes, maxLen = 45000) {
  if (!notes || !Array.isArray(notes.pins)) return { notes, dropped: 0 };
  const core = typeof globalThis !== 'undefined' ? globalThis.RustCore : null;
  const plan = core && typeof core.trimPlan === 'function' ? core.trimPlan(JSON.stringify(notes), maxLen) : null;
  if (!plan) return { notes: null, dropped: 0, unavailable: true };   // wasm 없음: 자르지도 보내지도 않는다(사용자 결정 2026-11-19)
  if (!plan.length) return { notes, dropped: 0 };
  const drop = new Set(plan.map(([pi, hi]) => `${pi}:${hi}`));
  const pins = notes.pins.map((p, pi) => (p && Array.isArray(p.history)
    ? { ...p, history: p.history.filter((_, hi) => !drop.has(`${pi}:${hi}`)) } : p));
  return { notes: { ...notes, pins }, dropped: plan.length };
}

// 예전 호출처용: 줄인 메모만 돌려준다. wasm 이 없으면 null(부르는 쪽은 보내지 않는다)
function trimNotesForCell(notes, maxLen = 45000) {
  return trimNotesForCellInfo(notes, maxLen).notes;
}

// wasm 이 없을 때 던지는 오류: 서버(Code.gs)가 같은 코드로 거절할 때와 같게 보관함(outbox.js)이 지우지 않고 보관한다
function coreUnavailableError() {
  const e = new Error('계산 모듈을 아직 못 불러왔습니다. 입력은 이 폰에 보관했으니 잠시 후 다시 시도합니다.');
  e.code = 'core_unavailable';
  return e;
}
// 보내기 직전용: 줄인 메모를 돌려주거나, wasm 이 없으면 core_unavailable 을 던진다
function trimNotesOrHold(notes, maxLen = 45000) {
  const r = trimNotesForCellInfo(notes, maxLen);
  if (r.unavailable) throw coreUnavailableError();
  return r.notes;
}

if (typeof module !== 'undefined') {
  module.exports = {
    MAX_PIN_HISTORY, readingNumber, pushPinHistory, pinReadings, readingSummary, trimNotesForCell, trimNotesForCellInfo, trimNotesOrHold, coreUnavailableError,
    pinSignedDiff, readingTiles, templateNotes, familyPinHistory, mergePinPast,
  };
}
