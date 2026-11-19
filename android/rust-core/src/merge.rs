//! 도면 메모 저장 전 합치기(작업 1, 2026-11-19 도면 값 사라짐). 화면 연결은 web/drawing.js mergeNotesForSave → rust-core.js mergeNotesPins.
//! 입력·출력은 동그라미 배열(JSON) 만이다. 필기·sourceId 등 나머지는 JS 가 내 메모 것을 그대로 둔다.
//!
//! 규칙:
//! - 내 동그라미는 순서·자리·번호 그대로. 같은 id 가 그쪽에도 있으면 값은 날짜가 늦은 쪽(같은 날이면 내 것 — 기존 규칙),
//!   진 쪽 값은 날짜가 다르면 history 로 들어간다. history 는 양쪽을 합친다(날짜·값이 같은 것은 하나, 날짜순, 최근 20).
//! - 그쪽에만 있는 동그라미: 내 메모의 마지막 지난 날짜(오늘 제외)보다 늦은 기록이 있거나 오늘 값이 있으면 더한다.
//!   그보다 늦은 기록이 없으면 내가 받아 본 뒤 지운 것으로 보고 되살리지 않는다(기존 규칙 유지).
//!
//! json.rs 는 ai 기능에 묶여 있어 이 모듈도 같이 묶는다(서버 Code.gs 작은 판에는 안 쓰는 화면 전용 규칙).
//! json.rs 의 to_json 은 숫자를 정수로만 써서(좌표 x·y 가 깨짐) 여기 출력기를 따로 둔다.
#![cfg(feature = "ai")]

use crate::json::{self, Value};
use crate::lock::{read_units, text, unpack};
use core::fmt::Write;

/// web/pinhistory.js MAX_PIN_HISTORY 와 같다
pub const MAX_PIN_HISTORY: usize = 20;

fn dup(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        Value::Bool(b) => Value::Bool(*b),
        Value::Num(n) => Value::Num(*n),
        Value::Str(s) => Value::Str(s.clone()),
        Value::Arr(a) => Value::Arr(a.iter().map(dup).collect()),
        Value::Obj(kv) => Value::Obj(kv.iter().map(|(k, v)| (k.clone(), dup(v))).collect()),
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// 숫자를 잃지 않고 쓰는 JSON 출력(f64 Display = 가장 짧은 되돌림 표기, 지수 없음)
fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) if n.is_finite() => {
            let _ = write!(out, "{}", n);
        }
        Value::Num(_) => out.push_str("null"),
        Value::Str(s) => write_str(out, s),
        Value::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Obj(kv) => {
            out.push('{');
            for (i, (k, x)) in kv.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(out, k);
                out.push(':');
                write(x, out);
            }
            out.push('}');
        }
    }
}

/// JS 의 참/거짓(!!v) 중 값 칸에 쓰이는 것: 빈 글자·0·null·false 는 거짓
fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Str(s)) => !s.is_empty(),
        Some(Value::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Value::Bool(b)) => *b,
        Some(Value::Arr(_)) | Some(Value::Obj(_)) => true,
        _ => false,
    }
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::Str(s)) => s.clone(),
        Some(Value::Num(n)) => {
            let mut s = String::new();
            write(&Value::Num(*n), &mut s);
            s
        }
        _ => String::new(),
    }
}

/// 동그라미 id(JS `p && p.id`): 거짓이면 None
fn pin_id(p: &Value) -> Option<String> {
    let id = p.get("id");
    if !matches!(p, Value::Obj(_)) || !truthy(id) {
        return None;
    }
    Some(str_of(id))
}

fn date_of(p: &Value) -> String {
    str_of(p.get("date"))
}

fn history_of(p: &Value) -> &[Value] {
    p.get("history").and_then(Value::as_arr).unwrap_or(&[])
}

/// 값이 적힌 날짜들(지금 값 + history)
fn value_dates(p: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if truthy(p.get("text")) {
        out.push(date_of(p));
    }
    for h in history_of(p) {
        if matches!(h, Value::Obj(_)) && truthy(h.get("text")) {
            out.push(date_of(h));
        }
    }
    out
}

fn set(obj: &mut Value, key: &str, v: Value) {
    if let Value::Obj(kv) = obj {
        match kv.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = v,
            None => kv.push((key.to_string(), v)),
        }
    }
}

/// 지금 값을 history 한 줄로(pushPinHistory 와 같은 모양: date·text·author)
fn entry_of(p: &Value) -> Value {
    let mut kv = vec![
        ("date".to_string(), Value::Str(date_of(p))),
        ("text".to_string(), p.get("text").map(dup).unwrap_or(Value::Null)),
    ];
    if truthy(p.get("author")) {
        kv.push(("author".to_string(), dup(p.get("author").unwrap())));
    }
    Value::Obj(kv)
}

/// 두 history 를 합친다: 객체만, (날짜|값) 같은 것은 앞의 것 하나, 날짜순(같은 날짜는 들어온 순), 최근 MAX 개
fn union_history(parts: Vec<Value>, drop_date: Option<&str>) -> Vec<Value> {
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for h in parts {
        if !matches!(h, Value::Obj(_)) {
            continue;
        }
        let key = (date_of(&h), str_of(h.get("text")));
        if drop_date == Some(key.0.as_str()) || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(h);
    }
    out.sort_by_key(date_of); // 안정 정렬
    let skip = out.len().saturating_sub(MAX_PIN_HISTORY);
    out.split_off(skip)
}

/// 같은 id 의 내 동그라미(mine)와 그쪽 동그라미(theirs)를 합친다
fn merge_pin(mine: &Value, theirs: &Value) -> Value {
    let (m_has, t_has) = (truthy(mine.get("text")), truthy(theirs.get("text")));
    let (m_date, t_date) = (date_of(mine), date_of(theirs));
    let theirs_wins = t_has && (!m_has || t_date > m_date);
    let mut out = dup(mine);
    let (winner, loser, loser_has) = if theirs_wins { (theirs, mine, m_has) } else { (mine, theirs, t_has) };
    if theirs_wins {
        set(&mut out, "text", dup(theirs.get("text").unwrap()));
        set(&mut out, "date", Value::Str(t_date.clone()));
        if truthy(theirs.get("author")) {
            set(&mut out, "author", dup(theirs.get("author").unwrap()));
        }
    }
    let win_date = (truthy(winner.get("text"))).then(|| date_of(winner));
    let mut parts: Vec<Value> = history_of(mine).iter().chain(history_of(theirs)).map(dup).collect();
    if loser_has && Some(date_of(loser)) != win_date {
        parts.push(entry_of(loser));
    }
    let had_key = mine.get("history").is_some() || theirs.get("history").is_some();
    let history = union_history(parts, win_date.as_deref());
    if had_key || !history.is_empty() {
        set(&mut out, "history", Value::Arr(history));
    }
    out
}

/// 순수 함수: 내 동그라미 배열에 그쪽 배열을 합친 새 배열. 배열이 아니면 빈 배열로 본다
pub fn merge_pins(mine: &Value, theirs: &Value, today: &str) -> Vec<Value> {
    let mine_pins = mine.as_arr().unwrap_or(&[]);
    let their_pins: Vec<&Value> = theirs.as_arr().unwrap_or(&[]).iter().filter(|p| pin_id(p).is_some()).collect();
    let find_theirs = |id: &str| their_pins.iter().rev().find(|p| pin_id(p).as_deref() == Some(id)).copied();
    // 내 메모를 받아 온 시점: 내 기록 중 오늘이 아닌 가장 늦은 날짜
    let base = mine_pins
        .iter()
        .flat_map(value_dates)
        .filter(|d| d != today)
        .max()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    let mut have: Vec<String> = Vec::new();
    for p in mine_pins {
        match pin_id(p) {
            Some(id) => {
                out.push(match find_theirs(&id) {
                    Some(t) => merge_pin(p, t),
                    None => dup(p),
                });
                have.push(id);
            }
            None => out.push(dup(p)),
        }
    }
    for t in &their_pins {
        let id = pin_id(t).unwrap_or_default();
        if have.contains(&id) {
            continue;
        }
        let newer = value_dates(t).iter().any(|d| d.as_str() > base.as_str() || d == today);
        if newer {
            out.push(dup(t));
        }
    }
    out
}

/// 글자 입출력판: 동그라미 배열 JSON 두 개 → 합친 배열 JSON. 망가진 JSON 이면 None
pub fn merge_pins_json(mine: &str, theirs: &str, today: &str) -> Option<String> {
    let m = json::parse(mine)?;
    let t = json::parse(theirs)?;
    let mut out = String::new();
    write(&Value::Arr(merge_pins(&m, &t, today)), &mut out);
    Some(out)
}

/// # Safety
/// 묶음 = [내 동그라미 배열 JSON, 그쪽 배열 JSON, 오늘]. 합친 배열 JSON 을 `out` 에 UTF-16 으로 쓰고 글자 수를 돌려준다.
/// -1 = 망가진 입력, -2 = out 이 모자람(필요한 글자 수 이상으로 다시 부른다). `ptr` 은 `units * 2`, `out` 은 `out_cap * 2` 바이트.
#[no_mangle]
pub unsafe extern "C" fn wasm_merge_notes(ptr: *const u8, units: usize, out: *mut u8, out_cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [mine, theirs, today] = &parts[..] else { return -1 };
    let (Some(mine), Some(theirs), Some(today)) = (text(mine), text(theirs), text(today)) else { return -1 };
    let Some(res) = merge_pins_json(&mine, &theirs, &today) else { return -1 };
    let u: Vec<u16> = res.encode_utf16().collect();
    if out.is_null() || u.len() > out_cap {
        return -2;
    }
    let dst = core::slice::from_raw_parts_mut(out, u.len() * 2);
    for (i, c) in u.iter().enumerate() {
        dst[i * 2..i * 2 + 2].copy_from_slice(&c.to_le_bytes());
    }
    u.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "2026-11-19";

    fn run(mine: &str, theirs: &str) -> Value {
        json::parse(&merge_pins_json(mine, theirs, T).expect("json")).unwrap()
    }
    fn pin<'a>(pins: &'a Value, id: &str) -> &'a Value {
        pins.as_arr().unwrap().iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)).expect(id)
    }
    fn ids(pins: &Value) -> Vec<&str> {
        pins.as_arr().unwrap().iter().map(|p| p.get("id").and_then(Value::as_str).unwrap()).collect()
    }
    fn s<'a>(p: &'a Value, k: &str) -> &'a str {
        p.get(k).and_then(Value::as_str).unwrap_or("")
    }
    fn hist(p: &Value) -> Vec<(String, String)> {
        history_of(p).iter().map(|h| (s(h, "date").to_string(), s(h, "text").to_string())).collect()
    }

    // 조사자료 repro.js: 옛 메모(11-17)를 든 폰A가 11-19 에 저장 → 폰B의 11-18 W1 값·새 W2 가 지워졌다
    #[test]
    fn repro_old_phone_keeps_other_phone_past_values_and_new_pins() {
        let server = r#"[{"id":"W1","text":"1.2","date":"2026-11-18","history":[{"date":"2026-11-17","text":"1.0"}]},
                         {"id":"W2","text":"5.0","date":"2026-11-18","history":[]}]"#;
        let phone_a = r#"[{"id":"W1","text":"1.0","date":"2026-11-17","history":[]},
                          {"id":"W3","text":"7","date":"2026-11-19","history":[]}]"#;
        let out = run(phone_a, server);
        assert_eq!(ids(&out), ["W1", "W3", "W2"]);
        let w1 = pin(&out, "W1");
        assert_eq!((s(w1, "text"), s(w1, "date")), ("1.2", "2026-11-18"));
        assert_eq!(hist(w1), [("2026-11-17".into(), "1.0".into())]);
        assert_eq!(s(pin(&out, "W2"), "text"), "5.0");
        assert_eq!(s(pin(&out, "W3"), "text"), "7");
    }

    #[test]
    fn later_mine_wins_and_theirs_goes_to_history() {
        let out = run(
            r#"[{"id":"a","text":"3","date":"2026-11-19","history":[],"author":"김"}]"#,
            r#"[{"id":"a","text":"2","date":"2026-11-18","history":[{"date":"2026-11-17","text":"1"}],"author":"박"}]"#,
        );
        let a = pin(&out, "a");
        assert_eq!((s(a, "text"), s(a, "author")), ("3", "김"));
        assert_eq!(hist(a), [("2026-11-17".into(), "1".into()), ("2026-11-18".into(), "2".into())]);
        assert_eq!(s(&history_of(a)[1], "author"), "박");
    }

    #[test]
    fn same_date_conflict_keeps_mine_and_drops_theirs() {
        let out = run(r#"[{"id":"a","text":"3","date":"2026-11-19","history":[]}]"#, r#"[{"id":"a","text":"9","date":"2026-11-19","history":[]}]"#);
        let a = pin(&out, "a");
        assert_eq!(s(a, "text"), "3");
        assert!(hist(a).is_empty());
    }

    #[test]
    fn theirs_today_value_fills_my_empty_pin() {
        // 기존 시험(web.test.js b): 나는 안 잼, 그쪽이 오늘 잼 → 그쪽 값·작성자
        let out = run(
            r#"[{"id":"b","text":"","date":"2026-11-19","history":[{"date":"2026-11-05","text":"-2.10"}],"author":"김"}]"#,
            r#"[{"id":"b","text":"-2.05","date":"2026-11-19","history":[{"date":"2026-11-05","text":"-2.10"}],"author":"박"}]"#,
        );
        let b = pin(&out, "b");
        assert_eq!((s(b, "text"), s(b, "author")), ("-2.05", "박"));
        assert_eq!(hist(b).len(), 1);
    }

    #[test]
    fn histories_are_unioned_sorted_and_capped() {
        let out = run(
            r#"[{"id":"a","text":"3","date":"2026-11-19","history":[{"date":"2026-11-10","text":"1"}]}]"#,
            r#"[{"id":"a","text":"2","date":"2026-11-15","history":[{"date":"2026-11-12","text":"1.5"},{"date":"2026-11-10","text":"1"}]}]"#,
        );
        let dates: Vec<String> = hist(pin(&out, "a")).into_iter().map(|h| h.0).collect();
        assert_eq!(dates, ["2026-11-10", "2026-11-12", "2026-11-15"]);
        let many: Vec<String> = (1..=25).map(|d| format!(r#"{{"date":"2026-10-{:02}","text":"{}"}}"#, d, d)).collect();
        let out = run(r#"[{"id":"a","text":"","history":[]}]"#, &format!(r#"[{{"id":"a","text":"","history":[{}]}}]"#, many.join(",")));
        let h = hist(pin(&out, "a"));
        assert_eq!(h.len(), MAX_PIN_HISTORY);
        assert_eq!(h[0].0, "2026-10-06");
    }

    #[test]
    fn deleted_pins_are_not_revived_but_newer_records_are_kept() {
        let out = run(
            r#"[{"id":"a","text":"3","date":"2026-11-19","history":[{"date":"2026-11-17","text":"1"}]}]"#,
            r#"[{"id":"a","text":"1","date":"2026-11-17"},
                {"id":"gone","text":"4","date":"2026-11-17"},
                {"id":"f","text":"","date":"2026-11-19","history":[{"date":"2026-11-05","text":"1.5"}]},
                {"id":"new","text":"","date":"2026-11-19","history":[{"date":"2026-11-18","text":"8"}]},
                {"id":"today","text":"1.00","date":"2026-11-19"},
                {"id":"blank","text":"","date":"2026-11-19"}]"#,
        );
        assert_eq!(ids(&out), ["a", "new", "today"]);
    }

    #[test]
    fn keeps_numbers_fields_and_pins_without_id() {
        let mine = r#"[{"id":"a","page":1,"x":0.123456789,"y":1e-7,"num":"W1","text":"","history":[]},{"text":"x"}]"#;
        let out = run(mine, r#"[{"id":"a","x":0.9,"text":"2","date":"2026-11-18"},null,{"id":""}]"#);
        let arr = out.as_arr().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0].get("x").and_then(Value::as_num), Some(0.123456789)); // 자리는 내 것
        assert_eq!(arr[0].get("y").and_then(Value::as_num), Some(1e-7));
        assert_eq!(arr[0].get("page").and_then(Value::as_num), Some(1.0));
        assert_eq!(s(&arr[0], "text"), "2");
        assert_eq!(s(&arr[1], "text"), "x");
    }

    #[test]
    fn bad_input_is_rejected_and_non_arrays_are_empty() {
        assert_eq!(merge_pins_json("[", "[]", T), None);
        assert_eq!(merge_pins_json(r#"[{"id":"a"}]"#, "\"x\"", T).as_deref(), Some(r#"[{"id":"a"}]"#));
    }

    #[test]
    fn wasm_entry_round_trips_utf16() {
        let pack = |strs: &[&str]| -> Vec<u8> {
            let mut u = Vec::new();
            for s in strs {
                let e: Vec<u16> = s.encode_utf16().collect();
                u.push(e.len() as u16);
                u.push((e.len() >> 16) as u16);
                u.extend(e);
            }
            u.iter().flat_map(|c| c.to_le_bytes()).collect()
        };
        let input = pack(&[r#"[{"id":"한","text":"","history":[]}]"#, r#"[{"id":"한","text":"값","date":"2026-11-18"}]"#, T]);
        let mut out = vec![0u8; 400];
        let n = unsafe { wasm_merge_notes(input.as_ptr(), input.len() / 2, out.as_mut_ptr(), 200) };
        assert!(n > 0);
        let u: Vec<u16> = out[..n as usize * 2].as_chunks::<2>().0.iter().map(|b| u16::from_le_bytes(*b)).collect();
        assert!(String::from_utf16(&u).unwrap().contains("\"값\""));
        assert_eq!(unsafe { wasm_merge_notes(input.as_ptr(), input.len() / 2, out.as_mut_ptr(), 3) }, -2);
        assert_eq!(unsafe { wasm_merge_notes(input.as_ptr(), 2, out.as_mut_ptr(), 200) }, -1);
    }
}
