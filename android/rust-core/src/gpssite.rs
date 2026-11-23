//! 앱을 켤 때 GPS 로 "여기 현장이 맞습니까?" 물을 현장 고르기 (2026-11-23, 직원용·Pro 공통).
//! 현장 이름에는 좌표가 없고 '○○동' 이 들어 있다(예: "반포동 726-9"). 그래서
//! 1) 지금 위치의 동 이름(화면이 OpenStreetMap 역지오코딩으로 받은 주소 칸들)과 현장 이름의 동이 같은 현장을 먼저 고르고,
//! 2) 없으면 현장 동의 중심 좌표(날씨 기능이 폰에 보관한 것)가 가장 가까운 동의 현장을 고른다.
//! 같은 이름의 동이 다른 구에도 있을 수 있어(신사동 등) 좌표를 아는 현장은 NEAR_M 안일 때만 고른다.
//! 결과: 1곳 → 확인 질문(CONFIRM), 여러 곳 → 그 동 현장 목록(LIST), 없음 → 묻지 않음(NONE). 자동으로 현장을 바꾸지는 않는다(사람이 고른다).

use crate::lock::{read_units, text, unpack};

pub const NONE: u32 = 0;
pub const CONFIRM: u32 = 1;
pub const LIST: u32 = 2;
/// 동 중심에서 이보다 멀면 그 동에 있다고 보지 않는다(서울 동 하나는 대개 1~2km)
pub const NEAR_M: f64 = 3000.0;
const M_PER_DEG_LAT: f64 = 110_540.0;
const M_PER_DEG_LNG: f64 = 111_320.0;

/// 현장 이름(또는 주소 칸)에서 첫 '○○동·읍·면·리' 낱말. 화면 weather.js siteToPlace 와 같은 규칙
pub fn place_of(name: &str) -> String {
    name.split(|c: char| c.is_whitespace() || ",()·_-/".contains(c))
        .find(|t| {
            let mut cs: Vec<char> = t.chars().collect();
            let Some(last) = cs.pop() else { return false };
            matches!(last, '동' | '읍' | '면' | '리')
                && !cs.is_empty()
                && cs.iter().all(|c| ('가'..='힣').contains(c) || c.is_ascii_digit())
        })
        .unwrap_or("")
        .to_string()
}

/// 행정동 번호를 뗀다: "반포1동" → "반포동"(현장 이름은 법정동, 역지오코딩은 행정동일 때가 있다)
fn norm(place: &str) -> String {
    place.chars().filter(|c| !c.is_ascii_digit()).collect()
}

pub struct Site {
    pub name: String,
    /// 그 현장 동의 중심(위도, 경도). 모르면 None
    pub pos: Option<(f64, f64)>,
}

fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let e = (b.1 - a.1) * M_PER_DEG_LNG * (a.0.to_radians()).cos();
    let n = (b.0 - a.0) * M_PER_DEG_LAT;
    e.hypot(n)
}

/// (모드, 현장 번호들 — 가까운 순, 좌표 모르는 현장은 뒤에 원래 순서대로)
pub fn pick(lat: f64, lng: f64, here: &[String], sites: &[Site]) -> (u32, Vec<usize>) {
    if !lat.is_finite() || !lng.is_finite() {
        return (NONE, vec![]);
    }
    let me = (lat, lng);
    let dist: Vec<Option<f64>> = sites.iter().map(|s| s.pos.map(|p| dist_m(me, p))).collect();
    let near_enough = |i: usize| dist[i].is_none_or(|d| d <= NEAR_M);
    let place: Vec<String> = sites.iter().map(|s| norm(&place_of(&s.name))).collect();
    let here: Vec<String> = here.iter().map(|h| norm(&place_of(h))).filter(|h| !h.is_empty()).collect();

    let mut hits: Vec<usize> = (0..sites.len())
        .filter(|&i| !place[i].is_empty() && here.contains(&place[i]) && near_enough(i))
        .collect();
    if hits.is_empty() {
        let nearest = (0..sites.len())
            .filter(|&i| dist[i].is_some_and(|d| d <= NEAR_M))
            .min_by(|&a, &b| dist[a].partial_cmp(&dist[b]).unwrap_or(std::cmp::Ordering::Equal));
        let Some(n) = nearest else { return (NONE, vec![]) };
        hits = if place[n].is_empty() {
            vec![n]
        } else {
            (0..sites.len()).filter(|&i| place[i] == place[n] && near_enough(i)).collect()
        };
    }
    hits.sort_by(|&a, &b| match (dist[a], dist[b]) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(&b),
    });
    (if hits.len() == 1 { CONFIRM } else { LIST }, hits)
}

/// # Safety
/// `ptr` 는 `units * 2` 바이트, `out` 은 `cap` 개 u32 를 쓸 수 있어야 한다.
/// 묶음 = [지금 위치 주소 칸 n_here 개…, 그다음 현장마다 (이름, 위도 글자, 경도 글자)]. 좌표 모르면 빈 글자.
/// out = [모드, 현장 번호…]. 돌려주는 값 = 쓴 개수, 망가진 입력·칸 모자람은 -1
#[no_mangle]
pub unsafe extern "C" fn wasm_gps_pick(ptr: *const u8, units: usize, n_here: usize, lat: f64, lng: f64, out: *mut u32, cap: usize) -> i32 {
    let buf = read_units(ptr, units);
    let parts = unpack(&buf);
    let strs: Option<Vec<String>> = parts.iter().map(|s| text(s)).collect();
    let Some(strs) = strs else { return -1 };
    if n_here > strs.len() || (strs.len() - n_here) % 3 != 0 || out.is_null() {
        return -1;
    }
    let (here, rest) = strs.split_at(n_here);
    let sites: Vec<Site> = rest
        .chunks_exact(3)
        .map(|c| Site {
            name: c[0].clone(),
            pos: match (c[1].trim().parse::<f64>(), c[2].trim().parse::<f64>()) {
                (Ok(a), Ok(b)) if a.is_finite() && b.is_finite() => Some((a, b)),
                _ => None,
            },
        })
        .collect();
    let (mode, idx) = pick(lat, lng, here, &sites);
    if idx.len() + 1 > cap {
        return -1;
    }
    // out 은 JS 가 바이트 단위로 빌린 칸이라 4바이트 정렬이 아닐 수 있다
    out.write_unaligned(mode);
    for (k, i) in idx.iter().enumerate() {
        out.add(k + 1).write_unaligned(*i as u32);
    }
    (idx.len() + 1) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, pos: Option<(f64, f64)>) -> Site {
        Site { name: name.into(), pos }
    }
    fn v(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }
    const BANPO: (f64, f64) = (37.5045, 126.9946);
    const YEOKSAM: (f64, f64) = (37.5006, 127.0366);

    #[test]
    fn place_rule_matches_weather_js() {
        assert_eq!(place_of("당산동 신축공사 계측용역현장"), "당산동");
        assert_eq!(place_of("반포동 726-9"), "반포동");
        assert_eq!(place_of("(주)키움 역삼1동"), "역삼1동");
        assert_eq!(place_of("A현장"), "");
        assert_eq!(place_of("동"), "");
    }

    #[test]
    fn one_site_in_my_dong_asks_to_confirm() {
        let sites = [s("반포동 726-9", Some(BANPO)), s("역삼동 A현장", Some(YEOKSAM))];
        assert_eq!(pick(37.505, 126.995, &v(&["반포2동", "서초구"]), &sites), (CONFIRM, vec![0]));
    }

    #[test]
    fn several_sites_in_same_dong_give_list_nearest_first() {
        let sites = [s("역삼동 A현장", Some((37.507, 127.04))), s("반포동 1", Some(BANPO)), s("역삼동 B현장", Some(YEOKSAM)), s("역삼동 C현장", None)];
        let (mode, idx) = pick(37.5006, 127.0366, &v(&["역삼동"]), &sites);
        assert_eq!(mode, LIST);
        assert_eq!(idx, vec![2, 0, 3], "가까운 순, 좌표 모르는 현장은 뒤");
    }

    #[test]
    fn falls_back_to_nearest_dong_centre_when_names_do_not_match() {
        let sites = [s("반포동 726-9", Some(BANPO)), s("역삼동 A현장", Some(YEOKSAM))];
        assert_eq!(pick(37.501, 127.035, &v(&["알수없는곳"]), &sites), (CONFIRM, vec![1]));
    }

    #[test]
    fn same_dong_name_far_away_is_not_picked() {
        // 강남 신사동 현장인데 지금은 50km 밖(다른 시의 같은 이름 동)
        let sites = [s("신사동 현장", Some((37.5240, 127.0230)))];
        assert_eq!(pick(37.0, 127.0, &v(&["신사동"]), &sites), (NONE, vec![]));
    }

    #[test]
    fn nothing_near_means_no_question() {
        let sites = [s("반포동 726-9", Some(BANPO)), s("A현장", None)];
        assert_eq!(pick(35.1, 129.0, &v(&["해운대동"]), &sites), (NONE, vec![]));
        assert_eq!(pick(f64::NAN, 127.0, &v(&["반포동"]), &sites), (NONE, vec![]));
    }

    #[test]
    fn wasm_export_matches() {
        let mut pack: Vec<u8> = Vec::new();
        for st in ["반포동", "반포동 726-9", "37.5045", "126.9946", "역삼동 A", "", ""] {
            let u: Vec<u16> = st.encode_utf16().collect();
            pack.extend_from_slice(&(u.len() as u16).to_le_bytes());
            pack.extend_from_slice(&((u.len() >> 16) as u16).to_le_bytes());
            for c in u {
                pack.extend_from_slice(&c.to_le_bytes());
            }
        }
        let mut out = [9u32; 4];
        unsafe {
            assert_eq!(wasm_gps_pick(pack.as_ptr(), pack.len() / 2, 1, 37.505, 126.995, out.as_mut_ptr(), 4), 2);
            assert_eq!(&out[..2], &[CONFIRM, 0]);
            assert_eq!(wasm_gps_pick(pack.as_ptr(), pack.len() / 2, 2, 37.505, 126.995, out.as_mut_ptr(), 4), -1, "현장 칸이 3개씩이 아님");
            assert_eq!(wasm_gps_pick(pack.as_ptr(), pack.len() / 2, 1, 37.505, 126.995, out.as_mut_ptr(), 1), -1, "칸 모자람");
        }
    }
}
