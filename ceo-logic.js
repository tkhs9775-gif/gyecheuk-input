// 감독판(대표님용 휴대폰 화면)의 계산 로직. 화면(ceo.js)과 분리해 node로 시험할 수 있게 했다.
// 기록 시트 열 번호는 Code.gs 의 COL 과 같다. 직원 근태·성실도 분석은 일부러 넣지 않았다.
const COL = {
  time: 0, clientId: 1, site: 2, user: 3, id: 4, type: 5, place: 6, value: 7, unit: 8, prev: 9, delta: 10,
  memo: 11, link: 12, date: 13, value2: 14, value3: 15, prev2: 16, prev3: 17, delta2: 18, delta3: 19,
  status: 20, history: 21, weather: 22,
};

const field = (row, idx) => (idx < row.length && row[idx] != null ? String(row[idx]).trim() : '');
const isActive = (row) => field(row, COL.status) !== '삭제';
const onDate = (row, date) => field(row, COL.date) === date || field(row, COL.time).startsWith(date);
const editedOrDeleted = (records) => records.filter((r) => field(r, COL.status) === '삭제' || field(r, COL.history) !== '');
const uniqueNonEmpty = (rows, idx) => [...new Set(rows.map((r) => field(r, idx)).filter(Boolean))];

function summarize(date, records, issues, sites) {
  const today = records.filter((r) => isActive(r) && onDate(r, date));
  return {
    todayCount: today.length,
    activeSites: uniqueNonEmpty(today, COL.site).length,
    totalSites: sites.length,
    issueCount: issues.length,
    editedCount: editedOrDeleted(records).length,
  };
}

// 현장별로 기준일에 측정된 계측기 수를 센다. 현장이 비어 있는 계측기는 모든 현장 공통이다.
function siteCoverage(date, sites, instruments, activeRecords) {
  return sites.map((site) => {
    const insts = instruments.filter((i) => !i.site || i.site === site);
    const today = activeRecords.filter((r) => field(r, COL.site) === site && onDate(r, date));
    const byId = new Map(today.map((r) => [field(r, COL.id), r]));
    const done = insts.filter((i) => byId.has(i.id)).length;
    const total = insts.length;
    const missing = Math.max(0, total - done);
    const rate = total > 0 ? Math.round((done / total) * 100) : (today.length ? 100 : 0);
    const level = total > 0 && missing === 0 ? 'complete' : (today.length ? 'partial' : 'zero');
    const items = insts.map((inst) => {
      const rec = byId.get(inst.id);
      return { inst, rec, state: !rec ? 'missing' : (field(rec, COL.status) ? 'issue' : 'done') };
    });
    const last = today.reduce((max, r) => (field(r, COL.time) > max ? field(r, COL.time) : max), '') || '-';
    return { site, total, done, missing, rate, level, workers: uniqueNonEmpty(today, COL.user).sort(), last, items };
  });
}

// 최신 기록이 위로 오게 뒤집고, 현장·검색어로 거른다
function filterFeed(records, { site = '', keyword = '' } = {}) {
  const kw = keyword.trim().toLowerCase();
  return [...records].reverse().filter((r) => {
    if (site && site !== '전체' && field(r, COL.site) !== site) return false;
    return !kw || r.join(' ').toLowerCase().includes(kw);
  });
}

function valueText(row) {
  const vals = [COL.value, COL.value2, COL.value3].map((i) => field(row, i)).filter(Boolean);
  return vals.length ? `${vals.join(' / ')} ${field(row, COL.unit)}`.trim() : '-';
}

// 도면 야장(동그라미 메모·펜 필기) 시트 한 줄을 사람이 읽을 요약으로 바꾼다
function summarizeNote(row) {
  const out = { updated: field(row, 0), site: field(row, 2), fileName: field(row, 3), user: field(row, 4), pinCount: 0, strokeCount: 0, summary: '' };
  const raw = field(row, 5);
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    const pins = parsed.pins || [];
    const strokes = parsed.strokes || {};
    const texts = pins.map((p, i) => `#${i + 1}(${p.page || 1}쪽): ${p.text || '(빈 마커)'}`);
    return {
      ...out,
      pinCount: pins.length,
      strokeCount: Object.values(strokes).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0),
      summary: texts.length ? texts.join(' | ') : '자유 펜 필기만 있음',
    };
  } catch {
    return { ...out, summary: raw.slice(0, 100) };
  }
}

// 서버에서 온 주소는 http(s)만 링크로 쓴다 (javascript:, intent: 등은 앱 안에서 실행될 수 있다)
const isWebUrl = (s) => /^https?:\/\//i.test(s);
const splitLinks = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(isWebUrl);

// 드라이브 트리(사진·측량·도면)를 한 줄짜리 파일 목록으로 편다
function driveItems(drive) {
  const d = drive || {};
  const item = (category, site, f) => ({ category, site, name: f.name || '', updated: f.updated || '', sizeKb: Math.round((Number(f.size) || 0) / 1024), id: f.id || '', url: isWebUrl(f.url || '') ? f.url : '', mime: f.mime || '' });
  const out = [];
  for (const g of d.photos || []) for (const f of g.files || []) out.push(item('사진', g.site || '', f));
  for (const g of d.surveys || []) for (const k of g.kinds || []) for (const f of k.files || []) out.push(item(`측량·${k.kind || ''}`, g.site || '', f));
  for (const g of d.drawings || []) for (const f of g.files || []) out.push(item('도면', g.site || '', f));
  return out;
}

if (typeof module !== 'undefined') module.exports = { COL, field, isActive, onDate, summarize, siteCoverage, filterFeed, valueText, editedOrDeleted, summarizeNote, splitLinks, driveItems };
