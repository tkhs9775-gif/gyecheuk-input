// 주간업무추진계획서(표) 판독: 글자 조각과 그 위치만 받아 날짜별 일정으로 바꾼다(화면·파일과 무관한 순수 함수).
// 휴대폰(web/schedule.js)과 PC(pc-app/ui/schedule-parse.js 복사본)가 같이 쓴다. 바꾸면 두 곳 다 바꾼다.
//
// 입력 items: [{ str, x0, y0, x1, y1 }] — 왼쪽 위가 (0,0), 아래로 갈수록 y 가 크다(PDF 글자층·OCR 단어 둘 다 이 모양으로 맞춰 넣는다)
// 표 모양(2026-11 계획서 기준): 머리줄에 '2026.11.09.~2026.11.13.' 기간과 그 아래 '월 화 수 목 금 토' 칸,
//   줄마다 No · 추진업무(현장) · 요일 칸의 'ㅇ' · 비고. 표 아래 'MEMO' 다음 줄은 자유 메모(날짜가 적혀 있으면 그날 일정).
// opts.inkAt({x0,y0,x1,y1}) → 0~1: 사진 판독 때 칸 안의 잉크 비율(OCR 이 작은 동그라미를 놓쳐도 잡는다). PDF 글자층이면 안 준다.

(function (root) {
  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];   // 0=월요일
  const MARK = /^[oO0ㅇ○◯●◎°Q]+$/;   // 동그라미로 읽힐 수 있는 글자들(OCR 은 o·0·Q 로 읽기도 한다)
  const INK_MIN = 0.035;   // 칸 안쪽 잉크 비율이 이보다 크면 표시된 것으로 본다(빈 칸은 0~1%, 'ㅇ' 은 5% 이상)
  const MEMO_WORD = /^(memo|메모)$/i;

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const validDate = (y, m, d) => { const t = utc(y, m, d); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t : null; };
  const addDays = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };
  const dowOf = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;   // 월요일=0 … 일요일=6
  const mondayOf = (iso) => addDays(iso, -dowOf(iso));
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const yc = (it) => (it.y0 + it.y1) / 2;
  const xc = (it) => (it.x0 + it.x1) / 2;
  const squash = (s) => s.replace(/\s+/g, '');

  // 'YYYY.MM.DD.~YYYY.MM.DD.' (점·빼기·빗금·년월일, 공백 허용, 끝 연도 생략 가능)
  const PERIOD = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*[.일]?\s*[~∼〜～-]\s*(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/;

  function findPeriod(text) {
    const m = PERIOD.exec(text) || PERIOD.exec(squash(text));
    if (!m) return null;
    const y = Number(m[1]);
    const start = validDate(y, Number(m[2]), Number(m[3]));
    const end = validDate(m[4] ? Number(m[4]) : y, Number(m[5]), Number(m[6]));
    if (!start || !end || end < start || (end - start) / 86400000 > 13) return null;
    return { start: ymd(start), end: ymd(end) };
  }

  // 여러 글자짜리 조각('월화수' 'ㅇㅇㅇ')은 폭을 글자 수로 나눠 한 글자씩으로 쪼갠다
  function splitChars(it) {
    const chars = [...squash(it.str)];
    if (chars.length <= 1) return [{ ...it, str: chars[0] || '' }];
    const w = (it.x1 - it.x0) / chars.length;
    return chars.map((c, i) => ({ ...it, str: c, x0: it.x0 + w * i, x1: it.x0 + w * (i + 1) }));
  }

  // 같은 높이(가로줄)에 있는 조각끼리 묶는다
  function groupRows(list, tol) {
    const sorted = [...list].sort((a, b) => yc(a) - yc(b));
    const rows = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(yc(it) - last.y) <= tol) {
        last.items.push(it);
        last.y = last.items.reduce((s, x) => s + yc(x), 0) / last.items.length;
      } else rows.push({ y: yc(it), items: [it] });
    }
    return rows;
  }

  // 요일 머리줄: 요일 글자가 가장 많이 모인 가로줄. 빠진 요일(OCR 이 놓친 칸)은 다른 칸 간격으로 채운다
  function findDayColumns(items, tol) {
    const cands = items.filter((it) => /^[월화수목금토일]+$/.test(squash(it.str))).flatMap(splitChars);
    let best = null;
    for (const row of groupRows(cands, tol)) {
      const byDow = new Map();
      for (const it of row.items) if (!byDow.has(DAYS.indexOf(it.str))) byDow.set(DAYS.indexOf(it.str), it);
      const weekdays = [0, 1, 2, 3, 4].filter((d) => byDow.has(d)).length;
      if (weekdays >= 3 && (!best || byDow.size > best.byDow.size)) best = { byDow };
    }
    if (!best) return null;
    // 칸 중심 = a + b*요일 (최소제곱). 표 칸은 폭이 같다
    const pts = [...best.byDow].map(([d, it]) => [d, xc(it)]);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    const b = sxx ? pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
    if (b <= 0) return null;
    const a = my - b * mx;
    const last = Math.max(5, ...best.byDow.keys());   // 토요일까지는 늘 둔다(일요일은 머리줄에 있을 때만)
    const cols = [];
    for (let d = 0; d <= last; d += 1) cols.push({ dow: d, cx: a + b * d });
    const its = [...best.byDow.values()];
    return { cols, width: b, bottom: Math.max(...its.map((i) => i.y1)) };
  }

  // 사진: OCR 이 요일 글자를 못 읽으면('월화'→'aH') 그림에서 찾은 세로 칸선(opts.vlines, x 목록)으로 요일 칸을 잡는다.
  // 폭이 거의 같은 좁은 칸이 6~7개 잇달아 있는 곳 = 월~토(일). 머리줄 아래 경계는 기간 글자 바로 아래 줄
  function columnsFromLines(vlines, items, tol, lineH) {
    const xs = [...new Set(vlines.map(Math.round))].sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 1) {
      const gaps = [];
      for (let j = i; j + 1 < xs.length; j += 1) {
        const g = xs[j + 1] - xs[j];
        if (g < lineH * 1.2 || g > lineH * 8) break;
        if (gaps.length && Math.abs(g - median(gaps)) > median(gaps) * 0.2) break;
        gaps.push(g);
      }
      if (gaps.length >= 6 && gaps.length <= 7 && (!best || gaps.length > best.n)) best = { i, n: gaps.length };
    }
    if (!best) return null;
    const cols = [];
    for (let d = 0; d < best.n; d += 1) cols.push({ dow: d, cx: (xs[best.i + d] + xs[best.i + d + 1]) / 2 });
    const width = (xs[best.i + best.n] - xs[best.i]) / best.n;
    const L = xs[best.i];
    const R = xs[best.i + best.n];
    const inCols = (it) => xc(it) > L && xc(it) < R;
    const periodY = Math.max(-Infinity, ...items.filter((it) => /20\d\d\s*[.\-/년]/.test(it.str) && xc(it) > L - width * 2 && xc(it) < R + width * 2).map((it) => it.y1));
    const below = groupRows(items.filter((it) => inCols(it) && yc(it) > periodY), tol);
    if (!below.length) return null;
    return { cols, width, bottom: Math.max(...below[0].items.map((it) => it.y1)) };
  }

  // 메모 줄에 적힌 날짜: '2026년 11월 10일' '11월 10일' '11/10' '11.10'
  // period 를 주면 OCR 오독도 되살린다: 굵은 '2026년 11월 10일' 을 '20264 118 102' 로 읽는다(년→4, 월→8, 일→2).
  // 끝 글자를 뗀 값이 계획서 기간 ±7일 안에 들 때만 쓴다(엉뚱한 숫자를 날짜로 잡지 않게)
  function noteDate(text, year, period) {
    let m = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text);
    if (!m) m = /(?:(\d{4})[./-])?\b(\d{1,2})[./](\d{1,2})\b/.exec(text);
    if (m) {
      const t = validDate(m[1] ? Number(m[1]) : year, Number(m[2]), Number(m[3]));
      return t ? ymd(t) : null;
    }
    const g = period && /(20\d\d)\d?\s+(\d{2,3})\s+(\d{2,3})/.exec(text);
    if (!g) return null;
    const cut = (s) => (s.length === 3 ? s.slice(0, 2) : s);
    const t = validDate(Number(g[1]), Number(cut(g[2])), Number(cut(g[3])));
    if (!t) return null;
    const iso = ymd(t);
    return iso >= addDays(period.start, -7) && iso <= addDays(period.end, 7) ? iso : null;
  }

  // 조각을 왼쪽부터 잇는다. OCR 은 한글을 한 글자씩 끊어 주므로, 틈이 글자 높이의 0.35배보다 좁으면 붙이고 넓으면 띄운다
  function joinText(list) {
    const s = [...list].filter((it) => it.str.trim()).sort((p, q) => p.x0 - q.x0);
    let out = '';
    let prev = null;
    for (const it of s) {
      const h = Math.min(it.y1 - it.y0, prev ? prev.y1 - prev.y0 : Infinity);
      out += prev && it.x0 - prev.x1 < h * 0.35 ? it.str.trim() : `${out ? ' ' : ''}${it.str.trim()}`;
      prev = it;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // 결과: { period, weekStart, rows:[{no,title,memo,days:[요일]}], notes:[{text,date}], warnings:[] }
  // 날짜 붙은 일정은 entriesOf(결과, 주 시작)로 만든다(주 시작을 사용자가 고칠 수 있게 나눠 둔다)
  function parseWeeklyPlan(rawItems, opts = {}) {
    const items = (rawItems || []).filter((it) => it && typeof it.str === 'string' && it.str.trim() && it.x1 > it.x0 && it.y1 > it.y0)
      .map((it) => ({ str: it.str.trim(), x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1 }));
    const warnings = [];
    const lineH = median(items.map((it) => it.y1 - it.y0)) || 10;
    const tol = lineH * 0.55;
    const period = findPeriod(groupRows(items, tol).map((r) => joinText(r.items)).join('\n'));
    const weekStart = period ? mondayOf(period.start) : null;
    const head = findDayColumns(items, tol) || (Array.isArray(opts.vlines) ? columnsFromLines(opts.vlines, items, tol, lineH) : null);
    if (!head) return { period, weekStart, rows: [], notes: [], warnings: ['요일 칸(월 화 수 목 금 토)을 찾지 못했습니다. 표 전체가 똑바로 나오게 다시 찍거나 PDF 로 올려 주세요.'] };
    const colL = head.cols[0].cx - head.width / 2;
    const colR = head.cols[head.cols.length - 1].cx + head.width / 2;
    const dowAt = (x) => {
      const d = Math.round((x - head.cols[0].cx) / head.width);
      return d >= 0 && d < head.cols.length ? head.cols[d].dow : -1;
    };

    // 표 몸통: 요일 머리줄 아래. 'MEMO' 줄이 있으면 그 위까지가 표, 아래는 메모
    const body = items.filter((it) => yc(it) > head.bottom);
    const memoHead = body.find((it) => MEMO_WORD.test(squash(it.str)));
    const memoY = memoHead ? yc(memoHead) : Infinity;
    const table = body.filter((it) => yc(it) < memoY - tol);

    const left = table.filter((it) => xc(it) < colL);
    const right = table.filter((it) => xc(it) > colR);
    const marks = table.filter((it) => xc(it) >= colL && xc(it) <= colR && MARK.test(squash(it.str))).flatMap(splitChars);

    const rows = groupRows(left, tol).map((r) => {
      const text = joinText(r.items);
      const m = /^(\d{1,3})\s+(.+)$/.exec(text);
      return { y: r.y, no: m ? Number(m[1]) : null, title: (m ? m[2] : text).trim(), memo: '', days: new Set() };
    }).filter((r) => r.title && !/^\d+$/.test(r.title));

    const nearest = (y) => {
      let best = null;
      for (const r of rows) if (!best || Math.abs(r.y - y) < Math.abs(best.y - y)) best = r;
      return best && Math.abs(best.y - y) <= lineH ? best : null;
    };
    for (const mk of marks) {
      const r = nearest(yc(mk));
      const d = dowAt(xc(mk));
      if (r && d >= 0) r.days.add(d);
    }
    const memoParts = new Map();
    for (const it of right) {
      const r = nearest(yc(it));
      if (r) memoParts.set(r, [...(memoParts.get(r) || []), it]);
    }
    for (const [r, parts] of memoParts) r.memo = joinText(parts);

    // 사진: OCR 이 놓친 동그라미를 칸 안쪽 잉크로 잡는다(칸 테두리 선은 빼고 가운데만 본다)
    if (typeof opts.inkAt === 'function') {
      const ys = rows.map((r) => r.y);
      const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > lineH * 0.8);
      const rowH = Math.min(median(gaps) || lineH * 1.6, lineH * 2.2);
      for (const r of rows) {
        for (const c of head.cols) {
          if (r.days.has(c.dow)) continue;
          const ink = opts.inkAt({ x0: c.cx - head.width * 0.3, x1: c.cx + head.width * 0.3, y0: r.y - rowH * 0.28, y1: r.y + rowH * 0.28 });
          if (ink >= (opts.inkMin ?? INK_MIN)) r.days.add(c.dow);
        }
      }
    }

    const year = period ? Number(period.start.slice(0, 4)) : (opts.year || new Date().getFullYear());
    const notes = Number.isFinite(memoY)
      ? groupRows(body.filter((it) => it !== memoHead && yc(it) >= memoY - tol), tol)
        .map((r) => joinText(r.items)).filter((t) => t && !MEMO_WORD.test(squash(t))).map((text) => ({ text, date: noteDate(text, year, period) }))
      : [];
    const outRows = rows.filter((r) => r.days.size).map((r) => ({ no: r.no, title: r.title, memo: r.memo, days: [...r.days].sort((p, q) => p - q) }));
    if (!outRows.length) warnings.push('요일 칸에 표시(ㅇ)가 있는 줄을 찾지 못했습니다.');
    if (!period) warnings.push('계획서 기간(예: 2026.11.09.~2026.11.13.)을 찾지 못했습니다. 주 시작일(월요일)을 직접 골라 주세요.');
    return { period, weekStart, rows: outRows, notes, warnings };
  }

  // 판독 결과 + 주 시작(그 주 아무 날) → 날짜별 일정. 메모 줄은 날짜가 적힌 것만(비고 'MEMO')
  function entriesOf(result, weekStart) {
    if (!weekStart) return [];
    const monday = mondayOf(weekStart);
    const out = [];
    for (const r of result.rows) for (const d of r.days) out.push({ date: addDays(monday, d), title: r.title, memo: r.memo });
    for (const n of result.notes) if (n.date) out.push({ date: n.date, title: n.text, memo: 'MEMO' });
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const api = { parseWeeklyPlan, entriesOf, findPeriod, noteDate, mondayOf, addDays, dowOf, DAYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchedParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
