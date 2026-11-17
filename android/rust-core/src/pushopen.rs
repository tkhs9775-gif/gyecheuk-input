//! 알림을 눌렀을 때 갈 곳(push_open). 알림마다 제 목적지(현장·도면·알림 번호)를 담아 둔다.
//! 예전에는 종류(kind)·날짜만 담아서, 앱이 '같은 종류의 가장 최근 알림'을 열었다 → 어느 도면 알림을 눌러도 같은 도면이 열렸다(2026-11-17 사용자 지적).
//! 알림 하나하나의 PendingIntent 에 이 JSON 이 들어가므로, 앱이 켜져 있는 동안 다른 알림을 눌러도 그 알림의 곳으로 간다.

const MAX_KIND: usize = 20;
const MAX_TS_DIGITS: usize = 15;
const MAX_TEXT: usize = 200;

fn clean_kind(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_lowercase()).take(MAX_KIND).collect()
}

fn clean_date(s: &str) -> String {
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if ok { s.to_string() } else { String::new() }
}

fn clean_ts(s: &str) -> String {
    if !s.is_empty() && s.len() <= MAX_TS_DIGITS && s.bytes().all(|c| c.is_ascii_digit()) { s.to_string() } else { String::new() }
}

// 현장 이름·도면 id: 제어 문자를 빼고 길이를 자른다(따옴표 등은 JSON 으로 만들 때 이스케이프된다)
fn clean_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(MAX_TEXT).collect::<String>().trim().to_string()
}

/// 알림 하나의 목적지 JSON. 비어 있는 칸은 넣지 않는다(옛 앱 화면도 kind·date 만 보면 예전처럼 동작)
pub fn push_open_json(kind: &str, date: &str, ts: &str, site: &str, file_id: &str) -> String {
    let mut map = serde_json::Map::new();
    map.insert("kind".into(), clean_kind(kind).into());
    map.insert("date".into(), clean_date(date).into());
    for (k, v) in [("ts", clean_ts(ts)), ("site", clean_text(site)), ("fileId", clean_text(file_id))] {
        if !v.is_empty() {
            map.insert(k.into(), v.into());
        }
    }
    serde_json::Value::Object(map).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("valid json")
    }

    #[test]
    fn each_notification_keeps_its_own_target() {
        let a = parse(&push_open_json("drawing", "", "1794889229594", "반포동 726-9", "1qt8La"));
        let b = parse(&push_open_json("drawing", "", "1794889999999", "청담동 59", "1cZmwm"));
        assert_eq!(a["site"], "반포동 726-9");
        assert_eq!(a["fileId"], "1qt8La");
        assert_eq!(b["site"], "청담동 59");
        assert_ne!(a["ts"], b["ts"]);
    }

    #[test]
    fn old_payload_without_target_stays_kind_and_date_only() {
        let v = parse(&push_open_json("memo", "2026-11-12", "", "", ""));
        assert_eq!(v, serde_json::json!({ "kind": "memo", "date": "2026-11-12" }));
    }

    #[test]
    fn bad_values_are_dropped_or_escaped() {
        let v = parse(&push_open_json("Draw\"ing<x>", "2026-1-12", "12a", "a\"b\u{0}\nc", &"x".repeat(500)));
        assert_eq!(v["kind"], "rawingx");
        assert_eq!(v["date"], "");
        assert!(v.get("ts").is_none());
        assert_eq!(v["site"], "a\"bc");
        assert_eq!(v["fileId"].as_str().unwrap().len(), MAX_TEXT);
    }
}
