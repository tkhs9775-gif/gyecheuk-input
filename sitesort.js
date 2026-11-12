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
  // 순수 함수(시험용): recent = { 현장: 연 시각(ms) }
  const order = (sites, m, recent = {}) => {
    const byName = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
    const list = [...(sites || [])];
    if (m !== 'recent') return list.sort(byName);
    return list.sort((a, b) => (recent[b] || 0) - (recent[a] || 0) || byName(a, b));
  };
  const sorted = (key, sites) => order(sites, mode(key), read(`sitesort_recent_${key}`, {}));
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
  return { mode, setMode, touch, order, sorted, control };
})();

if (typeof module !== 'undefined') module.exports = { SiteSort };
