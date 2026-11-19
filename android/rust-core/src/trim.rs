//! 도면 메모(JSON)를 시트 한 칸 글자 수 한도에 맞추려면 어떤 지난 기록(pin.history)을 뺄지 정한다(작업 4, 2026-11-19).
//! 모든 동그라미의 기록을 날짜 순으로 세워 가장 오래된 것(날짜 모름 '' 먼저, 같은 날이면 앞 기록·앞 동그라미 먼저)부터 뺀다 → 최근 기록이 남는다.
//! 글자 수는 JS `JSON.stringify(...).length` 와 같은 UTF-16 단위로 센다. 입력 JSON 은 화면이 JSON.stringify 로 만든 글자 그대로 받는다.
//! 웹 전용(json.rs 가 ai 기능 안에 있어 같이 묶는다. 서버 Code.gs 는 이 함수를 쓰지 않는다).
#![cfg(feature = "ai")]

use crate::json::{self, Value};

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 뺄 기록 목록 [(동그라미 번호, 그 동그라미 history 안 번호)]. 한도 안이면 빈 목록.
/// None = 메모 모양이 아님(JSON 아님·pins 배열 없음) → 화면은 손대지 않는다.
/// 다 빼도 넘으면 기록을 전부 뺀 목록을 돌려준다(예전과 같다).
pub fn plan(notes_json: &str, max_len: usize) -> Option<Vec<(u32, u32)>> {
    let notes = json::parse(notes_json)?;
    let pins = notes.get("pins")?.as_arr()?;
    let mut len = utf16_len(notes_json);
    if len <= max_len {
        return Some(Vec::new());
    }
    let hist: Vec<&[Value]> = pins.iter().map(|p| p.get("history").and_then(Value::as_arr).unwrap_or(&[])).collect();
    let mut order: Vec<(&str, usize, usize)> = Vec::new();
    for (pi, h) in hist.iter().enumerate() {
        for (hi, e) in h.iter().enumerate() {
            order.push((e.get("date").and_then(Value::as_str).unwrap_or(""), hi, pi));
        }
    }
    order.sort();
    let mut left: Vec<usize> = hist.iter().map(|h| h.len()).collect();
    let mut out = Vec::new();
    for (_, hi, pi) in order {
        if len <= max_len {
            break;
        }
        // 배열에서 원소 하나를 빼면 그 글자 수 + 쉼표 1개(남은 게 하나뿐이면 쉼표 없음)가 준다
        len -= utf16_len(&hist[pi][hi].to_json()) + usize::from(left[pi] > 1);
        left[pi] -= 1;
        out.push((pi as u32, hi as u32));
    }
    Some(out)
}

/// # Safety
/// `ptr` = 글자열 묶음 1개(lock.rs 묶음 형식: 메모 JSON). `out` 은 `out_cap * 8` 바이트를 쓸 수 있어야 한다.
/// `out` 에 (동그라미 번호, history 번호) u32 쌍을 리틀 엔디언으로 쓰고 쌍 수를 돌려준다. -1 = 메모 모양 아님, -2 = out 이 작음
#[no_mangle]
pub unsafe extern "C" fn wasm_trim_plan(ptr: *const u8, units: usize, max_len: u32, out: *mut u8, out_cap: usize) -> i32 {
    let buf = crate::lock::read_units(ptr, units);
    let Some(s) = crate::lock::unpack(&buf).first().and_then(|u| crate::lock::text(u)) else { return -1 };
    let Some(list) = plan(&s, max_len as usize) else { return -1 };
    if list.len() > out_cap || (out.is_null() && !list.is_empty()) {
        return -2;
    }
    if !list.is_empty() {
        let dst = core::slice::from_raw_parts_mut(out, list.len() * 8);
        for (c, (pi, hi)) in dst.chunks_exact_mut(8).zip(&list) {
            c[..4].copy_from_slice(&pi.to_le_bytes());
            c[4..].copy_from_slice(&hi.to_le_bytes());
        }
    }
    list.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notes(pins: &[Vec<(&str, String)>]) -> String {
        let pins: Vec<String> = pins
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let h: Vec<String> = h.iter().map(|(d, t)| format!(r#"{{"date":"{d}","text":"{t}"}}"#)).collect();
                format!(r#"{{"id":"p{i}","text":"-1.0","history":[{}]}}"#, h.join(","))
            })
            .collect();
        format!(r#"{{"pins":[{}],"strokes":{{"1":[[{{"x":1.5,"y":2}}]]}},"sourceId":"s1"}}"#, pins.join(","))
    }

    /// JS 쪽처럼 목록대로 뺐을 때의 글자 수(시험용: 길이가 딱 맞는지 본다)
    fn apply(src: &str, drop: &[(u32, u32)]) -> usize {
        let v = json::parse(src).unwrap();
        let pins = v.get("pins").unwrap().as_arr().unwrap();
        let mut total = utf16_len(src);
        for (pi, p) in pins.iter().enumerate() {
            let h = p.get("history").and_then(Value::as_arr).unwrap_or(&[]);
            let kept: Vec<String> = h
                .iter()
                .enumerate()
                .filter(|(hi, _)| !drop.contains(&(pi as u32, *hi as u32)))
                .map(|(_, e)| e.to_json())
                .collect();
            let all: Vec<String> = h.iter().map(Value::to_json).collect();
            total = total - utf16_len(&all.join(",")) + utf16_len(&kept.join(","));
        }
        total
    }

    fn twenty() -> Vec<(&'static str, String)> {
        const D: [&str; 20] = [
            "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
            "2026-01-09", "2026-01-10", "2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16",
            "2026-01-17", "2026-01-18", "2026-01-19", "2026-01-20",
        ];
        D.iter().map(|d| (*d, "x".repeat(200))).collect()
    }

    #[test]
    fn fits_means_nothing_dropped() {
        let s = notes(&[vec![("2026-11-01", "0".into())]]);
        assert_eq!(plan(&s, 45000), Some(vec![]));
    }

    #[test]
    fn not_notes_is_none() {
        assert_eq!(plan("{\"pins\":\"x\"}", 10), None);
        assert_eq!(plan("not json", 10), None);
        assert_eq!(plan("[1]", 10), None);
    }

    #[test]
    fn stops_exactly_at_limit_and_keeps_recent() {
        let full = notes(&[twenty(), twenty(), twenty()]);
        let five: Vec<Vec<_>> = (0..3).map(|_| twenty()[15..].to_vec()).collect();
        let five_len = utf16_len(&notes(&five));
        let d = plan(&full, five_len).unwrap();
        assert_eq!(d.len(), 45);
        assert_eq!(apply(&full, &d), five_len);
        assert!(d.iter().all(|&(_, hi)| hi < 15), "날짜 01-01~01-15 만 뺀다");
        assert_eq!(plan(&full, 10).unwrap().len(), 60, "다 빼도 넘으면 전부");
    }

    #[test]
    fn oldest_first_across_pins_unknown_date_first() {
        let big = "x".repeat(300);
        let s = notes(&[
            vec![("", big.clone()), ("2026-01-01", big.clone()), ("2026-11-01", big.clone())],
            vec![("2026-10-01", big.clone()), ("2026-11-02", big.clone())],
        ]);
        let d = plan(&s, utf16_len(&s) - 700).unwrap();
        assert_eq!(d, vec![(0, 0), (0, 1), (1, 0)]);
        assert!(apply(&s, &d) <= utf16_len(&s) - 700);
    }

    #[test]
    fn counts_korean_in_utf16_like_js() {
        // 한글 1자 = JS length 1 (UTF-8 로는 3바이트)
        let s = notes(&[vec![("2026-01-01", "가".repeat(100)), ("2026-01-02", "나".repeat(100))]]);
        let one = notes(&[vec![("2026-01-02", "나".repeat(100))]]);
        let d = plan(&s, utf16_len(&one)).unwrap();
        assert_eq!(d, vec![(0, 0)]);
        assert_eq!(apply(&s, &d), utf16_len(&one));
    }

    #[test]
    fn pins_without_history_are_skipped() {
        let s = format!(r#"{{"pins":[{{"id":"a"}},{{"id":"b","history":[{{"date":"2026-01-01","text":"{}"}}]}}]}}"#, "x".repeat(100));
        assert_eq!(plan(&s, 50).unwrap(), vec![(1, 0)]);
    }

    #[test]
    fn wasm_entry_writes_pairs() {
        let s = notes(&[vec![("2026-01-01", "x".repeat(100)), ("2026-01-02", "y".repeat(100))]]);
        let u: Vec<u16> = s.encode_utf16().collect();
        let mut packed = vec![u.len() as u16, (u.len() >> 16) as u16];
        packed.extend(&u);
        let bytes: Vec<u8> = packed.iter().flat_map(|x| x.to_le_bytes()).collect();
        let mut out = vec![0u8; 8 * 4];
        let n = unsafe { wasm_trim_plan(bytes.as_ptr(), packed.len(), (u.len() - 50) as u32, out.as_mut_ptr(), 4) };
        assert_eq!(n, 1);
        assert_eq!(&out[..8], &[0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(unsafe { wasm_trim_plan(bytes.as_ptr(), packed.len(), 1, out.as_mut_ptr(), 1) }, -2);
        let bad: Vec<u8> = [3u16, 0, b'a' as u16, b'b' as u16, b'c' as u16].iter().flat_map(|x| x.to_le_bytes()).collect();
        assert_eq!(unsafe { wasm_trim_plan(bad.as_ptr(), 5, 1, out.as_mut_ptr(), 4) }, -1);
    }
}
