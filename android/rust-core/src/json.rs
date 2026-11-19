//! 작은 JSON 읽기·쓰기. wasm 에 serde 를 넣지 않으려고 둔다(크기). AI 창구(ai.rs)의 입력·출력만 다룬다.
//! 읽기는 엄격하다(JSON.parse 와 같은 문법). 짝 없는 서로게이트(\ud800 혼자)는 받지 않는다.
//! 쓰기는 JSON.stringify 와 같은 글자를 낸다(" \ \b \f \n \r \t 와 0x20 미만만 이스케이프, '/'·DEL 은 그대로).

use core::fmt::Write;

#[derive(Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

const MAX_DEPTH: usize = 64;

impl Value {
    pub fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
        Value::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// 같은 키가 둘이면 JSON.parse 처럼 뒤의 것
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(kv) => kv.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            // 내보내는 숫자는 정수뿐(줄 번호·요일)
            Value::Num(n) => {
                let _ = write!(out, "{}", *n as i64);
            }
            Value::Str(s) => write_str(out, s),
            Value::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Value::Obj(kv) => {
                out.push('{');
                for (i, (k, v)) in kv.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn parse(s: &str) -> Option<Value> {
    let mut p = Parser { b: s.as_bytes(), i: 0 };
    let v = p.value(0)?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        let hit = self.b.get(self.i) == Some(&c);
        if hit {
            self.i += 1;
        }
        hit
    }

    fn word(&mut self, w: &[u8], v: Value) -> Option<Value> {
        if !self.b[self.i..].starts_with(w) {
            return None;
        }
        self.i += w.len();
        Some(v)
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.ws();
        match *self.b.get(self.i)? {
            b'n' => self.word(b"null", Value::Null),
            b't' => self.word(b"true", Value::Bool(true)),
            b'f' => self.word(b"false", Value::Bool(false)),
            b'"' => self.string().map(Value::Str),
            b'[' => self.array(depth),
            b'{' => self.object(depth),
            _ => self.number(),
        }
    }

    fn array(&mut self, depth: usize) -> Option<Value> {
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.eat(b']') {
            return Some(Value::Arr(a));
        }
        loop {
            a.push(self.value(depth + 1)?);
            self.ws();
            if self.eat(b']') {
                return Some(Value::Arr(a));
            }
            if !self.eat(b',') {
                return None;
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Value> {
        self.i += 1;
        let mut kv = Vec::new();
        self.ws();
        if self.eat(b'}') {
            return Some(Value::Obj(kv));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return None;
            }
            let k = self.string()?;
            self.ws();
            if !self.eat(b':') {
                return None;
            }
            kv.push((k, self.value(depth + 1)?));
            self.ws();
            if self.eat(b'}') {
                return Some(Value::Obj(kv));
            }
            if !self.eat(b',') {
                return None;
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
            self.i += 1;
        }
        self.i - start
    }

    /// -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        self.eat(b'-');
        match self.b.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return None;
            }
        }
        core::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok().map(Value::Num)
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = self.b.get(self.i..self.i + 4)?;
        if !h.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        self.i += 4;
        u32::from_str_radix(core::str::from_utf8(h).ok()?, 16).ok()
    }

    fn escape(&mut self) -> Option<char> {
        let e = *self.b.get(self.i)?;
        self.i += 1;
        Some(match e {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let hi = self.hex4()?;
                if !(0xD800..0xDC00).contains(&hi) {
                    return char::from_u32(hi); // 혼자 있는 뒤쪽 서로게이트는 None
                }
                if !(self.eat(b'\\') && self.eat(b'u')) {
                    return None;
                }
                let lo = self.hex4()?;
                if !(0xDC00..0xE000).contains(&lo) {
                    return None;
                }
                char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))?
            }
            _ => return None,
        })
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.b.get(self.i).is_some_and(|&c| c != b'"' && c != b'\\' && c >= 0x20) {
                self.i += 1;
            }
            // 끊는 곳이 늘 ASCII 라 글자 경계가 맞는다
            out.push_str(core::str::from_utf8(&self.b[start..self.i]).ok()?);
            match *self.b.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    out.push(self.escape()?);
                }
                _ => return None, // 날 제어 글자
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_like_json_stringify() {
        // node: JSON.stringify("x\"\\\n\u0001é😀\u001f\u007f\b\f\t\r/")
        let s = "x\"\\\n\u{1}é😀\u{1f}\u{7f}\u{8}\u{c}\t\r/";
        let want = String::from(r#""x\"\\\n\u0001é😀\u001f"#) + "\u{7f}" + r#"\b\f\t\r/""#;
        assert_eq!(Value::Str(s.into()).to_json(), want);
        assert_eq!(parse(&want), Some(Value::Str(s.into())));
    }

    #[test]
    fn parses_nested_values() {
        let v = parse(r#" {"a":[1,-2.5e1,true,null],"b":{"c":"\u00e9\ud83d\ude00"},"a":"last"} "#).unwrap();
        assert_eq!(v.get("a"), Some(&Value::Str("last".into())), "같은 키는 뒤의 것");
        assert_eq!(v.get("b").and_then(|b| b.get("c")), Some(&Value::Str("é😀".into())));
        assert_eq!(parse("[1,-2.5e1,0]").unwrap().as_arr().unwrap()[1], Value::Num(-25.0));
        assert_eq!(parse("{}"), Some(Value::Obj(vec![])));
        assert_eq!(parse("[ ]"), Some(Value::Arr(vec![])));
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "1e", "-", "tru", "\"a", "\"\t\"",
            "\"\\x\"", "\"\\u12g4\"", "\"\\u+123\"", "{a:1}", "[1] x", "'a'", "NaN"] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        assert_eq!(parse("\"\\ud800\""), None, "짝 없는 앞쪽 서로게이트");
        assert_eq!(parse("\"\\udc00\""), None, "짝 없는 뒤쪽 서로게이트");
        assert_eq!(parse(&("[".repeat(70) + &"]".repeat(70))), None, "너무 깊음");
        assert!(parse(&("[".repeat(60) + &"]".repeat(60))).is_some());
    }
}
