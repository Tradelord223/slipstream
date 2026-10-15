//! Mailbox roles (SPECIAL-USE, then well-known names), sync targets, and Gmail label handling.

use std::collections::BTreeMap;

use crate::types::{Label, PartialFolders, ProviderError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MailboxRole {
    Inbox,
    Sent,
    Trash,
    Junk,
    Archive,
    All,
}

pub type MailboxMap = BTreeMap<MailboxRole, String>;

/// One LIST response line, reduced to what role detection reads.
#[derive(Debug, Clone)]
pub struct ListedMailbox {
    pub path: String,
    /// The last path segment.
    pub name: String,
    /// Mailbox attributes as the server sent them (`\Sent`, `\Noselect`, ...).
    pub flags: Vec<String>,
}

impl ListedMailbox {
    pub fn new(path: &str, delimiter: Option<&str>, flags: Vec<String>) -> Self {
        let name = match delimiter {
            Some(d) if !d.is_empty() => path.rsplit(d).next().unwrap_or(path),
            _ => path,
        };
        ListedMailbox { path: path.to_string(), name: name.to_string(), flags }
    }
    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
    }
}

fn special_use(flag: &str) -> Option<MailboxRole> {
    Some(match flag.to_ascii_lowercase().as_str() {
        "\\inbox" => MailboxRole::Inbox,
        "\\sent" => MailboxRole::Sent,
        "\\trash" => MailboxRole::Trash,
        "\\junk" => MailboxRole::Junk,
        "\\archive" => MailboxRole::Archive,
        "\\all" => MailboxRole::All,
        _ => return None,
    })
}

fn role_names(role: MailboxRole) -> &'static [&'static str] {
    match role {
        MailboxRole::Sent => &["sent", "sent items", "sent mail", "sent messages"],
        MailboxRole::Trash => &["trash", "deleted items", "deleted messages", "bin"],
        MailboxRole::Junk => &["junk", "spam", "junk e-mail", "junk email", "bulk mail"],
        MailboxRole::Archive => &["archive", "archives"],
        MailboxRole::All => &["all mail"],
        MailboxRole::Inbox => &[],
    }
}

/// Find each role's mailbox: SPECIAL-USE flags first, then the usual names.
pub fn detect_mailboxes(list: &[ListedMailbox]) -> MailboxMap {
    let mut map = MailboxMap::new();
    let usable: Vec<&ListedMailbox> = list.iter().filter(|m| !m.has("\\Noselect") && !m.has("\\NonExistent")).collect();
    for m in &usable {
        for f in &m.flags {
            if let Some(role) = special_use(f) {
                map.entry(role).or_insert_with(|| m.path.clone());
            }
        }
        if !map.contains_key(&MailboxRole::Inbox) && m.path.eq_ignore_ascii_case("INBOX") {
            map.insert(MailboxRole::Inbox, m.path.clone());
        }
    }
    // Shallowest path first, so "Archive" beats "Old/Archive".
    let mut by_depth = usable.clone();
    by_depth.sort_by_key(|m| m.path.len());
    for role in [MailboxRole::Sent, MailboxRole::Trash, MailboxRole::Junk, MailboxRole::Archive, MailboxRole::All] {
        if map.contains_key(&role) {
            continue;
        }
        if let Some(hit) = by_depth.iter().find(|m| role_names(role).contains(&m.name.to_lowercase().as_str())) {
            map.insert(role, hit.path.clone());
        }
    }
    map
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncTarget {
    pub path: String,
    pub role: MailboxRole,
}

/// Gmail is read from All Mail (plus Trash and Spam, which All Mail excludes); everything else folder by folder.
pub fn sync_targets(map: &MailboxMap, gmail: bool) -> Result<Vec<SyncTarget>> {
    use MailboxRole::*;
    let order: &[MailboxRole] = if gmail { &[All, Trash, Junk] } else { &[Inbox, Sent, Archive, Trash, Junk] };
    if gmail && !map.contains_key(&All) {
        return Err(ProviderError::other(
            "Gmail's All Mail folder isn't visible over IMAP. In Gmail, open Settings, Forwarding and POP/IMAP, and make sure All Mail is shown in IMAP.",
        ));
    }
    let mut targets = Vec::new();
    for role in order {
        let path = map.get(role).cloned().or_else(|| (*role == Inbox).then(|| "INBOX".to_string()));
        if let Some(path) = path {
            targets.push(SyncTarget { path, role: *role });
        }
    }
    Ok(targets)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GmailLabels {
    pub inbox: bool,
    pub sent: bool,
    pub starred: bool,
    pub draft: bool,
    pub user: Vec<Label>,
}

/// Split X-GM-LABELS into the system labels we act on and the user's own labels.
pub fn gmail_labels<S: AsRef<str>>(labels: &[S]) -> GmailLabels {
    let mut out = GmailLabels::default();
    for l in labels {
        let l = l.as_ref();
        if let Some(sys) = l.strip_prefix('\\') {
            match sys.to_ascii_lowercase().as_str() {
                "inbox" => out.inbox = true,
                "sent" => out.sent = true,
                "starred" => out.starred = true,
                "draft" => out.draft = true,
                _ => {}
            }
        } else {
            out.user.push(Label { remote_id: l.to_string(), name: l.to_string() });
        }
    }
    out
}

pub fn folders_for(role: MailboxRole, gmail: Option<&GmailLabels>) -> PartialFolders {
    let only = |f: fn(&mut PartialFolders)| {
        let mut p = PartialFolders::default();
        f(&mut p);
        p
    };
    match (role, gmail) {
        (MailboxRole::Trash, _) => only(|p| p.trash = Some(true)),
        (MailboxRole::Junk, _) => only(|p| p.spam = Some(true)),
        (_, Some(g)) => PartialFolders { inbox: Some(g.inbox), sent: Some(g.sent), ..Default::default() },
        (MailboxRole::Inbox, None) => only(|p| p.inbox = Some(true)),
        (MailboxRole::Sent, None) => only(|p| p.sent = Some(true)),
        _ => PartialFolders::default(),
    }
}

/// IMAP keywords are atoms: no spaces, quotes, brackets or non-ASCII.
pub fn keyword_for(label: &str) -> Option<String> {
    let mut out = String::new();
    let mut in_run = false;
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            in_run = false;
            out.push(ch);
        } else if !in_run {
            in_run = true;
            out.push('_');
        }
    }
    let out = out.trim_matches('_');
    (!out.is_empty()).then(|| out.to_string())
}

/// Hosts whose SMTP server files the sent message itself; appending our own copy would duplicate it.
pub fn saves_sent_mail(imap_host: &str) -> bool {
    let h = imap_host.to_ascii_lowercase();
    ["gmail.com", "googlemail.com", "outlook.com", "office365.com", "hotmail.com", "live.com", "icloud.com", "me.com"]
        .iter()
        .any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lm(path: &str, flags: &[&str]) -> ListedMailbox {
        ListedMailbox::new(path, Some("/"), flags.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn prefers_special_use_then_names_shallowest_first() {
        let map = detect_mailboxes(&[lm("INBOX", &[]), lm("Mine/Sent", &[]), lm("Sent", &[]), lm("Old/Archive", &[]), lm("Archive", &[]), lm("Gone", &["\\Trash", "\\Noselect"]), lm("Bin", &[])]);
        assert_eq!(map[&MailboxRole::Inbox], "INBOX");
        assert_eq!(map[&MailboxRole::Sent], "Sent");
        assert_eq!(map[&MailboxRole::Archive], "Archive");
        assert_eq!(map[&MailboxRole::Trash], "Bin");
        let tagged = detect_mailboxes(&[lm("INBOX", &[]), lm("Weird", &["\\Sent"]), lm("Sent", &[])]);
        assert_eq!(tagged[&MailboxRole::Sent], "Weird");
    }

    #[test]
    fn chooses_what_to_sync() {
        let map = detect_mailboxes(&[lm("INBOX", &[]), lm("[Gmail]/All Mail", &["\\All"]), lm("[Gmail]/Trash", &["\\Trash"]), lm("[Gmail]/Spam", &["\\Junk"])]);
        let g: Vec<_> = sync_targets(&map, true).unwrap().into_iter().map(|t| t.path).collect();
        assert_eq!(g, ["[Gmail]/All Mail", "[Gmail]/Trash", "[Gmail]/Spam"]);
        let plain: Vec<_> = sync_targets(&map, false).unwrap().into_iter().map(|t| t.path).collect();
        assert_eq!(plain, ["INBOX", "[Gmail]/Trash", "[Gmail]/Spam"]);
        assert!(sync_targets(&MailboxMap::new(), true).is_err());
    }

    #[test]
    fn splits_gmail_labels_and_makes_atom_safe_keywords() {
        let g = gmail_labels(&["\\Inbox", "Clients", "\\Important", "\\Starred"]);
        assert!(g.inbox && g.starred && !g.sent);
        assert_eq!(g.user, vec![Label { remote_id: "Clients".into(), name: "Clients".into() }]);
        assert_eq!(keyword_for("Big Clients").as_deref(), Some("Big_Clients"));
        assert_eq!(keyword_for("  [x]  ").as_deref(), Some("x"));
        assert_eq!(keyword_for("!!!"), None);
    }

    #[test]
    fn knows_which_hosts_file_sent_mail_themselves() {
        assert!(saves_sent_mail("imap.gmail.com") && saves_sent_mail("imap.mail.me.com") && saves_sent_mail("outlook.office365.com"));
        assert!(!saves_sent_mail("imap.fastmail.com") && !saves_sent_mail("127.0.0.1") && !saves_sent_mail("notgmail.com"));
    }
}
