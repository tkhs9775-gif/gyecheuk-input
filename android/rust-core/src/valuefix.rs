//! 동그라미 메모 값 오타 제안(2026-11-19, 옛 web/valuefix.js 를 옮김). 순수 함수만.
//! 값을 바꾸는 것은 사람이 [바꾸기]를 눌렀을 때뿐(drawing.js renderPinFix).
//! 실제로 나온 오타: '-3,34'(쉼표), '4ㄷㅅ2753'(한글 자판), '2507 2502'(값 두 개), 소수점 빠짐(전회 -3.38 인데 -338).
//! 한글 음절·영문이 섞인 글(메모)은 값이 아니라 보고 건드리지 않는다. 규칙으로 못 고치는 것만 사람이 누르면 Claude 에 묻는다(/ai/typo).

/// 전회와 이 배 넘게 차이 나면 의심
const FAR: f64 = 10.0;
/// 소수점을 옮긴 값이 전회와 이 배 안이면 그 값을 제안
const NEAR: f64 = 2.0;
const EU: char = '\u{3161}'; // 'ㅡ'
const ARAEA: char = '\u{318d}'; // 천지인 'ㆍ'

#[derive(Debug, PartialEq)]
pub struct Suggestion {
    pub why: String,
    /// 비면 확인만 권한다(화면은 Claude 에 묻기 버튼)
    pub fixes: Vec<String>,
}

/// JS 의 `\s`·`trim()` 과 같은 공백. Rust `is_whitespace` 와는 U+0085·U+FEFF 가 다르다
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn is_jamo(c: char) -> bool {
    ('\u{3131}'..='\u{318e}').contains(&c)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn unsigned(s: &str) -> &str {
    s.strip_prefix(['+', '-']).unwrap_or(s)
}

/// `^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$`
fn is_num(s: &str) -> bool {
    let body = unsigned(s);
    match body.split_once('.') {
        None => digits(body),
        Some((a, b)) => (a.is_empty() || digits(a)) && digits(b),
    }
}

/// JS `Number(s)`. is_num 을 통과했거나 dot_moves 가 만든 글자만 넣는다
fn num(s: &str) -> f64 {
    s.parse().unwrap_or(f64::NAN)
}

fn ratio(a: f64, b: f64) -> f64 {
    let r = (a / b).abs();
    if r >= 1.0 { r } else { 1.0 / r }
}

/// 유효 숫자 개수. 전회보다 적으면 아직 치는 중('2' → '2505')으로 보고 10배 검사를 하지 않는다
fn sig_len(s: &str) -> usize {
    unsigned(s).replacen('.', "", 1).trim_start_matches('0').len()
}

/// '-', '.', '-3.' 처럼 아직 치는 중: `^[+-]?\.?$|\.$`
fn typing(s: &str) -> bool {
    s.ends_with('.') || matches!(s, "" | "+" | "-")
}

/// cs[i] 다음에 공백이 하나 이상 있고 그 뒤에 글자가 있으면 그 글자 위치
fn after_ws(cs: &[char], i: usize) -> Option<usize> {
    let j = i + 1 + cs[i + 1..].iter().take_while(|c| js_space(**c)).count();
    (j > i + 1 && j < cs.len()).then_some(j)
}

fn sign_at_start(cs: &[char], i: usize, also: char) -> bool {
    matches!(cs[i], '+' | '-') && (i == 0 || js_space(cs[i - 1]) || cs[i - 1] == also)
}

/// 한글 자판: 맨 앞·공백 뒤 'ㅡ' → '-', 천지인 'ㆍ' → '.', 나머지 자모는 뺀다. 부호 뒤 띄어쓰기는 붙인다(값이 두 개면 값마다)
fn clean(s: &str) -> String {
    let mut cs = Vec::with_capacity(s.len());
    let mut before: Option<char> = None;
    for c in s.chars() {
        match c {
            EU if before.is_none_or(js_space) => cs.push('-'),
            ARAEA => cs.push('.'),
            c if is_jamo(c) => {}
            c => cs.push(c),
        }
        before = Some(c);
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        out.push(cs[i]);
        let skip = if sign_at_start(&cs, i, ' ') {
            after_ws(&cs, i).filter(|&j| cs[j].is_ascii_digit() || cs[j] == '.')
        } else {
            None
        };
        i = skip.unwrap_or(i + 1);
    }
    out
}

/// 쉼표 → 소수점. 뒤가 세 자리('1,234')면 천 단위일 수도 있어 둘 다 후보
fn comma_cands(s: &str) -> Vec<String> {
    if let Some((a, b)) = s.split_once(',') {
        if digits(unsigned(a)) && digits(b) {
            let dot = format!("{a}.{b}");
            return if b.len() == 3 { vec![dot, format!("{a}{b}")] } else { vec![dot] };
        }
    }
    vec![s.to_string()]
}

/// 소수점 자리를 옮긴 후보: '-338' → '-0.00338', '-0.0338', '-0.338', '-3.38', '-33.8', '-338'
/// (0.00x 는 2026-11-19 agy 검토로 더함: 전회 -0.0034 에 '-34' 를 치면 옛 판은 못 찾았다)
fn dot_moves(s: &str) -> Vec<String> {
    let sign = &s[..s.len() - unsigned(s).len()];
    let all = unsigned(s).replacen('.', "", 1);
    let zeros = all.len() - all.trim_start_matches('0').len();
    let d = &all[zeros.min(all.len().saturating_sub(1))..];
    let mut out = vec![format!("{sign}0.00{d}"), format!("{sign}0.0{d}"), format!("{sign}0.{d}")];
    for i in 1..=d.len() {
        out.push(if i < d.len() { format!("{sign}{}.{}", &d[..i], &d[i..]) } else { format!("{sign}{d}") });
    }
    out
}

/// `'2500.0'.replace(/\.0+$/, '')`
fn strip_dot_zeros(d: &str) -> String {
    let t = d.trim_end_matches('0');
    match t.strip_suffix('.') {
        Some(head) if t.len() < d.len() => head.to_string(),
        _ => d.to_string(),
    }
}

/// JS `s.split(/\s+/)`: 앞뒤 공백이면 빈 칸이 남는다
fn split_ws(s: &str) -> Vec<&str> {
    let parts: Vec<&str> = s.split(js_space).collect();
    let last = parts.len() - 1;
    parts.into_iter().enumerate().filter(|(i, p)| !p.is_empty() || *i == 0 || *i == last).map(|(_, p)| p).collect()
}

fn dedup(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(v.len());
    for s in v {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// text: 오늘 친 값, prev: 전회 값(없으면 ''). None 이면 고칠 것 없음
pub fn suggest(text: &str, prev: &str) -> Option<Suggestion> {
    let t = js_trim(text);
    let ct = clean(t);
    let ct = js_trim(&ct); // '3.34 ㄱ' → 자모를 빼면 끝에 공백이 남아 '값이 두 개' 로 잘못 보던 것(2026-11-19 agy 검토)
    let wordy = t.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c) || c.is_ascii_alphabetic());
    if t.is_empty() || typing(ct) || wordy {
        return None; // '3ㆍ', 'ㅡ' 도 아직 치는 중
    }
    let tc: Vec<char> = t.chars().collect();
    let mut why: Vec<String> = Vec::new();
    if tc.iter().any(|c| is_jamo(*c)) {
        why.push("한글 자판 글자".into());
    }
    if t.as_bytes().windows(3).any(|w| w[0].is_ascii_digit() && w[1] == b',' && w[2].is_ascii_digit()) {
        why.push("쉼표".into());
    }
    // '- .5' 도(clean 이 붙이는 것과 같은 조건)
    if (0..tc.len()).any(|i| sign_at_start(&tc, i, '/') && after_ws(&tc, i).is_some_and(|j| tc[j].is_ascii_digit() || tc[j] == '.')) {
        why.push("부호 뒤 띄어쓰기".into());
    }
    if t.contains('/') {
        // 하중계 'a/b/c': 칸마다 쉼표·한글·띄어쓰기만 고친다(전회 비교는 하지 않는다)
        if why.is_empty() {
            return None;
        }
        let why = why.join("·");
        let cells: Vec<Vec<String>> = t.split('/').map(|c| comma_cands(&clean(js_trim(c)))).collect();
        if !cells.iter().all(|cs| is_num(&cs[0])) {
            return Some(Suggestion { why, fixes: vec![] });
        }
        // 0: 쉼표=소수점, 1: 쉼표=천 단위
        let pick = |i: usize| cells.iter().map(|cs| cs[i.min(cs.len() - 1)].as_str()).collect::<Vec<_>>().join("/");
        return Some(Suggestion { why, fixes: dedup(vec![pick(0), pick(1)]) });
    }
    let parts = split_ws(ct);
    if parts.len() > 1 {
        why.push("값이 두 개".into());
    }
    let mut cands: Vec<String> = parts.iter().flat_map(|p| comma_cands(p)).filter(|c| is_num(c)).collect();
    if cands.is_empty() {
        return Some(Suggestion { why: "숫자 모양이 아님".into(), fixes: vec![] });
    }
    let prev_t = js_trim(prev);
    let p = if is_num(prev_t) { num(prev_t) } else { 0.0 };
    if p != 0.0 {
        let far: Vec<String> = cands
            .iter()
            .filter(|c| num(c) != 0.0 && sig_len(c) >= sig_len(prev_t) && ratio(num(c), p) >= FAR)
            .cloned()
            .collect();
        if !far.is_empty() {
            why.push(format!("전회 {prev} 와 {}배 넘게 차이", FAR as u32));
            // 소수점을 옮겨 전회와 가까워지면 그 값('2500.0' → 전회가 정수면 '2500'). 못 찾으면 쉼표·한글로 고친 값은 남기고, 친 그대로면 경고만
            // ponytail: 부호를 모른다 — 수위계 핀에 '33,8'(전회 -3.38)은 '-33.8' 로 제안된다. 핀 종류를 넘기면 고칠 수 있음
            let near = |c: &str| {
                let d = dot_moves(c).into_iter().find(|x| num(x) * p > 0.0 && ratio(num(x), p) < NEAR)?;
                Some(if prev_t.contains('.') { d } else { strip_dot_zeros(&d) })
            };
            cands = cands
                .into_iter()
                .filter_map(|c| if !far.contains(&c) { Some(c) } else { near(&c).or_else(|| (c != t).then_some(c)) })
                .collect();
        }
        let key = |s: &String| {
            let v = num(s);
            ratio(if v != 0.0 { v } else { p }, p)
        };
        cands.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(core::cmp::Ordering::Equal));
    }
    if why.is_empty() {
        return None;
    }
    let fixes = dedup(cands).into_iter().filter(|f| f != t).collect();
    Some(Suggestion { why: why.join("·"), fixes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixes(t: &str, p: &str) -> Option<Vec<String>> {
        suggest(t, p).map(|s| s.fixes)
    }
    fn v(xs: &[&str]) -> Option<Vec<String>> {
        Some(xs.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn nothing_to_fix() {
        for t in ["-3.34", "0", ".5", "-", "-3.", "", "신규설치", "측정불가 -3.3", "W1 3"] {
            assert_eq!(suggest(t, "-3.38"), None, "{t}");
        }
        assert_eq!(suggest("-3.34", ""), None, "전회 없어도 정상");
        assert_eq!(suggest("2507", "2505"), None, "진동현식 정상");
        assert_eq!(fixes("2507", "-3.38"), v(&[]), "부호가 다르면 소수점 제안 안 함(경고만)");
        assert_eq!(suggest("1500/1520/1490", ""), None, "하중계 정상");
        for t in ["2", "25", "250"] {
            assert_eq!(suggest(t, "2505"), None, "치는 중 {t}");
        }
        for t in ["-0.3", "-0.33"] {
            assert_eq!(suggest(t, "-3.38"), None, "치는 중 {t}");
        }
    }

    #[test]
    fn real_typos() {
        assert_eq!(fixes("-3,34", "-3.38"), v(&["-3.34"]), "쉼표");
        assert_eq!(fixes("-7,0", ""), v(&["-7.0"]), "쉼표(전회 없음)");
        assert_eq!(fixes("4ㄷㅅ2753", ""), v(&["42753"]), "한글 자모 빼기");
        assert_eq!(suggest("4ㄷㅅ2753", "").unwrap().why, "한글 자판 글자");
        assert_eq!(fixes("2507 2502", ""), v(&["2507", "2502"]), "값 두 개 → 둘 다 후보");
        assert_eq!(fixes("2502 2507", "2508"), v(&["2507", "2502"]), "전회와 가까운 것 먼저");
        assert_eq!(fixes("-338", "-3.38"), v(&["-3.38"]), "소수점 빠짐");
        assert_eq!(fixes("-0.334", "-3.38"), v(&["-3.34"]), "소수점 한 칸 밀림");
        assert_eq!(fixes("0.6", "0.05"), v(&["0.06"]), "0 하나 빠짐");
        assert_eq!(fixes("ㅡ3.34", "-3.38"), v(&["-3.34"]), "맨 앞 'ㅡ' 는 빼기 부호");
        assert_eq!(fixes("3ㆍ34", ""), v(&["3.34"]), "천지인 'ㆍ' 는 소수점");
        assert_eq!(fixes("- 3.34", ""), v(&["-3.34"]), "부호 뒤 띄어쓰기");
        assert_eq!(fixes("1,234", ""), v(&["1.234", "1234"]), "천 단위일 수도");
        assert_eq!(fixes("1,234", "1200"), v(&["1234"]), "전회 1200 이면 1.234 는 빠진다");
        assert_eq!(fixes("15,1/1520/1490", ""), v(&["15.1/1520/1490"]), "하중계 칸 쉼표");
        assert_eq!(fixes("1,500/1,520/1,490", ""), v(&["1.500/1.520/1.490", "1500/1520/1490"]), "하중계 천 단위일 수도");
        assert_eq!(fixes("1500/- 1520/1490", ""), v(&["1500/-1520/1490"]), "하중계 칸 부호 뒤 띄어쓰기");
    }

    /// Gemini 검토(2026-11-19)에서 재현된 것
    #[test]
    fn review_cases() {
        for t in ["3ㆍ", "ㅡ"] {
            assert_eq!(suggest(t, "-3.38"), None, "한글 자판으로 치는 중 {t}");
        }
        for t in ["ㅡ3.34 ㅡ3.38", "-3.34 - 3.38"] {
            let f = fixes(t, "-3.38").unwrap();
            assert!(f.contains(&"-3.38".to_string()) && !f.contains(&"3.38".to_string()), "두 번째 값 부호 유지 {t}: {f:?}");
        }
        assert_eq!(fixes("-3,34", "0.2"), v(&["-3.34"]), "규칙으로 고친 값은 전회와 멀어도 남긴다");
        assert_eq!(fixes("ㅡ25", "-1.0"), v(&["-25"]), "규칙으로 고친 값은 전회와 멀어도 남긴다");
        assert_eq!(fixes("25000", "2500"), v(&["2500"]), "전회가 정수면 .0 을 붙이지 않는다");
        for t in ["1,2,3/1520/1490", "1500/ㄷㅅ/1490"] {
            assert_eq!(fixes(t, ""), v(&[]), "하중계 칸이 숫자가 안 되면 확인만 {t}");
        }
    }

    #[test]
    fn check_only() {
        assert_eq!(suggest("1.2.3", ""), Some(Suggestion { why: "숫자 모양이 아님".into(), fixes: vec![] }));
        let far = suggest("-25", "-1.0").unwrap();
        assert_eq!(far.fixes, Vec::<String>::new(), "소수점을 옮겨도 전회와 2배 안이 아님");
        assert!(far.why.contains("10배"), "{}", far.why);
    }

    /// JS 정규식과 다르게 갈 수 있는 곳(split·공백·치는 중)
    #[test]
    fn js_edges() {
        assert_eq!(split_ws(" a  b "), vec!["", "a", "b", ""]);
        assert_eq!(split_ws("a"), vec!["a"]);
        assert_eq!(clean("- - 3"), "- -3");
        assert_eq!(clean("ㅡㅡ3"), "-3", "두 번째 'ㅡ' 는 앞이 공백이 아니라 뺀다");
        assert_eq!(dot_moves("-338"), ["-0.00338", "-0.0338", "-0.338", "-3.38", "-33.8", "-338"]);
        assert_eq!(dot_moves("000"), ["0.000", "0.00", "0.0", "0"]);
        // 2026-11-19 agy 검토
        assert_eq!(fixes("-34", "-0.0034"), v(&["-0.0034"]), "0.00x 자리도 찾는다");
        assert!(!suggest("3.34 ㄱ", "").unwrap().why.contains("값이 두 개"), "끝 자모를 빼고 남은 공백은 값 두 개가 아님");
        assert_eq!(suggest("- .5", "").map(|s| (s.why, s.fixes)), Some(("부호 뒤 띄어쓰기".into(), vec!["-.5".to_string()])));
        assert_eq!(strip_dot_zeros("2500.0"), "2500");
        assert_eq!(strip_dot_zeros("3.10"), "3.10");
        assert!(typing("-") && typing("+.") && typing("3.") && !typing("3"));
        assert_eq!(suggest("\u{feff}-3,34\u{feff}", "-3.38").unwrap().fixes, ["-3.34"], "JS trim 은 U+FEFF 도 지운다");
    }
}
