//! 중계 서버(worker) 읽기 캐시 판단. 입출력(fetch·KV)은 worker JS 가 하고, "어떻게 할지"는 여기서 정한다.
//! 모두 숫자만 주고받는 순수 함수라 wasm 과 cargo test 에서 같게 돈다.

/// 기억한 목록을 그대로 준다
pub const DECIDE_HIT: u32 = 0;
/// 옛 목록을 바로 주고 뒤에서 새로 받는다
pub const DECIDE_STALE: u32 = 1;
/// 기억한 것이 없거나 너무 오래돼 구글 서버 답을 기다린다
pub const DECIDE_MISS: u32 = 2;

/// 한국 시간 = UTC + 9시간
const KST_OFFSET_MS: f64 = 9.0 * 60.0 * 60.0 * 1000.0;
const HOUR_MS: f64 = 60.0 * 60.0 * 1000.0;
/// 미리 받기를 하는 시간(한국 시각, 시작 포함·끝 제외). 현장 근무 시간 앞뒤로 넉넉히
pub const WARM_FROM_HOUR: u32 = 6;
pub const WARM_UNTIL_HOUR: u32 = 22;

/// age_ms: 기억한 지 지난 시간. fresh 안이면 그대로, stale_max 안이면 옛 것+뒤 갱신, 그 밖은 기다림.
/// 시계가 거꾸로 가거나(음수) 값이 망가졌으면(NaN) 믿지 않고 기다린다.
pub fn cache_decision(age_ms: f64, fresh_ms: f64, stale_max_ms: f64) -> u32 {
    if !(age_ms >= 0.0) {
        return DECIDE_MISS;
    }
    if age_ms < fresh_ms {
        DECIDE_HIT
    } else if age_ms < stale_max_ms {
        DECIDE_STALE
    } else {
        DECIDE_MISS
    }
}

/// KV 에 다시 쓸지. KV 무료 쓰기는 하루 1000번이라 내용이 같으면(same_content) 쓰지 않는다.
/// 같은지는 worker 가 이전 글자와 새 글자를 그대로 비교해 알려 준다(해시보다 정확하고 큰 목록에서 CPU 를 덜 쓴다).
/// 다만 KV 값은 stale_max 가 지나면 사라지므로 rewrite_after 가 지나면 같아도 한 번 다시 써서 살려 둔다.
/// kv_at_ms <= 0 은 "KV 에 아직 없음".
pub fn kv_write_needed(same_content: bool, kv_at_ms: f64, now_ms: f64, rewrite_after_ms: f64) -> bool {
    if !(kv_at_ms > 0.0) {
        return true;
    }
    !same_content || now_ms - kv_at_ms >= rewrite_after_ms
}

/// 미리 받기를 할 시각인지(한국 시각 6시~22시)
pub fn warm_active(now_utc_ms: f64) -> bool {
    if !now_utc_ms.is_finite() || now_utc_ms < 0.0 {
        return false;
    }
    let hour = (((now_utc_ms + KST_OFFSET_MS) / HOUR_MS).floor() as u64 % 24) as u32;
    (WARM_FROM_HOUR..WARM_UNTIL_HOUR).contains(&hour)
}

/// 이번 차례(tick)에 미리 받을 항목 번호를 out 에 채우고 개수를 돌려준다.
/// 항목 0번(설정)은 현장 목록을 알아야 해서 늘 받고, 나머지(1..n)는 per_tick-1 개씩 돌아가며 받는다.
pub fn warm_pick(tick: u64, n_items: usize, per_tick: usize, out: &mut [u32]) -> usize {
    let take = per_tick.min(n_items).min(out.len());
    if take == 0 {
        return 0;
    }
    out[0] = 0;
    let rest = n_items - 1;
    let rest_take = (take - 1).min(rest);
    if rest_take == 0 {
        return 1;
    }
    let start = (tick % rest as u64) as usize * rest_take % rest;
    for (i, slot) in out[1..=rest_take].iter_mut().enumerate() {
        *slot = (1 + (start + i) % rest) as u32;
    }
    1 + rest_take
}

#[no_mangle]
pub extern "C" fn wasm_cache_decision(age_ms: f64, fresh_ms: f64, stale_max_ms: f64) -> u32 {
    cache_decision(age_ms, fresh_ms, stale_max_ms)
}

#[no_mangle]
pub extern "C" fn wasm_kv_write_needed(same_content: u32, kv_at_ms: f64, now_ms: f64, rewrite_after_ms: f64) -> u32 {
    kv_write_needed(same_content != 0, kv_at_ms, now_ms, rewrite_after_ms) as u32
}

#[no_mangle]
pub extern "C" fn wasm_warm_active(now_utc_ms: f64) -> u32 {
    warm_active(now_utc_ms) as u32
}

#[no_mangle]
/// # Safety
/// `out_ptr..out_ptr+out_cap` must be a valid u32 slice in linear memory.
pub unsafe extern "C" fn wasm_warm_pick(tick: f64, n_items: usize, per_tick: usize, out_ptr: *mut u32, out_cap: usize) -> usize {
    if out_ptr.is_null() || out_cap == 0 || !(tick >= 0.0) {
        return 0;
    }
    let out = core::slice::from_raw_parts_mut(out_ptr, out_cap);
    warm_pick(tick as u64, n_items, per_tick, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_bands() {
        assert_eq!(cache_decision(0.0, 60_000.0, 3_600_000.0), DECIDE_HIT);
        assert_eq!(cache_decision(59_999.0, 60_000.0, 3_600_000.0), DECIDE_HIT);
        assert_eq!(cache_decision(60_000.0, 60_000.0, 3_600_000.0), DECIDE_STALE);
        assert_eq!(cache_decision(3_600_000.0, 60_000.0, 3_600_000.0), DECIDE_MISS);
        assert_eq!(cache_decision(f64::INFINITY, 60_000.0, 3_600_000.0), DECIDE_MISS);
    }

    #[test]
    fn broken_age_waits() {
        assert_eq!(cache_decision(-1.0, 60_000.0, 3_600_000.0), DECIDE_MISS);
        assert_eq!(cache_decision(f64::NAN, 60_000.0, 3_600_000.0), DECIDE_MISS);
    }

    #[test]
    fn kv_write_only_on_change_or_old() {
        let now = 1.0e12;
        assert!(kv_write_needed(false, 0.0, now, 1000.0), "KV에 없으면 쓴다");
        assert!(kv_write_needed(false, now - 1.0, now, 1000.0), "내용이 바뀌면 쓴다");
        assert!(!kv_write_needed(true, now - 999.0, now, 1000.0), "같고 새것이면 안 쓴다");
        assert!(kv_write_needed(true, now - 1000.0, now, 1000.0), "같아도 오래되면 살려 둔다");
        assert!(kv_write_needed(true, f64::NAN, now, 1000.0));
    }

    #[test]
    fn warm_hours_in_korea() {
        // 2026-11-17T00:00:00Z = 09:00 KST
        let nine_kst = 1_794_873_600_000.0;
        assert!(warm_active(nine_kst));
        assert!(warm_active(nine_kst - 3.0 * HOUR_MS)); // 06:00
        assert!(!warm_active(nine_kst - 3.0 * HOUR_MS - 1.0)); // 05:59
        assert!(warm_active(nine_kst + 13.0 * HOUR_MS - 1.0)); // 21:59
        assert!(!warm_active(nine_kst + 13.0 * HOUR_MS)); // 22:00
        assert!(!warm_active(f64::NAN));
    }

    #[test]
    fn warm_pick_always_config_then_rotates() {
        let mut out = [u32::MAX; 4];
        assert_eq!(warm_pick(0, 10, 4, &mut out), 4);
        assert_eq!(out, [0, 1, 2, 3]);
        assert_eq!(warm_pick(1, 10, 4, &mut out), 4);
        assert_eq!(out, [0, 4, 5, 6]);
        assert_eq!(warm_pick(2, 10, 4, &mut out), 4);
        assert_eq!(out, [0, 7, 8, 9]);
        assert_eq!(warm_pick(3, 10, 4, &mut out), 4);
        assert_eq!(out, [0, 1, 2, 3], "한 바퀴 돌면 처음부터");
    }

    #[test]
    fn warm_pick_covers_every_item_for_any_start() {
        let n = 83;
        let mut out = [0u32; 12];
        for first in [0u64, 7, 29_900_000] {
            let mut seen = vec![false; n];
            for tick in first..first + 8 {
                let k = warm_pick(tick, n, 12, &mut out);
                for &i in &out[..k] {
                    seen[i as usize] = true;
                }
            }
            assert!(seen.iter().all(|&s| s), "8번 안에 모든 항목을 한 번은 받는다 (시작 {first})");
        }
    }

    #[test]
    fn warm_pick_small_and_empty() {
        let mut out = [9u32; 12];
        assert_eq!(warm_pick(5, 0, 12, &mut out), 0);
        assert_eq!(warm_pick(5, 1, 12, &mut out), 1);
        assert_eq!(out[0], 0);
        assert_eq!(warm_pick(7, 3, 12, &mut out), 3);
        assert_eq!(&out[..3], &[0, 1, 2]);
        assert_eq!(warm_pick(1, 10, 1, &mut out), 1, "한 개면 설정만");
    }

    #[test]
    fn wasm_exports_match() {
        assert_eq!(wasm_cache_decision(0.0, 1.0, 2.0), DECIDE_HIT);
        assert_eq!(wasm_kv_write_needed(1, 1.0, 2.0, 10.0), 0);
        let mut out = [0u32; 3];
        let k = unsafe { wasm_warm_pick(1.0, 10, 3, out.as_mut_ptr(), out.len()) };
        assert_eq!(k, 3);
        assert_eq!(out, [0, 3, 4]);
        assert_eq!(unsafe { wasm_warm_pick(-1.0, 10, 3, out.as_mut_ptr(), 3) }, 0);
    }
}
