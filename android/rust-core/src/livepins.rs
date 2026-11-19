//! 실시간 줄(도면야장 탭의 `live:<원본>:<측정자>` 줄) 규칙. 2026-11-19 작업 3(동시 입력 지연).
//! - 서버(Code.gs): 줄을 지우고 맨 아래에 다시 붙이는 대신, 최근 입력이 보는 마지막 줄들 안에 있으면 그 자리에서 고친다.
//! - 화면(drawing.js): 고칠 때마다 보내지 않고 몇 초씩 묶어 보낸다. 화면을 떠날 때는 바로 보낸다.

/// 새 줄로 맨 아래에 붙인다(그 열쇠 줄이 아직 없음)
pub const WRITE_APPEND: u32 = 0;
/// 그 자리에서 고친다
pub const WRITE_IN_PLACE: u32 = 1;
/// 지우고 맨 아래에 다시 붙인다(예전 방식)
pub const WRITE_MOVE: u32 = 2;

/// 실시간 줄을 어떻게 쓸지. `hit_row`=찾은 줄 번호(없으면 0 이하), `last_row`=탭의 마지막 줄, `window`=최근 입력이 보는 마지막 줄 수.
/// 마지막 `window/2` 줄 안에 있으면 제자리 → 그 뒤로 새 줄이 `window/2`개 붙을 때까지는 최근 입력 범위 안에 남는다.
/// 더 위에 있으면(곧 범위 밖으로 밀려남) 예전처럼 맨 아래로 옮긴다. 최근 입력은 시각으로 정렬하므로 범위 안 위치는 결과에 영향 없다.
pub fn write_mode(hit_row: i32, last_row: i32, window: i32) -> u32 {
    if hit_row < 2 {
        return WRITE_APPEND;
    }
    let keep = (window / 2).max(1);
    if hit_row <= last_row && last_row - hit_row < keep { WRITE_IN_PLACE } else { WRITE_MOVE }
}

/// 마지막으로 고친 뒤 이만큼 조용하면 보낸다
pub const QUIET_MS: f64 = 3000.0;
/// 계속 고치고 있어도 첫 안 보낸 변경에서 이만큼 지나면 보낸다(홈 최근 입력이 너무 늦지 않게)
pub const MAX_HOLD_MS: f64 = 10000.0;

/// 지금부터 몇 ms 뒤에 보낼지. `last_change`=마지막으로 고친 시각, `first_pending`=아직 안 보낸 첫 변경 시각, `leaving`=화면을 떠남(앱 숨김·도면 닫기).
/// 메모 상자를 닫는 것은 '고침'과 같게 본다(동그라미마다 바로 보내던 것이 요청 대부분이었다).
pub fn send_wait_ms(now: f64, last_change: f64, first_pending: f64, leaving: bool) -> f64 {
    if leaving || !now.is_finite() || !last_change.is_finite() || !first_pending.is_finite() {
        return 0.0;
    }
    let at = (last_change + QUIET_MS).min(first_pending + MAX_HOLD_MS);
    (at - now).clamp(0.0, MAX_HOLD_MS)
}

// ---------- wasm 내보내기(숫자만 주고받음) ----------

#[no_mangle]
pub extern "C" fn wasm_live_write_mode(hit_row: i32, last_row: i32, window: i32) -> u32 {
    write_mode(hit_row, last_row, window)
}

#[no_mangle]
pub extern "C" fn wasm_live_send_wait_ms(now: f64, last_change: f64, first_pending: f64, leaving: u32) -> f64 {
    send_wait_ms(now, last_change, first_pending, leaving != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_row_appends() {
        assert_eq!(write_mode(0, 50, 20), WRITE_APPEND);
        assert_eq!(write_mode(-1, 50, 20), WRITE_APPEND);
        assert_eq!(write_mode(1, 50, 20), WRITE_APPEND); // 1줄은 머리글
    }

    #[test]
    fn near_bottom_in_place_else_move() {
        assert_eq!(write_mode(50, 50, 20), WRITE_IN_PLACE);
        assert_eq!(write_mode(41, 50, 20), WRITE_IN_PLACE); // 마지막 10줄 안
        assert_eq!(write_mode(40, 50, 20), WRITE_MOVE);
        assert_eq!(write_mode(3, 50, 20), WRITE_MOVE);
        assert_eq!(write_mode(60, 50, 20), WRITE_MOVE); // 이상한 값은 예전 방식
        assert_eq!(write_mode(2, 2, 1), WRITE_IN_PLACE); // window 가 1이어도 마지막 줄은 제자리
    }

    #[test]
    fn waits_for_quiet_then_sends() {
        assert_eq!(send_wait_ms(1000.0, 1000.0, 1000.0, false), 3000.0);
        assert_eq!(send_wait_ms(2500.0, 1000.0, 1000.0, false), 1500.0);
        assert_eq!(send_wait_ms(5000.0, 1000.0, 1000.0, false), 0.0);
    }

    #[test]
    fn keeps_editing_still_sends_within_max_hold() {
        // 9초 동안 계속 고침: 조용해지길 기다리지 않고 첫 변경 + 10초에 보낸다
        assert_eq!(send_wait_ms(9000.0, 9000.0, 0.0, false), 1000.0);
        assert_eq!(send_wait_ms(11000.0, 11000.0, 0.0, false), 0.0);
    }

    #[test]
    fn leaving_or_bad_time_sends_now() {
        assert_eq!(send_wait_ms(1000.0, 1000.0, 1000.0, true), 0.0);
        assert_eq!(send_wait_ms(f64::NAN, 1000.0, 1000.0, false), 0.0);
        assert_eq!(wasm_live_send_wait_ms(1000.0, 1000.0, 1000.0, 1), 0.0);
        assert_eq!(wasm_live_write_mode(50, 50, 20), WRITE_IN_PLACE);
    }
}
