//! Claude 창구(worker /ai/*)의 검사·정리(2026-11-19, 옛 worker/src/ai.js 의 판단 부분을 옮김). worker 는 SDK 호출·KV 읽기쓰기만 한다.
//! 화면(web)은 op 1(값 오타 제안)·op 2(메모 문장 한 줄로)를 쓴다. 판정·저장·삭제는 Claude 에게 맡기지 않는다.
//!
//! op 3 [일, meta, b64ok, 지금ms] → ["ok", KV 키, 내용 종류(text|image|document), 글/파일 형식] 또는 [상태, 오류 JSON]
//! op 4 [오늘 쓴 횟수]            → ["ok", 새 횟수] 또는 ["429", 오류 JSON]
//! op 5 [일, stop_reason, 답 글, meta] → [상태, 앱에 돌려줄 JSON]

use crate::json::{self, Value};
use crate::lock::{read_units, text, unpack};
use crate::valuefix::{js_space, js_trim, suggest};

const MAX_B64: usize = 6_600_000; // 파일 약 4.9MB(이미지 한 장 5MB 한도 안). 앱이 미리 줄여 보낸다
const DAILY_LIMIT: u32 = 60; // 기기별 하루 횟수. 전체 상한은 Anthropic 콘솔 월 한도
const KST_MS: f64 = 9.0 * 3600.0 * 1000.0;
const MAX_DATE_MS: f64 = 8.64e15;
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;
const MEMO_MAX: usize = 1000; // 메모·다듬은 문장 글자 수(UTF-16). 받기·한 줄로·답 검사 모두 같은 값(자르면 잘린 뒤 숫자는 검사를 못 받는다)
const PDF: &str = "application/pdf";
const IMAGE_TYPES: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];
const CARD_FIELDS: [&str; 6] = ["name", "title", "company", "mobile", "email", "memo"]; // web/contacts.js CONTACT_FIELDS 와 같은 이름

type Clean = Result<Vec<(String, Value)>, Vec<String>>;

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS slice(0, max)(UTF-16 글자 수). ponytail: 경계에 걸친 이모지는 통째로 뺀다(JS 는 반쪽을 남김)
fn cut(s: &str, max: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        n += c.len_utf16();
        if n > max {
            return &s[..i];
        }
    }
    s
}

/// 글자면 앞뒤 공백 빼고 max 까지, 아니면 ''
fn str_of(v: Option<&Value>, max: usize) -> String {
    v.and_then(Value::as_str).map_or_else(String::new, |s| cut(js_trim(s), max).to_string())
}

fn list(v: Option<&Value>, max: usize) -> &[Value] {
    let a = v.and_then(Value::as_arr).unwrap_or(&[]);
    &a[..a.len().min(max)]
}

/// JS Number.isInteger. ponytail: 2^53 넘는 정수는 뺀다(JS 는 받음) — 줄 번호·요일엔 안 나온다
fn int_of(v: &Value) -> Option<f64> {
    v.as_num().filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE_INT)
}

/// YYYY-MM-DD 이고 Date.parse 가 받는 날(월 1~12, 일 1~31 — V8 은 2월 30일도 받는다)이면 그대로, 아니면 null
fn day(v: Option<&Value>) -> Value {
    let Some(s) = v.and_then(Value::as_str) else { return Value::Null };
    let b = s.as_bytes();
    let shape = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !shape {
        return Value::Null;
    }
    let num = |r: core::ops::Range<usize>| s[r].parse::<u32>().ok();
    match (num(5..7), num(8..10)) {
        (Some(1..=12), Some(1..=31)) => Value::Str(s.to_string()),
        _ => Value::Null,
    }
}

/// 기기 번호: 잠금(lock)과 같은 규칙 [A-Za-z0-9-]{8,64}. 앱은 UUID 를 쓴다
fn device_of(meta: &Value) -> Option<&str> {
    meta.get("device")?.as_str().filter(|d| crate::lock::device_ok(d))
}

/// 한국 날짜 YYYY-MM-DD (Hinnant civil_from_days)
fn kst_day(now_ms: f64) -> Option<String> {
    if !(0.0..=MAX_DATE_MS).contains(&now_ms) {
        return None;
    }
    let z = ((now_ms + KST_MS) / 86_400_000.0).floor() as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// JS /^-?\d+(?:\.\d+)?$/
fn is_num(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = s.split_once('.').unwrap_or((s, "0"));
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit());
    digits(int) && digits(frac)
}

fn fail(status: &str, error: &str) -> Vec<String> {
    vec![status.to_string(), Value::obj([("ok", Value::Bool(false)), ("error", Value::Str(error.into()))]).to_json()]
}

fn fields<const N: usize>(pairs: [(&str, Value); N]) -> Vec<(String, Value)> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

// ---------------------------------------------------------------------------
// 사실 비교: 숫자·날짜·계측기 번호(W1, H-3, SW2)를 나온 순서대로 모은다. 다듬은 문장도 이 목록·순서가 같아야 한다
// (정렬하면 'W1 -3.38, W2 -1.20' 이 'W1 -1.20, W2 -3.38' 로 바뀌어도 통과한다). 옛 JS: /[A-Za-z]{1,4}-?\d+|(?<![\w.])-?\d+(?:\.\d+)?/g
// ---------------------------------------------------------------------------

fn digits_from(b: &[u8], i: usize) -> usize {
    b.get(i..).map_or(0, |r| r.iter().take_while(|c| c.is_ascii_digit()).count())
}

fn digit_at(b: &[u8], i: usize) -> bool {
    b.get(i).is_some_and(u8::is_ascii_digit)
}

/// j 에서 숫자 하나의 끝: `\d+(\.\d+)*` — 날짜 2026.11.19·번호 뒤 소수 W1.5 는 한 덩어리. lead_dot 이면 '.5' 도
fn num_end(b: &[u8], mut j: usize, lead_dot: bool) -> Option<usize> {
    let d = digits_from(b, j);
    if d == 0 && !(lead_dot && b.get(j) == Some(&b'.') && digit_at(b, j + 1)) {
        return None;
    }
    j += d;
    while b.get(j) == Some(&b'.') && digit_at(b, j + 1) {
        j += 1 + digits_from(b, j + 1);
    }
    Some(j)
}

/// i 에서 시작하는 사실의 끝. 2026-11-19 agy 검토: 옛 JS 를 그대로 옮긴 판은 날짜 끝자리('2026.11.19' 의 19)·
/// 번호 뒤 소수('W1.5' 의 .5)·'.5'·5글자 번호 앞 글자('POINT1' 의 P)를 빼서, 모델이 바꿔도 통과했다
fn fact_at(b: &[u8], i: usize) -> Option<usize> {
    let letters = b[i..].iter().take_while(|c| c.is_ascii_alphabetic()).count();
    if letters > 0 {
        // 글자로 시작하면 숫자 쪽은 보지 않는다
        let mut j = i + letters;
        if b.get(j) == Some(&b'-') && digit_at(b, j + 1) {
            j += 1;
        }
        return num_end(b, j, false);
    }
    if i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_' || b[i - 1] == b'.') {
        return None;
    }
    let mut j = i;
    if b[j] == b'-' && (digit_at(b, j + 1) || (b.get(j + 1) == Some(&b'.') && digit_at(b, j + 2))) {
        j += 1;
    }
    num_end(b, j, true)
}

pub fn facts_of(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match fact_at(b, i) {
            Some(end) => {
                out.push(s[i..end].to_ascii_uppercase());
                i = end;
            }
            None => i += 1,
        }
    }
    out.join("|")
}

/// 메모 다듬은 문장(줄마다 '- ')을 한 줄로: 앞 '- ' 빼고 ', ' 로 잇는다. MEMO_MAX 자까지
fn memo_join(s: &str) -> String {
    let lines: Vec<&str> = s
        .split('\n')
        .map(|l| {
            let t = l.trim_start_matches(js_space);
            match t.strip_prefix('-') {
                Some(rest) if rest.starts_with(js_space) => js_trim(rest),
                _ => js_trim(l),
            }
        })
        .filter(|l| !l.is_empty())
        .collect();
    cut(&lines.join(", "), MEMO_MAX).to_string()
}

// ---------------------------------------------------------------------------
// 보내기 전 검사(op 3)
// ---------------------------------------------------------------------------

/// 파일: 계획서는 PDF·사진, 명함은 사진만. 글자 검사(b64ok)는 wasm_ai_b64_ok 가 먼저 한다
fn file_input(meta: &Value, pdf_ok: bool, b64ok: bool) -> Option<(&'static str, String)> {
    let t = meta.get("file")?.get("type")?.as_str()?;
    let kind = if pdf_ok && t == PDF {
        "document"
    } else if IMAGE_TYPES.contains(&t) {
        "image"
    } else {
        return None;
    };
    b64ok.then(|| (kind, t.to_string()))
}

/// 값 1~20개. 친 글자가 모델에 들어가니 칸마다 길이를 자른다
fn typo_input(meta: &Value) -> Option<(&'static str, String)> {
    let items = list(meta.get("items"), 21);
    if items.is_empty() || items.len() > 20 {
        return None;
    }
    let mut clean = Vec::with_capacity(items.len());
    for i in items {
        let (id, value) = (str_of(i.get("id"), 40), str_of(i.get("value"), 40));
        if id.is_empty() || value.is_empty() {
            return None;
        }
        clean.push(Value::obj([
            ("id", Value::Str(id)),
            ("value", Value::Str(value)),
            ("prev", Value::Str(str_of(i.get("prev"), 40))),
            ("unit", Value::Str(str_of(i.get("unit"), 10))),
        ]));
    }
    Some(("text", Value::Arr(clean).to_json()))
}

fn memo_input(meta: &Value) -> Option<(&'static str, String)> {
    let t = js_trim(meta.get("text")?.as_str()?);
    (!t.is_empty() && len16(t) <= MEMO_MAX).then(|| ("text", format!("메모:\n{t}")))
}

fn ai_input(task: &str, meta: &Value, b64ok: bool, now: f64) -> Option<Vec<String>> {
    let Some(device) = device_of(meta) else { return Some(fail("400", "bad_device")) };
    let got = match task {
        "schedule" => file_input(meta, true, b64ok),
        "card" => file_input(meta, false, b64ok),
        "typo" => typo_input(meta),
        "memo" => memo_input(meta),
        _ => return None,
    };
    let Some((kind, payload)) = got else { return Some(fail("400", "bad_input")) };
    let day = kst_day(now)?;
    Some(vec!["ok".into(), format!("ai:{device}:{day}"), kind.into(), payload])
}

/// 하루 횟수를 넘었으면 429. 아니면 올린 값(실패한 호출도 센다 — 같은 기기가 되풀이해 부르는 것을 막는다)
/// ponytail: KV 읽고 쓰기 사이에 동시에 부르면 한두 번 더 갈 수 있다
fn ai_quota(used: &str) -> Vec<String> {
    let used = js_trim(used).parse::<u32>().unwrap_or(0);
    if used >= DAILY_LIMIT {
        return fail("429", "ai_limit");
    }
    vec!["ok".into(), (used + 1).to_string()]
}

// ---------------------------------------------------------------------------
// 답 정리(op 5): 모델 답은 그대로 내보내지 않는다. 칸마다 모양·길이를 다시 맞춘다
// ---------------------------------------------------------------------------

fn schedule_clean(out: &Value, _meta: &Value) -> Clean {
    let period = out.get("period");
    let start = day(period.and_then(|p| p.get("start")));
    let end = day(period.and_then(|p| p.get("end")));
    let period = match (&start, &end) {
        (Value::Str(_), Value::Str(_)) => Value::obj([("start", start), ("end", end)]),
        _ => Value::Null,
    };
    let rows = list(out.get("rows"), 80)
        .iter()
        .filter_map(|r| {
            let title = str_of(r.get("title"), 200);
            // 요일 0~6 을 비트로 모으면 정렬·중복 빼기가 한 번에 된다(정렬 코드가 wasm 에 안 들어감)
            let mask = list(r.get("days"), 7).iter().filter_map(int_of).filter(|d| (0.0..=6.0).contains(d)).fold(0u8, |m, d| m | 1 << d as u8);
            (!title.is_empty() && mask != 0).then(|| {
                Value::obj([
                    ("no", Value::Num(r.get("no").and_then(int_of).unwrap_or(0.0))),
                    ("title", Value::Str(title)),
                    ("memo", Value::Str(str_of(r.get("memo"), 200))),
                    ("days", Value::Arr((0..7u8).filter(|d| mask & 1 << d != 0).map(|d| Value::Num(f64::from(d))).collect())),
                ])
            })
        })
        .collect();
    let notes = list(out.get("notes"), 40)
        .iter()
        .filter_map(|n| {
            let text = str_of(n.get("text"), 300);
            (!text.is_empty()).then(|| Value::obj([("text", Value::Str(text)), ("date", day(n.get("date")))]))
        })
        .collect();
    Ok(fields([("period", period), ("rows", Value::Arr(rows)), ("notes", Value::Arr(notes))]))
}

fn card_clean(out: &Value, _meta: &Value) -> Clean {
    Ok(CARD_FIELDS
        .iter()
        .map(|&k| (k.to_string(), Value::Str(str_of(out.get(k), if k == "memo" { 300 } else { 100 }))))
        .collect())
}

/// 보낸 id 만, 제안은 숫자 모양(20자까지)만 통과. 이유 글은 받지 않는다(자유 글을 화면에 그대로 띄우지 않는다)
fn typo_clean(out: &Value, meta: &Value) -> Clean {
    let ids: Vec<String> = list(meta.get("items"), 21).iter().map(|i| str_of(i.get("id"), 40)).collect();
    let items = list(out.get("items"), 20)
        .iter()
        .filter_map(|i| {
            let id = i.get("id")?.as_str()?;
            if !ids.iter().any(|x| x == id) {
                return None;
            }
            let s = i.get("suggestion").and_then(Value::as_str).filter(|s| is_num(s) && s.len() <= 20).unwrap_or("");
            Some(Value::obj([("id", Value::Str(id.into())), ("suggestion", Value::Str(s.into()))]))
        })
        .collect();
    Ok(fields([("items", Value::Arr(items))]))
}

fn memo_clean(out: &Value, meta: &Value) -> Clean {
    // 자르지 않고 거절: 잘라서 비교하면 잘린 뒤쪽 숫자는 검사를 안 받는다(2026-11-19 agy 검토)
    let sentence = out.get("sentence").and_then(Value::as_str).map_or("", js_trim);
    if sentence.is_empty() || len16(sentence) > MEMO_MAX {
        return Err(fail("502", "ai_bad_output"));
    }
    if facts_of(sentence) != facts_of(&str_of(meta.get("text"), MEMO_MAX)) {
        return Err(fail("422", "ai_changed_facts"));
    }
    Ok(fields([("sentence", Value::Str(sentence.to_string()))]))
}

fn ai_finish(task: &str, stop: &str, out: &str, meta: &Value) -> Option<Vec<String>> {
    let clean: fn(&Value, &Value) -> Clean = match task {
        "schedule" => schedule_clean,
        "card" => card_clean,
        "typo" => typo_clean,
        "memo" => memo_clean,
        _ => return None,
    };
    if stop == "refusal" {
        return Some(fail("422", "ai_refused"));
    }
    if stop != "end_turn" {
        return Some(fail("502", "ai_cut"));
    }
    // 답 형식(json_schema)은 늘 객체. 객체가 아니면 망가진 답
    let Some(out @ Value::Obj(_)) = json::parse(out) else { return Some(fail("502", "ai_bad_output")) };
    Some(match clean(&out, meta) {
        Ok(kv) => {
            let mut all = vec![("ok".to_string(), Value::Bool(true))];
            all.extend(kv);
            vec!["200".into(), Value::Obj(all).to_json()]
        }
        Err(e) => e,
    })
}

/// Claude 오류 → [앱 코드, http 상태]. status 빈 글자 = 연결 끊김·시간 초과
/// 지출 한도(2026-11-19, platform.claude.com/docs/en/api/errors·rate-limits): 직접 건 월 한도 = 400 + 한도 문구,
/// 등급 월 상한 = 429 + details.error_code enforced_spend_limit_reached(retry-after 없음), 결제 문제 = 402 billing_error.
/// 400 한도 문구는 문서에 글자가 안 나와 86 세션이 전한 앞부분으로 본다 — 바뀌면 ai_bad_input 으로 떨어질 뿐(안전한 쪽)
fn ai_error(status: &str, etype: &str, ecode: &str, message: &str) -> Vec<String> {
    let spend = status == "402"
        || etype == "billing_error"
        || ecode == "enforced_spend_limit_reached"
        || (status == "400" && message.starts_with("You have reached your specified"));
    let (code, http) = if spend {
        ("ai_spend_limit", "503")
    } else {
        match status {
            "429" => ("ai_busy", "429"),
            "401" | "403" => ("ai_not_configured", "503"),
            "400" => ("ai_bad_input", "400"),
            _ => ("ai_down", "502"), // 529 과부하·5xx·그 밖 4xx·연결 끊김·시간 초과
        }
    };
    vec![code.into(), http.into()]
}

/// 글자열 묶음 하나로 부르는 입구. None = 모르는 op·인자 수가 틀림
pub fn text_call(op: u32, args: &[String]) -> Option<Vec<String>> {
    match (op, args) {
        (1, [t, prev]) => Some(suggest(t, prev).map_or_else(Vec::new, |s| core::iter::once(s.why).chain(s.fixes).collect())),
        (2, [s]) => Some(vec![memo_join(s)]),
        (3, [task, meta, b64ok, now]) => {
            let now = now.parse::<u64>().ok()? as f64; // JS Date.now() 는 정수 ms
            match json::parse(meta) {
                Some(m) => ai_input(task, &m, b64ok == "1", now),
                None => Some(fail("400", "bad_input")),
            }
        }
        (4, [used]) => Some(ai_quota(used)),
        (5, [task, stop, out, meta]) => ai_finish(task, stop, out, &json::parse(meta)?),
        (6, [status, etype, ecode, message]) => Some(ai_error(status, etype, ecode, message)),
        _ => None,
    }
}

fn pack(strs: &[String]) -> Vec<u16> {
    let mut out = Vec::new();
    for s in strs {
        let u: Vec<u16> = s.encode_utf16().collect();
        out.push(u.len() as u16);
        out.push((u.len() >> 16) as u16);
        out.extend(u);
    }
    out
}

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있고, `out` 은 `out_cap * 2` 바이트를 쓸 수 있어야 한다.
/// 돌려주는 값: 쓴 글자 수(묶음, 0 = 빈 답), -1 = 망가진 입력·모르는 op, -2 = out 이 작음
#[no_mangle]
pub unsafe extern "C" fn wasm_text_call(op: u32, ptr: *const u8, units: usize, out: *mut u8, out_cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let Some(args) = unpack(&buf).into_iter().map(text).collect::<Option<Vec<_>>>() else { return -1 };
    let Some(res) = text_call(op, &args) else { return -1 };
    let packed = pack(&res);
    if packed.is_empty() {
        return 0;
    }
    if out.is_null() || packed.len() > out_cap {
        return -2;
    }
    let dst = core::slice::from_raw_parts_mut(out, packed.len() * 2);
    for (c, u) in dst.as_chunks_mut::<2>().0.iter_mut().zip(&packed) {
        *c = u.to_le_bytes();
    }
    packed.len() as i32
}

#[no_mangle]
pub extern "C" fn wasm_ai_b64_max() -> usize {
    MAX_B64
}

/// JS /^[A-Za-z0-9+/]+={0,2}$/ 에 길이 4의 배수를 더함(앱은 늘 '=' 를 채워 보낸다. 2026-11-19 agy 검토)
fn b64_ok(b: &[u8]) -> bool {
    let pad = b.iter().rev().take(2).take_while(|&&c| c == b'=').count();
    let body = &b[..b.len() - pad];
    b.len().is_multiple_of(4) && !body.is_empty() && body.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}

/// # Safety
/// `ptr` 는 `written` 바이트를 읽을 수 있어야 한다. JS 가 TextEncoder.encodeInto 로 `units` 바이트 칸에 base64 를 넣는다.
/// written(바이트) != units(JS 글자 수)면 ASCII 아닌 글자가 섞인 것 → 0
#[no_mangle]
pub unsafe extern "C" fn wasm_ai_b64_ok(ptr: *const u8, written: usize, units: usize) -> u32 {
    if ptr.is_null() || written != units || !(1..=MAX_B64).contains(&units) {
        return 0;
    }
    u32::from(b64_ok(core::slice::from_raw_parts(ptr, written)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "dev-abc-123";
    const NOW: &str = "1795014000000"; // 2026-11-19 00:00 KST

    fn call(op: u32, args: &[&str]) -> Option<Vec<String>> {
        text_call(op, &args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }
    fn input(task: &str, meta: &str, b64ok: &str) -> Vec<String> {
        call(3, &[task, meta, b64ok, NOW]).unwrap()
    }
    fn finish(task: &str, stop: &str, out: &str, meta: &str) -> Vec<String> {
        call(5, &[task, stop, out, meta]).unwrap()
    }
    fn ok(json: &str) -> Vec<String> {
        vec!["200".into(), json.into()]
    }
    fn key() -> String {
        format!("ai:{D}:2026-11-19")
    }
    fn bytes(units: &[u16]) -> Vec<u8> {
        units.iter().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn facts_match_old_js_regex() {
        // 값은 node 에서 옛 FACT_RE 로 뽑은 것
        for (s, want) in [
            ("11-18 W1 -3.38, h2 12", "11|18|W1|-3.38|H2|12"),
            ("- 11-18 W1 -3.38 확인, H2 12 임", "11|18|W1|-3.38|H2|12"),
            ("ABCDE5 x", "ABCDE5"),
            ("W1W2 12W3", "W1|W2|12|W3"),
            ("H-3 SW-12 a-b", "H-3|SW-12"),
            ("1.2.3 .5 _7 x.9", "1.2.3|.5"),
            ("현장3 3.", "3|3"),
            ("-0.5 --2 1-2-3", "-0.5|-2|1|2|3"),
            ("ab12.5", "AB12.5"),
            ("", ""),
        ] {
            assert_eq!(facts_of(s), want, "{s:?}");
        }
        assert_ne!(facts_of("W1 -3.38, W2 -1.20"), facts_of("W1 -1.20, W2 -3.38"), "순서가 바뀌면 다르다");
        // 2026-11-19 agy 검토: 옛 JS 는 아래 쌍을 같다고 봤다(모델이 바꿔도 통과)
        assert_eq!(facts_of("2026.11.19 W1-3.38 및 .5 침하"), "2026.11.19|W1|3.38|.5");
        for (a, b) in [("2026.11.19", "2026.11.29"), ("값 .5", "값 .8"), ("값 -.5", "값 .5"), ("POINT1", "XOINT1"), ("H-3.38", "H-3.99"), ("W1.5", "W1.9")] {
            assert_ne!(facts_of(a), facts_of(b), "{a:?} vs {b:?}");
        }
        // 같은 사실을 달리 쓴 것은 그대로 같다
        assert_eq!(facts_of("2026-11-19 W1 -3.38"), facts_of("2026년 11월 19일 W1은 -3.38"));
    }

    #[test]
    fn day_like_date_parse() {
        let d = |s: &str| day(Some(&Value::Str(s.into())));
        for s in ["2026-11-09", "2026-02-30", "2026-02-31", "0000-01-01"] {
            assert_eq!(d(s), Value::Str(s.into()), "{s}");
        }
        for s in ["2026-02-32", "2026-13-01", "2026-00-10", "2026-01-00", " 2026-11-09", "2026-1-09", "2026-11-0a", ""] {
            assert_eq!(d(s), Value::Null, "{s:?}");
        }
        assert_eq!(day(Some(&Value::Num(20261109.0))), Value::Null);
        assert_eq!(day(None), Value::Null);
    }

    #[test]
    fn kst_day_turns_at_midnight_korea() {
        assert_eq!(kst_day(1_795_014_000_000.0 - 1.0).as_deref(), Some("2026-11-18"));
        assert_eq!(kst_day(1_795_014_000_000.0).as_deref(), Some("2026-11-19"));
        assert_eq!(kst_day(1_709_132_400_000.0).as_deref(), Some("2024-02-29"));
        assert_eq!(kst_day(f64::NAN), None);
        assert_eq!(kst_day(-1.0), None);
    }

    #[test]
    fn memo_join_like_old_app_js() {
        assert_eq!(memo_join("- 11-18 W1 -3.38 들뜸이 확인됨\n- 배수 불량임"), "11-18 W1 -3.38 들뜸이 확인됨, 배수 불량임");
        assert_eq!(memo_join("  -x\n\n -  y \r\n-\tz"), "-x, y, z");
        assert_eq!(memo_join("-"), "-");
        assert_eq!(memo_join("- "), "");
        assert_eq!(memo_join(&"가".repeat(1200)).chars().count(), 1000);
    }

    #[test]
    fn op1_is_valuefix_suggest() {
        let s = suggest("-3,34", "").unwrap();
        let want: Vec<String> = core::iter::once(s.why).chain(s.fixes).collect();
        assert!(want[0].contains("쉼표"), "{want:?}");
        assert_eq!(call(1, &["-3,34", ""]), Some(want));
        assert_eq!(call(1, &["", ""]), Some(vec![]));
        assert_eq!(call(1, &["x"]), None, "인자 수가 틀림");
    }

    #[test]
    fn input_checks_device_first() {
        for dev in ["x", "abcdefg", &"a".repeat(65), "dev abc-123", "dev-abc_123", "기기번호입니다요"] {
            let meta = Value::obj([("device", Value::Str(dev.into())), ("text", Value::Str("W1".into()))]).to_json();
            assert_eq!(input("memo", &meta, "0"), fail("400", "bad_device"), "{dev:?}");
        }
        assert_eq!(input("memo", r#"{"device":12345678,"text":"W1"}"#, "0"), fail("400", "bad_device"));
        assert_eq!(input("memo", r#"{"device":"x","text":""}"#, "0"), fail("400", "bad_device"), "기기 먼저");
        assert_eq!(input("memo", "{", "0"), fail("400", "bad_input"));
        assert_eq!(call(3, &["chat", &format!(r#"{{"device":"{D}"}}"#), "0", NOW]), None);
        assert_eq!(call(3, &["memo", "{}", "0", "abc"]), None);
    }

    #[test]
    fn memo_input() {
        let m = |t: &str| input("memo", &Value::obj([("device", Value::Str(D.into())), ("text", Value::Str(t.into()))]).to_json(), "0");
        assert_eq!(m("  W1 -3.38 \n"), vec!["ok".into(), key(), "text".into(), "메모:\nW1 -3.38".to_string()]);
        assert_eq!(m(&"x".repeat(1001)), fail("400", "bad_input"));
        assert_eq!(m(&format!(" {} ", "x".repeat(1000)))[0], "ok");
        assert_eq!(m(" \n "), fail("400", "bad_input"));
        assert_eq!(input("memo", &format!(r#"{{"device":"{D}"}}"#), "0"), fail("400", "bad_input"));
    }

    #[test]
    fn file_input_by_task() {
        let f = |task: &str, file: &str, b64ok: &str| input(task, &format!(r#"{{"device":"{D}","file":{file}}}"#), b64ok);
        assert_eq!(f("card", r#"{"type":"application/pdf"}"#, "1"), fail("400", "bad_input"), "명함은 사진만");
        assert_eq!(f("card", r#"{"type":"image/png"}"#, "1"), vec!["ok".into(), key(), "image".into(), "image/png".into()]);
        assert_eq!(f("card", r#"{"type":"image/png"}"#, "0"), fail("400", "bad_input"), "base64 가 틀림");
        assert_eq!(f("schedule", r#"{"type":"application/pdf"}"#, "1"), vec!["ok".into(), key(), "document".into(), PDF.into()]);
        assert_eq!(f("schedule", r#"{"type":"image/webp"}"#, "1")[2], "image");
        assert_eq!(f("schedule", r#"{"type":"image/gif"}"#, "1"), fail("400", "bad_input"));
        assert_eq!(f("schedule", "null", "1"), fail("400", "bad_input"));
        assert_eq!(f("schedule", "{}", "1"), fail("400", "bad_input"));
    }

    #[test]
    fn typo_input() {
        let t = |items: &str| input("typo", &format!(r#"{{"device":"{D}","items":{items}}}"#), "0");
        let item = r#"{"id":"a","value":"1"}"#;
        assert_eq!(t("[]"), fail("400", "bad_input"));
        assert_eq!(t(&format!("[{}]", vec![item; 21].join(","))), fail("400", "bad_input"));
        assert_eq!(t(&format!("[{}]", vec![item; 20].join(",")))[0], "ok");
        assert_eq!(t(r#"[{"id":"a"}]"#), fail("400", "bad_input"));
        assert_eq!(t(r#"[{"id":" ","value":"1"}]"#), fail("400", "bad_input"));
        assert_eq!(t(r#"["a"]"#), fail("400", "bad_input"));
        assert_eq!(t(r#""a""#), fail("400", "bad_input"));
        let got = t(r#"[{"id":" a ","value":" -3,34 ","prev":-3.3,"unit":"지하수위계 W1 깊은곳","extra":1}]"#);
        assert_eq!(got, vec!["ok".into(), key(), "text".into(), r#"[{"id":"a","value":"-3,34","prev":"","unit":"지하수위계 W1 깊"}]"#.into()]);
    }

    #[test]
    fn quota_counts_to_60() {
        let q = |u: &str| call(4, &[u]).unwrap();
        assert_eq!(q(""), vec!["ok", "1"]);
        assert_eq!(q("59"), vec!["ok", "60"]);
        assert_eq!(q("60"), fail("429", "ai_limit"));
        assert_eq!(q("abc"), vec!["ok", "1"], "망가진 값은 0 부터(옛 JS 는 NaN 이 되어 한도가 풀렸다)");
    }

    #[test]
    fn finish_stop_reasons_and_bad_output() {
        let meta = format!(r#"{{"device":"{D}"}}"#);
        assert_eq!(finish("card", "refusal", "{}", &meta), fail("422", "ai_refused"));
        assert_eq!(finish("card", "max_tokens", "{}", &meta), fail("502", "ai_cut"));
        for bad in ["{이상한", "[1]", "", "null", "\"x\""] {
            assert_eq!(finish("card", "end_turn", bad, &meta), fail("502", "ai_bad_output"), "{bad:?}");
        }
        assert_eq!(call(5, &["chat", "end_turn", "{}", &meta]), None);
        assert_eq!(call(5, &["card", "end_turn", "{}", "{"]), None);
    }

    #[test]
    fn finish_schedule() {
        let out = r#"{"period":{"start":"2026-11-09","end":"2026-11-14"},
            "rows":[{"no":1,"title":" 역삼동 667-6 ","memo":"","days":[3,0,3,9,1.5,"2",-0]},
                    {"no":2,"title":"","memo":"","days":[1]},
                    {"no":3,"title":"용산동","memo":"x","days":[]},
                    {"no":3.5,"title":"b","days":[6]}, 7],
            "notes":[{"text":"11/10 회의","date":""},{"text":"  ","date":"2026-11-10"},{"text":"x","date":"2026-11-10"}]}"#;
        assert_eq!(
            finish("schedule", "end_turn", out, "{}"),
            ok(r#"{"ok":true,"period":{"start":"2026-11-09","end":"2026-11-14"},"rows":[{"no":1,"title":"역삼동 667-6","memo":"","days":[0,3]},{"no":0,"title":"b","memo":"","days":[6]}],"notes":[{"text":"11/10 회의","date":null},{"text":"x","date":"2026-11-10"}]}"#)
        );
        assert_eq!(
            finish("schedule", "end_turn", r#"{"period":{"start":"2026-11-09","end":""}}"#, "{}"),
            ok(r#"{"ok":true,"period":null,"rows":[],"notes":[]}"#)
        );
    }

    #[test]
    fn finish_card() {
        let out = format!(r#"{{"name":" 홍길동 ","email":5,"memo":"{}"}}"#, "x".repeat(301));
        assert_eq!(
            finish("card", "end_turn", &out, "{}"),
            ok(&format!(r#"{{"ok":true,"name":"홍길동","title":"","company":"","mobile":"","email":"","memo":"{}"}}"#, "x".repeat(300)))
        );
    }

    #[test]
    fn finish_typo_keeps_sent_ids_and_numbers_only() {
        let meta = format!(r#"{{"device":"{D}","items":[{{"id":" a ","value":"-3,34"}},{{"id":"b","value":"ㅁ"}}]}}"#);
        let out = r#"{"items":[{"id":"a","suggestion":"-3.34"},{"id":"b","suggestion":"모름"},{"id":"zz","suggestion":"1"},
            {"id":"a","suggestion":"123456789012345678901"},{"id":"b","suggestion":3.5},{"id":"b"}]}"#;
        assert_eq!(
            finish("typo", "end_turn", out, &meta),
            ok(r#"{"ok":true,"items":[{"id":"a","suggestion":"-3.34"},{"id":"b","suggestion":""},{"id":"a","suggestion":""},{"id":"b","suggestion":""},{"id":"b","suggestion":""}]}"#)
        );
        for (s, want) in [("12", true), ("-0.5", true), ("1.", false), (".5", false), ("1.2.3", false), ("-", false), ("3\n", false)] {
            assert_eq!(is_num(s), want, "{s:?}");
        }
    }

    #[test]
    fn finish_memo_keeps_facts() {
        let meta = Value::obj([("device", Value::Str(D.into())), ("text", Value::Str("W1 -3.38 들뜸".into()))]).to_json();
        assert_eq!(
            finish("memo", "end_turn", r#"{"sentence":" - W1 -3.38 들뜸이 확인됨 "}"#, &meta),
            ok(r#"{"ok":true,"sentence":"- W1 -3.38 들뜸이 확인됨"}"#)
        );
        assert_eq!(finish("memo", "end_turn", r#"{"sentence":"- W1 -3.83 들뜸이 확인됨"}"#, &meta), fail("422", "ai_changed_facts"));
        assert_eq!(finish("memo", "end_turn", r#"{"sentence":"  "}"#, &meta), fail("502", "ai_bad_output"));
        let long = format!(r#"{{"sentence":"- W1 -3.38 {}"}}"#, "가".repeat(1000));
        assert_eq!(finish("memo", "end_turn", &long, &meta), fail("502", "ai_bad_output"), "길면 자르지 않고 거절");
    }

    #[test]
    fn wasm_text_call_round_trip() {
        let input = bytes(&pack(&["- a\n- b".to_string()]));
        let units = input.len() / 2;
        let mut out = vec![0u8; 64];
        let n = unsafe { wasm_text_call(2, input.as_ptr(), units, out.as_mut_ptr(), 32) };
        assert_eq!(n, 6);
        let got: Vec<u16> = out[..12].as_chunks::<2>().0.iter().map(|b| u16::from_le_bytes(*b)).collect();
        assert_eq!(unpack(&got).into_iter().map(|u| text(u).unwrap()).collect::<Vec<_>>(), ["a, b"]);
        assert_eq!(unsafe { wasm_text_call(2, input.as_ptr(), units, out.as_mut_ptr(), 5) }, -2);
        assert_eq!(unsafe { wasm_text_call(9, input.as_ptr(), units, out.as_mut_ptr(), 32) }, -1);
        let lone = bytes(&[1, 0, 0xD800]);
        assert_eq!(unsafe { wasm_text_call(2, lone.as_ptr(), 3, out.as_mut_ptr(), 32) }, -1);
        let empty = bytes(&pack(&[String::new(), String::new()]));
        assert_eq!(unsafe { wasm_text_call(1, empty.as_ptr(), empty.len() / 2, out.as_mut_ptr(), 32) }, 0);
    }

    #[test]
    fn b64_like_old_regex() {
        for (s, want) in [("QUJD", true), ("QUI=", true), ("QQ==", true), ("a+/9", true), ("A===", false), ("==", false), ("", false), ("QU JD", false), ("QUJD\n", false), ("Q=UJ", false), ("A=", false), ("QUI", false), ("QUJDQ", false)] {
            assert_eq!(b64_ok(s.as_bytes()), want, "{s:?}");
        }
        let s = b"QUJD";
        assert_eq!(unsafe { wasm_ai_b64_ok(s.as_ptr(), 4, 4) }, 1);
        assert_eq!(unsafe { wasm_ai_b64_ok(s.as_ptr(), 3, 4) }, 0, "다 못 넣음 = ASCII 아닌 글자");
        assert_eq!(unsafe { wasm_ai_b64_ok("é".as_ptr(), 2, 2) }, 0);
        assert_eq!(unsafe { wasm_ai_b64_ok(core::ptr::null(), 4, 4) }, 0);
        assert_eq!(wasm_ai_b64_max(), MAX_B64);
    }

    #[test]
    fn error_codes_and_spend_limit() {
        let e = |s: &str, t: &str, c: &str, m: &str| text_call(6, &[s.into(), t.into(), c.into(), m.into()]).unwrap();
        let spend = vec!["ai_spend_limit".to_string(), "503".into()];
        assert_eq!(e("400", "invalid_request_error", "", "You have reached your specified API usage limits. You will regain access on 2026-12-01."), spend);
        assert_eq!(e("400", "invalid_request_error", "", "You have reached your specified workspace API usage limits."), spend);
        assert_eq!(e("429", "rate_limit_error", "enforced_spend_limit_reached", "spend cap"), spend);
        assert_eq!(e("402", "billing_error", "", "card declined"), spend);
        // 한도가 아니면 옛 JS 분류 그대로
        assert_eq!(e("429", "rate_limit_error", "", "Number of request tokens has exceeded your per-minute rate limit"), ["ai_busy", "429"]);
        assert_eq!(e("400", "invalid_request_error", "", "messages: Input should be a valid list"), ["ai_bad_input", "400"]);
        assert_eq!(e("400", "invalid_request_error", "", "x You have reached your specified API usage limits"), ["ai_bad_input", "400"], "앞부분만 본다");
        assert_eq!(e("401", "authentication_error", "", ""), ["ai_not_configured", "503"]);
        assert_eq!(e("403", "permission_error", "", ""), ["ai_not_configured", "503"]);
        for s in ["529", "500", "404", ""] {
            assert_eq!(e(s, "", "", ""), ["ai_down", "502"], "{s:?}");
        }
        assert_eq!(text_call(6, &["400".into()]), None, "인자 수가 틀림");
    }
}
