//! 도면이력(작업 2, 2026-11-19): 도면야장 저장이 덮어쓰기 직전 판을 '도면이력' 탭에 남길 때의 판단.
//! Code.gs 는 시트를 읽고 쓰기만 하고, 남길지·어떻게 나눌지·어느 줄을 지울지는 여기서 정한다.
//! - 남길지: 실시간 줄(`live:` 키)은 남기지 않는다(800ms마다 바뀌는 임시 줄). 옛 JSON 과 새 JSON 이 같으면 잃는 것이 없어 남기지 않는다.
//! - 나누기: 옛 JSON 이 한 칸(5만 자)에 안 들어가면 CHUNK 글자(UTF-16)씩 여러 줄(조각 1/n … n/n)로. 대리 글자 쌍은 가르지 않는다.
//! - 정리: 보관한 지 KEEP_DAYS 일이 지났거나, 같은 파일ID에서 최근 KEEP_VERSIONS 판 밖이면 지운다.
//!   같은 초에 두 번 저장될 수 있어 판은 보관시각이 아니라 조각 표시로 센다(아래에서 올라가며 n/n 을 만날 때 새 판).

use crate::lock::{read_units, unpack};

pub const CHUNK: usize = 49_000; // 시트 한 칸 한도 50,000 - safe() 가 붙이는 ' 등 여유
pub const KEEP_VERSIONS: usize = 30; // ponytail: 파일ID마다 최근 30판. 하루 저장이 많아 30일을 못 채우면 늘린다
pub const KEEP_DAYS: i64 = 30;
const KST_MS: i64 = 9 * 3_600_000;
const DAY_MS: i64 = 86_400_000;

fn starts_with_live(file_id: &[u16]) -> bool {
    let live: Vec<u16> = "live:".encode_utf16().collect();
    file_id.starts_with(&live)
}

/// 덮어쓰기 전에 옛 판을 남길지
pub fn should_keep(file_id: &[u16], old_json: &[u16], new_json: &[u16]) -> bool {
    !starts_with_live(file_id) && old_json != new_json
}

/// Code.gs FORMULA_START(/^[=+\-@]/) 와 같은 글자
fn is_formula_start(u: u16) -> bool {
    matches!(u, 0x3D | 0x2B | 0x2D | 0x40)
}

/// 조각 끝 위치들(UTF-16 글자 수). 빈 JSON 도 조각 하나(끝 0)
pub fn part_ends(json: &[u16], chunk: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut at = 0;
    while at < json.len() {
        let mut end = (at + chunk.max(2)).min(json.len());
        // 높은 대리 글자에서 끊기면 짝과 같이 다음 조각으로
        if end < json.len() && (0xD800..0xDC00).contains(&json[end - 1]) {
            end -= 1;
        }
        // 다음 조각이 = + - @ 로 시작하면 Code.gs safe() 가 앞에 ' 를 붙여 이어 붙인 JSON 이 깨진다 → 경계를 앞으로 당긴다
        // (2026-11-19 Gemini 지적 6). JSON 에서 이 네 글자가 길게 이어지는 일은 드물어 몇 글자 안에 멈춘다
        while end < json.len() && end > at + 1 && is_formula_start(json[end]) {
            end -= 1;
            if end > at + 1 && (0xD800..0xDC00).contains(&json[end - 1]) {
                end -= 1;
            }
        }
        ends.push(end);
        at = end;
    }
    if ends.is_empty() {
        ends.push(0);
    }
    ends
}

/// epoch 밀리초 → 한국 시각 "yyyy-MM-dd HH:mm:ss" (Code.gs TZ 와 같은 꼴)
pub fn kst_stamp(ms: i64) -> String {
    let t = ms + KST_MS;
    let days = t.div_euclid(DAY_MS);
    let secs = t.rem_euclid(DAY_MS) / 1000;
    // Howard Hinnant civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

/// "조각 a/b" 에서 (a, b). 못 읽으면 None
fn chunk_mark(s: &str) -> Option<(u32, u32)> {
    let slash = s.find('/')?;
    let head = &s[..slash];
    let a = &head[head.trim_end_matches(|c: char| c.is_ascii_digit()).len()..];
    let tail = &s[slash + 1..];
    let b = &tail[..tail.len() - tail.trim_start_matches(|c: char| c.is_ascii_digit()).len()];
    Some((a.parse().ok()?, b.parse().ok()?))
}

pub struct Row<'a> {
    pub at: &'a str,
    pub file_id: &'a str,
    pub chunk: &'a str,
}

/// 지울 줄의 순번(0부터, 큰 것부터). rows 는 시트 위→아래 순(맨 아래가 최신)
pub fn prune(rows: &[Row], file_id: &str, stamp: &str, now_ms: i64, keep: usize, days: i64) -> Vec<usize> {
    let cutoff = kst_stamp(now_ms - days * DAY_MS);
    let mut versions = 0;
    let mut drop = Vec::new();
    for (i, r) in rows.iter().enumerate().rev() {
        let mut gone = r.at < cutoff.as_str() && r.at != stamp;
        if r.file_id == file_id {
            match chunk_mark(r.chunk) {
                Some((a, b)) if a != b => {}
                _ => versions += 1,
            }
            if versions > keep {
                gone = true;
            }
        }
        if gone {
            drop.push(i);
        }
    }
    drop
}

// ---------------------------------------------------------------------------
// wasm 입구(묶음 형식은 lock.rs 와 같다). Code.gs 작은 판에도 들어간다(feature 조건 없음)
// ---------------------------------------------------------------------------

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있어야 한다. 묶음 = [파일ID, 옛 JSON, 새 JSON]. 1 = 남긴다
#[no_mangle]
pub unsafe extern "C" fn wasm_history_keep(ptr: *const u8, units: usize) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [fid, old, new] = parts[..] else { return 0 };
    should_keep(fid, old, new) as u32
}

/// # Safety
/// 묶음 = [옛 JSON]. 조각 끝 위치를 `out`(u32 `out_cap` 개)에 쓰고 조각 수를 돌려준다. -1 = 묶음 깨짐, -2 = out 모자람
#[no_mangle]
pub unsafe extern "C" fn wasm_history_parts(ptr: *const u8, units: usize, out: *mut u32, out_cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [json] = parts[..] else { return -1 };
    let ends = part_ends(json, CHUNK);
    if out.is_null() || ends.len() > out_cap {
        return -2;
    }
    let dst = core::slice::from_raw_parts_mut(out, ends.len());
    for (d, e) in dst.iter_mut().zip(&ends) {
        *d = *e as u32;
    }
    ends.len() as i32
}

/// # Safety
/// 묶음 = [파일ID, 이번 보관시각, (보관시각, 파일ID, 조각) × 줄 수]. 지울 줄 순번(0부터, 큰 것부터)을 `out` 에 쓰고 개수를 돌려준다.
/// -1 = 묶음 깨짐(아무것도 지우지 않는다), -2 = out 모자람
#[no_mangle]
pub unsafe extern "C" fn wasm_history_prune(ptr: *const u8, units: usize, now_ms: f64, out: *mut u32, out_cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let strs: Option<Vec<String>> = parts.iter().map(|s| String::from_utf16(s).ok()).collect();
    let Some(strs) = strs else { return -1 };
    let [fid, stamp, cells @ ..] = &strs[..] else { return -1 };
    if cells.len() % 3 != 0 {
        return -1;
    }
    let rows: Vec<Row> = cells.chunks_exact(3).map(|c| Row { at: &c[0], file_id: &c[1], chunk: &c[2] }).collect();
    let drop = prune(&rows, fid, stamp, now_ms as i64, KEEP_VERSIONS, KEEP_DAYS);
    if drop.len() > out_cap || (out.is_null() && !drop.is_empty()) {
        return -2;
    }
    if !drop.is_empty() {
        let dst = core::slice::from_raw_parts_mut(out, drop.len());
        for (d, i) in dst.iter_mut().zip(&drop) {
            *d = *i as u32;
        }
    }
    drop.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn live_rows_and_same_json_are_not_kept() {
        assert!(should_keep(&u("fid"), &u("{\"pins\":[1]}"), &u("{\"pins\":[2]}")));
        assert!(!should_keep(&u("fid"), &u("{}"), &u("{}")));
        assert!(!should_keep(&u("live:orig:김"), &u("{\"pins\":[1]}"), &u("{\"pins\":[2]}")));
    }

    #[test]
    fn parts_split_at_chunk_and_never_inside_a_surrogate_pair() {
        assert_eq!(part_ends(&u(""), 10), vec![0]);
        assert_eq!(part_ends(&u("abc"), 10), vec![3]);
        assert_eq!(part_ends(&u(&"x".repeat(25)), 10), vec![10, 20, 25]);
        let s = u(&format!("{}😀b", "x".repeat(9))); // 😀 = 2글자, 10번째 자리에서 끊기면 쌍이 갈린다
        let ends = part_ends(&s, 10);
        assert_eq!(ends, vec![9, 12]);
        assert!(String::from_utf16(&s[..ends[0]]).is_ok() && String::from_utf16(&s[ends[0]..]).is_ok());
    }

    #[test]
    fn no_part_starts_with_a_formula_char() {
        // Gemini 지적 6 재현: 10번째 자리 다음이 -12.5 → 예전엔 조각 2 가 '-' 로 시작해 safe() 가 ' 를 붙였다
        let s = u(r#"{"a":[1,2,-12.5,+3,=x,@y]}"#);
        for chunk in 2..s.len() {
            let ends = part_ends(&s, chunk);
            let mut at = 0;
            for &e in &ends {
                assert!(e > at, "빈 조각 chunk={chunk}");
                assert!(at == 0 || !is_formula_start(s[at]), "chunk={chunk} 조각 시작 {}", s[at] as u8 as char);
                at = e;
            }
            assert_eq!(at, s.len());
        }
    }

    #[test]
    fn kst_stamp_matches_seoul_wall_clock() {
        assert_eq!(kst_stamp(0), "1970-01-01 09:00:00");
        assert_eq!(kst_stamp(1_795_017_600_000), "2026-11-19 01:00:00"); // 2026-11-18T16:00:00Z
        assert_eq!(kst_stamp(951_782_400_000 + 3_599_000), "2000-02-29 09:59:59"); // 윤일(00:59:59Z)
    }

    #[test]
    fn prune_drops_old_days_and_versions_beyond_keep_but_not_partial_versions() {
        let now = 1_795_017_600_000; // 2026-11-19 01:00:00
        let rows = [
            Row { at: "2026-09-01 00:00:00", file_id: "other", chunk: "조각 1/1" }, // 0: 30일 지남
            Row { at: "2026-11-18 10:00:00", file_id: "f", chunk: "조각 1/2" },     // 1: 가장 옛 판(2조각)
            Row { at: "2026-11-18 10:00:00", file_id: "f", chunk: "조각 2/2" },     // 2
            Row { at: "2026-11-18 11:00:00", file_id: "f", chunk: "조각 1/1" },     // 3
            Row { at: "2026-11-18 11:00:00", file_id: "g", chunk: "조각 1/1" },     // 4: 다른 파일
            Row { at: "2026-11-19 01:00:00", file_id: "f", chunk: "조각 1/1" },     // 5: 같은 초 저장 두 번
            Row { at: "2026-11-19 01:00:00", file_id: "f", chunk: "조각 1/1" },     // 6
        ];
        assert_eq!(prune(&rows, "f", "2026-11-19 01:00:00", now, 3, 30), vec![2, 1, 0]);
        assert_eq!(prune(&rows, "f", "2026-11-19 01:00:00", now, 4, 30), vec![0]);
        // 이번 보관시각과 같은 줄은 시계가 어긋나도 지우지 않는다
        assert_eq!(prune(&rows[5..], "f", "2026-11-19 01:00:00", now + 40 * DAY_MS, 30, 30), Vec::<usize>::new());
    }

    #[test]
    fn chunk_mark_reads_korean_label_and_rejects_garbage() {
        assert_eq!(chunk_mark("조각 2/3"), Some((2, 3)));
        assert_eq!(chunk_mark("조각"), None);
        assert_eq!(chunk_mark(""), None);
    }
}
