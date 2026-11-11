// 명함 판독: OCR 줄(글자 + 위치·크기)을 이름·직함·회사·부서·휴대폰·전화·팩스·이메일·주소로 나눈다(순수 함수).
// 휴대폰(web/contacts.js)과 PC(pc-app/ui/card-parse.js 복사본)가 같이 쓴다. 바꾸면 두 곳 다.
// 입력 lines: [{ text, x0, y0, x1, y1 }] 또는 글자만 [string]. 결과는 사람이 확인·고친 뒤 저장한다(리멤버처럼).
(function (root) {
  const TITLES = ['현장소장', '현장대리인', '대표이사', '대표', '부사장', '사장', '전무', '상무', '이사', '본부장', '실장', '부장', '차장', '과장', '대리', '주임', '사원', '소장', '팀장', '파트장', '공무', '기사', '책임', '선임', '수석', '감리단장', '감리원', '단장', '센터장', '지점장', 'CEO', 'Manager', 'Director'];
  const TITLE_RE = new RegExp(`(${TITLES.join('|')})`);
  const COMPANY_RE = /(\(주\)|㈜|주식회사|\(유\)|유한회사|건설|산업|엔지니어링|이엔씨|E&C|ENC|개발|종합|기술|건축|토건|공단|Co\.|Corp|Inc|Ltd|LTD|CORP)/i;
  const DEPT_RE = /(부$|팀$|실$|본부|사업부|현장$|공무부|공사부|기술부|안전|품질|사업단|지사)/;
  const ADDR_RE = /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|특별시|광역시|[가-힣]+(시|군|구)\s|[가-힣\d]+(로|길)\s*\d)/;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+\s?@\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  // 전화번호: 지역번호·휴대폰·대표번호(1588 등). OCR 이 ')' '.' ' ' 로 끊어도 잡는다
  const PHONE_RE = /(?:\+?82[\s.-]?\(?0?|\(?0)\d{1,2}\)?[\s.)-]*\d{3,4}[\s.-]*\d{4}|1[5-9]\d{2}[\s.-]*\d{4}/g;   // +82 10-… 처럼 앞 0 이 빠진 국가번호 표기도
  const LABELS = [
    ['mobile', /(M\.?P|H\.?P|C\.?P|Mobile|MOBILE|Mob|핸드폰|휴대폰|휴대전화|(^|[^A-Za-z])[MHC])\s*[.:)]?\s*$/],
    ['fax', /(FAX|Fax|팩스|(^|[^A-Za-z])F)\s*[.:)]?\s*$/],
    ['phone', /(TEL|Tel|전화|직통|대표|(^|[^A-Za-z])[TD])\s*[.:)]?\s*$/],
  ];

  const clean = (s) => String(s || '').replace(/[|_~`"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  const digits = (s) => s.replace(/\D/g, '');

  function formatPhone(raw) {
    let d = digits(raw);
    if (d.startsWith('82')) d = `0${d.slice(2)}`;
    if (/^1[5-9]\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4)}`;
    if (d.startsWith('02')) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : d.length === 10 ? `02-${d.slice(2, 6)}-${d.slice(6)}` : '';
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    return '';
  }

  // 한 줄에서 전화번호들과 그 앞에 붙은 표시(T·M·F)를 찾는다
  function phonesIn(text) {
    const out = [];
    PHONE_RE.lastIndex = 0;
    let m;
    while ((m = PHONE_RE.exec(text))) {
      const num = formatPhone(m[0]);
      if (!num) continue;
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      let kind = '';
      for (const [k, re] of LABELS) if (re.test(before)) { kind = k; break; }
      out.push({ num, kind });
    }
    return out;
  }

  // 이름 후보: 한글 2~4자(띄어 쓴 '홍 길 동'도). 직함이 붙어 있으면 떼어 낸다
  function nameIn(text) {
    const t = clean(text).replace(new RegExp(TITLE_RE.source, 'g'), ' ').replace(/[^가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const spaced = /^([가-힣])\s([가-힣])\s([가-힣])(?:\s([가-힣]))?$/.exec(t);
    if (spaced) return spaced.slice(1).filter(Boolean).join('');
    const m = /(^|\s)([가-힣]{2,4})(\s|$)/.exec(t);
    return m ? m[2] : '';
  }

  function parseCard(input) {
    const lines = (input || []).map((l) => (typeof l === 'string' ? { text: l } : l)).map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
    const out = { name: '', title: '', company: '', dept: '', mobile: '', phone: '', fax: '', email: '', address: '' };
    const used = new Set();

    for (const l of lines) {
      const em = EMAIL_RE.exec(l.text.replace(/(@[A-Za-z0-9.-]+\.(co|or|ne|go|ac|re))[\s,]+(kr)(?![A-Za-z])/i, '$1.$3'));   // OCR 이 'co.kr' 의 점을 빈칸으로 읽는다
      if (em && !out.email) { out.email = em[0].replace(/\s/g, '').toLowerCase(); used.add(l); }
      const phones = phonesIn(l.text);
      for (const p of phones) {
        const kind = p.kind || (/^01[016789]/.test(digits(p.num)) ? 'mobile' : 'phone');
        if (!out[kind]) out[kind] = p.num;
        else if (kind === 'phone' && !out.fax) out.fax = p.num;   // 표시 없는 두 번째 일반 번호는 대개 팩스
      }
      if (phones.length) used.add(l);
    }
    for (const l of lines) {
      if (used.has(l) || out.address) continue;
      if (ADDR_RE.test(`${l.text} `) && /\d/.test(l.text) && l.text.length >= 8) { out.address = l.text.replace(/^(주소|ADD|Add)\s*[.:)]?\s*/, ''); used.add(l); }
    }
    for (const l of lines) {
      if (used.has(l) || out.company) continue;
      if (COMPANY_RE.test(l.text) && !(TITLE_RE.test(l.text) && nameIn(l.text))) { out.company = l.text; used.add(l); }
    }

    // 이름: 직함이 같이 적힌 줄이 가장 확실하고, 없으면 가장 큰 글씨의 한글 줄(명함에서 이름이 제일 크다)
    const rest = lines.filter((l) => !used.has(l));
    const height = (l) => (l.y1 != null && l.y0 != null ? l.y1 - l.y0 : 0);
    const withTitle = rest.find((l) => TITLE_RE.test(l.text) && nameIn(l.text));
    const byHeight = rest.filter((l) => nameIn(l.text) && l.text.replace(/\s/g, '').length <= 12).sort((a, b) => height(b) - height(a));
    const nameLine = withTitle || byHeight[0];
    if (nameLine) {
      out.name = nameIn(nameLine.text);
      const t = TITLE_RE.exec(nameLine.text);
      if (t) out.title = t[1];
      used.add(nameLine);
    }
    for (const l of lines) {
      if (used.has(l)) continue;
      const t = TITLE_RE.exec(l.text);
      const exactTitle = TITLES.includes(l.text.replace(/\s/g, ''));   // '공무부'는 부서, '공무'·'본부장'만 있으면 직함
      if (!out.dept && !exactTitle && DEPT_RE.test(l.text) && l.text.length <= 20 && !COMPANY_RE.test(l.text)) { out.dept = l.text; used.add(l); continue; }
      if (!out.title && t && l.text.length <= 20) { out.title = t[1]; used.add(l); }
    }
    if (!out.company) {   // 회사 표시 낱말이 없으면 남은 줄 중 가장 큰 글씨(로고 옆 회사명)
      const big = lines.filter((l) => !used.has(l) && /[가-힣A-Za-z]{2,}/.test(l.text) && l.text.length <= 30).sort((a, b) => height(b) - height(a))[0];
      if (big && height(big)) out.company = big.text;
    }
    return out;
  }

  const api = { parseCard, formatPhone, phonesIn, nameIn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
