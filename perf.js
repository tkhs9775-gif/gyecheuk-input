// 속도 기록: 도면 열기·저장과 서버 요청의 단계별 시간(ms)을 performance.mark/measure 로 재고, 최근 PERF_KEEP 건을 폰(localStorage)에 남긴다.
// 정보 탭 '속도 기록'에서 본다. 파일 이름·값 같은 내용은 남기지 않는다(단계 이름·시간·바이트/글자 수만).
// perf.js 가 아직 없는 옛 앱 사본에서도 멈추지 않게, 쓰는 쪽은 window.perfTrace?.() 처럼 부른다.

const PERF_KEEP = 20;
const PERF_KEYS = { trace: 'perfLog', api: 'perfApiLog' };
let perfSeq = 0;

const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
function perfMarkSafe(name) { try { performance.mark(name); } catch { /* 옛 브라우저 */ } }
function perfMeasureSafe(name, start, end) { try { performance.measure(name, start, end); } catch { /* 옛 브라우저 */ } }

function perfRead(kind) {
  try { const v = JSON.parse(localStorage.getItem(PERF_KEYS[kind]) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// 순수 함수: 기록 목록 끝에 하나를 더하고 최근 keep 건만 남긴 새 배열
const perfAppend = (list, entry, keep = PERF_KEEP) => [...(Array.isArray(list) ? list : []), entry].slice(-keep);

function perfSave(kind, entry) {
  try { localStorage.setItem(PERF_KEYS[kind], JSON.stringify(perfAppend(perfRead(kind), entry))); } catch { /* 저장 못 해도 앱은 그대로 */ }
}

// 한 동작(open·save)의 기록. step(name, n) 은 시작부터 지금까지 ms 를 적고, end(result) 가 한 줄로 저장한다(두 번 불러도 한 번)
function perfTrace(kind) {
  const id = `${kind}#${++perfSeq}`;
  const t0 = perfNow();
  const steps = [];
  let done = false;
  perfMarkSafe(`${id}:start`);
  return {
    step(name, n) {
      if (done) return;
      perfMarkSafe(`${id}:${name}`);
      perfMeasureSafe(`${kind}:${name}`, `${id}:start`, `${id}:${name}`);
      steps.push(n == null ? [name, Math.round(perfNow() - t0)] : [name, Math.round(perfNow() - t0), n]);
    },
    end(result = 'ok') {
      if (done) return;
      done = true;
      perfSave('trace', { kind, at: Date.now(), total: Math.round(perfNow() - t0), result, steps });
      // 이 기록의 표시만 지운다(동시에 진행 중인 다른 기록의 시작 표시는 남게). 잰 값은 위에서 이미 저장했다
      try { for (const name of ['start', ...steps.map((s) => s[0])]) performance.clearMarks(`${id}:${name}`); } catch { /* 옛 브라우저 */ }
    },
  };
}

// 서버 요청 한 번: api:<action>, 걸린 ms, 보낸·받은 글자 수, 결과(ok·오류 코드·network)
function perfApi(action, ms, sent, got, result) {
  perfSave('api', { action, at: Date.now(), ms: Math.round(ms), sent, got, result });
  try { window.errlogApi?.(action, ms, result); } catch { /* 오류 기록(errlog.js)이 없거나 실패해도 그대로 */ }
}

// 순수 함수: 기록 한 줄을 사람이 읽는 글로
function perfLine(e) {
  const d = new Date(e.at);
  const two = (v) => String(v).padStart(2, '0');
  const when = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  if (e.action) return `${when} api:${e.action} ${e.ms}ms · 보냄 ${e.sent} · 받음 ${e.got}자${e.result === 'ok' ? '' : ` · ${e.result}`}`;
  const kindName = { open: '열기', save: '저장' }[e.kind] || e.kind;
  const steps = (e.steps || []).map(([name, ms, n]) => `${name} ${ms}${n == null ? '' : `(${n})`}`).join(' · ');
  return `${when} ${kindName} ${e.total}ms${e.result === 'ok' ? '' : ` [${e.result}]`} · ${steps}`;
}

function perfReport() {
  return [...perfRead('trace').reverse().map(perfLine), '', ...perfRead('api').reverse().map(perfLine)].join('\n').trim();
}

function perfClear() {
  try { localStorage.removeItem(PERF_KEYS.trace); localStorage.removeItem(PERF_KEYS.api); } catch { /* 무시 */ }
}

if (typeof module !== 'undefined') module.exports = { perfAppend, perfLine, PERF_KEEP };
