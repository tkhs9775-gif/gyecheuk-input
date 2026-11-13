use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::json;

const WIN_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn sanitize_filename_core(name: &str, max_len: usize) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        return "file".to_string();
    }

    let ext = match s.rfind('.') {
        Some(idx) if s.len() - idx <= 10 && idx > 0 => &s[idx..],
        _ => "",
    };
    let mut stem = s[..s.len() - ext.len()].to_string();
    let first_seg = stem.split('.').next().unwrap_or("").to_uppercase();
    if WIN_RESERVED_NAMES.contains(&first_seg.as_str()) {
        stem = format!("_{}", stem);
    }
    if stem.len() + ext.len() > max_len {
        let keep = max_len.saturating_sub(ext.len()).max(1);
        stem = stem
            .chars()
            .take(keep)
            .collect::<String>()
            .trim_end_matches(['.', ' '])
            .to_string();
        if stem.is_empty() {
            stem = "_".to_string();
        }
    }
    format!("{}{}", stem, ext)
}

#[no_mangle]
pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_ping<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jstring {
    let payload = json!({
        "ok": true,
        "engine": "gyecheuk-android-core",
        "version": env!("CARGO_PKG_VERSION")
    })
    .to_string();
    env.new_string(payload)
        .expect("Failed to create JNI string")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_sanitizeFilename<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    input: JString<'local>,
) -> jstring {
    let raw: String = env
        .get_string(&input)
        .map(|s| s.into())
        .unwrap_or_default();
    let out = sanitize_filename_core(&raw, 150);
    env.new_string(out)
        .expect("Failed to create JNI string")
        .into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename_core("도면:1/2?.pdf", 150), "도면_1_2_.pdf");
        assert_eq!(sanitize_filename_core("CON.txt", 150), "_CON.txt");
        assert_eq!(sanitize_filename_core("   ", 150), "file");
    }
}
