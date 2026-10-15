//! Sending: lettre over rustls with an explicit envelope and caller-built bytes (Bcc already stripped).

use futures::future::BoxFuture;
use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use crate::conn::is_loopback;
use crate::types::ImapSettings;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmtpFailure {
    /// The server rejected the sign-in.
    Auth(String),
    /// A 5xx answer: the server will never take this message.
    Permanent(String),
    Transient(String),
}

/// The seam the provider sends through. `LettreMailer` is the production implementation.
pub trait Mailer: Send + Sync {
    fn send_raw<'a>(&'a self, from: &'a str, to: &'a [String], raw: &'a [u8]) -> BoxFuture<'a, Result<(), SmtpFailure>>;
}

pub struct LettreMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    host: String,
}

/// Build a transport from the account settings. `tls` decides the security: implicit TLS (465) when
/// `smtp_secure`, otherwise STARTTLS is required (587): there is no plaintext mode reachable from settings.
pub fn transport_from(s: &ImapSettings, tls: Tls, port: u16) -> AsyncSmtpTransport<Tokio1Executor> {
    AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&s.smtp_host)
        .port(port)
        .tls(tls)
        .credentials(Credentials::new(s.username.clone(), s.password.clone()))
        .timeout(Some(std::time::Duration::from_secs(120)))
        .build()
}

impl LettreMailer {
    pub fn new(s: &ImapSettings) -> Result<Self, SmtpFailure> {
        // Proton Bridge presents a self-signed certificate on loopback; nothing else gets that exemption.
        let params = TlsParameters::builder(s.smtp_host.clone())
            .dangerous_accept_invalid_certs(is_loopback(&s.smtp_host))
            .dangerous_accept_invalid_hostnames(is_loopback(&s.smtp_host))
            .build_rustls()
            .map_err(|e| SmtpFailure::Transient(e.to_string()))?;
        let tls = if s.smtp_secure { Tls::Wrapper(params) } else { Tls::Required(params) };
        Ok(LettreMailer { transport: transport_from(s, tls, s.smtp_port), host: s.smtp_host.clone() })
    }

    /// Wrap a transport built elsewhere (tests point one at an in-process sink).
    pub fn with_transport(transport: AsyncSmtpTransport<Tokio1Executor>, host: &str) -> Self {
        LettreMailer { transport, host: host.to_string() }
    }
}

impl Mailer for LettreMailer {
    fn send_raw<'a>(&'a self, from: &'a str, to: &'a [String], raw: &'a [u8]) -> BoxFuture<'a, Result<(), SmtpFailure>> {
        Box::pin(async move {
            let parse = |a: &str| a.parse::<lettre::Address>().map_err(|e| SmtpFailure::Permanent(format!("bad address {a}: {e}")));
            let envelope = Envelope::new(Some(parse(from)?), to.iter().map(|a| parse(a)).collect::<Result<Vec<_>, _>>()?)
                .map_err(|e| SmtpFailure::Permanent(e.to_string()))?;
            self.transport.send_raw(&envelope, raw).await.map(|_| ()).map_err(|e| {
                let code = e.status().map(|c| c.to_string());
                let detail = format!("{}: {e}", self.host);
                match code.as_deref() {
                    Some("530" | "534" | "535") => SmtpFailure::Auth(detail),
                    _ if e.is_permanent() => SmtpFailure::Permanent(detail),
                    _ => SmtpFailure::Transient(detail),
                }
            })
        })
    }
}
