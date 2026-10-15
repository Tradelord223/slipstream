//! A Rust IMAP provider with the same contract as `server/src/providers/imap.ts`.
//!
//! `types` mirrors `server/src/mail/types.ts`, `cursor` is the persisted per-mailbox cursor,
//! `provider::ImapProvider` is `sync` / `apply` / `fetch_attachment`, `conn` is TLS + the IMAP verbs
//! (on `async-imap`), `smtp` is lettre, `mime` is mail-parser.

pub mod conn;
pub mod cursor;
pub mod mime;
pub mod provider;
pub mod roles;
pub mod smtp;
pub mod types;
pub mod utf7;

pub use conn::{Conn, Connector, TlsConnector};
pub use provider::ImapProvider;
pub use smtp::{LettreMailer, Mailer, SmtpFailure};
pub use types::*;
