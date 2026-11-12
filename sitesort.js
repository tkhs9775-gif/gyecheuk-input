// 현장 목록 정렬(2026-11-12): [가나다 | 최근] 두 가지. 휴대폰(web)과 PC(pc-app/ui)가 같은 파일을 쓴다(pc-app/test_pc.py 가 같은지 검사).
// '최근' = 이 기기에서 그 현장을 마지막으로 연 순서(서버·Drive 를 거치지 않는다). 연 적 없는 현장은 뒤에 가나다순.
// 탭(key: 'drawing' | 'cad')마다 고른 방식과 연 기록을 따로 기기에 둔다.
const SiteSort = (() => {
  const MODES = ['name', 'recent'];
  const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 공간이 없으면 정렬만 기억 못 한다 */ } };
  const mode = (key) => (MODES.includes(read(`sitesort_mode_${key}`, '')) ? read(`sitesort_mode_${key}`, '') : 'name');
  const setMode = (key, m) => write(`sitesort_mode_${key}`, MODES.includes(m) ? m : 'name');
  const touch = (key, site, now = Date.now()) => { if (site) write(`sitesort_recent_${key}`, { ...read(`sitesort_recent_${key}`, {}), [site]: now }); };
  // 순수 함수(시험용): recent = { 현장: 연 시각(ms) }. hint(현장) = 연 기록이 없는 현장의 보조 시각(ms, 예: 폰에 보관된 목록의 최근 파일 날짜)
  // 순서: 이 기기에서 연 현장(연 순) → 연 적 없지만 hint 있는 현장(hint 순) → 나머지 가나다
  const order = (sites, m, recent = {}, hint = () => 0) => {
    const byName = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
    const list = [...(sites || [])];
    if (m !== 'recent') return list.sort(byName);
    const h = new Map(list.map((s) => [s, recent[s] ? 0 : (Number(hint(s)) || 0)]));
    return list.sort((a, b) => (recent[b] || 0) - (recent[a] || 0) || h.get(b) - h.get(a) || byName(a, b));
  };
  // 보관된 목록 { files, folders:[{files}] } 의 가장 최근 파일 시각(ms). updated 는 'YYYY-MM-DD HH:mm'. 없으면 0
  const newest = (files = [], folders = []) => Math.max(0, ...[...(files || []), ...(folders || []).flatMap((fo) => fo?.files || [])]
    .map((f) => Date.parse(String(f?.updated || '').replace(' ', 'T')) || 0));
  // 현장별 hint 를 한 번만 계산해 기억(보관 목록 JSON 을 버튼 누를 때마다 다시 읽으면 느린 태블릿에서 0.1초 넘게 걸린다). 탭에 들어올 때 clear()
  const cached = (fn) => { const m = new Map(); const f = (s) => { if (!m.has(s)) m.set(s, fn(s)); return m.get(s); }; f.clear = () => m.clear(); return f; };
  // 탭이 뜬 뒤 쉬는 틈에 hint 를 미리 계산(첫 [최근 연 순] 터치도 바로 바뀌게)
  const warm = (fn, sites) => (globalThis.requestIdleCallback || setTimeout)(() => (sites || []).forEach((s) => fn(s)));
  const sorted = (key, sites, hint) => order(sites, mode(key), read(`sitesort_recent_${key}`, {}), hint);
  // [가나다 | 최근 연 순] 버튼 묶음. onChange 는 다시 그리는 함수. cls 는 web '.seg', PC 'seg-group'
  const control = (key, onChange, cls = 'seg', btnCls = '') => {
    const nav = document.createElement('div');
    nav.className = cls;
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', '현장 정렬');
    const paint = () => nav.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.mode === mode(key);
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('active', on);
    });
    for (const [m, label] of [['name', '가나다'], ['recent', '최근 연 순']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m;
      b.textContent = label;
      if (btnCls) b.className = btnCls;
      b.addEventListener('click', () => { setMode(key, m); paint(); onChange(); });
      nav.append(b);
    }
    paint();
    return nav;
  };
  return { mode, setMode, touch, order, sorted, newest, cached, warm, control };
})();

if (typeof module !== 'undefined') module.exports = { SiteSort };
