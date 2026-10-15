//! Connections: TLS (implicit or STARTTLS) over rustls, the login handshake, and the IMAP verbs the
//! provider needs. `async-imap` does the protocol framing; where it has no accessor (X-GM-THRID) the
//! FETCH response is read through its raw `run_command` / `read_response` hooks and parsed with the
//! same `imap-proto` types it uses itself.

use std::collections::HashSet;
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_imap::imap_proto::{AttributeValue, MailboxDatum, Response, Status};
use async_imap::types::{Mailbox, NameAttribute};
use async_imap::{Client, Session};
use futures::future::BoxFuture;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector as RustlsConnector;

use crate::roles::ListedMailbox;
use crate::types::{ImapSettings, ProviderError, Result};

/// Either side of a connection, so a plain start and a TLS one are the same `Session` type.
pub enum MailStream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl fmt::Debug for MailStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            MailStream::Plain(_) => "MailStream::Plain",
            MailStream::Tls(_) => "MailStream::Tls",
        })
    }
}

impl AsyncRead for MailStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MailStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            MailStream::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MailStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            MailStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            MailStream::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MailStream::Plain(s) => Pin::new(s).poll_flush(cx),
            MailStream::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MailStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            MailStream::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/* ---------------------------------------------------------------- errors */

pub fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "[::1]" || host.starts_with("127.")
}

/// Turn a connection, login or protocol failure into a sentence a person can act on (cf. `friendlyError`).
pub fn friendly(err: impl fmt::Display, host: &str, auth: bool) -> ProviderError {
    let detail = err.to_string().split_whitespace().collect::<Vec<_>>().join(" ");
    if auth {
        return ProviderError::Auth(format!(
            "{host} rejected the IMAP sign-in ({detail}). Check the username and password; many providers need an app password instead of your normal one."
        ));
    }
    ProviderError::Other(format!("IMAP {host}: {detail}"))
}

/// A failed IMAP command: a dead socket means reconnect-and-retry, a NO or BAD means the server said no.
pub fn imap_err<'a>(what: &'a str) -> impl Fn(async_imap::error::Error) -> ProviderError + 'a {
    move |e| {
        if is_connection_error(&e) {
            ProviderError::Disconnected(format!("IMAP {what}: {e}"))
        } else {
            ProviderError::Other(format!("IMAP {what}: {e}"))
        }
    }
}

pub fn map_io(e: std::io::Error, host: &str) -> ProviderError {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => ProviderError::Other(format!("{host} refused the IMAP connection. Check the port, and that the server (or Proton Bridge) is running.")),
        TimedOut => ProviderError::Other(format!("{host} didn't answer in time over IMAP. Check the server name and port.")),
        ConnectionReset | BrokenPipe | UnexpectedEof => ProviderError::Other(format!("{host} closed the IMAP connection. Check the port and the TLS setting.")),
        _ => ProviderError::Other(format!("IMAP {host}: {e}")),
    }
}

/// Did this error come from a dead connection (retry on a fresh one) rather than a refused command?
pub fn is_connection_error(e: &async_imap::error::Error) -> bool {
    use async_imap::error::Error::*;
    matches!(e, Io(_) | ConnectionLost)
}

/* ---------------------------------------------------------------- TLS */

#[derive(Debug)]
struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub fn native_roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    let loaded = rustls_native_certs::load_native_certs();
    for cert in loaded.certs {
        let _ = roots.add(cert);
    }
    roots
}

/// A client config that trusts `roots` only.
pub fn tls_config(roots: RootCertStore) -> Arc<ClientConfig> {
    Arc::new(
        ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// Proton Bridge presents a self-signed certificate on loopback; nothing else gets that exemption.
fn loopback_config() -> Arc<ClientConfig> {
    let p = provider();
    Arc::new(
        ClientConfig::builder_with_provider(p.clone())
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(p)))
            .with_no_client_auth(),
    )
}

/* ---------------------------------------------------------------- connecting */

pub type ImapSession = Session<MailStream>;

/// A live, logged-in connection and what the server said it can do (after TLS, never before).
pub struct Conn {
    pub session: ImapSession,
    pub caps: HashSet<String>,
    pub host: String,
}

impl Conn {
    pub fn has(&self, cap: &str) -> bool {
        self.caps.contains(&cap.to_ascii_uppercase())
    }
}

/// How the provider opens connections. `TlsConnector` is the only production implementation; tests supply
/// one that skips TLS to reach an in-process server, which no setting can switch on.
pub trait Connector: Send + Sync {
    fn connect<'a>(&'a self, settings: &'a ImapSettings) -> BoxFuture<'a, Result<Conn>>;
}

pub struct TlsConnector {
    config: Option<Arc<ClientConfig>>,
}

impl TlsConnector {
    /// Trust the operating system's certificate store.
    pub fn new() -> Self {
        TlsConnector { config: None }
    }
    /// Trust exactly this configuration (tests, pinned servers).
    pub fn with_config(config: Arc<ClientConfig>) -> Self {
        TlsConnector { config: Some(config) }
    }
    fn config_for(&self, host: &str) -> Arc<ClientConfig> {
        if let Some(c) = &self.config {
            return c.clone();
        }
        if is_loopback(host) {
            return loopback_config();
        }
        tls_config(native_roots())
    }
}

impl Default for TlsConnector {
    fn default() -> Self {
        Self::new()
    }
}

async fn read_line(s: &mut TcpStream) -> std::io::Result<String> {
    // One byte at a time: nothing may be consumed past the line, because what follows STARTTLS is a handshake.
    let mut line = Vec::new();
    loop {
        let b = s.read_u8().await?;
        line.push(b);
        if b == b'\n' {
            return Ok(String::from_utf8_lossy(&line).trim_end().to_string());
        }
        if line.len() > 16 * 1024 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "IMAP line too long"));
        }
    }
}

/// Greeting, CAPABILITY, STARTTLS; nothing secret is sent. Returns the stream still plain, ready to upgrade.
async fn plain_phase(s: &mut TcpStream, host: &str) -> Result<()> {
    let greeting = read_line(s).await.map_err(|e| map_io(e, host))?;
    if !greeting.starts_with("* OK") && !greeting.starts_with("* PREAUTH") {
        return Err(ProviderError::other(format!("IMAP {host}: unexpected greeting ({greeting})")));
    }
    s.write_all(b"s1 CAPABILITY\r\n").await.map_err(|e| map_io(e, host))?;
    let mut starttls = false;
    loop {
        let line = read_line(s).await.map_err(|e| map_io(e, host))?;
        if let Some(rest) = line.strip_prefix("* CAPABILITY") {
            starttls |= rest.split_whitespace().any(|c| c.eq_ignore_ascii_case("STARTTLS"));
        } else if line.starts_with("s1 ") {
            if !line.starts_with("s1 OK") {
                return Err(ProviderError::other(format!("IMAP {host}: CAPABILITY failed ({line})")));
            }
            break;
        }
    }
    // Never fall back to a plaintext login: the password stays home unless the connection can be encrypted.
    let no_tls = || {
        ProviderError::other(format!(
            "{host} doesn't offer an encrypted (STARTTLS) connection on this port, and Slipstream won't send your password unencrypted. Use the server's TLS port, usually 993 for IMAP and 465 for SMTP."
        ))
    };
    if !starttls {
        return Err(no_tls());
    }
    s.write_all(b"s2 STARTTLS\r\n").await.map_err(|e| map_io(e, host))?;
    loop {
        let line = read_line(s).await.map_err(|e| map_io(e, host))?;
        if line.starts_with("s2 ") {
            return if line.starts_with("s2 OK") { Ok(()) } else { Err(no_tls()) };
        }
    }
}

fn server_name(host: &str) -> Result<ServerName<'static>> {
    ServerName::try_from(host.to_string()).map_err(|_| ProviderError::other(format!("{host} is not a valid server name")))
}

async fn handshake(tcp: TcpStream, host: &str, config: Arc<ClientConfig>) -> Result<MailStream> {
    let tls = RustlsConnector::from(config).connect(server_name(host)?, tcp).await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("InvalidCertificate") || msg.contains("certificate") {
            ProviderError::other(format!("Couldn't verify {host}'s security certificate ({msg})."))
        } else {
            ProviderError::other(format!("{host} doesn't speak TLS on this IMAP port ({msg}). Ports 993 and 465 use TLS from the start; ports 143 and 587 start plain and upgrade (turn the secure option off for those)."))
        }
    })?;
    Ok(MailStream::Tls(Box::new(tls)))
}

/// Log in on an unauthenticated client and read what the server can do now that the channel is settled.
pub async fn login(mut client: Client<MailStream>, settings: &ImapSettings) -> Result<Conn> {
    let host = &settings.imap_host;
    let mut session = match client.login(&settings.username, &settings.password).await {
        Ok(s) => s,
        Err((e, c)) => {
            client = c;
            drop(client);
            let auth = matches!(e, async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_));
            return Err(match e {
                async_imap::error::Error::Io(io) => map_io(io, host),
                e => friendly(e, host, auth),
            });
        }
    };
    let caps = session.capabilities().await.map_err(|e| friendly(e, host, false))?;
    let caps: HashSet<String> = caps
        .iter()
        .map(|c| match c {
            async_imap::types::Capability::Imap4rev1 => "IMAP4REV1".to_string(),
            async_imap::types::Capability::Auth(a) => format!("AUTH={}", a.to_ascii_uppercase()),
            async_imap::types::Capability::Atom(a) => a.to_ascii_uppercase(),
        })
        .collect();
    if caps.contains("CONDSTORE") && caps.contains("ENABLE") {
        session.run_command_and_check_ok("ENABLE CONDSTORE").await.map_err(|e| friendly(e, host, false))?;
    }
    Ok(Conn { session, caps, host: host.clone() })
}

impl Connector for TlsConnector {
    fn connect<'a>(&'a self, s: &'a ImapSettings) -> BoxFuture<'a, Result<Conn>> {
        Box::pin(async move {
            let host = s.imap_host.as_str();
            let tcp = tokio::time::timeout(std::time::Duration::from_secs(30), TcpStream::connect((host, s.imap_port)))
                .await
                .map_err(|_| ProviderError::other(format!("{host} didn't answer in time over IMAP. Check the server name and port.")))?
                .map_err(|e| map_io(e, host))?;
            let config = self.config_for(host);
            let client = if s.imap_secure {
                let mut client = Client::new(handshake(tcp, host, config).await?);
                client.read_response().await.map_err(|e| map_io(e, host))?.ok_or_else(|| ProviderError::other(format!("{host} closed the IMAP connection")))?;
                client
            } else {
                let mut tcp = tcp;
                plain_phase(&mut tcp, host).await?;
                Client::new(handshake(tcp, host, config).await?)
            };
            login(client, s).await
        })
    }
}

/* ---------------------------------------------------------------- IMAP verbs */

/// What a FETCH response carries, in the shapes the provider uses.
#[derive(Debug, Clone, Default)]
pub struct Fetched {
    pub seq: u32,
    pub uid: u32,
    pub flags: HashSet<String>,
    pub labels: Option<Vec<String>>,
    pub thread_id: Option<String>,
    /// Epoch milliseconds.
    pub internal_date: Option<i64>,
    pub source: Option<Vec<u8>>,
    pub modseq: Option<u64>,
}

/// "1-Feb-1994 13:02:03 -0700" to epoch milliseconds.
pub fn parse_internal_date(s: &str) -> Option<i64> {
    let mut parts = s.split_whitespace();
    let mut d = parts.next()?.split('-');
    let day: i64 = d.next()?.parse().ok()?;
    let mon = d.next()?;
    let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].iter().position(|m| m.eq_ignore_ascii_case(mon))? as i64 + 1;
    let year: i64 = d.next()?.parse().ok()?;
    let mut t = parts.next()?.split(':');
    let (h, mi, sec): (i64, i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let zone = parts.next().unwrap_or("+0000");
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let z: i64 = zone.get(1..5)?.parse().ok()?;
    let offset = sign * ((z / 100) * 3600 + (z % 100) * 60);
    Some((days_from_civil(year, month, day) * 86_400 + h * 3600 + mi * 60 + sec - offset) * 1000)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "17-Jul-1996" (UTC) for SEARCH SINCE, and "17-Jul-1996 02:44:25 +0000" for APPEND.
pub fn imap_date(ms: i64, with_time: bool) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let date = format!("{d:02}-{}-{y}", MONTHS[(m - 1) as usize]);
    if with_time {
        format!("{date} {:02}:{:02}:{:02} +0000", rem / 3600, rem % 3600 / 60, rem % 60)
    } else {
        date
    }
}

/// What a raw command produced besides its status line.
#[derive(Default)]
struct Raw {
    fetched: Vec<Fetched>,
    search: Vec<u32>,
    listed: Vec<ListedMailbox>,
}

impl Conn {
    /// Run a tagged command and read its responses until the matching tagged status. Used where async-imap
    /// has no accessor (X-GM-THRID) and where its streams would end quietly on a dead socket and look like an
    /// empty result: here a missing tagged status is always `Disconnected`, never "nothing found".
    async fn raw(&mut self, command: String) -> Result<Raw> {
        let host = self.host.clone();
        let id = self.session.run_command(command).await.map_err(imap_err("command"))?;
        let mut out = Raw::default();
        loop {
            let res = self
                .session
                .read_response()
                .await
                .map_err(|e| ProviderError::Disconnected(format!("IMAP {host}: {e}")))?
                .ok_or_else(|| ProviderError::Disconnected(format!("IMAP {host}: connection closed mid-command")))?;
            match res.parsed() {
                Response::Fetch(seq, attrs) => out.fetched.push(fetched_from(*seq, attrs)),
                Response::MailboxData(MailboxDatum::Search(ids)) => out.search.extend(ids.iter().copied()),
                Response::MailboxData(MailboxDatum::List(l)) => {
                    let flags = l.name_attributes.iter().filter_map(attribute_text).collect();
                    out.listed.push(ListedMailbox::new(&l.name, l.delimiter.as_deref(), flags));
                }
                Response::Done { tag, status, outcome } if *tag == id => {
                    return match status {
                        Status::Ok => Ok(out),
                        _ => Err(ProviderError::other(format!("IMAP {:?}: {}", status, outcome.information.as_deref().unwrap_or("command failed")))),
                    };
                }
                _ => {}
            }
        }
    }

    /// `UID FETCH <set> <items> [(CHANGEDSINCE n)]`
    pub async fn uid_fetch(&mut self, set: &str, items: &str, changed_since: Option<u64>) -> Result<Vec<Fetched>> {
        let tail = changed_since.map(|m| format!(" (CHANGEDSINCE {m})")).unwrap_or_default();
        Ok(self.raw(format!("UID FETCH {set} {items}{tail}")).await?.fetched)
    }

    /// `FETCH <sequence set> <items>`
    pub async fn seq_fetch(&mut self, set: &str, items: &str) -> Result<Vec<Fetched>> {
        Ok(self.raw(format!("FETCH {set} {items}")).await?.fetched)
    }

    /// SELECT or EXAMINE. A reply without UIDVALIDITY (which RFC 3501 requires) is a truncated one.
    pub async fn select(&mut self, path: &str, read_only: bool) -> Result<Mailbox> {
        let r = if read_only { self.session.examine(path).await } else { self.session.select(path).await };
        let mb = r.map_err(imap_err(path))?;
        if mb.uid_validity.is_none() {
            return Err(ProviderError::Disconnected(format!("IMAP {path}: no UIDVALIDITY in the reply; the connection dropped")));
        }
        Ok(mb)
    }

    pub async fn uid_search(&mut self, query: &str) -> Result<Vec<u32>> {
        let mut uids = self.raw(format!("UID SEARCH {query}")).await?.search;
        uids.sort_unstable();
        uids.dedup();
        Ok(uids)
    }

    /// `UID STORE <set> <op> (<values>)`; `op` should end in .SILENT so no echoes come back.
    pub async fn uid_store(&mut self, set: &str, op: &str, values: &[String]) -> Result<()> {
        self.raw(format!("UID STORE {set} {op} ({})", values.join(" "))).await.map(|_| ())
    }

    pub async fn uid_move(&mut self, set: &str, dest: &str) -> Result<()> {
        self.session.uid_mv(set, dest).await.map_err(imap_err(&format!("move to {dest}")))
    }

    pub async fn uid_copy(&mut self, set: &str, dest: &str) -> Result<()> {
        self.session.uid_copy(set, dest).await.map_err(imap_err(&format!("copy to {dest}")))
    }

    /// UID EXPUNGE (needs UIDPLUS): removes only the named messages.
    pub async fn uid_expunge(&mut self, set: &str) -> Result<()> {
        self.raw(format!("UID EXPUNGE {set}")).await.map(|_| ())
    }

    pub async fn create(&mut self, path: &str) -> Result<()> {
        self.session.create(path).await.map_err(imap_err(&format!("create {path}")))
    }

    pub async fn append(&mut self, path: &str, flags: &str, date_ms: i64, raw: &[u8]) -> Result<()> {
        let date = format!("\"{}\"", imap_date(date_ms, true));
        self.session.append(path, Some(flags), Some(&date), raw).await.map_err(imap_err(&format!("append to {path}")))
    }

    pub async fn list(&mut self) -> Result<Vec<ListedMailbox>> {
        let listed = self.raw("LIST \"\" \"*\"".to_string()).await?.listed;
        if listed.is_empty() {
            // Every account has at least INBOX.
            return Err(ProviderError::Disconnected(format!("IMAP {}: empty mailbox list", self.host)));
        }
        Ok(listed)
    }

    /// Drop unsolicited responses (EXPUNGE, EXISTS) nobody reads, so the channel never fills.
    pub fn drain_unsolicited(&mut self) {
        while self.session.unsolicited_responses.try_recv().is_ok() {}
    }

    pub async fn logout(&mut self) {
        let _ = self.session.logout().await;
    }

    /// Hold the connection in IDLE until the server reports a change or `timeout` passes. Returns the connection
    /// and whether the server announced something; on any failure the connection is gone and the caller reconnects.
    pub async fn idle_once(self, timeout: std::time::Duration) -> Result<(Conn, bool)> {
        let Conn { session, caps, host } = self;
        let mut handle = session.idle();
        handle.init().await.map_err(imap_err("idle"))?;
        let (wait, _stop) = handle.wait_with_timeout(timeout);
        let woke = matches!(wait.await.map_err(imap_err("idle"))?, async_imap::extensions::idle::IdleResponse::NewData(_));
        let session = handle.done().await.map_err(imap_err("idle"))?;
        Ok((Conn { session, caps, host }, woke))
    }
}

fn attribute_text(a: &NameAttribute<'_>) -> Option<String> {
    Some(match a {
        NameAttribute::NoInferiors => "\\Noinferiors".to_string(),
        NameAttribute::NoSelect => "\\Noselect".to_string(),
        NameAttribute::Marked => "\\Marked".to_string(),
        NameAttribute::Unmarked => "\\Unmarked".to_string(),
        NameAttribute::Extension(e) => e.to_string(),
        _ => return None,
    })
}

fn fetched_from(seq: u32, attrs: &[AttributeValue<'_>]) -> Fetched {
    let mut f = Fetched { seq, ..Default::default() };
    for a in attrs {
        match a {
            AttributeValue::Uid(u) => f.uid = *u,
            AttributeValue::Flags(fl) => f.flags = fl.iter().map(|s| s.to_string()).collect(),
            AttributeValue::GmailLabels(l) => f.labels = Some(l.iter().map(|s| s.to_string()).collect()),
            AttributeValue::GmailThrId(t) => f.thread_id = Some(t.to_string()),
            AttributeValue::InternalDate(d) => f.internal_date = parse_internal_date(d),
            AttributeValue::ModSeq(m) => f.modseq = Some(*m),
            AttributeValue::Rfc822(Some(b)) => f.source = Some(b.to_vec()),
            AttributeValue::BodySection { section: None, data: Some(b), .. } => f.source = Some(b.to_vec()),
            _ => {}
        }
    }
    f
}
