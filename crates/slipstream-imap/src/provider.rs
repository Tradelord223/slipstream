//! The IMAP provider: a port of `server/src/providers/imap.ts`. Same cursor, same round structure
//! (change checks first, then new mail; Gmail the other way round), same action semantics.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use async_imap::types::{Flag, Mailbox};

use crate::conn::{Conn, Connector, Fetched, TlsConnector};
use crate::cursor::{compress_uids, expand_uids, find_expunged, finish_batch, parse_remote_id, remote_id_for, BoxState, Cursor, Initial, BATCH, DAY_MS, WINDOW};
use crate::mime::{extract_attachment, now_ms, parse_raw, strip_bcc_header, ParseOptions};
use crate::roles::{detect_mailboxes, folders_for, gmail_labels, keyword_for, saves_sent_mail, sync_targets, MailboxMap, MailboxRole, SyncTarget};
use crate::smtp::{LettreMailer, Mailer, SmtpFailure};
use crate::types::*;

#[derive(Default)]
struct Mem {
    /// UIDs still to fetch, per mailbox: spares re-running a large SEARCH for every batch of the first sync.
    queued: HashMap<String, Vec<u32>>,
    /// Last flags sent per mailbox window, so an unchanged message isn't re-announced every round.
    signatures: HashMap<String, BTreeMap<u32, String>>,
    /// Gmail: remote ids of messages we moved out of a mailbox, to retire even if they're outside the change window.
    moved: HashSet<String>,
}

#[derive(Clone)]
struct Layout {
    gmail: bool,
    map: MailboxMap,
    targets: Vec<SyncTarget>,
}

#[derive(Default)]
struct Step {
    messages: Vec<IncomingMessage>,
    flag_updates: Vec<FlagUpdate>,
    deleted: Vec<String>,
    /// More new mail is queued behind this batch.
    more: bool,
}

pub struct ImapProvider {
    ctx: ProviderContext,
    settings: ImapSettings,
    connector: Arc<dyn Connector>,
    mailer: Option<Arc<dyn Mailer>>,
    conn: Option<Conn>,
    /// A command was started and never finished (the future was dropped): the stream may hold half a response.
    dirty: bool,
    mem: Mem,
}

fn has_flag(f: &Fetched, flag: &str) -> bool {
    f.flags.iter().any(|x| x.eq_ignore_ascii_case(flag))
}

/// A quoted IMAP string.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Gmail system labels (`\Inbox`) go bare, user labels quoted.
fn label_atom(l: &str) -> String {
    if l.starts_with('\\') {
        l.to_string()
    } else {
        quote(l)
    }
}

struct MsgState {
    skip: bool,
    unread: bool,
    starred: bool,
    folders: PartialFolders,
    labels: Option<Vec<Label>>,
}

/// The part of a fetched message that lives on the server: flags, folders, labels.
fn state_of(f: &Fetched, target: &SyncTarget, gmail: bool) -> MsgState {
    let g = gmail.then(|| gmail_labels(f.labels.as_deref().unwrap_or(&[])));
    MsgState {
        skip: has_flag(f, "\\Draft") || has_flag(f, "\\Deleted") || g.as_ref().is_some_and(|g| g.draft),
        unread: !has_flag(f, "\\Seen"),
        starred: has_flag(f, "\\Flagged") || g.as_ref().is_some_and(|g| g.starred),
        folders: folders_for(target.role, g.as_ref()),
        labels: g.map(|g| g.user),
    }
}

fn to_incoming(f: &Fetched, target: &SyncTarget, validity: &str, gmail: bool, self_email: &str) -> Option<IncomingMessage> {
    let s = state_of(f, target, gmail);
    let source = f.source.as_deref()?;
    if s.skip {
        return None;
    }
    let folders = Folders {
        inbox: s.folders.inbox.unwrap_or(false),
        sent: s.folders.sent.unwrap_or(false),
        trash: s.folders.trash.unwrap_or(false),
        spam: s.folders.spam.unwrap_or(false),
    };
    let mut m = parse_raw(
        source,
        ParseOptions {
            remote_id: remote_id_for(&target.path, validity, f.uid),
            remote_thread_id: if gmail { f.thread_id.clone() } else { None },
            folders,
            unread: s.unread,
            starred: s.starred,
            labels: s.labels,
            self_email,
            received_at: f.internal_date,
        },
    )?;
    if folders.sent {
        m.outgoing = Some(true);
    }
    Some(m)
}

fn flag_update_of(f: &Fetched, target: &SyncTarget, validity: &str, gmail: bool) -> FlagUpdate {
    let s = state_of(f, target, gmail);
    let mut u = FlagUpdate { remote_id: remote_id_for(&target.path, validity, f.uid), unread: Some(s.unread), starred: Some(s.starred), folders: None, labels: None };
    // Folder membership only moves around in Gmail (labels); elsewhere a message's mailbox never changes under its UID.
    if gmail {
        u.folders = Some(s.folders);
        u.labels = s.labels;
    }
    u
}

fn flag_signature(u: &FlagUpdate) -> String {
    let mut names: Vec<&str> = u.labels.iter().flatten().map(|l| l.name.as_str()).collect();
    names.sort_unstable();
    format!("{:?}", (u.unread, u.starred, u.folders, names))
}

const FETCH_FLAGS: &str = "(UID FLAGS)";
const FETCH_FLAGS_GMAIL: &str = "(UID FLAGS X-GM-LABELS)";

impl ImapProvider {
    /// Production: TLS verified against the OS store, mail sent through lettre.
    pub fn new(ctx: ProviderContext, settings: ImapSettings) -> Self {
        Self::with_parts(ctx, settings, Arc::new(TlsConnector::new()), None)
    }

    /// Test seams: swap the connector and/or the SMTP transport.
    pub fn with_parts(ctx: ProviderContext, settings: ImapSettings, connector: Arc<dyn Connector>, mailer: Option<Arc<dyn Mailer>>) -> Self {
        ImapProvider { ctx, settings, connector, mailer, conn: None, dirty: false, mem: Mem::default() }
    }

    /* -------- connection */

    /// Run `op` on the live connection; if the connection died under it, reconnect and try once more.
    async fn run<T>(&mut self, mut op: impl AsyncFnMut(&mut Conn, &mut Mem) -> Result<T>) -> Result<T> {
        let mut retry = true;
        loop {
            if self.dirty {
                self.conn = None;
            }
            if self.conn.is_none() {
                self.conn = Some(self.connector.connect(&self.settings).await?);
            }
            self.dirty = true;
            let conn = self.conn.as_mut().expect("connected above");
            let result = op(conn, &mut self.mem).await;
            match result {
                Ok(v) => {
                    conn.drain_unsolicited();
                    self.dirty = false;
                    return Ok(v);
                }
                Err(ProviderError::Disconnected(msg)) => {
                    self.dirty = false;
                    self.conn = None;
                    if retry {
                        retry = false;
                        continue;
                    }
                    return Err(ProviderError::Other(msg));
                }
                Err(e) => {
                    self.dirty = false;
                    return Err(e);
                }
            }
        }
    }

    pub async fn close(&mut self) {
        if let Some(mut c) = self.conn.take() {
            c.logout().await;
        }
    }

    /// Block until the server reports a change in the main mailbox (IDLE), `timeout` passes, or the link drops.
    /// Returns true when the server announced something worth a sync.
    pub async fn wait_for_change(&mut self, timeout: std::time::Duration) -> Result<bool> {
        let layout = self.run(async |c, _| layout(c).await).await?;
        let path = layout.targets[0].path.clone();
        self.run(async |c, _| c.select(&path, true).await.map(|_| ())).await?;
        let Some(conn) = self.conn.take() else { return Err(ProviderError::other("not connected")) };
        if !conn.has("IDLE") {
            self.conn = Some(conn);
            return Err(ProviderError::Permanent("The server does not offer IDLE".into()));
        }
        let (conn, woke) = conn.idle_once(timeout).await?;
        self.conn = Some(conn);
        Ok(woke)
    }

    /* -------- sync */

    /// Pull one page of changes. `cursor` is None for the first sync.
    pub async fn sync(&mut self, cursor_text: Option<&str>) -> Result<SyncPage> {
        let mut cursor = Cursor::parse(cursor_text);
        let lay = self.run(async |c, _| layout(c).await).await?;
        let n = lay.targets.len();
        let total = n * 2;
        let days = self.ctx.initial_sync_days;
        let self_email = self.ctx.email.clone();
        while cursor.step < total {
            // Elsewhere the store drops a copy that arrives while its twin still exists, so deletions must come first.
            // Gmail threads by X-GM-THRID, which keeps a thread alive across a move, so there additions go first.
            let checking = (cursor.step < n) == !lay.gmail;
            let target = lay.targets[cursor.step % n].clone();
            let res = self
                .run(async |c, mem| {
                    if checking {
                        check_changes(c, mem, &target, lay.gmail, &mut cursor).await
                    } else {
                        fetch_new(c, mem, &target, lay.gmail, &mut cursor, days, &self_email).await
                    }
                })
                .await?;
            let content = !res.messages.is_empty() || !res.flag_updates.is_empty() || !res.deleted.is_empty();
            if content || res.more {
                if !res.more {
                    cursor.step += 1;
                }
                let done = cursor.step >= total;
                if done {
                    cursor.step = 0;
                }
                return Ok(SyncPage {
                    messages: res.messages,
                    flag_updates: (!res.flag_updates.is_empty()).then_some(res.flag_updates),
                    deleted_remote_ids: (!res.deleted.is_empty()).then_some(res.deleted),
                    cursor: Some(cursor.serialize()),
                    done,
                });
            }
            cursor.step += 1;
        }
        cursor.step = 0;
        Ok(SyncPage { messages: vec![], flag_updates: None, deleted_remote_ids: None, cursor: Some(cursor.serialize()), done: true })
    }

    /* -------- actions */

    pub async fn apply(&mut self, action: RemoteAction) -> Result<Option<String>> {
        if let RemoteAction::Send { message } = &action {
            self.send(message).await?;
            return Ok(None);
        }
        self.run(async |c, mem| apply_to_thread(c, mem, &action).await).await?;
        Ok(None)
    }

    /* -------- sending */

    async fn send(&mut self, m: &OutgoingMessage) -> Result<()> {
        let mut seen = HashSet::new();
        let recipients: Vec<String> = m
            .to
            .iter()
            .chain(&m.cc)
            .chain(&m.bcc)
            .map(|a| a.email.trim().to_lowercase())
            .filter(|e| !e.is_empty() && seen.insert(e.clone()))
            .collect();
        if recipients.is_empty() {
            return Err(ProviderError::Permanent("The message has no recipients".into()));
        }
        if self.mailer.is_none() {
            let mailer = LettreMailer::new(&self.settings).map_err(|e| ProviderError::other(format!("{e:?}")))?;
            self.mailer = Some(Arc::new(mailer));
        }
        // The envelope carries the Bcc recipients; the bytes on the wire must not name them.
        let wire = strip_bcc_header(&m.raw);
        let sent = self.mailer.as_ref().expect("set above").send_raw(m.from.email.trim(), &recipients, &wire).await;
        match sent {
            Ok(()) => {}
            Err(SmtpFailure::Auth(d)) => {
                return Err(ProviderError::Auth(format!(
                    "{} rejected the SMTP sign-in ({d}). Check the username and password; many providers need an app password instead of your normal one.",
                    self.settings.smtp_host
                )))
            }
            // A 5xx answer means the server will never take this message; retrying only repeats the refusal.
            Err(SmtpFailure::Permanent(d)) => return Err(ProviderError::Permanent(format!("The mail server refused the message: {d}"))),
            Err(SmtpFailure::Transient(d)) => return Err(ProviderError::Other(format!("SMTP {d}"))),
        }
        if saves_sent_mail(&self.settings.imap_host) {
            return Ok(());
        }
        // The message is gone; failing to file a copy must not make the queue send it again.
        if let Err(e) = self.save_to_sent(&m.raw).await {
            eprintln!("[slipstream] imap: sent, but couldn't save a copy to Sent: {e}");
        }
        Ok(())
    }

    async fn save_to_sent(&mut self, raw: &[u8]) -> Result<()> {
        self.run(async |c, _| {
            let sent = layout(c).await?.map.get(&MailboxRole::Sent).cloned().ok_or_else(|| ProviderError::other("no Sent folder found"))?;
            c.append(&sent, "(\\Seen)", now_ms(), raw).await
        })
        .await
    }

    /* -------- attachments */

    pub async fn fetch_attachment(&mut self, message_remote_id: &str, attachment_remote_id: &str) -> Result<Vec<u8>> {
        let (path, validity, uid) = parse_remote_id(message_remote_id).ok_or_else(|| ProviderError::other("Unrecognized message id"))?;
        let source = self
            .run(async |c, _| {
                let mb = c.select(&path, true).await?;
                if mb.uid_validity.unwrap_or(0).to_string() != validity {
                    return Err(ProviderError::other("The mailbox was renumbered by the server; sync again to download this attachment"));
                }
                let got = c.uid_fetch(&uid.to_string(), "(UID BODY.PEEK[])", None).await?;
                got.into_iter().find_map(|f| f.source).ok_or_else(|| ProviderError::other("The message is no longer in that mailbox"))
            })
            .await?;
        extract_attachment(&source, attachment_remote_id).ok_or_else(|| ProviderError::other("Attachment not found in message"))
    }
}

async fn layout(c: &mut Conn) -> Result<Layout> {
    let gmail = c.has("X-GM-EXT-1");
    let map = detect_mailboxes(&c.list().await?);
    let targets = sync_targets(&map, gmail)?;
    Ok(Layout { gmail, map, targets })
}

fn validity_of(mb: &Mailbox) -> String {
    mb.uid_validity.unwrap_or(0).to_string()
}

/* ---------------------------------------------------------------- change checks and new mail */

/// Flag changes and expunges in mailboxes we already follow.
async fn check_changes(c: &mut Conn, mem: &mut Mem, target: &SyncTarget, gmail: bool, cursor: &mut Cursor) -> Result<Step> {
    let Some(st) = cursor.boxes.get(&target.path) else { return Ok(Step::default()) };
    if st.initial.is_some() {
        return Ok(Step::default());
    }
    let (st_validity, last_uid, st_modseq, st_window) = (st.uid_validity.clone(), st.last_uid, st.highest_modseq.clone(), st.window.clone());
    let mb = c.select(&target.path, true).await?;
    let validity = validity_of(&mb);
    if validity != st_validity {
        // The server renumbered the mailbox: start over. Old rows keep their old ids until the store learns to retire them.
        cursor.boxes.remove(&target.path);
        mem.queued.remove(&target.path);
        mem.signatures.remove(&target.path);
        return Ok(Step::default());
    }
    let items = if gmail { FETCH_FLAGS_GMAIL } else { FETCH_FLAGS };
    let first_seq = (mb.exists + 1).saturating_sub(WINDOW).max(1);
    let win = if mb.exists > 0 { c.seq_fetch(&format!("{first_seq}:*"), items).await? } else { Vec::new() };
    let mut res = Step::default();

    let current: Vec<(u32, bool)> = win.iter().map(|m| (m.uid, has_flag(m, "\\Deleted"))).collect();
    for uid in find_expunged(&expand_uids(st_window.as_deref()), &current, first_seq == 1) {
        res.deleted.push(remote_id_for(&target.path, &validity, uid));
    }
    let prefix = format!("{}:{}:", target.path, validity);
    let moved: Vec<String> = mem.moved.iter().filter(|id| id.starts_with(&prefix)).cloned().collect();
    for id in moved {
        mem.moved.remove(&id);
        if !res.deleted.contains(&id) {
            res.deleted.push(id);
        }
    }

    let live: Vec<&Fetched> = win.iter().filter(|m| m.uid <= last_uid && !has_flag(m, "\\Deleted")).collect();
    let hms = mb.highest_modseq;
    let known_modseq = st_modseq.as_deref().and_then(|m| m.parse::<u64>().ok());
    match (hms, known_modseq) {
        (Some(hms), Some(known)) => {
            if known < hms {
                for m in c.uid_fetch("1:*", items, Some(known)).await? {
                    if m.uid <= last_uid && !has_flag(&m, "\\Deleted") {
                        res.flag_updates.push(flag_update_of(&m, target, &validity, gmail));
                    }
                }
            }
        }
        _ => {
            let sigs = mem.signatures.entry(target.path.clone()).or_default();
            let mut next = BTreeMap::new();
            for m in &live {
                let update = flag_update_of(m, target, &validity, gmail);
                let sig = flag_signature(&update);
                if sigs.get(&m.uid) != Some(&sig) {
                    res.flag_updates.push(update);
                }
                next.insert(m.uid, sig);
            }
            *sigs = next;
        }
    }
    let st = cursor.boxes.get_mut(&target.path).expect("checked above");
    if let Some(h) = hms {
        st.highest_modseq = Some(h.to_string());
    }
    let live_uids: Vec<u32> = live.iter().map(|m| m.uid).collect();
    st.window = Some(compress_uids(&live_uids));
    Ok(res)
}

/// One batch of mail the store hasn't seen: the first sync (recent mail only) or anything past lastUid.
async fn fetch_new(c: &mut Conn, mem: &mut Mem, target: &SyncTarget, gmail: bool, cursor: &mut Cursor, initial_days: u32, self_email: &str) -> Result<Step> {
    let mb = c.select(&target.path, true).await?;
    let validity = validity_of(&mb);
    if cursor.boxes.get(&target.path).is_none_or(|st| st.uid_validity != validity) {
        cursor.boxes.insert(
            target.path.clone(),
            BoxState {
                uid_validity: validity.clone(),
                last_uid: 0,
                highest_modseq: mb.highest_modseq.map(|h| h.to_string()),
                window: None,
                initial: Some(Initial { since: now_ms() - i64::from(initial_days) * DAY_MS, ceiling: mb.uid_next.filter(|n| *n > 0).map(|n| n - 1) }),
            },
        );
        mem.queued.remove(&target.path);
    }
    let st = cursor.boxes.get_mut(&target.path).expect("inserted above");
    let after = st.last_uid;
    let ceiling = st.initial.as_ref().and_then(|i| i.ceiling);
    let queued: Option<Vec<u32>> = mem.queued.get(&target.path).map(|q| q.iter().copied().filter(|u| *u > after).collect());
    let uids = match queued {
        Some(q) => q,
        None => {
            let mut query = format!("UID {}:{}", after + 1, ceiling.map(|c| c.to_string()).unwrap_or_else(|| "*".into()));
            if let Some(i) = &st.initial {
                query.push_str(&format!(" SINCE {}", crate::conn::imap_date(i.since, false)));
            }
            let found = if ceiling.is_some_and(|c| after + 1 > c) { Vec::new() } else { c.uid_search(&query).await? };
            // "N:*" always includes the newest message even when it is older than N, hence the filter.
            found.into_iter().filter(|u| *u > after && ceiling.is_none_or(|c| *u <= c)).collect()
        }
    };
    let batch: Vec<u32> = uids.iter().copied().take(BATCH).collect();
    let rest: Vec<u32> = uids.iter().copied().skip(BATCH).collect();

    let mut res = Step::default();
    if !batch.is_empty() {
        let items = if gmail { "(UID FLAGS INTERNALDATE BODY.PEEK[] X-GM-LABELS X-GM-THRID)" } else { "(UID FLAGS INTERNALDATE BODY.PEEK[])" };
        let mut fetched = c.uid_fetch(&compress_uids(&batch), items, None).await?;
        fetched.sort_by_key(|f| f.uid);
        let sigs = mem.signatures.entry(target.path.clone()).or_default();
        for f in &fetched {
            match to_incoming(f, target, &validity, gmail, self_email) {
                Some(m) => {
                    res.messages.push(m);
                    // The store has these flags now; the next change check shouldn't announce them again.
                    sigs.insert(f.uid, flag_signature(&flag_update_of(f, target, &validity, gmail)));
                    if sigs.len() > (WINDOW * 2) as usize {
                        sigs.pop_first();
                    }
                }
                None if f.source.is_some() && !state_of(f, target, gmail).skip => {
                    // One unreadable message shouldn't stop the mailbox from syncing.
                    eprintln!("[slipstream] imap {} uid {}: skipped, unparseable", target.path, f.uid);
                }
                None => {}
            }
        }
    }
    finish_batch(st, batch.last().copied(), rest.len());
    if rest.is_empty() {
        mem.queued.remove(&target.path);
    } else {
        mem.queued.insert(target.path.clone(), rest.clone());
    }
    res.more = !rest.is_empty();
    Ok(res)
}

/* ---------------------------------------------------------------- actions */

fn header_term(id: &str) -> Option<String> {
    // Non-ASCII ids would need a literal and a charset; they are skipped (and found by remote id if possible).
    (id.is_ascii() && !id.contains(['\r', '\n'])).then(|| format!("HEADER Message-ID {}", quote(id)))
}

/// `OR a OR b c` for any number of terms.
fn or_chain(terms: &[String]) -> String {
    match terms {
        [] => String::new(),
        [one] => one.clone(),
        [first, rest @ ..] => format!("OR {first} {}", or_chain(rest)),
    }
}

/// UIDs of the thread's messages in the open mailbox. Remote ids go stale when mail moves, so look up by
/// Message-ID; a message without one can only be found by its remote id, and only if that still points here.
async fn locate(c: &mut Conn, path: &str, validity: &str, thread: &ThreadRef) -> Result<Vec<u32>> {
    let mut uids = BTreeSet::new();
    let mut ids = Vec::new();
    let mut candidates = Vec::new();
    for m in &thread.messages {
        match (&m.message_id_header, parse_remote_id(&m.remote_id)) {
            (Some(h), _) if !h.is_empty() => ids.extend(header_term(h)),
            (_, Some((p, v, uid))) if p == path && v == validity => candidates.push(uid),
            _ => {}
        }
    }
    for chunk in ids.chunks(20) {
        uids.extend(c.uid_search(&or_chain(chunk)).await?);
    }
    if !candidates.is_empty() {
        uids.extend(c.uid_search(&format!("UID {}", compress_uids(&candidates))).await?);
    }
    Ok(uids.into_iter().collect())
}

/// Run `f` on the thread's messages in each of the given mailboxes (skipping mailboxes where it has none).
async fn each_mailbox(c: &mut Conn, paths: &[String], thread: &ThreadRef, mut f: impl AsyncFnMut(&mut Conn, &str, &[u32], &Mailbox) -> Result<()>) -> Result<()> {
    for path in paths {
        let mb = c.select(path, false).await?;
        let uids = locate(c, path, &validity_of(&mb), thread).await?;
        if !uids.is_empty() {
            f(c, path, &uids, &mb).await?;
        }
    }
    Ok(())
}

enum Dest {
    Path(String),
    /// The Archive folder, created on first use.
    Archive,
}

async fn archive_folder(c: &mut Conn, lay: &mut Layout) -> Result<String> {
    if let Some(p) = lay.map.get(&MailboxRole::Archive) {
        return Ok(p.clone());
    }
    c.create("Archive").await?;
    lay.map.insert(MailboxRole::Archive, "Archive".into());
    Ok("Archive".into())
}

/// Move the thread's messages out of `from` into `to`.
async fn move_thread(c: &mut Conn, mem: &mut Mem, lay: &mut Layout, from: &[String], to: Dest, thread: &ThreadRef) -> Result<()> {
    let has_move = c.has("MOVE");
    // Without MOVE a copy-and-expunge from Gmail's All Mail deletes for good.
    if lay.gmail && !has_move {
        return Err(ProviderError::Permanent("Gmail's IMAP server did not offer MOVE".into()));
    }
    if !has_move && !c.has("UIDPLUS") {
        // Plain EXPUNGE would also remove other clients' \Deleted mail.
        return Err(ProviderError::Permanent("The server offers neither MOVE nor UIDPLUS, so mail can't be moved safely".into()));
    }
    let mut dest = match &to {
        Dest::Path(p) => Some(p.clone()),
        Dest::Archive => None,
    };
    let from: Vec<String> = from.iter().filter(|p| Some(*p) != dest.as_ref()).cloned().collect();
    let gmail = lay.gmail;
    each_mailbox(c, &from, thread, async |c, path, uids, mb| {
        if dest.is_none() {
            dest = Some(archive_folder(c, lay).await?);
        }
        let dest = dest.as_deref().expect("resolved above");
        let set = compress_uids(uids);
        if has_move {
            c.uid_move(&set, dest).await?;
        } else {
            c.uid_copy(&set, dest).await?;
            c.uid_store(&set, "+FLAGS.SILENT", &["\\Deleted".to_string()]).await?;
            c.uid_expunge(&set).await?;
        }
        // Gmail's old rows would otherwise linger beyond the newest-500 window and show up as duplicates.
        if gmail {
            for uid in uids {
                mem.moved.insert(remote_id_for(path, &validity_of(mb), *uid));
            }
        }
        Ok(())
    })
    .await
}

async fn apply_to_thread(c: &mut Conn, mem: &mut Mem, action: &RemoteAction) -> Result<()> {
    use RemoteAction::*;
    let mut lay = layout(c).await?;
    let gmail = lay.gmail;
    let everywhere: Vec<String> = lay.targets.iter().map(|t| t.path.clone()).collect();
    let inbox = lay.map.get(&MailboxRole::Inbox).cloned().unwrap_or_else(|| "INBOX".into());
    let need = |role: MailboxRole| -> Result<String> {
        lay.map.get(&role).cloned().ok_or_else(|| ProviderError::Permanent(format!("This account has no {} folder", if role == MailboxRole::Trash { "Trash" } else { "Junk" })))
    };
    let targets = lay.targets.clone();
    let except = |roles: &[MailboxRole]| -> Vec<String> { targets.iter().filter(|t| !roles.contains(&t.role)).map(|t| t.path.clone()).collect() };
    let all_mail = || lay.map.get(&MailboxRole::All).cloned().into_iter().collect::<Vec<String>>();

    match action {
        MarkRead(t) | Star(t) | Unstar(t) => {
            let (flag, add) = match action {
                MarkRead(_) => ("\\Seen", true),
                Star(_) => ("\\Flagged", true),
                _ => ("\\Flagged", false),
            };
            each_mailbox(c, &everywhere, t, async |c, _, uids, _| c.uid_store(&compress_uids(uids), if add { "+FLAGS.SILENT" } else { "-FLAGS.SILENT" }, &[flag.to_string()]).await).await
        }
        MarkUnread(t) => mark_unread_newest(c, &everywhere, t).await,
        Archive(t) if gmail => {
            each_mailbox(c, &all_mail(), t, async |c, _, uids, _| c.uid_store(&compress_uids(uids), "-X-GM-LABELS.SILENT", &["\\Inbox".to_string()]).await).await
        }
        Unarchive(t) if gmail => {
            each_mailbox(c, &all_mail(), t, async |c, _, uids, _| c.uid_store(&compress_uids(uids), "+X-GM-LABELS.SILENT", &["\\Inbox".to_string()]).await).await
        }
        Archive(t) => move_thread(c, mem, &mut lay, &[inbox], Dest::Archive, t).await,
        Unarchive(t) => match lay.map.get(&MailboxRole::Archive).cloned() {
            Some(a) => move_thread(c, mem, &mut lay, &[a], Dest::Path(inbox), t).await,
            None => Ok(()),
        },
        Trash(t) => {
            let dest = need(MailboxRole::Trash)?;
            move_thread(c, mem, &mut lay, &except(&[MailboxRole::Trash]), Dest::Path(dest), t).await
        }
        Untrash(t) => {
            let from = need(MailboxRole::Trash)?;
            move_thread(c, mem, &mut lay, &[from], Dest::Path(inbox), t).await
        }
        Spam(t) => {
            let dest = need(MailboxRole::Junk)?;
            move_thread(c, mem, &mut lay, &except(&[MailboxRole::Trash, MailboxRole::Junk]), Dest::Path(dest), t).await
        }
        Unspam(t) => {
            let from = need(MailboxRole::Junk)?;
            move_thread(c, mem, &mut lay, &[from], Dest::Path(inbox), t).await
        }
        AddLabel { label, thread } | RemoveLabel { label, thread } => {
            let add = matches!(action, AddLabel { .. });
            if gmail {
                let op = if add { "+X-GM-LABELS.SILENT" } else { "-X-GM-LABELS.SILENT" };
                return each_mailbox(c, &all_mail(), thread, async |c, _, uids, _| c.uid_store(&compress_uids(uids), op, &[label_atom(&label.name)]).await).await;
            }
            let Some(keyword) = keyword_for(&label.name) else { return Ok(()) };
            each_mailbox(c, &everywhere, thread, async |c, _, uids, mb| {
                // Servers that don't allow custom keywords can't store labels; that is a no-op, not an error.
                if !mb.permanent_flags.is_empty() && !mb.permanent_flags.iter().any(|f| matches!(f, Flag::MayCreate) || matches!(f, Flag::Custom(k) if k.as_ref() == keyword)) {
                    return Ok(());
                }
                c.uid_store(&compress_uids(uids), if add { "+FLAGS.SILENT" } else { "-FLAGS.SILENT" }, std::slice::from_ref(&keyword)).await
            })
            .await
        }
        Send { .. } => unreachable!("send is handled before apply_to_thread"),
    }
}

/// Like the local store and the Gmail provider, mark only the newest message unread (not the whole thread).
async fn mark_unread_newest(c: &mut Conn, paths: &[String], thread: &ThreadRef) -> Result<()> {
    let mut newest: Option<((i64, u32), String)> = None;
    each_mailbox(c, paths, thread, async |c, path, uids, _| {
        for f in c.uid_fetch(&compress_uids(uids), "(UID INTERNALDATE)", None).await? {
            let key = (f.internal_date.unwrap_or(0), f.uid);
            if newest.as_ref().is_none_or(|(k, _)| key > *k) {
                newest = Some((key, path.to_string()));
            }
        }
        Ok(())
    })
    .await?;
    if let Some(((_, uid), path)) = newest {
        c.select(&path, false).await?;
        c.uid_store(&uid.to_string(), "-FLAGS.SILENT", &["\\Seen".to_string()]).await?;
    }
    Ok(())
}
