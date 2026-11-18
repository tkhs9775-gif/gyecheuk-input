//! 앱을 다시 볼 때(자정 넘김·오래 뒤로 가 있음) 무엇을 새로 할지 판단. 입출력은 web/app.js·schedule.js, 판단은 여기서.
//! 날짜는 화면 값 그대로 'YYYY-MM-DD'(빈 글자 = 아직 없음). 글자는 UTF-16 그대로 비교한다(짝 없는 대리 글자도 JS === 와 같은 답).

use crate::lock::{read_units, unpack};

/// 다시 보일 때 이만큼 지났으면 boot 를 새로 받는다
pub const RESUME_REFRESH_MS: f64 = 5.0 * 60.0 * 1000.0;

/// 날이 바뀌었다(앱이 넣어 둔 '오늘'을 새 오늘로 바꾼다)
pub const ROLL_DAY: u32 = 1;
/// 측정일 칸이 앱이 넣은 '오늘' 그대로라 새 오늘로 바꾼다(사람이 고른 날짜는 그대로)
pub const SET_FIELD: u32 = 2;
/// 홈 일정·오늘의 공지 판을 다시 그린다
pub const SCHED: u32 = 4;
/// 계측기 목록 등(boot)을 새로 받는다
pub const FETCH_BOOT: u32 = 8;

pub fn resume_plan<T: PartialEq>(today: &[T], auto_date: &[T], field_date: &[T], now_ms: f64, last_boot_ms: f64) -> u32 {
    let new_day = today != auto_date;
    let stale = now_ms - last_boot_ms >= RESUME_REFRESH_MS; // NaN 이면 false(JS 와 같다)
    let mut plan = 0;
    if new_day {
        plan |= ROLL_DAY;
        if field_date == auto_date {
            plan |= SET_FIELD;
        }
    }
    if new_day || stale {
        plan |= SCHED;
    }
    if stale {
        plan |= FETCH_BOOT;
    }
    plan
}

/// 일정 달력을 오늘로 옮길지: 처음 열 때, 또는 자정이 지났는데 그 전날(그때의 오늘)을 보고 있었을 때만
pub fn sched_follow_today<T: PartialEq>(today: &[T], today_was: &[T], selected: &[T]) -> bool {
    today_was.is_empty() || (today != today_was && selected == today_was)
}

/// 임시저장할 때: 측정일이 앱이 넣은 '오늘' 그대로인지(그러면 되살릴 때 그날의 오늘로 바꾼다)
pub fn date_is_auto<T: PartialEq>(field_date: &[T], auto_date: &[T]) -> bool {
    field_date == auto_date
}

/// 임시저장본을 되살릴 때 저장된 날짜를 쓸지: 사람이 고른 날짜만
pub fn draft_keeps_date(has_date: bool, was_auto: bool) -> bool {
    has_date && !was_auto
}

/// 묶음에서 글자열 n 개를 꺼내 f 에 넘긴다. 개수가 다르면 None
unsafe fn with_texts<R>(ptr: *const u8, units: usize, n: usize, f: impl FnOnce(&[&[u16]]) -> R) -> Option<R> {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    (parts.len() == n).then(|| f(&parts))
}

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있어야 한다. 묶음 = [오늘, 앱이 넣은 오늘, 측정일 칸]. 묶음이 깨졌으면 0(아무것도 안 함)
#[no_mangle]
pub unsafe extern "C" fn wasm_resume_plan(ptr: *const u8, units: usize, now_ms: f64, last_boot_ms: f64) -> u32 {
    with_texts(ptr, units, 3, |t| resume_plan(t[0], t[1], t[2], now_ms, last_boot_ms)).unwrap_or(0)
}

/// # Safety
/// 묶음 = [오늘, 지난번 오늘, 보고 있는 날]
#[no_mangle]
pub unsafe extern "C" fn wasm_sched_follow_today(ptr: *const u8, units: usize) -> u32 {
    with_texts(ptr, units, 3, |t| sched_follow_today(t[0], t[1], t[2])).unwrap_or(false) as u32
}

/// # Safety
/// 묶음 = [측정일 칸, 앱이 넣은 오늘]
#[no_mangle]
pub unsafe extern "C" fn wasm_date_is_auto(ptr: *const u8, units: usize) -> u32 {
    with_texts(ptr, units, 2, |t| date_is_auto(t[0], t[1])).unwrap_or(false) as u32
}

#[no_mangle]
pub extern "C" fn wasm_draft_keeps_date(has_date: u32, was_auto: u32) -> u32 {
    draft_keeps_date(has_date != 0, was_auto != 0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_800_000_000_000.0;

    #[test]
    fn same_day_recent_does_nothing() {
        assert_eq!(resume_plan(b"2026-11-18", b"2026-11-18", b"2026-11-18", NOW, NOW - 1000.0), 0);
    }

    #[test]
    fn stale_refreshes_boot_and_schedule() {
        assert_eq!(resume_plan(b"2026-11-18", b"2026-11-18", b"2026-11-18", NOW, NOW - RESUME_REFRESH_MS), SCHED | FETCH_BOOT);
        assert_eq!(resume_plan(b"2026-11-18", b"2026-11-18", b"2026-11-18", NOW, NOW - RESUME_REFRESH_MS + 1.0), 0);
        assert_eq!(resume_plan(b"2026-11-18", b"2026-11-18", b"", NOW, 0.0), SCHED | FETCH_BOOT, "boot 를 아직 안 했으면 받는다");
        assert_eq!(resume_plan(b"2026-11-18", b"2026-11-18", b"", f64::NAN, 0.0), 0);
    }

    #[test]
    fn midnight_rolls_only_auto_field() {
        assert_eq!(resume_plan(b"2026-11-19", b"2026-11-18", b"2026-11-18", NOW, NOW), ROLL_DAY | SET_FIELD | SCHED);
        assert_eq!(resume_plan(b"2026-11-19", b"2026-11-18", b"2026-11-10", NOW, NOW), ROLL_DAY | SCHED, "사람이 고른 날짜는 그대로");
        assert_eq!(
            resume_plan(b"2026-11-19", b"2026-11-18", b"2026-11-18", NOW, 0.0),
            ROLL_DAY | SET_FIELD | SCHED | FETCH_BOOT
        );
    }

    #[test]
    fn schedule_follows_today_only_from_yesterday() {
        assert!(sched_follow_today(b"2026-11-18", b"", b"2026-11-03"), "처음 열 때");
        assert!(sched_follow_today(b"2026-11-19", b"2026-11-18", b"2026-11-18"));
        assert!(!sched_follow_today(b"2026-11-19", b"2026-11-18", b"2026-11-25"), "다른 날을 보고 있으면 그대로");
        assert!(!sched_follow_today(b"2026-11-18", b"2026-11-18", b"2026-11-18"));
    }

    #[test]
    fn draft_date_rules() {
        assert!(date_is_auto(b"2026-11-18", b"2026-11-18"));
        assert!(!date_is_auto(b"2026-11-17", b"2026-11-18"));
        assert!(draft_keeps_date(true, false));
        assert!(!draft_keeps_date(true, true));
        assert!(!draft_keeps_date(false, false));
    }

    fn pack(strs: &[&str]) -> Vec<u8> {
        let mut units = Vec::new();
        for s in strs {
            let u: Vec<u16> = s.encode_utf16().collect();
            units.push(u.len() as u16);
            units.push((u.len() >> 16) as u16);
            units.extend(u);
        }
        units.iter().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn wasm_exports_match() {
        unsafe {
            let p = pack(&["2026-11-19", "2026-11-18", "2026-11-18"]);
            assert_eq!(wasm_resume_plan(p.as_ptr(), p.len() / 2, NOW, NOW), ROLL_DAY | SET_FIELD | SCHED);
            assert_eq!(wasm_sched_follow_today(p.as_ptr(), p.len() / 2), 1);
            let p = pack(&["2026-11-19", "2026-11-18"]);
            assert_eq!(wasm_resume_plan(p.as_ptr(), p.len() / 2, NOW, 0.0), 0, "묶음이 모자라면 아무것도 안 함");
            assert_eq!(wasm_date_is_auto(p.as_ptr(), p.len() / 2), 0);
            let p = pack(&["2026-11-18", "2026-11-18"]);
            assert_eq!(wasm_date_is_auto(p.as_ptr(), p.len() / 2), 1);
            // 짝 없는 대리 글자도 글자 그대로 비교(JS 와 같다): 오늘 = D800 한 글자, 앱 날짜·칸 = '' → 날 바뀜·칸도 바꿈
            let raw: Vec<u8> = [1u16, 0, 0xD800, 0, 0, 0, 0].iter().flat_map(|u| u.to_le_bytes()).collect();
            assert_eq!(wasm_resume_plan(raw.as_ptr(), raw.len() / 2, NOW, NOW), ROLL_DAY | SET_FIELD | SCHED);
            let raw: Vec<u8> = [1u16, 0, 0xD800, 1, 0, 0xD800].iter().flat_map(|u| u.to_le_bytes()).collect();
            assert_eq!(wasm_date_is_auto(raw.as_ptr(), raw.len() / 2), 1);
        }
        assert_eq!(wasm_draft_keeps_date(1, 0), 1);
        assert_eq!(wasm_draft_keeps_date(1, 1), 0);
    }
}
