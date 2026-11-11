// 홈 일정 캘린더(2026-11-11): 월 달력 + 고른 날의 일정 + 일정 기입(직접 / 주간 계획서 PDF·JPG·PNG 판독).
// 일정은 서버 시트 '일정' 탭에 쌓이고 모든 직원·PC 가 같이 본다(Code.gs schedule_list/add/delete).
// 판독 규칙은 schedule-parse.js(순수 함수). 여기서는 파일 → 글자 조각(PDF 글자층 또는 OCR 단어) 만들기와 화면만 맡는다.
// app.js 다음에 읽힌다: $, api, state, store, flash, errorText, todayKst 를 쓴다.

const SCHED_MAX_PAGES = 5;          // 계획서 PDF 는 보통 1쪽. 이보다 많으면 앞쪽만 읽는다
const SCHED_MIN_TEXT_ITEMS = 15;    // PDF 글자층 조각이 이보다 적으면 스캔본으로 보고 그림으로 OCR
const SCHED_MAX_FILE = 25 * 1024 * 1024;
const SCHED_SEND_CHUNK = 250;       // 서버 한 번에 300건까지
const SCHED_FILE_RE = /\.(pdf|jpe?g|png)$/i;

const sched = {
  month: '',          // 보고 있는 달 'YYYY-MM'
  selected: '',       // 고른 날 'YYYY-MM-DD'
  byDate: new Map(),  // 날짜 → 일정 목록(보이는 달력 범위만)
  seq: 0,
  import: null,       // { result, fileName, entries, checked:Set }
};

const schedPad = (n) => String(n).padStart(2, '0');
const schedIso = (y, m, d) => `${y}-${schedPad(m)}-${schedPad(d)}`;
const schedDow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();   // 0=일
const schedLabel = (iso) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 (${'일월화수목금토'[schedDow(iso)]})`;

// 보이는 달력의 첫 칸(그달 1일이 든 주의 일요일)과 마지막 칸
function schedRange(month) {
  const [y, m] = month.split('-').map(Number);
  const first = schedIso(y, m, 1);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = SchedParse.addDays(first, -schedDow(first));
  const last = schedIso(y, m, days);
  const to = SchedParse.addDays(last, 6 - schedDow(last));
  return { from, to };
}

// 일정 제목이 지금 고른 현장과 같은 곳인지(띄어쓰기·괄호 꼬리 '(윤)' 무시, 앞 10글자 기준)
const schedNorm = (s) => String(s || '').replace(/\([^)]*\)/g, '').replace(/[\s\-·.,_]/g, '');
function schedMine(item) {
  const site = schedNorm(state.site);
  if (site.length < 3) return false;
  const t = schedNorm(item.title);
  return t.includes(site.slice(0, 10)) || site.includes(t.slice(0, 10));
}

function schedCacheKey(from) { return `sched:${from}`; }

async function schedLoad() {
  const { from, to } = schedRange(sched.month);
  const cached = (() => { try { return JSON.parse(store.get(schedCacheKey(from)) || 'null'); } catch { return null; } })();
  if (Array.isArray(cached)) schedSet(cached);
  const seq = ++sched.seq;
  try {
    const { items } = await api('schedule_list', { from, to });
    if (seq !== sched.seq) return;
    const list = Array.isArray(items) ? items : [];
    store.set(schedCacheKey(from), JSON.stringify(list));
    schedSet(list);
    $('schedNote').textContent = '';
  } catch (err) {
    if (seq !== sched.seq) return;
    if (err.isAuth) { signOut(); return; }
    $('schedNote').textContent = err.code === 'bad_action'
      ? '서버가 아직 옛 버전이라 일정을 볼 수 없습니다(관리자: Code.gs 새 버전 배포).'
      : `${cached ? '저장해 둔 일정을 보여 줍니다. ' : ''}${err.network ? '신호가 없어 최신 일정을 받지 못했습니다.' : `일정을 불러오지 못했습니다. ${errorText(err)}`}`;
    if (!cached) schedSet([]);
  }
}

function schedSet(list) {
  sched.byDate = new Map();
  for (const it of list) {
    if (!it || !it.date) continue;
    if (!sched.byDate.has(it.date)) sched.byDate.set(it.date, []);
    sched.byDate.get(it.date).push(it);
  }
  schedRender();
}

function schedRender() {
  if (!sched.month) return;
  const [y, m] = sched.month.split('-').map(Number);
  $('schedMonth').textContent = `${y}년 ${m}월`;
  const { from, to } = schedRange(sched.month);
  const today = todayKst();
  const cells = [];
  for (let d = from; d <= to; d = SchedParse.addDays(d, 1)) {
    const list = sched.byDate.get(d) || [];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sched-cell';
    if (d.slice(0, 7) !== sched.month) b.classList.add('out');
    if (schedDow(d) === 0) b.classList.add('sun');
    if (schedDow(d) === 6) b.classList.add('sat');
    if (d === today) b.classList.add('today');
    if (d === sched.selected) b.classList.add('sel');
    b.dataset.date = d;
    b.setAttribute('aria-pressed', String(d === sched.selected));
    b.setAttribute('aria-label', `${schedLabel(d)}${d === today ? ' 오늘' : ''} 일정 ${list.length}건`);
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(Number(d.slice(8, 10)));
    b.append(num);
    if (list.some(SchedParse.isNotice)) {
      b.classList.add('notice');
      const n = document.createElement('span');
      n.className = 'nt';
      n.setAttribute('aria-hidden', 'true');
      n.textContent = '📢';
      b.append(n);
    }
    if (list.length) {
      const cnt = document.createElement('span');
      cnt.className = list.some(schedMine) ? 'c mine' : 'c';
      cnt.textContent = String(list.length);
      b.append(cnt);
    }
    cells.push(b);
  }
  $('schedGrid').replaceChildren(...cells);
  schedRenderNotice();
  schedRenderDay();
}

// 달력 위 공지 띠: 보이는 달의 연차·휴가 등. 지난 날은 흐리게, 누르면 그날 창
function schedRenderNotice() {
  const box = $('schedNotice');
  const today = todayKst();
  const list = [];
  for (const [d, items] of sched.byDate) {
    if (d.slice(0, 7) !== sched.month) continue;
    for (const it of items) if (SchedParse.isNotice(it)) list.push(it);
  }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  box.hidden = !list.length;
  if (!list.length) { box.replaceChildren(); return; }
  const head = document.createElement('p');
  head.className = 'sn-head';
  head.textContent = `📢 공지 ${list.length}건`;
  const ul = document.createElement('ul');
  ul.className = 'sn-list';
  for (const it of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = it.date < today ? 'sn-item past' : 'sn-item';
    const d = document.createElement('span');
    d.className = 'sn-date';
    d.textContent = `${Number(it.date.slice(5, 7))}/${Number(it.date.slice(8, 10))}(${'일월화수목금토'[schedDow(it.date)]})${it.date === today ? ' 오늘' : ''}`;
    const t = document.createElement('span');
    t.className = 'sn-text';
    t.textContent = SchedParse.noticeText(it.title);
    b.append(d, t);
    b.addEventListener('click', () => schedOpenDay(it.date));
    li.append(b);
    ul.append(li);
  }
  box.replaceChildren(head, ul);
}

// 담당 직원 한 글자마다 정해진 색(같은 사람은 늘 같은 색)
const SCHED_PERSON_COLORS = ['#2B6FB3', '#0E8A5F', '#B4561C', '#7A3FB8', '#C0306B', '#4E6A12'];
const schedPersonColor = (ch) => SCHED_PERSON_COLORS[ch.charCodeAt(0) % SCHED_PERSON_COLORS.length];

// 그날 일정 한 줄: [담당 직원 동그라미] 현장(굵게, 단어 단위 줄바꿈) / 시공사 · 비고 꼬리표 · 기입한 사람
function schedItemEl(it) {
  const { main, company, person } = SchedParse.splitTitle(it.title);
  const memoLine = SchedParse.isNotice(it);   // 공지(연차 등): 창 맨 위에 눈에 띄게
  const li = document.createElement('li');
  li.className = 'sd-item';
  if (schedMine(it)) li.classList.add('mine');
  if (memoLine) li.classList.add('memo');
  const who = document.createElement('span');
  who.className = 'sd-person';
  who.setAttribute('aria-hidden', 'true');
  if (person) { who.textContent = person; who.style.background = schedPersonColor(person); who.title = `담당 ${person}`; } else { who.textContent = memoLine ? '📢' : '·'; who.classList.add('none'); }
  const body = document.createElement('div');
  body.className = 'sd-body';
  const title = document.createElement('p');
  title.className = 'sd-main';
  title.textContent = memoLine ? SchedParse.noticeText(it.title) : main;
  body.append(title);
  const tags = document.createElement('p');
  tags.className = 'sd-tags';
  const tag = (text, cls) => { const t = document.createElement('span'); t.className = `sd-tag ${cls}`; t.textContent = text; tags.append(t); };
  if (schedMine(it)) tag('내 현장', 'mine');
  if (company) tag(company, 'company');
  if (memoLine) tag('공지', 'notice');
  if (it.memo && it.memo !== 'MEMO') tag(it.memo, 'memo');
  if (tags.childElementCount) body.append(tags);
  if (it.user) { const by = document.createElement('p'); by.className = 'sd-by'; by.textContent = `${it.user} 기입`; body.append(by); }
  // 줄을 누르거나 ✎ 를 누르면 수정 창, ✕ 는 바로 지우기(확인 후)
  body.addEventListener('click', () => schedOpenEdit(it));
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'sched-del sched-edit';
  edit.setAttribute('aria-label', `${main} 일정 수정`);
  edit.textContent = '✎';
  edit.addEventListener('click', () => schedOpenEdit(it));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'sched-del';
  del.setAttribute('aria-label', `${main} 일정 삭제`);
  del.textContent = '✕';
  del.addEventListener('click', () => schedDelete(it));
  li.append(who, body, edit, del);
  return li;
}

function schedRenderDay() {
  const d = sched.selected;
  if (!d) return;
  // 공지(연차 등)는 맨 위 → 내 현장 → 담당 직원별 → 이름순(같은 사람 일정이 붙어 보이게)
  const list = [...(sched.byDate.get(d) || [])].sort((a, b) => {
    const A = SchedParse.splitTitle(a.title); const B = SchedParse.splitTitle(b.title);
    return Number(SchedParse.isNotice(b)) - Number(SchedParse.isNotice(a)) || Number(schedMine(b)) - Number(schedMine(a)) || (A.person || '힣').localeCompare(B.person || '힣') || A.main.localeCompare(B.main);
  });
  $('schedDayTitle').textContent = `${schedLabel(d)}${d === todayKst() ? ' · 오늘' : ''}`;
  const people = [...new Set(list.map((x) => SchedParse.splitTitle(x.title).person).filter(Boolean))];
  $('schedDaySub').textContent = list.length ? `일정 ${list.length}건${people.length ? ` · 담당 ${people.join('·')}` : ''}` : '';
  const ul = $('schedList');
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'sd-empty';
    li.textContent = '이 날 일정이 없습니다. 아래 「＋ 이 날 일정 기입」으로 추가하세요.';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...list.map(schedItemEl));
}

// 날짜를 누르면 그날 일정 창. 창 안 ‹ › 로 앞뒤 날(달이 바뀌면 달력도 따라간다)
function schedOpenDay(d) {
  sched.selected = d;
  if (d.slice(0, 7) !== sched.month) schedGo(d.slice(0, 7), d);
  else schedRender();
  if (!$('schedDayDialog').open) $('schedDayDialog').showModal();
  $('schedList').scrollTop = 0;
}

function schedGo(month, selected) {
  sched.month = month;
  if (selected) sched.selected = selected;
  schedRender();
  schedLoad();
}

function schedShift(delta) {
  const [y, m] = sched.month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  const month = `${t.getUTCFullYear()}-${schedPad(t.getUTCMonth() + 1)}`;
  const keepDay = Math.min(Number(sched.selected.slice(8, 10)), new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate());
  schedGo(month, `${month}-${schedPad(keepDay)}`);
}

async function schedDelete(it, busyEl = $('schedDayDialog')) {
  if (!confirm(`'${SchedParse.splitTitle(it.title).main}' 일정을 지울까요?\n(${schedLabel(it.date)})`)) return false;
  try {
    await withBusy(busyEl, () => api('schedule_delete', { ids: [it.id] }));
    flash('일정을 지웠습니다');
    await schedLoad();
    return true;
  } catch (err) {
    if (err.isAuth) { signOut(); return false; }
    alert(`지우지 못했습니다. ${errorText(err)}`);
    return false;
  }
}

const schedUser = () => $('user').value || state.config.names?.[0] || '미지정';

async function schedSend(items, source) {
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i += SCHED_SEND_CHUNK) {
    const r = await api('schedule_add', { user: schedUser(), items: items.slice(i, i + SCHED_SEND_CHUNK), source });
    added += r.added || 0;
    skipped += r.skipped || 0;
  }
  return { added, skipped };
}

// ---------- 기입 창 ----------

// 같은 창을 기입·수정에 함께 쓴다. sched.editing 이 있으면 수정(파일 버튼 숨김, 삭제 버튼 보임)
function schedFormMode(item) {
  sched.editing = item || null;
  $('schedAddTitle').textContent = item ? '일정 수정' : '일정 기입';
  $('schedAddSubmit').textContent = item ? '저장' : '기입';
  $('schedFileBtn').hidden = Boolean(item);
  $('schedFileHint').hidden = Boolean(item);
  $('schedEditDelete').hidden = !item;
  $('schedAddError').textContent = '';
}

function schedOpenAdd() {
  schedFormMode(null);
  $('schedDate').value = sched.selected || todayKst();
  $('schedText').value = '';
  $('schedMemo').value = '';
  $('schedAddDialog').showModal();
}

function schedOpenEdit(it) {
  schedFormMode(it);
  $('schedDate').value = it.date;
  $('schedText').value = it.title;
  $('schedMemo').value = it.memo === 'MEMO' ? '' : it.memo;   // 계획서 MEMO 칸 표시는 숨겨 두고 그대로 지킨다
  if ($('schedDayDialog').open) $('schedDayDialog').close();
  $('schedAddDialog').showModal();
}

const SCHED_EDIT_ERRORS = { duplicate: '같은 날짜에 같은 일정이 이미 있습니다.', not_found: '이 일정은 이미 지워졌습니다. 새로고침해 주세요.' };

async function schedSubmitEdit(it, date, title, memo) {
  await withBusy($('schedAddForm'), () => api('schedule_update', { user: schedUser(), id: it.id, item: { date, title, memo: memo || (it.memo === 'MEMO' ? 'MEMO' : '') } }));
  $('schedAddDialog').close();
  flash('일정을 고쳤습니다');
  await schedLoad();
  schedGo(date.slice(0, 7), date);
  schedOpenDay(date);
}

async function schedSubmitAdd(e) {
  e.preventDefault();
  const date = $('schedDate').value;
  const title = $('schedText').value.trim();
  if (!date) { $('schedAddError').textContent = '날짜를 골라 주세요.'; return; }
  if (!title) { $('schedAddError').textContent = '내용을 적거나, 옆 「파일」 버튼으로 계획서를 올려 주세요.'; $('schedText').focus(); return; }
  try {
    if (sched.editing) { await schedSubmitEdit(sched.editing, date, title, $('schedMemo').value.trim()); return; }
    const r = await withBusy($('schedAddForm'), () => schedSend([{ date, title, memo: $('schedMemo').value.trim() }], ''));
    $('schedAddDialog').close();
    flash(r.added ? '일정을 기입했습니다' : '같은 일정이 이미 있습니다');
    schedGo(date.slice(0, 7), date);
    schedOpenDay(date);
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('schedAddError').textContent = (sched.editing && SCHED_EDIT_ERRORS[err.code]) || `${sched.editing ? '고치지' : '기입하지'} 못했습니다. ${errorText(err)}`;
  }
}

// ---------- 계획서 읽기: 파일 → 글자 조각 ----------

// PDF 글자층: pdf.js 조각을 왼쪽 위 기준 좌표로
async function schedPdfTextItems(page, lib) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    const t = lib.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(t[2], t[3]) || it.height || 10;
    const x0 = t[4];
    const base = t[5];
    return { str: it.str, x0, x1: x0 + (it.width || h * it.str.length), y0: base - h, y1: base };
  });
}

async function schedRenderPage(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = OCR_WIDTH / vp1.width;
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFF';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

// 여러 쪽이면 쪽마다 읽어 합친다. 주 시작은 기간을 찾은 첫 쪽 기준
async function schedReadFile(file) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const results = [];
  if (isPdf) {
    const lib = await ensurePdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = Math.min(doc.numPages, SCHED_MAX_PAGES);
    for (let p = 1; p <= pages; p += 1) {
      busyText(`계획서 읽는 중 (${p}/${pages}쪽)`);
      const page = await doc.getPage(p);
      const items = await schedPdfTextItems(page, lib);
      let r = items.length >= SCHED_MIN_TEXT_ITEMS ? SchedParse.parseWeeklyPlan(items) : null;
      if (!r || !r.rows.length) {   // 스캔한 PDF(글자층 없음)는 그림으로 OCR
        const ocr = await ocrCanvas(await schedRenderPage(page), `${p}/${pages}쪽`);
        r = SchedParse.parseWeeklyPlan(ocr.items, { inkAt: ocr.inkAt, vlines: ocr.vlines });
      }
      results.push(r);
    }
    doc.destroy?.();
  } else {
    busyText('사진 준비 중...');
    const ocr = await ocrCanvas(await ocrImageCanvas(file), '사진');
    results.push(SchedParse.parseWeeklyPlan(ocr.items, { inkAt: ocr.inkAt, vlines: ocr.vlines }));
  }
  const withPeriod = results.find((r) => r.period);
  return {
    period: withPeriod?.period ?? null,
    weekStart: withPeriod?.weekStart ?? null,
    rows: results.flatMap((r) => r.rows),
    notes: results.flatMap((r) => r.notes),
    warnings: [...new Set(results.flatMap((r) => r.warnings))].filter((w) => !(withPeriod && /기간/.test(w))),
  };
}

async function schedPickedFile() {
  const file = $('schedFile').files[0];
  $('schedFile').value = '';
  if (!file) return;
  if (!SCHED_FILE_RE.test(file.name) && !/^(application\/pdf|image\/(jpeg|png))$/.test(file.type)) {
    $('schedAddError').textContent = 'PDF·JPG·PNG 파일만 올릴 수 있습니다.';
    return;
  }
  if (file.size > SCHED_MAX_FILE) { $('schedAddError').textContent = '파일이 너무 큽니다(25MB 이하).'; return; }
  $('schedAddError').textContent = '';
  busyShow('계획서 읽는 중...');
  let result;
  try {
    result = await schedReadFile(file);
  } catch (err) {
    console.warn('계획서 판독 실패', err);
    $('schedAddError').textContent = friendlyError(err, '파일을 읽지 못했습니다. 다른 파일로 해 보거나 PDF 로 올려 주세요.');
    return;
  } finally {
    busyHide();
  }
  $('schedAddDialog').close();
  schedShowImport(result, file.name);
}

// ---------- 판독 결과 확인 창 ----------

const schedEntryKey = (e) => `${e.date}|${e.title}|${e.memo}`;

function schedShowImport(result, fileName) {
  const weekStart = result.weekStart || SchedParse.mondayOf(sched.selected || todayKst());
  sched.import = { result, fileName, entries: [], checked: new Set() };
  $('schedWeek').value = weekStart;
  const p = result.period;
  $('schedImportInfo').textContent = `${fileName}${p ? ` · 기간 ${p.start.replace(/-/g, '.')} ~ ${p.end.replace(/-/g, '.')}` : ''} · ${result.rows.length}줄 읽음`;
  $('schedImportWarn').textContent = result.warnings.join(' ');
  schedRebuildImport();
  $('schedImportDialog').showModal();
}

function schedRebuildImport() {
  const imp = sched.import;
  imp.entries = SchedParse.entriesOf(imp.result, $('schedWeek').value);
  imp.checked = new Set(imp.entries.map(schedEntryKey));
  const groups = new Map();
  for (const e of imp.entries) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  const box = $('schedImportList');
  if (!imp.entries.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '넣을 일정이 없습니다.';
    box.replaceChildren(p);
  } else {
    box.replaceChildren(...[...groups].map(([date, list]) => {
      const sec = document.createElement('section');
      sec.className = 'sched-pv-day';
      const h = document.createElement('h3');
      h.textContent = `${schedLabel(date)} · ${list.length}건`;
      sec.append(h);
      for (const e of list) {
        const label = document.createElement('label');
        label.className = 'sched-pv-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.addEventListener('change', () => {
          if (cb.checked) imp.checked.add(schedEntryKey(e)); else imp.checked.delete(schedEntryKey(e));
          schedImportCount();
        });
        const text = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = e.title;
        text.append(b);
        if (e.memo) {
          const s = document.createElement('small');
          s.textContent = e.memo;
          text.append(s);
        }
        label.append(cb, text);
        sec.append(label);
      }
      return sec;
    }));
  }
  schedImportCount();
}

function schedImportCount() {
  const n = sched.import.checked.size;
  $('schedImportSave').textContent = n ? `${n}건 일정에 추가` : '추가할 일정 없음';
  $('schedImportSave').disabled = !n;
}

async function schedSaveImport() {
  const imp = sched.import;
  const items = imp.entries.filter((e) => imp.checked.has(schedEntryKey(e)));
  if (!items.length) return;
  try {
    const r = await withBusy($('schedImportDialog'), () => schedSend(items, imp.fileName));
    $('schedImportDialog').close();
    flash(`일정 ${r.added}건 추가${r.skipped ? ` · 이미 있던 ${r.skipped}건은 건너뜀` : ''}`);
    const first = items[0].date;
    schedGo(first.slice(0, 7), first);
    schedOpenDay(first);
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('schedImportWarn').textContent = `저장하지 못했습니다. ${errorText(err)}`;
  }
}

// ---------- 시작 ----------

let schedStarted = false;
function schedOnOpen() {
  if (!schedStarted) {
    schedStarted = true;
    const today = todayKst();
    sched.selected = today;
    sched.month = today.slice(0, 7);
  }
  schedRender();
  schedLoad();
}
window.schedOnOpen = schedOnOpen;

$('schedGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.sched-cell');
  if (!cell) return;
  const d = cell.dataset.date;
  schedOpenDay(d);
});
$('schedDayPrev').addEventListener('click', () => schedOpenDay(SchedParse.addDays(sched.selected, -1)));
$('schedDayNext').addEventListener('click', () => schedOpenDay(SchedParse.addDays(sched.selected, 1)));
$('schedDayClose').addEventListener('click', () => $('schedDayDialog').close());
$('schedDayAdd').addEventListener('click', () => { $('schedDayDialog').close(); schedOpenAdd(); });
$('schedPrev').addEventListener('click', () => schedShift(-1));
$('schedNext').addEventListener('click', () => schedShift(1));
$('schedToday').addEventListener('click', () => { const t = todayKst(); schedGo(t.slice(0, 7), t); });
$('schedAdd').addEventListener('click', schedOpenAdd);
$('schedAddForm').addEventListener('submit', schedSubmitAdd);
$('schedAddCancel').addEventListener('click', () => $('schedAddDialog').close());
$('schedEditDelete').addEventListener('click', async () => {
  const it = sched.editing;
  if (it && await schedDelete(it, $('schedAddForm'))) { $('schedAddDialog').close(); schedOpenDay(it.date); }
});
// 앱(APK) 파일 선택창은 accept 의 첫 형식만 보여 주므로 앱에서는 비우고 고른 뒤에 검사한다(drawing.js 와 같은 이유)
if (!window.AndroidGallery) $('schedFile').accept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
$('schedFileBtn').addEventListener('click', () => $('schedFile').click());
$('schedFile').addEventListener('change', schedPickedFile);
$('schedWeek').addEventListener('change', () => { if ($('schedWeek').value) schedRebuildImport(); });
$('schedImportCancel').addEventListener('click', () => $('schedImportDialog').close());
$('schedImportSave').addEventListener('click', schedSaveImport);
$('site').addEventListener('change', () => schedRender());   // '내 현장' 표시가 바뀐다
if (state.ready) schedOnOpen();
