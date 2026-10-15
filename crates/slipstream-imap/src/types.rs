//! The contract between Slipstream's local store and a mail provider, mirrored from
//! `server/src/mail/types.ts`. Field names serialize in camelCase so the JSON is the same shape the
//! TypeScript core already reads and writes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Address {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Folders {
    pub inbox: bool,
    pub sent: bool,
    pub trash: bool,
    pub spam: bool,
}

/// `Folders` where each flag may be absent (TypeScript `Partial<Folders>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PartialFolders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spam: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub remote_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    pub inline: bool,
    /// IMAP: "idx:N", the position among the message's attachments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    /// `<mailbox>:<uidvalidity>:<uid>`
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub subject: String,
    /// Milliseconds since the epoch.
    pub sent_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub body_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    pub unread: bool,
    pub starred: bool,
    pub folders: Folders,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<Label>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outgoing: Option<bool>,
    pub attachments: Vec<IncomingAttachment>,
}

/// A change to an already-synced message that doesn't need the body again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagUpdate {
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<PartialFolders>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<Label>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPage {
    pub messages: Vec<IncomingMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag_updates: Option<Vec<FlagUpdate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_remote_ids: Option<Vec<String>>,
    pub cursor: Option<String>,
    /// False when the provider wants to be called again right away with the new cursor.
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id_header: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub thread_remote_id: String,
    pub messages: Vec<ThreadMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub html: String,
    pub text: String,
    /// Pre-built RFC 5322 bytes.
    pub raw: Vec<u8>,
    pub message_id_header: String,
}

/// `{ kind: "archive", threadRemoteId, messages }` and so on, as in the TypeScript union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteAction {
    Archive(ThreadRef),
    Unarchive(ThreadRef),
    Trash(ThreadRef),
    Untrash(ThreadRef),
    Spam(ThreadRef),
    Unspam(ThreadRef),
    MarkRead(ThreadRef),
    MarkUnread(ThreadRef),
    Star(ThreadRef),
    Unstar(ThreadRef),
    AddLabel {
        label: Label,
        #[serde(flatten)]
        thread: ThreadRef,
    },
    RemoveLabel {
        label: Label,
        #[serde(flatten)]
        thread: ThreadRef,
    },
    Send {
        message: OutgoingMessage,
    },
}

/// The three failure classes the TypeScript queue distinguishes.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// Bad credentials: the account needs re-authorizing (`ProviderAuthError`).
    #[error("{0}")]
    Auth(String),
    /// The action can never succeed; stop retrying it (`PermanentProviderError`).
    #[error("{0}")]
    Permanent(String),
    /// The connection died under a command; the provider reconnects and retries once before surfacing it.
    #[error("{0}")]
    Disconnected(String),
    /// Anything else; the caller may retry later.
    #[error("{0}")]
    Other(String),
}

impl ProviderError {
    pub fn other(msg: impl Into<String>) -> Self {
        ProviderError::Other(msg.into())
    }
}

pub type Result<T> = std::result::Result<T, ProviderError>;

/// What `ProviderContext` carries into the provider, minus the callbacks.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub account_id: String,
    /// The account's own address, used to flag outgoing mail.
    pub email: String,
    pub initial_sync_days: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapSettings {
    pub username: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    /// true: TLS from the first byte (993). false: plain start that must upgrade with STARTTLS (143).
    pub imap_secure: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_secure: bool,
}
