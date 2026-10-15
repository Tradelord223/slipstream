//! Test support: an in-process IMAP server (a port of server/test/mini-imap.ts over fake-imap.ts's data model),
//! an SMTP sink, and a connector that skips TLS to reach them. Nothing here is compiled into the library.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use async_imap::Client;
use futures::future::BoxFuture;
use slipstream_imap::conn::{self, Conn, Connector, MailStream};
use slipstream_imap::{ImapSettings, ProviderError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

pub mod smtp;

/* ---------------------------------------------------------------- data model */

#[derive(Clone, Debug)]
pub struct Msg {
    pub uid: u32,
    pub flags: BTreeSet<String>,
    pub labels: Option<BTreeSet<String>>,
    pub thread_id: Option<String>,
    pub internal_date_ms: i64,
    pub source: Vec<u8>,
    pub modseq: u64,
}

#[derive(Clone, Debug)]
pub struct MBox {
    pub path: String,
    pub special_use: Option<String>,
    pub uid_validity: u32,
    pub uid_next: u32,
    pub highest_modseq: u64,
    pub permanent_flags: Vec<String>,
    pub messages: Vec<Msg>,
}

pub struct Data {
    pub boxes: Vec<MBox>,
    pub capabilities: BTreeSet<String>,
    pub condstore: bool,
    pub appended: Vec<(String, Vec<u8>, Vec<String>)>,
    pub fail_append: bool,
    /// After login, swallow every command without answering (a wedged server).
    pub hang: bool,
    /// Every command verb received, in order (LOGIN included).
    pub log: Vec<String>,
    /// Full command lines (without literals) for assertions about what went over the wire.
    pub lines: Vec<String>,
}

#[derive(Default)]
pub struct Extra {
    pub flags: Vec<&'static str>,
    pub labels: Option<Vec<&'static str>>,
    pub thread_id: Option<&'static str>,
}

#[derive(Clone)]
pub struct Fake {
    pub data: Arc<Mutex<Data>>,
    changed: Arc<watch::Sender<u64>>,
    kill: Arc<watch::Sender<u64>>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

impl Fake {
    pub fn new(condstore: bool) -> Fake {
        let mut caps: BTreeSet<String> = ["UIDPLUS", "MOVE"].iter().map(|s| s.to_string()).collect();
        if condstore {
            caps.insert("CONDSTORE".into());
        }
        Fake {
            data: Arc::new(Mutex::new(Data { boxes: vec![], capabilities: caps, condstore, appended: vec![], fail_append: false, hang: false, log: vec![], lines: vec![] })),
            changed: Arc::new(watch::channel(0).0),
            kill: Arc::new(watch::channel(0).0),
        }
    }

    /// INBOX, Sent, Archive, Trash, Junk with special-use flags.
    pub fn generic(condstore: bool) -> Fake {
        let f = Fake::new(condstore);
        f.add("INBOX", Some("\\Inbox"));
        f.add("Sent", Some("\\Sent"));
        f.add("Archive", Some("\\Archive"));
        f.add("Trash", Some("\\Trash"));
        f.add("Junk", Some("\\Junk"));
        f
    }

    /// Gmail's layout: X-GM-EXT-1, All Mail, Trash, Spam.
    pub fn gmail() -> Fake {
        let f = Fake::new(true);
        f.with(|d| {
            d.capabilities.insert("X-GM-EXT-1".into());
        });
        f.add("INBOX", Some("\\Inbox"));
        f.add("[Gmail]/All Mail", Some("\\All"));
        f.add("[Gmail]/Trash", Some("\\Trash"));
        f.add("[Gmail]/Spam", Some("\\Junk"));
        f.add("[Gmail]/Sent Mail", Some("\\Sent"));
        f
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut Data) -> R) -> R {
        let r = f(&mut self.data.lock().unwrap());
        self.changed.send_modify(|n| *n += 1);
        r
    }

    pub fn add(&self, path: &str, special_use: Option<&str>) {
        self.with(|d| {
            d.boxes.push(MBox {
                path: path.into(),
                special_use: special_use.map(String::from),
                uid_validity: 1,
                uid_next: 1,
                highest_modseq: 1,
                permanent_flags: ["\\Seen", "\\Flagged", "\\Deleted", "\\Draft", "\\*"].iter().map(|s| s.to_string()).collect(),
                messages: vec![],
            })
        });
    }

    pub fn deliver(&self, path: &str, source: impl AsRef<[u8]>, extra: Extra) -> u32 {
        self.with(|d| deliver_in(d, path, source.as_ref().to_vec(), extra.flags.iter().map(|s| s.to_string()).collect(), extra.labels.map(|l| l.iter().map(|s| s.to_string()).collect()), extra.thread_id.map(String::from), now_ms()))
    }

    /// Change a message the way another client would, bumping MODSEQ so CHANGEDSINCE sees it.
    pub fn change(&self, path: &str, uid: u32, f: impl FnOnce(&mut Msg)) {
        self.with(|d| {
            let b = d.boxes.iter_mut().find(|b| b.path == path).unwrap();
            b.highest_modseq += 1;
            let hm = b.highest_modseq;
            let m = b.messages.iter_mut().find(|m| m.uid == uid).unwrap();
            f(m);
            m.modseq = hm;
        });
    }

    pub fn expunge(&self, path: &str, uid: u32) {
        self.with(|d| expunge_in(d, path, uid));
    }

    pub fn set_validity(&self, path: &str, v: u32) {
        self.with(|d| d.boxes.iter_mut().find(|b| b.path == path).unwrap().uid_validity = v);
    }

    pub fn msg(&self, path: &str, uid: u32) -> Option<Msg> {
        self.with(|d| d.boxes.iter().find(|b| b.path == path)?.messages.iter().find(|m| m.uid == uid).cloned())
    }

    pub fn has_box(&self, path: &str) -> bool {
        self.with(|d| d.boxes.iter().any(|b| b.path == path))
    }

    pub fn remove_box(&self, path: &str) {
        self.with(|d| d.boxes.retain(|b| b.path != path));
    }

    /// Message-ID headers of a mailbox in UID order.
    pub fn ids(&self, path: &str) -> Vec<String> {
        self.with(|d| d.boxes.iter().find(|b| b.path == path).map(|b| b.messages.iter().map(|m| header_of(&m.source, "Message-ID").unwrap_or_default()).collect()).unwrap_or_default())
    }

    pub fn log(&self) -> Vec<String> {
        self.with(|d| d.log.clone())
    }

    pub fn lines(&self) -> Vec<String> {
        self.with(|d| d.lines.clone())
    }

    /// Hang up on every connected client, as a server timing out idle sessions does.
    pub fn drop_all(&self) {
        self.kill.send_modify(|n| *n += 1);
    }
}

fn deliver_in(d: &mut Data, path: &str, source: Vec<u8>, flags: BTreeSet<String>, labels: Option<BTreeSet<String>>, thread_id: Option<String>, date: i64) -> u32 {
    let b = d.boxes.iter_mut().find(|b| b.path == path).unwrap_or_else(|| panic!("no mailbox {path}"));
    let uid = b.uid_next;
    b.uid_next += 1;
    b.highest_modseq += 1;
    b.messages.push(Msg { uid, flags, labels, thread_id, internal_date_ms: date, source, modseq: b.highest_modseq });
    uid
}

fn expunge_in(d: &mut Data, path: &str, uid: u32) {
    let b = d.boxes.iter_mut().find(|b| b.path == path).unwrap();
    b.messages.retain(|m| m.uid != uid);
    b.highest_modseq += 1;
}

pub fn header_of(source: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(source);
    for line in text.split("\r\n") {
        if line.is_empty() {
            break;
        }
        if let Some((n, v)) = line.split_once(':') {
            if n.eq_ignore_ascii_case(name) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// A plain message with a Message-ID of `<id@example.com>`.
pub fn mail(id: &str) -> String {
    mail_from(id, "Alice <alice@example.com>")
}

pub fn mail_from(id: &str, from: &str) -> String {
    [
        format!("Message-ID: <{id}@example.com>"),
        format!("From: {from}"),
        "To: me@example.com".into(),
        format!("Subject: Subject {id}"),
        "Date: Thu, 01 Oct 2026 10:00:00 +0000".into(),
        String::new(),
        format!("Body of {id}"),
        String::new(),
    ]
    .join("\r\n")
}

/* ---------------------------------------------------------------- server */

#[derive(Clone)]
pub enum TlsMode {
    /// Plain only; STARTTLS is not offered.
    None,
    /// STARTTLS is offered and works.
    StartTls(Arc<rustls::ServerConfig>),
    /// STARTTLS is advertised but the server answers NO.
    StartTlsRefused,
    /// TLS from the first byte.
    Implicit(Arc<rustls::ServerConfig>),
}

pub struct Server {
    pub port: u16,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub const USER: &str = "me@example.com";
pub const PASS: &str = "pw";

pub async fn serve(fake: &Fake, mode: TlsMode) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fake = fake.clone();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let (fake, mode) = (fake.clone(), mode.clone());
            tokio::spawn(async move {
                let stream: Box<dyn Duplex> = match &mode {
                    TlsMode::Implicit(cfg) => match TlsAcceptor::from(cfg.clone()).accept(tcp).await {
                        Ok(t) => Box::new(t),
                        Err(_) => return,
                    },
                    _ => Box::new(tcp),
                };
                let kill = fake.kill.subscribe();
                let _ = session(stream, fake, mode, kill).await;
            });
        }
    });
    Server { port, handle }
}

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

#[derive(Debug, Clone)]
enum Tok {
    A(String),
    L(Vec<Tok>),
}

impl Tok {
    fn s(&self) -> String {
        match self {
            Tok::A(s) => s.clone(),
            Tok::L(_) => String::new(),
        }
    }
    fn list(&self) -> Vec<String> {
        match self {
            Tok::L(l) => l.iter().map(Tok::s).collect(),
            Tok::A(_) => vec![],
        }
    }
}

/// Split a command line into atoms, quoted strings and nested lists. Literals arrive as "\0L<n>" placeholders.
fn tokenize(text: &str) -> Vec<Tok> {
    let mut stack: Vec<Vec<Tok>> = vec![vec![]];
    let b: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            ' ' => i += 1,
            '(' => {
                stack.push(vec![]);
                i += 1;
            }
            ')' => {
                let l = stack.pop().unwrap();
                stack.last_mut().unwrap().push(Tok::L(l));
                i += 1;
            }
            '"' => {
                let mut s = String::new();
                i += 1;
                while b[i] != '"' {
                    if b[i] == '\\' {
                        i += 1;
                    }
                    s.push(b[i]);
                    i += 1;
                }
                i += 1;
                stack.last_mut().unwrap().push(Tok::A(s));
            }
            _ => {
                let mut s = String::new();
                while i < b.len() && !matches!(b[i], ' ' | '(' | ')') {
                    s.push(b[i]);
                    i += 1;
                }
                stack.last_mut().unwrap().push(Tok::A(s));
            }
        }
    }
    stack.swap_remove(0)
}

fn uid_set(set: &str, max: u32) -> impl Fn(u32) -> bool {
    let ranges: Vec<(u32, u32)> = set
        .split(',')
        .map(|part| {
            let mut it = part.split(':');
            let conv = |s: &str| if s == "*" { max } else { s.parse().unwrap_or(0) };
            let lo = conv(it.next().unwrap());
            let hi = it.next().map(conv).unwrap_or(lo);
            (lo.min(hi), lo.max(hi))
        })
        .collect();
    move |n| ranges.iter().any(|(lo, hi)| n >= *lo && n <= *hi)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn parse_search(tokens: &[Tok], max: u32) -> Box<dyn Fn(&Msg) -> bool> {
    let mut i = 0;
    let mut keys: Vec<Box<dyn Fn(&Msg) -> bool>> = vec![];
    fn key(tokens: &[Tok], i: &mut usize, max: u32) -> Box<dyn Fn(&Msg) -> bool> {
        let t = tokens[*i].clone();
        *i += 1;
        if let Tok::L(inner) = &t {
            return parse_search(inner, max);
        }
        match t.s().to_ascii_uppercase().as_str() {
            "ALL" => Box::new(|_| true),
            "UID" => {
                let set = uid_set(&tokens[*i].s(), max);
                *i += 1;
                Box::new(move |m| set(m.uid))
            }
            "SINCE" => {
                let d = tokens[*i].s();
                *i += 1;
                let mut p = d.split('-');
                let day: i64 = p.next().unwrap().parse().unwrap();
                let mon_name = p.next().unwrap();
                let mon = MONTHS.iter().position(|m| *m == mon_name).unwrap() + 1;
                let year: i64 = p.next().unwrap().parse().unwrap();
                let from = slipstream_imap::conn::days_from_civil(year, mon as i64, day) * 86_400_000;
                Box::new(move |m| m.internal_date_ms >= from)
            }
            "HEADER" => {
                let name = tokens[*i].s();
                let value = tokens[*i + 1].s().to_lowercase();
                *i += 2;
                Box::new(move |m| {
                    let line = header_of(&m.source, &name).unwrap_or_default();
                    if value.is_empty() {
                        !line.is_empty()
                    } else {
                        line.to_lowercase().contains(&value)
                    }
                })
            }
            "OR" => {
                let a = key(tokens, i, max);
                let b = key(tokens, i, max);
                Box::new(move |m| a(m) || b(m))
            }
            "NOT" => {
                let a = key(tokens, i, max);
                Box::new(move |m| !a(m))
            }
            other => panic!("unsupported search key {other}"),
        }
    }
    while i < tokens.len() {
        keys.push(key(tokens, &mut i, max));
    }
    Box::new(move |m| keys.iter().all(|k| k(m)))
}

fn imap_date(ms: i64) -> String {
    slipstream_imap::conn::imap_date(ms, true)
}

fn fetch_line(d: &Data, m: &Msg, seq: usize, items: &[String], force_uid: bool) -> Vec<u8> {
    let wanted: BTreeSet<String> = items.iter().map(|s| s.to_ascii_uppercase()).collect();
    let mut parts: Vec<String> = vec![];
    if force_uid || wanted.contains("UID") {
        parts.push(format!("UID {}", m.uid));
    }
    if wanted.contains("FLAGS") {
        parts.push(format!("FLAGS ({})", m.flags.iter().cloned().collect::<Vec<_>>().join(" ")));
    }
    if wanted.contains("INTERNALDATE") {
        parts.push(format!("INTERNALDATE \"{}\"", imap_date(m.internal_date_ms)));
    }
    if wanted.contains("RFC822.SIZE") {
        parts.push(format!("RFC822.SIZE {}", m.source.len()));
    }
    if wanted.contains("X-GM-LABELS") {
        let l: Vec<String> = m.labels.iter().flatten().map(|l| if l.starts_with('\\') { l.clone() } else { format!("\"{l}\"") }).collect();
        parts.push(format!("X-GM-LABELS ({})", l.join(" ")));
    }
    if wanted.contains("X-GM-THRID") {
        parts.push(format!("X-GM-THRID {}", m.thread_id.clone().unwrap_or_else(|| "0".into())));
    }
    if wanted.contains("MODSEQ") && d.condstore {
        parts.push(format!("MODSEQ ({})", m.modseq));
    }
    let body = items.iter().any(|s| matches!(s.to_ascii_uppercase().as_str(), "BODY[]" | "BODY.PEEK[]"));
    let mut head = format!("* {seq} FETCH ({}", parts.join(" "));
    let mut out = vec![];
    if body {
        head.push_str(&format!("{}BODY[] {{{}}}\r\n", if parts.is_empty() { "" } else { " " }, m.source.len()));
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(&m.source);
        out.extend_from_slice(b")\r\n");
    } else {
        out.extend_from_slice(format!("{head})\r\n").as_bytes());
    }
    out
}

enum Action {
    None,
    Logout,
    StartTls,
    Idle(String),
}

struct Out {
    bytes: Vec<u8>,
    action: Action,
}

fn caps(d: &Data, secure: bool, mode: &TlsMode) -> String {
    let mut c: Vec<String> = ["IMAP4rev1", "ENABLE", "SPECIAL-USE", "IDLE"].iter().map(|s| s.to_string()).collect();
    c.extend(d.capabilities.iter().cloned());
    if !secure && matches!(mode, TlsMode::StartTls(_) | TlsMode::StartTlsRefused) {
        c.push("STARTTLS".into());
    }
    c.join(" ")
}

struct SessionState {
    selected: Option<String>,
    authed: bool,
    secure: bool,
}

#[allow(clippy::too_many_arguments)]
fn handle(fake: &Fake, st: &mut SessionState, mode: &TlsMode, tag: &str, command: &str, args: &[Tok], literals: &[Vec<u8>]) -> Out {
    let cmd = command.to_ascii_uppercase();
    let mut out: Vec<u8> = vec![];
    let mut action = Action::None;
    macro_rules! send {
        ($e:expr) => {{
            let line: String = $e;
            out.extend_from_slice(line.as_bytes());
            out.extend_from_slice(b"\r\n");
        }};
    }
    let mut d = fake.data.lock().unwrap();
    let verb = if cmd == "UID" { format!("UID {}", args.first().map(Tok::s).unwrap_or_default().to_ascii_uppercase()) } else { cmd.clone() };
    d.log.push(verb);
    d.lines.push(format!("{cmd} {}", args.iter().map(|a| match a { Tok::A(s) => s.clone(), Tok::L(l) => format!("({})", l.iter().map(Tok::s).collect::<Vec<_>>().join(" ")) }).collect::<Vec<_>>().join(" ")));
    let dcond = d.condstore;
    macro_rules! ok {
        () => {{
            send!(format!("{tag} OK Completed"));
            return Out { bytes: out, action };
        }};
        ($t:expr) => {{
            send!(format!("{tag} OK {}", $t));
            return Out { bytes: out, action };
        }};
    }
    macro_rules! no {
        ($t:expr) => {{
            send!(format!("{tag} NO {}", $t));
            return Out { bytes: out, action };
        }};
    }
    match cmd.as_str() {
        "CAPABILITY" => {
            send!(format!("* CAPABILITY {}", caps(&d, st.secure, mode)));
            ok!()
        }
        "NOOP" => ok!(),
        "STARTTLS" => match mode {
            TlsMode::StartTls(_) if !st.secure => {
                action = Action::StartTls;
                ok!("Begin TLS negotiation now")
            }
            _ => no!("STARTTLS not available"),
        },
        "LOGIN" => {
            if args.first().map(Tok::s).as_deref() == Some(USER) && args.get(1).map(Tok::s).as_deref() == Some(PASS) {
                st.authed = true;
                let c = caps(&d, st.secure, mode);
                ok!(format!("[CAPABILITY {c}] Logged in"))
            }
            no!("[AUTHENTICATIONFAILED] Invalid credentials")
        }
        "ENABLE" => {
            send!(format!("* ENABLED{}", if dcond { " CONDSTORE" } else { "" }));
            ok!()
        }
        "LOGOUT" => {
            send!("* BYE bye".into());
            action = Action::Logout;
            ok!()
        }
        _ => {}
    }
    if !st.authed {
        send!(format!("{tag} BAD not authenticated"));
        return Out { bytes: out, action };
    }
    match cmd.as_str() {
        "LIST" | "LSUB" => {
            let pattern = args.get(1).map(Tok::s).unwrap_or_else(|| "*".into());
            if pattern.is_empty() {
                send!(format!("* {cmd} (\\Noselect) \"/\" \"\""));
            } else {
                for b in d.boxes.iter() {
                    send!(format!("* {cmd} (\\HasNoChildren{}) \"/\" \"{}\"", b.special_use.as_ref().map(|s| format!(" {s}")).unwrap_or_default(), b.path));
                }
            }
            ok!()
        }
        "CREATE" => {
            let path = args[0].s();
            if d.boxes.iter().any(|b| b.path == path) {
                no!("[ALREADYEXISTS] exists");
            }
            d.boxes.push(MBox { path, special_use: None, uid_validity: 1, uid_next: 1, highest_modseq: 1, permanent_flags: vec!["\\Seen".into(), "\\*".into()], messages: vec![] });
            ok!()
        }
        "SUBSCRIBE" => ok!(),
        "SELECT" | "EXAMINE" => {
            let path = args[0].s();
            let Some(b) = d.boxes.iter().find(|b| b.path == path) else { no!("[NONEXISTENT] no such mailbox") };
            st.selected = Some(path);
            send!("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)".into());
            send!(format!("* {} EXISTS", b.messages.len()));
            send!("* 0 RECENT".into());
            send!(format!("* OK [UIDVALIDITY {}] ok", b.uid_validity));
            send!(format!("* OK [UIDNEXT {}] ok", b.uid_next));
            send!(format!("* OK [PERMANENTFLAGS ({})] ok", b.permanent_flags.join(" ")));
            if dcond {
                send!(format!("* OK [HIGHESTMODSEQ {}] ok", b.highest_modseq));
            }
            ok!(format!("[{}] done", if cmd == "SELECT" { "READ-WRITE" } else { "READ-ONLY" }))
        }
        "CLOSE" | "UNSELECT" => {
            st.selected = None;
            ok!()
        }
        "APPEND" => {
            let path = args[0].s();
            if !d.boxes.iter().any(|b| b.path == path) {
                no!("[TRYCREATE] no such mailbox");
            }
            let flags = args.get(1).map(Tok::list).unwrap_or_default();
            let lit = literals.last().cloned().unwrap_or_default();
            if d.fail_append {
                no!("[OVERQUOTA] Over quota");
            }
            d.appended.push((path.clone(), lit.clone(), flags.clone()));
            let uid = deliver_in(&mut d, &path, lit, flags.into_iter().collect(), None, None, now_ms());
            let validity = d.boxes.iter().find(|b| b.path == path).unwrap().uid_validity;
            ok!(format!("[APPENDUID {validity} {uid}] Appended"))
        }
        _ => {}
    }

    let Some(sel) = st.selected.clone() else {
        send!(format!("{tag} NO no mailbox selected"));
        return Out { bytes: out, action };
    };
    let use_uid = cmd == "UID";
    let sub = if use_uid { args[0].s().to_ascii_uppercase() } else { cmd.clone() };
    let rest: &[Tok] = if use_uid { &args[1..] } else { args };
    let bi = d.boxes.iter().position(|b| b.path == sel).unwrap();
    let max_uid = d.boxes[bi].messages.last().map(|m| m.uid).unwrap_or(0);
    let count = d.boxes[bi].messages.len() as u32;

    match sub.as_str() {
        "SEARCH" => {
            let test = parse_search(rest, max_uid);
            let hits: Vec<String> = d.boxes[bi].messages.iter().enumerate().filter(|(_, m)| test(m)).map(|(i, m)| if use_uid { m.uid } else { i as u32 + 1 }.to_string()).collect();
            send!(format!("* SEARCH{}", hits.iter().map(|h| format!(" {h}")).collect::<String>()));
            ok!()
        }
        "FETCH" => {
            let items: Vec<String> = match &rest[1] {
                Tok::L(l) => l.iter().map(Tok::s).collect(),
                Tok::A(s) => vec![s.clone()],
            };
            let since = rest.get(2).map(Tok::list).filter(|m| m.first().is_some_and(|k| k.eq_ignore_ascii_case("CHANGEDSINCE"))).map(|m| m[1].parse::<u64>().unwrap());
            if since.is_some() && !dcond {
                send!(format!("{tag} BAD CHANGEDSINCE without CONDSTORE"));
                return Out { bytes: out, action };
            }
            let set = uid_set(&rest[0].s(), if use_uid { max_uid } else { count });
            let lines: Vec<Vec<u8>> = d.boxes[bi]
                .messages
                .iter()
                .enumerate()
                .filter(|(i, m)| set(if use_uid { m.uid } else { *i as u32 + 1 }) && since.is_none_or(|s| m.modseq > s))
                .map(|(i, m)| fetch_line(&d, m, i + 1, &items, use_uid))
                .collect();
            for l in lines {
                out.extend_from_slice(&l);
            }
            ok!()
        }
        "STORE" => {
            let set = uid_set(&rest[0].s(), max_uid);
            let op = rest[1].s().to_ascii_uppercase();
            let values: Vec<String> = rest[2].list();
            let labels = op.contains("X-GM-LABELS");
            let (add, remove) = (op.starts_with('+'), op.starts_with('-'));
            let silent = op.contains("SILENT");
            let b = &mut d.boxes[bi];
            let mut echoes = vec![];
            for i in 0..b.messages.len() {
                if !set(b.messages[i].uid) {
                    continue;
                }
                b.highest_modseq += 1;
                let hm = b.highest_modseq;
                let m = &mut b.messages[i];
                let target = if labels { m.labels.get_or_insert_with(BTreeSet::new) } else { &mut m.flags };
                if !add && !remove {
                    target.clear();
                }
                for v in &values {
                    if remove {
                        target.remove(v);
                    } else {
                        target.insert(v.clone());
                    }
                }
                m.modseq = hm;
                echoes.push(i);
            }
            if !silent {
                for i in echoes {
                    let items = if labels { vec!["UID".to_string(), "X-GM-LABELS".to_string()] } else { vec!["UID".to_string(), "FLAGS".to_string()] };
                    let line = fetch_line(&d, &d.boxes[bi].messages[i], i + 1, &items, true);
                    out.extend_from_slice(&line);
                }
            }
            ok!()
        }
        "COPY" | "MOVE" => {
            let set = uid_set(&rest[0].s(), max_uid);
            let dest = rest[1].s();
            if !d.boxes.iter().any(|b| b.path == dest) {
                no!("[TRYCREATE] no such mailbox");
            }
            let picked: Vec<Msg> = d.boxes[bi].messages.iter().filter(|m| set(m.uid)).cloned().collect();
            let mut new_uids = vec![];
            for m in &picked {
                new_uids.push(deliver_in(&mut d, &dest, m.source.clone(), m.flags.clone(), m.labels.clone(), m.thread_id.clone(), m.internal_date_ms));
            }
            let validity = d.boxes.iter().find(|b| b.path == dest).unwrap().uid_validity;
            let join = |v: Vec<u32>| v.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
            let src_uids: Vec<u32> = picked.iter().map(|m| m.uid).collect();
            if sub == "MOVE" {
                let mut seqs: Vec<usize> = picked.iter().map(|m| d.boxes[bi].messages.iter().position(|x| x.uid == m.uid).unwrap() + 1).collect();
                for m in &picked {
                    expunge_in(&mut d, &sel, m.uid);
                }
                send!(format!("* OK [COPYUID {validity} {} {}] moved", join(src_uids), join(new_uids)));
                seqs.reverse();
                for s in seqs {
                    send!(format!("* {s} EXPUNGE"));
                }
            }
            ok!()
        }
        "EXPUNGE" => {
            let set = uid_set(&rest.first().map(Tok::s).unwrap_or_else(|| "1:*".into()), max_uid);
            let doomed: Vec<(usize, u32)> = d.boxes[bi].messages.iter().enumerate().filter(|(_, m)| m.flags.contains("\\Deleted") && set(m.uid)).map(|(i, m)| (i + 1, m.uid)).collect();
            for (_, uid) in &doomed {
                expunge_in(&mut d, &sel, *uid);
            }
            for (seq, _) in doomed.iter().rev() {
                send!(format!("* {seq} EXPUNGE"));
            }
            ok!()
        }
        "IDLE" => {
            action = Action::Idle(tag.to_string());
            send!("+ idling".into());
            Out { bytes: out, action }
        }
        _ => {
            send!(format!("{tag} BAD unsupported command {cmd} {sub}"));
            Out { bytes: out, action }
        }
    }
}

async fn session(mut stream: Box<dyn Duplex>, fake: Fake, mode: TlsMode, mut kill: watch::Receiver<u64>) -> std::io::Result<()> {
    let mut st = SessionState { selected: None, authed: false, secure: matches!(mode, TlsMode::Implicit(_)) };
    {
        let c = caps(&fake.data.lock().unwrap(), st.secure, &mode);
        stream.write_all(format!("* OK [CAPABILITY {c}] mini imap ready\r\n").as_bytes()).await?;
    }
    let mut buf: Vec<u8> = vec![];
    // A command whose line ended in a literal marker waits here for the literal's bytes.
    let mut pending: Option<(String, Vec<Vec<u8>>, usize)> = None;
    let mut tmp = [0u8; 8192];
    loop {
        // Drain complete commands.
        loop {
            if let Some((_, lits, need)) = pending.as_mut() {
                if *need > 0 {
                    if buf.len() < *need {
                        break;
                    }
                    lits.push(buf.drain(..*need).collect());
                    *need = 0;
                }
            }
            let Some(eol) = buf.windows(2).position(|w| w == b"\r\n") else { break };
            let line = String::from_utf8_lossy(&buf[..eol]).to_string();
            buf.drain(..eol + 2);
            let (mut text, lits, _) = pending.take().unwrap_or_default();
            if let Some(open) = line.rfind('{') {
                let tail = &line[open..];
                if tail.ends_with('}') || tail.ends_with("+}") {
                    let plus = tail.ends_with("+}");
                    let n: usize = tail.trim_start_matches('{').trim_end_matches('}').trim_end_matches('+').parse().unwrap_or(0);
                    text.push_str(&line[..open]);
                    text.push_str(&format!("\"\0L{}\"", lits.len()));
                    if !plus {
                        stream.write_all(b"+ ready\r\n").await?;
                    }
                    pending = Some((text, lits, n));
                    continue;
                }
            }
            text.push_str(&line);
            let toks = tokenize(&text);
            if st.authed && fake.data.lock().unwrap().hang {
                continue;
            }
            let tag = toks[0].s();
            let command = toks[1].s();
            let out = handle(&fake, &mut st, &mode, &tag, &command, &toks[2..], &lits);
            stream.write_all(&out.bytes).await?;
            match out.action {
                Action::None => {}
                Action::Logout => return Ok(()),
                Action::StartTls => {
                    let TlsMode::StartTls(cfg) = &mode else { unreachable!() };
                    stream = Box::new(TlsAcceptor::from(cfg.clone()).accept(stream).await?);
                    st.secure = true;
                    buf.clear();
                }
                Action::Idle(tag) => {
                    let mut rx = fake.changed.subscribe();
                    loop {
                        tokio::select! {
                            _ = rx.changed() => {
                                let n = {
                                    let d = fake.data.lock().unwrap();
                                    st.selected.as_ref().and_then(|s| d.boxes.iter().find(|b| &b.path == s)).map(|b| b.messages.len()).unwrap_or(0)
                                };
                                stream.write_all(format!("* {n} EXISTS\r\n").as_bytes()).await?;
                            }
                            r = stream.read(&mut tmp) => {
                                let n = r?;
                                if n == 0 { return Ok(()); }
                                buf.extend_from_slice(&tmp[..n]);
                                if let Some(p) = buf.windows(6).position(|w| w == b"DONE\r\n") {
                                    buf.drain(..p + 6);
                                    stream.write_all(format!("{tag} OK IDLE terminated\r\n").as_bytes()).await?;
                                    break;
                                }
                            }
                            _ = kill.changed() => return Ok(()),
                        }
                    }
                }
            }
        }
        tokio::select! {
            r = stream.read(&mut tmp) => {
                let n = r?;
                if n == 0 { return Ok(()); }
                buf.extend_from_slice(&tmp[..n]);
            }
            _ = kill.changed() => return Ok(()),
        }
    }
}

/* ---------------------------------------------------------------- client side */

/// Reaches the test server over plain TCP and logs in. No setting can produce this: only a test can.
pub struct PlainConnector {
    pub port: u16,
}

impl Connector for PlainConnector {
    fn connect<'a>(&'a self, s: &'a ImapSettings) -> BoxFuture<'a, Result<Conn, ProviderError>> {
        Box::pin(async move {
            let tcp = TcpStream::connect(("127.0.0.1", self.port)).await.map_err(|e| ProviderError::Other(e.to_string()))?;
            let mut client = Client::new(MailStream::Plain(tcp));
            client.read_response().await.map_err(|e| ProviderError::Other(e.to_string()))?;
            conn::login(client, s).await
        })
    }
}

pub fn settings(imap_host: &str, port: u16, secure: bool) -> ImapSettings {
    ImapSettings { username: USER.into(), password: PASS.into(), imap_host: imap_host.into(), imap_port: port, imap_secure: secure, smtp_host: "127.0.0.1".into(), smtp_port: 1, smtp_secure: false }
}

/// A self-signed certificate for `localhost`: the server's config and a client config that trusts exactly it.
pub fn tls_pair() -> (Arc<rustls::ServerConfig>, Arc<rustls::ClientConfig>) {
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert = ck.cert.der().clone();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(ck.key_pair.serialize_der());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key.into())
        .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert).unwrap();
    (Arc::new(server), conn::tls_config(roots))
}

pub type Boxes = BTreeMap<String, Vec<String>>;
