// truthgate shim (Rust) for spec "total.ok". Save as examples/truthgate_total_ok.rs; truthgate builds it with `cargo build --example truthgate_total_ok` and runs the binary.
// Needs a library crate (src/lib.rs) with the target and its module `pub`. No dependencies: a tiny JSON reader/writer is included.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// Type mapping: int -> i64, decimal -> f64, str -> String, bool -> bool, list<T> -> Vec<T>, record/oneof -> J (raw JSON).
// Edit the calls in `call` if your signature differs (e.g. &[i64], i32, &str). Results: anything implementing Tj
// (ints, floats, bool, String, Vec, Option, maps); Result::Err(e) -> rejected; a panic -> crash.
// sequence specs: reset -> total::new(); ops are methods; state -> its state() method.
#![allow(dead_code, unused_imports)]
use std::io::{BufRead, Write};
use fixture as target;

type Obj = ();

fn reset(o: &mut Obj) { let _ = o; }

fn state(o: &mut Obj) -> J { let _ = o; J::Null }

fn call(o: &mut Obj, f: &str, a: &[J]) -> J {
    let _ = &o;
    match f {
        "total" => target::total(arg::<Vec<i64>>(a, 0)).tj(),
        _ => die(&format!("no function {f}")),
    }
}

fn die(msg: &str) -> ! {
    eprintln!("truthgate shim: {msg}");
    std::process::exit(3)
}

fn arg<T: Fj>(a: &[J], i: usize) -> T {
    T::fj(a.get(i).unwrap_or(&J::Null)).unwrap_or_else(|e| die(&format!("arg {i}: {e}")))
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut out = std::io::stdout().lock();
    let mut o: Obj = Default::default();
    for line in std::io::stdin().lock().lines() {
        let msg = parse(&line.unwrap());
        let op = if let Some(J::S(s)) = msg.get("op") { s.clone() } else { die("bad request") };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match op.as_str() {
            "reset" => { reset(&mut o); J::Null }
            "state" => state(&mut o),
            _ => {
                let f = if let Some(J::S(s)) = msg.get("fn") { s.clone() } else { die("bad request") };
                let a: Vec<J> = if let Some(J::O(v)) = msg.get("input") { v.iter().map(|e| e.1.clone()).collect() } else { vec![] };
                call(&mut o, &f, &a)
            }
        }));
        let reply = match r {
            Ok(J::Rej(e)) => J::O(vec![("error".into(), J::S(e)), ("kind".into(), J::S("rejected".into()))]),
            Ok(v) => J::O(vec![("out".into(), v)]),
            Err(p) => {
                let m = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
                J::O(vec![("error".into(), J::S(format!("panic: {m}"))), ("kind".into(), J::S("crash".into()))])
            }
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}

// ---- tiny JSON (std only) ----------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum J { Null, B(bool), I(i64), F(f64), S(String), A(Vec<J>), O(Vec<(String, J)>), Rej(String) }

impl J {
    fn get(&self, k: &str) -> Option<&J> {
        if let J::O(v) = self { v.iter().find(|e| e.0 == k).map(|e| &e.1) } else { None }
    }
}

fn quote(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' | '\\' => { o.push('\\'); o.push(c) }
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o + "\""
}

impl std::fmt::Display for J {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            J::Null => write!(f, "null"),
            J::B(b) => write!(f, "{b}"),
            J::I(n) => write!(f, "{n}"),
            J::F(x) => write!(f, "{x:?}"),
            J::S(s) | J::Rej(s) => write!(f, "{}", quote(s)),
            J::A(v) => write!(f, "[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")),
            J::O(v) => write!(f, "{{{}}}", v.iter().map(|(k, x)| format!("{}:{x}", quote(k))).collect::<Vec<_>>().join(",")),
        }
    }
}

fn parse(s: &str) -> J {
    fn ws(b: &[u8], i: &mut usize) { while *i < b.len() && b[*i].is_ascii_whitespace() { *i += 1 } }
    fn hex(b: &[u8], i: &mut usize) -> u32 { let h = u32::from_str_radix(std::str::from_utf8(&b[*i..*i + 4]).unwrap(), 16).unwrap(); *i += 4; h }
    fn string(b: &[u8], i: &mut usize) -> String {
        let mut o: Vec<u8> = Vec::new();
        *i += 1;
        loop {
            let c = b[*i];
            *i += 1;
            match c {
                b'"' => return String::from_utf8(o).unwrap(),
                b'\\' => {
                    let e = b[*i];
                    *i += 1;
                    let ch = match e {
                        b'n' => '\n', b't' => '\t', b'r' => '\r', b'b' => '\u{8}', b'f' => '\u{c}',
                        b'u' => {
                            let mut h = hex(b, i);
                            if (0xD800..0xDC00).contains(&h) && b.get(*i) == Some(&b'\\') { *i += 2; h = 0x10000 + ((h - 0xD800) << 10) + (hex(b, i) - 0xDC00) }
                            char::from_u32(h).unwrap_or('\u{fffd}')
                        }
                        c => c as char,
                    };
                    o.extend_from_slice(ch.to_string().as_bytes());
                }
                c => o.push(c),
            }
        }
    }
    fn val(b: &[u8], i: &mut usize) -> J {
        ws(b, i);
        match b[*i] {
            b'{' | b'[' => {
                let obj = b[*i] == b'{';
                *i += 1;
                let (mut o, mut a) = (Vec::new(), Vec::new());
                ws(b, i);
                if b[*i] == b'}' || b[*i] == b']' { *i += 1 } else {
                    loop {
                        if obj { ws(b, i); let k = string(b, i); ws(b, i); *i += 1; o.push((k, val(b, i))) } else { a.push(val(b, i)) }
                        ws(b, i);
                        *i += 1;
                        if b[*i - 1] != b',' { break }
                    }
                }
                if obj { J::O(o) } else { J::A(a) }
            }
            b'"' => J::S(string(b, i)),
            b't' => { *i += 4; J::B(true) }
            b'f' => { *i += 5; J::B(false) }
            b'n' => { *i += 4; J::Null }
            _ => {
                let st = *i;
                while *i < b.len() && b"+-0123456789.eE".contains(&b[*i]) { *i += 1 }
                let t = std::str::from_utf8(&b[st..*i]).unwrap();
                t.parse::<i64>().map(J::I).unwrap_or_else(|_| J::F(t.parse().unwrap()))
            }
        }
    }
    val(s.as_bytes(), &mut 0)
}

/// JSON -> Rust argument.
pub trait Fj: Sized { fn fj(j: &J) -> Result<Self, String>; }
/// Rust result -> JSON. `Err(e)` becomes a `rejected` reply.
pub trait Tj { fn tj(&self) -> J; }

impl Fj for J { fn fj(j: &J) -> Result<Self, String> { Ok(j.clone()) } }
impl Fj for bool { fn fj(j: &J) -> Result<Self, String> { if let J::B(b) = j { Ok(*b) } else { Err(format!("expected bool, got {j}")) } } }
impl Fj for String { fn fj(j: &J) -> Result<Self, String> { if let J::S(s) = j { Ok(s.clone()) } else { Err(format!("expected string, got {j}")) } } }
impl Fj for f64 { fn fj(j: &J) -> Result<Self, String> { match j { J::F(x) => Ok(*x), J::I(n) => Ok(*n as f64), _ => Err(format!("expected number, got {j}")) } } }
impl Fj for f32 { fn fj(j: &J) -> Result<Self, String> { f64::fj(j).map(|x| x as f32) } }
impl<T: Fj> Fj for Vec<T> { fn fj(j: &J) -> Result<Self, String> { if let J::A(v) = j { v.iter().map(T::fj).collect() } else { Err(format!("expected list, got {j}")) } } }
macro_rules! ints { ($($t:ty),*) => { $(
    impl Fj for $t { fn fj(j: &J) -> Result<Self, String> { if let J::I(n) = j { <$t>::try_from(*n).map_err(|e| e.to_string()) } else { Err(format!("expected int, got {j}")) } } }
    impl Tj for $t { fn tj(&self) -> J { J::I(*self as i64) } }
)* } }
ints!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

impl Tj for J { fn tj(&self) -> J { self.clone() } }
impl Tj for () { fn tj(&self) -> J { J::Null } }
impl Tj for bool { fn tj(&self) -> J { J::B(*self) } }
impl Tj for str { fn tj(&self) -> J { J::S(self.to_string()) } }
impl Tj for String { fn tj(&self) -> J { J::S(self.clone()) } }
impl Tj for f64 { fn tj(&self) -> J { assert!(self.is_finite(), "non-finite number in output"); J::F(*self) } }
impl Tj for f32 { fn tj(&self) -> J { (*self as f64).tj() } }
impl<T: Tj + ?Sized> Tj for &T { fn tj(&self) -> J { (**self).tj() } }
impl<T: Tj> Tj for [T] { fn tj(&self) -> J { J::A(self.iter().map(Tj::tj).collect()) } }
impl<T: Tj> Tj for Vec<T> { fn tj(&self) -> J { self.as_slice().tj() } }
impl<T: Tj> Tj for Option<T> { fn tj(&self) -> J { self.as_ref().map_or(J::Null, Tj::tj) } }
impl<T: Tj, E: std::fmt::Display> Tj for Result<T, E> { fn tj(&self) -> J { match self { Ok(v) => v.tj(), Err(e) => J::Rej(e.to_string()) } } }
impl<K: ToString, V: Tj> Tj for std::collections::BTreeMap<K, V> { fn tj(&self) -> J { J::O(self.iter().map(|(k, v)| (k.to_string(), v.tj())).collect()) } }
impl<K: ToString, V: Tj> Tj for std::collections::HashMap<K, V> { fn tj(&self) -> J { J::O(self.iter().map(|(k, v)| (k.to_string(), v.tj())).collect()) } }
