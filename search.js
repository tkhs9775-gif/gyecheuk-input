// 목록 검색(공통): 단어 일부만 쳐도 찾는다. 공백으로 나눈 여러 단어는 모두 들어 있어야(AND) 하고,
// 한글 초성(ㄷㅅ → 당산)과 초성·글자 섞기(ㄷ산), 치는 중인 마지막 글자(다 → 당)도 찾는다. 정규식을 쓰지 않아 ( ) / . * 같은 글자도 그대로 찾는다.
// 목록이 길어도 빠르게: 항목마다 찾기용 글자(searchIndex)를 한 번만 만들어 두고, 입력은 잠깐 모아서(debounce) 한 번만 거른다.
// search.js 가 아직 안 받아진 옛 앱 사본에서도 화면이 멈추지 않게, 쓰는 쪽은 typeof searchMatch === 'function' 일 때만 쓴다.

const SEARCH_DEBOUNCE_MS = 120;
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JUNG_JONG = 588;   // 초성 하나에 딸린 글자 수(중성 21 × 종성 28)
const CHOSUNG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const isSyllable = (c) => c >= HANGUL_BASE && c <= HANGUL_LAST;
const isChosungJamo = (ch) => CHOSUNG.includes(ch);

// 비교용 글자: 소문자, 공백 없앰, 한글은 완성형(NFC)으로
const searchNormalize = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '');

// 글자 하나의 초성(한글 음절이 아니면 그대로)
function chosungOf(ch) {
  const c = ch.charCodeAt(0);
  return isSyllable(c) ? CHOSUNG[Math.floor((c - HANGUL_BASE) / JUNG_JONG)] : ch;
}

// 찾기용 글자: 원래 글자와 같은 길이의 초성 줄을 함께 둔다(자리마다 맞춰 보며 섞인 검색어도 찾는다)
function searchIndex(text) {
  const plain = searchNormalize(text);
  return { plain, cho: plain.split('').map(chosungOf).join('') };   // 글자 단위(code unit)로: 📄 같은 그림 글자가 있어도 자리가 어긋나지 않게
}

// 검색어를 단어로. 빈 검색어면 빈 배열(= 전부 보임)
const searchTokens = (query) => String(query ?? '').normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);

// 검색어 글자 q 가 본문 i 자리 글자와 맞는지. last: 검색어의 마지막 글자(받침 없이 치는 중이면 받침 있는 글자도 맞게)
function charMatches(idx, i, q, last) {
  const t = idx.plain[i];
  if (t === q) return true;
  if (isChosungJamo(q)) return idx.cho[i] === q;
  if (!last) return false;
  const qc = q.charCodeAt(0);
  const tc = t.charCodeAt(0);
  if (!isSyllable(qc) || !isSyllable(tc) || (qc - HANGUL_BASE) % 28 !== 0) return false;
  return tc - ((tc - HANGUL_BASE) % 28) === qc;   // 초성·중성이 같고 검색어에 받침이 없으면 맞음
}

function tokenMatches(idx, token) {
  if (idx.plain.includes(token)) return true;   // 대부분은 여기서 끝난다
  const n = idx.plain.length;
  const m = token.length;
  for (let i = 0; i + m <= n; i += 1) {
    let ok = true;
    for (let j = 0; j < m && ok; j += 1) ok = charMatches(idx, i + j, token[j], j === m - 1);
    if (ok) return true;
  }
  return false;
}

// text 는 글자 또는 searchIndex() 결과. query 가 비면 true
function searchMatch(text, query) {
  const tokens = Array.isArray(query) ? query : searchTokens(query);
  if (!tokens.length) return true;
  const idx = typeof text === 'object' && text && 'plain' in text ? text : searchIndex(text);
  return tokens.every((t) => tokenMatches(idx, t));
}

// 항목 배열을 거른다. textOf(item) 은 찾을 글자. 원래 순서를 지키고 원래 배열은 바꾸지 않는다
function searchFilter(items, query, textOf = String) {
  const tokens = searchTokens(query);
  if (!tokens.length) return items.slice();
  return items.filter((it) => searchMatch(textOf(it), tokens));
}

function debounce(fn, ms = SEARCH_DEBOUNCE_MS) {
  let timer = 0;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// 화면용: 검색 칸(input)이 목록(ul)의 줄(li)을 숨기고 보인다. 목록이 다시 그려져도(replaceChildren) 지금 검색어로 다시 거른다.
// 줄마다 찾기용 글자는 처음 한 번만 만든다(WeakMap). 맞는 줄이 없으면 '검색 결과 없음' 줄을 하나 붙인다
function attachListSearch(input, list, textOf = (li) => li.textContent) {
  const cache = new WeakMap();
  let empty = null;
  const apply = () => {
    const tokens = searchTokens(input.value);
    let shown = 0;
    for (const li of list.children) {
      if (li === empty || li.classList.contains('empty')) continue;
      if (!cache.has(li)) cache.set(li, searchIndex(textOf(li)));
      const hit = searchMatch(cache.get(li), tokens);
      li.hidden = !hit;
      if (hit) shown += 1;
    }
    const need = tokens.length > 0 && shown === 0 && list.children.length > 0;
    if (need && !empty?.isConnected) {
      empty = document.createElement('li');
      empty.className = 'empty search-empty';
      empty.textContent = `'${input.value.trim()}' 검색 결과가 없습니다.`;
      list.append(empty);
    } else if (need) {
      empty.textContent = `'${input.value.trim()}' 검색 결과가 없습니다.`;
    } else if (empty?.isConnected) {
      empty.remove();
    }
  };
  input.addEventListener('input', debounce(apply));
  new MutationObserver((records) => {
    if (records.some((r) => [...r.addedNodes].some((nd) => nd !== empty))) apply();
  }).observe(list, { childList: true });
  return apply;
}

if (typeof module !== 'undefined') module.exports = { searchNormalize, searchIndex, searchTokens, searchMatch, searchFilter, debounce, chosungOf };
