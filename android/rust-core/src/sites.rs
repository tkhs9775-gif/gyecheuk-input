//! 현장 진행·종료 규칙 (2026-11-20 사용자 결정).
//! - 종료한 현장은 Drive 각 앱 폴더 아래 `종료/<현장>` 으로 옮기고, 설정 탭 `현장` 줄에서 `종료현장` 줄로 옮긴다.
//! - 종료한 현장은 열람만 된다(값·사진·도면·CAD 저장 거절). 종료는 직원 누구나 하되 현장 이름을 그대로 따라 써야 한다.
//! 서버(Code.gs)와 화면(web)이 같은 규칙을 쓰도록 판단은 여기에만 둔다.

use crate::lock::{read_units, text, unpack};

/// 종료한 현장 폴더를 모아 두는 Drive 폴더 이름. 새 현장 이름으로 쓸 수 없다
pub const CLOSED_DIR: &str = "종료";

pub const ACTIVE: u32 = 0;
pub const CLOSED: u32 = 1;
pub const UNKNOWN: u32 = 2;
/// `종료` 폴더 이름과 같아 현장 이름으로 쓸 수 없음
pub const RESERVED: u32 = 3;

/// 종료 확인: 따라 쓴 글자가 현장 이름과 같아야 한다(앞뒤 공백만 무시, 대소문자·띄어쓰기 안은 그대로)
pub fn confirm_ok(site: &str, typed: &str) -> bool {
    let s = site.trim();
    !s.is_empty() && s == typed.trim()
}

/// 이 이름이 진행 중·종료·모름·쓸 수 없는 이름 중 어느 것인지. 진행 목록을 먼저 본다(두 목록에 다 있으면 진행)
pub fn access(site: &str, active: &[String], closed: &[String]) -> u32 {
    let s = site.trim();
    if s == CLOSED_DIR {
        return RESERVED;
    }
    if active.iter().any(|a| a.trim() == s) {
        ACTIVE
    } else if closed.iter().any(|c| c.trim() == s) {
        CLOSED
    } else {
        UNKNOWN
    }
}

// ---------- wasm 내보내기 (묶음 형식은 lock.rs 와 같음) ----------

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있어야 한다. 묶음 [현장, 따라 쓴 글자]
#[no_mangle]
pub unsafe extern "C" fn wasm_site_confirm(ptr: *const u8, units: usize) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let [site, typed] = parts[..] else { return 0 };
    match (text(site), text(typed)) {
        (Some(s), Some(t)) => confirm_ok(&s, &t) as u32,
        _ => 0,
    }
}

/// # Safety
/// `ptr` 는 `units * 2` 바이트를 읽을 수 있어야 한다. 묶음 [현장, 진행 현장 n_active개…, 종료 현장…]. 망가진 입력은 UNKNOWN
#[no_mangle]
pub unsafe extern "C" fn wasm_site_access(ptr: *const u8, units: usize, n_active: usize) -> u32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let strs: Option<Vec<String>> = parts.iter().map(|s| text(s)).collect();
    let Some(strs) = strs else { return UNKNOWN };
    let [site, rest @ ..] = &strs[..] else { return UNKNOWN };
    if n_active > rest.len() {
        return UNKNOWN;
    }
    let (active, closed) = rest.split_at(n_active);
    access(site, active, closed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(strs: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for s in strs {
            let u: Vec<u16> = s.encode_utf16().collect();
            out.extend_from_slice(&(u.len() as u16).to_le_bytes());
            out.extend_from_slice(&((u.len() >> 16) as u16).to_le_bytes());
            for c in u {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        out
    }
    fn v(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn confirm_needs_exact_name() {
        assert!(confirm_ok("역삼동 A현장", "역삼동 A현장"));
        assert!(confirm_ok("역삼동 A현장", "  역삼동 A현장 "));
        assert!(!confirm_ok("역삼동 A현장", "역삼동A현장"));
        assert!(!confirm_ok("역삼동 A현장", "현장 종료"));
        assert!(!confirm_ok("", ""));
        assert!(!confirm_ok("  ", "  "));
    }

    #[test]
    fn access_kinds() {
        let a = v(&["가현장", "나현장"]);
        let c = v(&["다현장"]);
        assert_eq!(access("가현장", &a, &c), ACTIVE);
        assert_eq!(access(" 다현장 ", &a, &c), CLOSED);
        assert_eq!(access("라현장", &a, &c), UNKNOWN);
        assert_eq!(access("종료", &a, &c), RESERVED);
        // 두 목록에 다 있으면 진행으로 본다(저장을 막지 않는 쪽)
        assert_eq!(access("다현장", &v(&["다현장"]), &c), ACTIVE);
    }

    #[test]
    fn wasm_exports_match() {
        unsafe {
            let p = pack(&["가현장", "가현장"]);
            assert_eq!(wasm_site_confirm(p.as_ptr(), p.len() / 2), 1);
            let p = pack(&["가현장", "나현장"]);
            assert_eq!(wasm_site_confirm(p.as_ptr(), p.len() / 2), 0);
            let p = pack(&["가현장"]);
            assert_eq!(wasm_site_confirm(p.as_ptr(), p.len() / 2), 0);

            let p = pack(&["다현장", "가현장", "나현장", "다현장"]);
            assert_eq!(wasm_site_access(p.as_ptr(), p.len() / 2, 2), CLOSED);
            assert_eq!(wasm_site_access(p.as_ptr(), p.len() / 2, 3), ACTIVE);
            assert_eq!(wasm_site_access(p.as_ptr(), p.len() / 2, 9), UNKNOWN);
            let p = pack(&["종료"]);
            assert_eq!(wasm_site_access(p.as_ptr(), p.len() / 2, 0), RESERVED);
        }
    }
}
