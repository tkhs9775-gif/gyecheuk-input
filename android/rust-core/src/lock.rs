//! 접속 코드 잠금 판단(서버 apps-script/Code.gs 와 apps-script-rs 공용, 웹 화면의 기기 표시 검사도 같이 쓴다).
//! 입출력(캐시·스크립트 속성 읽기/쓰기)은 부르는 쪽이 하고, "막을지·셀지·기억할지"는 여기서 정한다.
//! 규칙(2026-11-18c): 한 기기가 5번 틀리면 그 기기만 10분 막는다. 전체 실패가 5번에 닿으면
//! 접속 코드를 맞힌 적이 있는 기기(목록)만 받는다. 코드가 바뀌면 목록은 처음부터 다시 쌓는다.

/// 이만큼 틀리면 막는다(기기별·전체 공통)
pub const MAX_FAILS: f64 = 5.0;
/// 목록(ids 배열)을 JSON 으로 적었을 때 최대 글자 수(스크립트 속성 한 칸 9KB 한도 안)
pub const KNOWN_MAX_CHARS: usize = 8000;

/// 코드를 본 뒤 판정(낮은 4비트)
pub const VERDICT_MASK: u32 = 0x0F;
pub const VERDICT_OK: u32 = 0;
pub const VERDICT_LOCKED: u32 = 1;
pub const VERDICT_BAD_CODE: u32 = 2;
/// 할 일(비트)
pub const DO_RESET_LIST: u32 = 0x10;
pub const DO_COUNT_FAIL: u32 = 0x20;
pub const DO_COUNT_DEVICE_FAIL: u32 = 0x40;
pub const DO_REMEMBER: u32 = 0x80;

/// 기기 표시: 영문·숫자·- 만, 8~64자(앱이 만드는 UUID 는 36자)
pub fn device_ok(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 이 기기가 막혔는지. 실패 수가 망가졌으면(NaN) 막지 않는다(JS 의 Number('x') >= 5 와 같게)
pub fn device_locked(device_fails: f64) -> bool {
    device_fails >= MAX_FAILS
}

/// 전체 실패가 넘쳐 목록에 있는 기기만 받아야 하는지
pub fn list_matters(fails: f64) -> bool {
    fails >= MAX_FAILS
}

/// 목록에 이 기기가 있는지. 빈 표시는 늘 없다
pub fn known_has<S: AsRef<str>>(ids: &[S], device: &str) -> bool {
    !device.is_empty() && ids.iter().any(|d| d.as_ref() == device)
}

/// 접속 코드 비교(UTF-16 글자 그대로). 길이가 같으면 끝까지 다 보고 답한다(어디서 틀렸는지 시간으로 새지 않게)
pub fn same_secret(given: &[u16], expected: &[u16]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    given.iter().zip(expected).fold(0u16, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// 코드를 본 뒤 판정과 할 일.
/// same_tag: 읽은 목록이 지금 코드로 쌓은 것인지(list_matters 가 아니면 보지 않는다)
pub fn after_code(fails: f64, same_tag: bool, code_ok: bool, has_device: bool) -> u32 {
    if list_matters(fails) && !same_tag {
        return VERDICT_LOCKED | DO_RESET_LIST;
    }
    if !code_ok {
        return VERDICT_BAD_CODE | DO_COUNT_FAIL | if has_device { DO_COUNT_DEVICE_FAIL } else { 0 };
    }
    VERDICT_OK | if has_device { DO_REMEMBER } else { 0 }
}

/// 목록을 JSON.stringify 했을 때 글자 수(device_ok 를 지난 표시만 담으니 이스케이프가 없다)
fn json_len<S: AsRef<str>>(ids: &[S]) -> usize {
    if ids.is_empty() {
        return 2;
    }
    1 + ids.iter().map(|d| d.as_ref().len() + 3).sum::<usize>()
}

/// 맞게 들어온 기기를 목록 맨 뒤로 옮긴다(가장 오래 안 온 기기가 앞). None 이면 쓰지 않는다.
/// seen: 최근에 이 기기를 이미 적었다는 캐시 표시. 목록에 지금도 있고 코드도 같을 때만 믿는다(밀려났거나 코드가 바뀌었으면 다시 적는다).
/// 규칙에 안 맞는 옛 표시는 버리고, 길이 한도를 넘으면 앞(오래된 기기)부터 뺀다.
pub fn remember<S: AsRef<str>>(ids: &[S], device: &str, same_tag: bool, seen: bool) -> Option<Vec<String>> {
    if !device_ok(device) {
        return None;
    }
    if same_tag && seen && known_has(ids, device) {
        return None;
    }
    let mut out: Vec<String> = if same_tag {
        ids.iter()
            .map(|d| d.as_ref())
            .filter(|d| *d != device && device_ok(d))
            .map(String::from)
            .collect()
    } else {
        Vec::new()
    };
    out.push(device.to_string());
    let mut cut = 0;
    let mut len = json_len(&out);
    while len > KNOWN_MAX_CHARS && cut < out.len() - 1 {
        len -= out[cut].len() + 3;
        cut += 1;
    }
    out.drain(..cut);
    Some(out)
}

// ---------------------------------------------------------------------------
// wasm 입구. 글자는 JS 가 UTF-16 그대로 넘긴다(Apps Script 에 TextEncoder 가 있는지 몰라서).
// 묶음 형식: 글자열마다 [길이 하위 16비트][길이 상위 16비트][UTF-16 글자들], 바이트는 리틀 엔디언.
// ---------------------------------------------------------------------------

pub(crate) unsafe fn read_units(ptr: *const u8, units: usize) -> Vec<u16> {
    if ptr.is_null() || units == 0 {
        return Vec::new();
    }
    core::slice::from_raw_parts(ptr, units * 2)
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect()
}

/// 묶음을 글자열들로 푼다. 길이가 남은 것보다 크면(망가진 입력) 거기서 멈춘다
pub fn unpack(units: &[u16]) -> Vec<&[u16]> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 <= units.len() {
        let n = units[i] as usize | (units[i + 1] as usize) << 16;
        i += 2;
        if n > units.len() - i {
            break;
        }
        out.push(&units[i..i + n]);
        i += n;
    }
    out
}

pub(crate) fn text(units: &[u16]) -> Option<String> {
    String::from_utf16(units).ok()
}

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있어야 한다. 묶음 = [기기]
#[no_mangle]
pub unsafe extern "C" fn wasm_lock_device_ok(ptr: *const u8, units: usize) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    parts.first().and_then(|s| text(s)).is_some_and(|s| device_ok(&s)) as u32
}

#[no_mangle]
pub extern "C" fn wasm_lock_device_locked(device_fails: f64) -> u32 {
    device_locked(device_fails) as u32
}

#[no_mangle]
pub extern "C" fn wasm_lock_list_matters(fails: f64) -> u32 {
    list_matters(fails) as u32
}

/// # Safety
/// 묶음 = [기기, 목록...]
#[no_mangle]
pub unsafe extern "C" fn wasm_lock_known_has(ptr: *const u8, units: usize) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let Some((dev, ids)) = parts.split_first() else { return 0 };
    // known_has 와 같은 규칙을 UTF-16 그대로(짝 없는 대리 글자도 JS includes 와 같은 답)
    (!dev.is_empty() && ids.contains(dev)) as u32
}

/// # Safety
/// 묶음 = [목록의 코드 지문, 지금 코드 지문, 보낸 코드, 맞는 코드]. has_code=0 이면 보낸 코드가 글자가 아니었다(틀린 것으로 본다).
/// 묶음이 깨졌으면 막는다(VERDICT_LOCKED, 셈도 기억도 안 함)
#[no_mangle]
pub unsafe extern "C" fn wasm_lock_after_code(ptr: *const u8, units: usize, fails: f64, has_code: u32, has_device: u32) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [known_tag, tag, given, expected] = parts[..] else { return VERDICT_LOCKED };
    after_code(fails, known_tag == tag, has_code != 0 && same_secret(given, expected), has_device != 0)
}

/// # Safety
/// 묶음 = [목록의 코드 지문, 지금 코드 지문, 기기, 목록...]. 새 목록을 "\n" 으로 이어 `out` 에 UTF-16 으로 쓰고 글자 수를 돌려준다.
/// -1 = 쓰지 않음, -2 = out 이 모자람. `out` 은 `out_cap * 2` 바이트를 쓸 수 있어야 한다.
#[no_mangle]
pub unsafe extern "C" fn wasm_lock_remember(ptr: *const u8, units: usize, seen: u32, out: *mut u8, out_cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [known_tag, tag, dev, ids @ ..] = &parts[..] else { return -1 };
    let Some(dev) = text(dev) else { return -1 };
    let ids: Vec<String> = ids.iter().filter_map(|s| text(s)).collect();
    let Some(list) = remember(&ids, &dev, known_tag == tag, seen != 0) else { return -1 };
    let joined: Vec<u16> = list.join("\n").encode_utf16().collect();
    if joined.len() > out_cap || out.is_null() {
        return -2;
    }
    let dst = core::slice::from_raw_parts_mut(out, joined.len() * 2);
    for (i, u) in joined.iter().enumerate() {
        dst[i * 2..i * 2 + 2].copy_from_slice(&u.to_le_bytes());
    }
    joined.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "11111111-2222-3333-4444-555555555555";
    const B: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
    fn device_id_rule_matches_js_regex() {
        assert!(device_ok(A));
        assert!(device_ok("abcd-123"));
        assert!(!device_ok("abc-123"), "7자");
        assert!(!device_ok(&"a".repeat(65)));
        assert!(device_ok(&"a".repeat(64)));
        assert!(!device_ok("a b c d e f g h"));
        assert!(!device_ok("가나다라마바사아"));
        assert!(!device_ok("abcdefgh\n"));
        assert!(!device_ok(""));
    }

    #[test]
    fn device_and_global_lock_at_five() {
        assert!(!device_locked(4.0));
        assert!(device_locked(5.0));
        assert!(!device_locked(f64::NAN));
        assert!(!list_matters(4.0));
        assert!(list_matters(5.0));
        assert!(list_matters(1e10));
    }

    #[test]
    fn after_code_verdicts() {
        // 전체가 잠겼는데 목록이 옛 코드 것 → 목록을 비우고 막는다
        assert_eq!(after_code(5.0, false, true, true), VERDICT_LOCKED | DO_RESET_LIST);
        // 잠기지 않았으면 태그는 보지 않는다
        assert_eq!(after_code(0.0, false, true, true), VERDICT_OK | DO_REMEMBER);
        assert_eq!(after_code(0.0, true, false, true), VERDICT_BAD_CODE | DO_COUNT_FAIL | DO_COUNT_DEVICE_FAIL);
        assert_eq!(after_code(0.0, true, false, false), VERDICT_BAD_CODE | DO_COUNT_FAIL);
        assert_eq!(after_code(5.0, true, true, false), VERDICT_OK);
    }

    #[test]
    fn secret_compare_is_exact() {
        let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert!(same_secret(&u("비밀1234"), &u("비밀1234")));
        assert!(!same_secret(&u("비밀1234"), &u("비밀1235")));
        assert!(!same_secret(&u("abc"), &u("abcd")));
        assert!(!same_secret(&[0xD800], &[0xD801]), "짝 없는 대리 글자도 그대로 비교");
    }

    #[test]
    fn remember_moves_device_to_end_and_skips_when_seen() {
        assert_eq!(remember(&[A, B], A, true, false).unwrap(), vec![B, A]);
        assert_eq!(remember(&[A, B], A, true, true), None, "목록에 있고 seen 이면 안 쓴다");
        assert_eq!(remember(&[B], A, true, true).unwrap(), vec![B, A], "밀려났으면 seen 이어도 다시 적는다");
        assert_eq!(remember(&[A, B], A, false, true).unwrap(), vec![A], "코드가 바뀌었으면 새 목록");
        assert_eq!(remember::<&str>(&[], "", true, false), None);
        assert_eq!(remember(&["bad id!", B], A, true, false).unwrap(), vec![B, A], "규칙에 안 맞는 옛 표시는 버림");
    }

    #[test]
    fn remember_trims_oldest_to_fit_property_limit() {
        let ids: Vec<String> = (0..300).map(|i| format!("{:08}-2222-3333-4444-555555555555", i)).collect();
        let out = remember(&ids, A, true, false).unwrap();
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.len() <= KNOWN_MAX_CHARS, "{}", json.len());
        assert_eq!(json.len(), json_len(&out));
        assert_eq!(out.last().unwrap(), A);
        assert_eq!(out[0], ids[ids.len() - out.len() + 1], "앞(오래된 기기)부터 뺐다");
        // 하나 더 남겼으면 한도를 넘었다(필요한 만큼만 뺐다)
        let mut more = out.clone();
        more.insert(0, ids[ids.len() - out.len()].clone());
        assert!(json_len(&more) > KNOWN_MAX_CHARS);
    }

    #[test]
    fn unpack_stops_on_broken_length() {
        let units: Vec<u16> = vec![2, 0, 65, 66, 9, 0, 67];
        assert_eq!(unpack(&units), vec![&[65u16, 66][..]]);
        assert!(unpack(&[1]).is_empty());
    }

    #[test]
    fn wasm_exports_match() {
        unsafe {
            let p = pack(&[A]);
            assert_eq!(wasm_lock_device_ok(p.as_ptr(), p.len() / 2), 1);
            let p = pack(&["a b c d e f"]);
            assert_eq!(wasm_lock_device_ok(p.as_ptr(), p.len() / 2), 0);
            let p = pack(&[A, B, A]);
            assert_eq!(wasm_lock_known_has(p.as_ptr(), p.len() / 2), 1);
            let p = pack(&[A, B]);
            assert_eq!(wasm_lock_known_has(p.as_ptr(), p.len() / 2), 0);
            let raw: Vec<u8> = [1u16, 0, 0xD800, 1, 0, 0xD800].iter().flat_map(|u| u.to_le_bytes()).collect();
            assert_eq!(wasm_lock_known_has(raw.as_ptr(), raw.len() / 2), 1, "짝 없는 대리 글자도 글자 그대로");
            let raw: Vec<u8> = [0u16, 0, 0, 0].iter().flat_map(|u| u.to_le_bytes()).collect();
            assert_eq!(wasm_lock_known_has(raw.as_ptr(), raw.len() / 2), 0, "빈 기기는 없음");
            let after = |strs: &[&str], fails: f64, has_code: u32, has_device: u32| {
                let p = pack(strs);
                wasm_lock_after_code(p.as_ptr(), p.len() / 2, fails, has_code, has_device)
            };
            assert_eq!(after(&["t1", "t1", "코드", "코드"], 0.0, 1, 1), VERDICT_OK | DO_REMEMBER);
            assert_eq!(after(&["t1", "t1", "코드", "코드2"], 0.0, 1, 1), VERDICT_BAD_CODE | DO_COUNT_FAIL | DO_COUNT_DEVICE_FAIL);
            assert_eq!(after(&["t1", "t1", "코드", "코드"], 0.0, 0, 0), VERDICT_BAD_CODE | DO_COUNT_FAIL, "코드가 글자가 아니면 틀림");
            assert_eq!(after(&["t0", "t1", "코드", "코드"], 5.0, 1, 1), VERDICT_LOCKED | DO_RESET_LIST, "잠긴 뒤 코드가 바뀌었으면 목록을 비운다");
            assert_eq!(after(&["t0", "t1", "코드", "코드"], 4.0, 1, 1), VERDICT_OK | DO_REMEMBER, "안 잠겼으면 지문은 안 본다");
            assert_eq!(after(&["t1", "t1", "코드"], 0.0, 1, 1), VERDICT_LOCKED, "묶음이 깨졌으면 막는다");
            let p = pack(&["t1", "t1", A, A, B]);
            let mut out = vec![0u8; 200];
            let n = wasm_lock_remember(p.as_ptr(), p.len() / 2, 0, out.as_mut_ptr(), 100);
            let got: Vec<u16> = out[..n as usize * 2].chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            assert_eq!(String::from_utf16(&got).unwrap(), format!("{B}\n{A}"));
            assert_eq!(wasm_lock_remember(p.as_ptr(), p.len() / 2, 1, out.as_mut_ptr(), 100), -1, "seen 이고 목록에 있으면 안 씀");
            assert_eq!(wasm_lock_remember(p.as_ptr(), p.len() / 2, 0, out.as_mut_ptr(), 3), -2);
            let p = pack(&["t0", "t1", A, A, B]);
            let n = wasm_lock_remember(p.as_ptr(), p.len() / 2, 1, out.as_mut_ptr(), 100);
            assert_eq!(n as usize, A.len(), "코드가 바뀌었으면 seen 이어도 새 목록 [A]");
        }
        assert_eq!(wasm_lock_device_locked(5.0), 1);
        assert_eq!(wasm_lock_list_matters(4.0), 0);
    }
}
