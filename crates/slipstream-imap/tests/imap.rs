//! Gate tests: ImapProvider over a real TCP IMAP connection against the in-process server in `support`.
//! Mirrors server/test/imap.test.ts and imap-wire.test.ts assertion for assertion where the contract is the same.

mod support;

use std::sync::Arc;

use slipstream_imap::cursor::Cursor;
use slipstream_imap::smtp::Mailer;
use slipstream_imap::*;
use support::*;

struct Rig {
    fake: Fake,
    _server: Server,
    provider: ImapProvider,
}

fn ctx() -> ProviderContext {
    ProviderContext { account_id: "acc".into(), email: "me@example.com".into(), initial_sync_days: 30 }
}

async fn rig(fake: Fake) -> Rig {
    rig_with(fake, "127.0.0.1", None).await
}

async fn rig_with(fake: Fake, imap_host: &str, mailer: Option<Arc<dyn Mailer>>) -> Rig {
    let server = serve(&fake, TlsMode::None).await;
    let connector = Arc::new(PlainConnector { port: server.port });
    let provider = ImapProvider::with_parts(ctx(), settings(imap_host, server.port, false), connector, mailer);
    Rig { fake, _server: server, provider }
}

#[derive(Default)]
struct Drained {
    pages: Vec<SyncPage>,
    cursor: Option<String>,
    messages: Vec<IncomingMessage>,
    flags: Vec<FlagUpdate>,
    deleted: Vec<String>,
}

async fn drain(p: &mut ImapProvider, mut cursor: Option<String>) -> Drained {
    let mut d = Drained::default();
    for _ in 0..100 {
        let page = p.sync(cursor.as_deref()).await.expect("sync");
        cursor = page.cursor.clone();
        let done = page.done;
        d.messages.extend(page.messages.clone());
        d.flags.extend(page.flag_updates.clone().unwrap_or_default());
        d.deleted.extend(page.deleted_remote_ids.clone().unwrap_or_default());
        d.pages.push(page);
        if done {
            break;
        }
    }
    assert!(d.pages.last().unwrap().done, "sync never finished");
    d.cursor = cursor;
    d
}

fn ids(d: &Drained) -> Vec<&str> {
    d.messages.iter().map(|m| m.remote_id.as_str()).collect()
}

fn mids(d: &Drained) -> Vec<&str> {
    d.messages.iter().map(|m| m.message_id_header.as_deref().unwrap_or("")).collect()
}

fn thread(msgs: &[(&str, &str)]) -> ThreadRef {
    ThreadRef {
        thread_remote_id: "t".into(),
        messages: msgs.iter().map(|(rid, mid)| ThreadMessage { remote_id: rid.to_string(), message_id_header: (!mid.is_empty()).then(|| mid.to_string()) }).collect(),
    }
}

fn flags_of(f: &Fake, path: &str, uid: u32) -> Vec<String> {
    f.msg(path, uid).unwrap().flags.into_iter().collect()
}

/* ================================================================ gate 1: initial sync */

#[tokio::test]
async fn initial_sync_of_every_role_with_batching_and_cursor() {
    let f = Fake::generic(false);
    for i in 0..120 {
        f.deliver("INBOX", mail(&format!("m{i}")), Extra { flags: if i == 5 { vec!["\\Seen"] } else { vec![] }, ..Default::default() });
    }
    f.deliver("Sent", mail_from("out", "Me <me@example.com>"), Extra { flags: vec!["\\Seen"], ..Default::default() });
    f.deliver("Archive", mail("arch1"), Extra::default());
    f.deliver("Archive", mail("arch2"), Extra { flags: vec!["\\Flagged"], ..Default::default() });
    f.deliver("Trash", mail("trashed"), Extra::default());
    f.deliver("Junk", mail("junky"), Extra::default());
    f.deliver("INBOX", mail("a-draft"), Extra { flags: vec!["\\Draft"], ..Default::default() });
    let mut r = rig(f).await;

    let st = drain(&mut r.provider, None).await;
    assert_eq!(st.messages.len(), 121 + 2 + 1 + 1, "the draft is skipped");
    let sizes: Vec<usize> = st.pages.iter().filter(|p| !p.messages.is_empty()).map(|p| p.messages.len()).collect();
    assert_eq!(sizes, [50, 50, 20, 1, 2, 1, 1], "batches of 50 per mailbox, in role order");
    let m5 = st.messages.iter().find(|m| m.message_id_header.as_deref() == Some("<m5@example.com>")).unwrap();
    assert_eq!(m5.remote_id, "INBOX:1:6");
    assert!(!m5.unread);
    assert_eq!(m5.subject, "Subject m5");
    assert_eq!(m5.body_text.trim(), "Body of m5");
    assert_eq!(m5.folders, Folders { inbox: true, ..Default::default() });
    let by = |mid: &str| st.messages.iter().find(|m| m.message_id_header.as_deref() == Some(&format!("<{mid}@example.com>"))).unwrap();
    assert_eq!(by("out").outgoing, Some(true));
    assert_eq!(by("out").folders, Folders { sent: true, ..Default::default() });
    assert_eq!(by("arch1").folders, Folders::default(), "archived mail is in no folder");
    assert!(by("arch2").starred && by("arch2").unread);
    assert!(by("trashed").folders.trash);
    assert!(by("junky").folders.spam);
    assert_eq!(by("arch1").remote_id, "Archive:1:1");

    let cur = Cursor::parse(st.cursor.as_deref());
    assert_eq!(cur.step, 0);
    let inbox = &cur.boxes["INBOX"];
    assert_eq!((inbox.last_uid, inbox.initial.is_none(), inbox.uid_validity.as_str()), (121, true, "1"));
    assert_eq!(cur.boxes["Junk"].last_uid, 1);
    // The first change check seeds the window. Like the TypeScript provider it announces the skipped draft's
    // flags once (the store has no such row and ignores it); after that a quiet account stays quiet.
    let seed = drain(&mut r.provider, st.cursor.clone()).await;
    assert!(seed.messages.is_empty() && seed.deleted.is_empty());
    assert_eq!(seed.flags.iter().map(|f| f.remote_id.as_str()).collect::<Vec<_>>(), ["INBOX:1:121"]);
    let again = drain(&mut r.provider, seed.cursor.clone()).await;
    assert!(again.messages.is_empty() && again.flags.is_empty() && again.deleted.is_empty());
}

#[tokio::test]
async fn first_sync_only_reaches_back_initial_sync_days_and_stops_at_its_ceiling() {
    let f = Fake::generic(false);
    let old = f.deliver("INBOX", mail("ancient"), Extra::default());
    f.change("INBOX", old, |m| m.internal_date_ms = now_ms() - 400 * 86_400_000);
    f.deliver("INBOX", mail("recent"), Extra::default());
    let mut r = rig(f).await;
    let st = drain(&mut r.provider, None).await;
    assert_eq!(mids(&st), ["<recent@example.com>"]);
    // Mail that arrives while the backlog is still being read is picked up on the next round, not lost.
    r.fake.deliver("INBOX", mail("later"), Extra::default());
    let st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(mids(&st), ["<later@example.com>"]);
}

/* ================================================================ gate 2: incremental */

#[tokio::test]
async fn follows_new_mail_flag_changes_and_expunges_without_condstore() {
    let f = Fake::generic(false);
    for i in 0..120 {
        f.deliver("INBOX", mail(&format!("m{i}")), Extra::default());
    }
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    st = drain(&mut r.provider, st.cursor).await; // seed the window
    assert!(st.flags.is_empty() && st.messages.is_empty());

    r.fake.deliver("INBOX", mail("fresh"), Extra::default());
    r.fake.change("INBOX", 1, |m| {
        m.flags.insert("\\Seen".into());
        m.flags.insert("\\Flagged".into());
    });
    r.fake.expunge("INBOX", 2);
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(ids(&st), ["INBOX:1:121"]);
    assert_eq!(st.flags, vec![FlagUpdate { remote_id: "INBOX:1:1".into(), unread: Some(false), starred: Some(true), folders: None, labels: None }]);
    assert_eq!(st.deleted, ["INBOX:1:2"]);
    assert!(r.fake.lines().iter().all(|l| !l.contains("CHANGEDSINCE")), "no CONDSTORE on this server");

    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!((st.messages.len(), st.flags.len(), st.deleted.len()), (0, 0, 0), "each change is reported once");
}

#[tokio::test]
async fn uses_changedsince_when_the_server_has_condstore() {
    let f = Fake::generic(true);
    f.deliver("INBOX", mail("a"), Extra::default());
    f.deliver("INBOX", mail("b"), Extra::default());
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    assert!(Cursor::parse(st.cursor.as_deref()).boxes["INBOX"].highest_modseq.is_some());
    st = drain(&mut r.provider, st.cursor).await;
    assert!(st.flags.is_empty());

    r.fake.change("INBOX", 2, |m| {
        m.flags.insert("\\Seen".into());
    });
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(st.flags, vec![FlagUpdate { remote_id: "INBOX:1:2".into(), unread: Some(false), starred: Some(false), folders: None, labels: None }]);
    let lines = r.fake.lines();
    assert!(lines.iter().any(|l| l.starts_with("UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE ")), "{lines:#?}");
    st = drain(&mut r.provider, st.cursor).await;
    assert!(st.flags.is_empty(), "highestModseq advanced, nothing to re-announce");
}

#[tokio::test]
async fn detects_expunges_and_deletes_before_it_adds_when_mail_moves_between_mailboxes() {
    let f = Fake::generic(false);
    let uid = f.deliver("INBOX", mail("mover"), Extra::default());
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    st = drain(&mut r.provider, st.cursor).await;

    // Another client files the message into Archive.
    let src = r.fake.msg("INBOX", uid).unwrap().source;
    r.fake.deliver("Archive", src, Extra::default());
    r.fake.expunge("INBOX", uid);
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(st.deleted, ["INBOX:1:1"]);
    assert_eq!(st.messages.iter().map(|m| (m.remote_id.as_str(), m.message_id_header.as_deref().unwrap())).collect::<Vec<_>>(), [("Archive:1:1", "<mover@example.com>")]);
    let delete_page = st.pages.iter().position(|p| p.deleted_remote_ids.is_some()).unwrap();
    let add_page = st.pages.iter().position(|p| !p.messages.is_empty()).unwrap();
    assert!(delete_page < add_page, "the store drops a duplicate Message-ID, so the old copy has to go first");
    assert_eq!(st.messages[0].folders, Folders::default(), "archived");
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!((st.messages.len(), st.deleted.len()), (0, 0));
}

#[tokio::test]
async fn treats_deleted_flag_like_an_expunge() {
    let f = Fake::generic(false);
    let uid = f.deliver("INBOX", mail("a"), Extra::default());
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    st = drain(&mut r.provider, st.cursor).await;
    r.fake.change("INBOX", uid, |m| {
        m.flags.insert("\\Deleted".into());
    });
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(st.deleted, ["INBOX:1:1"]);
}

#[tokio::test]
async fn starts_a_mailbox_over_when_uidvalidity_changes() {
    let f = Fake::generic(true);
    f.deliver("INBOX", mail("a"), Extra::default());
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    st = drain(&mut r.provider, st.cursor).await;

    r.fake.with(|d| {
        let b = d.boxes.iter_mut().find(|b| b.path == "INBOX").unwrap();
        b.uid_validity = 7;
        b.uid_next = 1;
        b.messages.clear();
    });
    r.fake.deliver("INBOX", mail("a"), Extra::default());
    r.fake.deliver("INBOX", mail("c"), Extra::default());
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(ids(&st), ["INBOX:7:1", "INBOX:7:2"]);
    assert_eq!(Cursor::parse(st.cursor.as_deref()).boxes["INBOX"].uid_validity, "7");
}

#[tokio::test]
async fn resumes_the_first_sync_from_the_cursor_after_a_restart() {
    let f = Fake::generic(false);
    for i in 0..120 {
        f.deliver("INBOX", mail(&format!("m{i}")), Extra::default());
    }
    let mut r1 = rig(f.clone()).await;
    let p1 = r1.provider.sync(None).await.unwrap();
    assert_eq!(p1.messages.len(), 50);

    let mut r2 = rig(f).await; // a new provider has no in-memory queue
    let rest = drain(&mut r2.provider, p1.cursor).await;
    assert_eq!(&ids(&rest)[..2], ["INBOX:1:51", "INBOX:1:52"]);
    assert_eq!(rest.messages.len(), 70);
}

#[tokio::test]
async fn carries_on_from_a_cursor_the_typescript_provider_wrote() {
    let f = Fake::generic(true);
    for i in 0..3 {
        f.deliver("INBOX", mail(&format!("old{i}")), Extra::default());
    }
    let hm = f.with(|d| d.boxes.iter().find(|b| b.path == "INBOX").unwrap().highest_modseq);
    // What ImapProvider (TypeScript) persists after syncing those three messages and one change check.
    let ts_cursor = format!(
        r#"{{"v":1,"step":0,"boxes":{{"INBOX":{{"uidValidity":"1","lastUid":3,"highestModseq":"{hm}","window":"1:3"}},"Sent":{{"uidValidity":"1","lastUid":0,"highestModseq":"1","window":""}},"Archive":{{"uidValidity":"1","lastUid":0,"highestModseq":"1","window":""}},"Trash":{{"uidValidity":"1","lastUid":0,"highestModseq":"1","window":""}},"Junk":{{"uidValidity":"1","lastUid":0,"highestModseq":"1","window":""}}}}}}"#
    );
    let mut r = rig(f).await;
    let st = drain(&mut r.provider, Some(ts_cursor.clone())).await;
    assert!(st.messages.is_empty(), "nothing is downloaded again");
    r.fake.deliver("INBOX", mail("new"), Extra::default());
    r.fake.change("INBOX", 1, |m| {
        m.flags.insert("\\Seen".into());
    });
    let st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(ids(&st), ["INBOX:1:4"]);
    assert_eq!(st.flags.len(), 1);
    assert_eq!(st.flags[0].remote_id, "INBOX:1:1");
    // The cursor Rust writes is the same JSON shape TypeScript reads.
    let v: serde_json::Value = serde_json::from_str(st.cursor.as_deref().unwrap()).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["boxes"]["INBOX"]["lastUid"], 4);
    assert!(v["boxes"]["INBOX"]["uidValidity"].is_string() && v["boxes"]["INBOX"]["highestModseq"].is_string());
}

#[tokio::test]
async fn reconnects_when_the_server_drops_the_connection() {
    let f = Fake::generic(false);
    f.deliver("INBOX", mail("a"), Extra::default());
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    r.fake.drop_all();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    r.fake.deliver("INBOX", mail("b"), Extra::default());
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(mids(&st), ["<b@example.com>"]);
    assert!(r.fake.log().iter().filter(|l| *l == "LOGIN").count() >= 2, "a second login proves a new connection");
}

#[tokio::test]
async fn login_failure_is_an_auth_error() {
    let f = Fake::generic(false);
    let server = serve(&f, TlsMode::None).await;
    let mut bad = settings("127.0.0.1", server.port, false);
    bad.password = "wrong".into();
    let mut p = ImapProvider::with_parts(ctx(), bad, Arc::new(PlainConnector { port: server.port }), None);
    match p.sync(None).await {
        Err(ProviderError::Auth(m)) => assert!(m.contains("Invalid credentials"), "{m}"),
        other => panic!("expected an auth error, got {other:?}"),
    }
}

#[tokio::test]
async fn idle_wakes_on_new_mail_and_times_out_quietly() {
    let f = Fake::generic(false);
    f.deliver("INBOX", mail("a"), Extra::default());
    let mut r = rig(f.clone()).await;
    assert!(!r.provider.wait_for_change(std::time::Duration::from_millis(300)).await.unwrap(), "nothing happened");
    let writer = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        f.deliver("INBOX", mail("b"), Extra::default());
    });
    assert!(r.provider.wait_for_change(std::time::Duration::from_secs(10)).await.unwrap(), "the server announced the new message");
    writer.await.unwrap();
    // The connection is usable again after IDLE.
    let st = drain(&mut r.provider, None).await;
    assert_eq!(st.messages.len(), 2);
}

/* ================================================================ gate 3: Gmail */

#[tokio::test]
async fn gmail_reads_all_mail_trash_and_spam_with_threads_and_labels() {
    let f = Fake::gmail();
    f.deliver("INBOX", mail("dup-inbox"), Extra::default()); // Gmail shows the same mail in INBOX; we never read it
    f.deliver("[Gmail]/All Mail", mail("a"), Extra { labels: Some(vec!["\\Inbox", "Clients", "\\Important"]), thread_id: Some("1800"), ..Default::default() });
    f.deliver("[Gmail]/All Mail", mail_from("b", "Me <me@example.com>"), Extra { labels: Some(vec!["\\Sent"]), thread_id: Some("1800"), flags: vec!["\\Seen"] });
    f.deliver("[Gmail]/All Mail", mail("starred"), Extra { labels: Some(vec!["\\Starred"]), flags: vec!["\\Flagged"], thread_id: Some("1801") });
    f.deliver("[Gmail]/All Mail", mail("draft"), Extra { labels: Some(vec!["\\Draft"]), flags: vec!["\\Draft"], thread_id: Some("1802") });
    f.deliver("[Gmail]/Trash", mail("t"), Extra { labels: Some(vec![]), thread_id: Some("1803"), ..Default::default() });
    f.deliver("[Gmail]/Spam", mail("sp"), Extra { labels: Some(vec![]), thread_id: Some("1804"), ..Default::default() });
    let mut r = rig_with(f, "imap.gmail.com", None).await;

    let st = drain(&mut r.provider, None).await;
    assert_eq!(st.messages.len(), 5);
    let by = |mid: &str| st.messages.iter().find(|m| m.message_id_header.as_deref() == Some(&format!("<{mid}@example.com>")));
    assert!(by("dup-inbox").is_none() && by("draft").is_none());
    let a = by("a").unwrap();
    assert_eq!(a.remote_id, "[Gmail]/All Mail:1:1");
    assert_eq!(a.remote_thread_id.as_deref(), Some("1800"), "X-GM-THRID is the thread id");
    assert_eq!(a.folders, Folders { inbox: true, ..Default::default() });
    assert_eq!(a.labels, Some(vec![Label { remote_id: "Clients".into(), name: "Clients".into() }]));
    let b = by("b").unwrap();
    assert_eq!(b.remote_thread_id.as_deref(), Some("1800"));
    assert_eq!(b.folders, Folders { sent: true, ..Default::default() });
    assert_eq!(b.outgoing, Some(true));
    assert!(by("starred").unwrap().starred);
    assert!(by("t").unwrap().folders.trash);
    assert!(by("sp").unwrap().folders.spam);
    let lines = r.fake.lines();
    assert!(lines.iter().any(|l| l.starts_with("UID FETCH") && l.contains("X-GM-THRID") && l.contains("X-GM-LABELS") && l.contains("BODY.PEEK[]")), "{lines:#?}");
}

#[tokio::test]
async fn gmail_notices_an_archive_done_elsewhere_through_the_labels() {
    let f = Fake::gmail();
    let uid = f.deliver("[Gmail]/All Mail", mail("a"), Extra { labels: Some(vec!["\\Inbox"]), thread_id: Some("1"), ..Default::default() });
    let mut r = rig(f).await;
    let mut st = drain(&mut r.provider, None).await;
    st = drain(&mut r.provider, st.cursor).await;
    r.fake.change("[Gmail]/All Mail", uid, |m| {
        let l = m.labels.as_mut().unwrap();
        l.remove("\\Inbox");
        l.insert("Receipts".into());
    });
    st = drain(&mut r.provider, st.cursor).await;
    assert_eq!(st.flags.len(), 1);
    assert_eq!(st.flags[0].folders.unwrap().inbox, Some(false));
    assert_eq!(st.flags[0].labels, Some(vec![Label { remote_id: "Receipts".into(), name: "Receipts".into() }]));
}

#[tokio::test]
async fn gmail_explains_a_missing_all_mail() {
    let f = Fake::gmail();
    f.remove_box("[Gmail]/All Mail");
    let mut r = rig(f).await;
    let err = r.provider.sync(None).await.unwrap_err();
    assert!(err.to_string().contains("All Mail"), "{err}");
}

async fn gmail_actions() -> Rig {
    let f = Fake::gmail();
    f.deliver("[Gmail]/All Mail", mail("a"), Extra { labels: Some(vec!["\\Inbox"]), thread_id: Some("1"), ..Default::default() });
    f.deliver("[Gmail]/All Mail", mail("b"), Extra { labels: Some(vec!["\\Inbox", "Clients"]), thread_id: Some("1"), ..Default::default() });
    rig_with(f, "imap.gmail.com", None).await
}

#[tokio::test]
async fn gmail_archives_by_removing_the_inbox_label_and_unarchives_by_adding_it_back() {
    let mut r = gmail_actions().await;
    let t = thread(&[("[Gmail]/All Mail:1:1", "<a@example.com>"), ("[Gmail]/All Mail:1:2", "<b@example.com>")]);
    r.provider.apply(RemoteAction::Archive(t.clone())).await.unwrap();
    assert!(!r.fake.msg("[Gmail]/All Mail", 1).unwrap().labels.unwrap().contains("\\Inbox"));
    let b = r.fake.msg("[Gmail]/All Mail", 2).unwrap().labels.unwrap();
    assert!(!b.contains("\\Inbox") && b.contains("Clients"), "other labels survive");
    r.provider.apply(RemoteAction::Unarchive(t)).await.unwrap();
    assert!(r.fake.msg("[Gmail]/All Mail", 2).unwrap().labels.unwrap().contains("\\Inbox"));
    assert!(r.fake.lines().iter().any(|l| l.contains("-X-GM-LABELS.SILENT (\\Inbox)")), "the system label is sent bare");
}

#[tokio::test]
async fn gmail_adds_and_removes_user_labels_as_labels_not_flags() {
    let mut r = gmail_actions().await;
    let t = thread(&[("[Gmail]/All Mail:1:1", "<a@example.com>"), ("[Gmail]/All Mail:1:2", "<b@example.com>")]);
    let label = |n: &str| Label { remote_id: n.into(), name: n.into() };
    r.provider.apply(RemoteAction::AddLabel { label: label("Big Clients"), thread: t.clone() }).await.unwrap();
    let m = r.fake.msg("[Gmail]/All Mail", 1).unwrap();
    assert!(m.labels.unwrap().contains("Big Clients") && !m.flags.contains("Big Clients"));
    r.provider.apply(RemoteAction::RemoveLabel { label: label("Clients"), thread: t }).await.unwrap();
    assert!(!r.fake.msg("[Gmail]/All Mail", 2).unwrap().labels.unwrap().contains("Clients"));
}

#[tokio::test]
async fn gmail_trashes_by_move_retires_the_old_rows_and_refuses_a_server_without_move() {
    let mut r = gmail_actions().await;
    let t = thread(&[("[Gmail]/All Mail:1:1", "<a@example.com>"), ("[Gmail]/All Mail:1:2", "<b@example.com>")]);
    let st = drain(&mut r.provider, None).await;
    let st = drain(&mut r.provider, st.cursor).await;
    r.provider.apply(RemoteAction::Trash(t)).await.unwrap();
    assert_eq!(r.fake.ids("[Gmail]/Trash").len(), 2);
    assert_eq!(r.fake.ids("[Gmail]/All Mail").len(), 0);
    let st = drain(&mut r.provider, st.cursor).await;
    assert!(st.deleted.contains(&"[Gmail]/All Mail:1:1".to_string()) && st.deleted.contains(&"[Gmail]/All Mail:1:2".to_string()), "{:?}", st.deleted);
    assert_eq!(st.messages.len(), 2, "the trashed copies arrive in Trash");
    assert!(st.messages.iter().all(|m| m.folders.trash));

    let nomove = Fake::gmail();
    nomove.with(|d| {
        d.capabilities.remove("MOVE");
    });
    nomove.deliver("[Gmail]/All Mail", mail("a"), Extra { labels: Some(vec!["\\Inbox"]), ..Default::default() });
    let mut r = rig_with(nomove, "imap.gmail.com", None).await;
    let err = r.provider.apply(RemoteAction::Trash(thread(&[("[Gmail]/All Mail:1:1", "<a@example.com>")]))).await.unwrap_err();
    assert!(matches!(err, ProviderError::Permanent(_)), "{err:?}");
    assert_eq!(r.fake.ids("[Gmail]/All Mail").len(), 1, "nothing was expunged");
    assert!(r.fake.lines().iter().all(|l| !l.contains("EXPUNGE") && !l.starts_with("UID COPY")), "no copy-and-expunge fallback on Gmail");
}

#[tokio::test]
async fn gmail_spam_moves_out_of_all_mail() {
    let mut r = gmail_actions().await;
    r.provider.apply(RemoteAction::Spam(thread(&[("x:1:1", "<a@example.com>")]))).await.unwrap();
    assert_eq!(r.fake.ids("[Gmail]/Spam"), ["<a@example.com>"]);
    assert_eq!(r.fake.ids("[Gmail]/All Mail"), ["<b@example.com>"]);
}

/* ================================================================ gate 4: actions on a generic server */

async fn actions() -> Rig {
    let f = Fake::generic(false);
    f.deliver("INBOX", mail("a"), Extra::default());
    f.deliver("INBOX", mail("b"), Extra::default());
    f.deliver("INBOX", mail("other"), Extra::default());
    rig(f).await
}

fn t_ab() -> ThreadRef {
    thread(&[("Stale:9:1", "<a@example.com>"), ("INBOX:1:2", "<b@example.com>")])
}

#[tokio::test]
async fn marks_read_and_starred_finding_messages_by_message_id() {
    let mut r = actions().await;
    r.provider.apply(RemoteAction::MarkRead(t_ab())).await.unwrap();
    r.provider.apply(RemoteAction::Star(t_ab())).await.unwrap();
    assert_eq!(flags_of(&r.fake, "INBOX", 1), ["\\Flagged", "\\Seen"]);
    assert_eq!(flags_of(&r.fake, "INBOX", 2), ["\\Flagged", "\\Seen"]);
    assert!(flags_of(&r.fake, "INBOX", 3).is_empty(), "the unrelated message is untouched");
    r.provider.apply(RemoteAction::Unstar(t_ab())).await.unwrap();
    assert_eq!(flags_of(&r.fake, "INBOX", 1), ["\\Seen"]);
}

#[tokio::test]
async fn a_message_without_a_message_id_is_found_by_its_remote_id_while_it_still_points_here() {
    let mut r = actions().await;
    r.provider.apply(RemoteAction::MarkRead(thread(&[("INBOX:1:3", ""), ("INBOX:99:1", "")]))).await.unwrap();
    assert_eq!(flags_of(&r.fake, "INBOX", 3), ["\\Seen"]);
    assert!(flags_of(&r.fake, "INBOX", 1).is_empty(), "a remote id from another UIDVALIDITY matches nothing");
}

#[tokio::test]
async fn mark_unread_touches_only_the_newest_message() {
    let mut r = actions().await;
    r.fake.deliver("Sent", mail_from("a-reply", "Me <me@example.com>"), Extra { flags: vec!["\\Seen"], ..Default::default() });
    r.fake.change("INBOX", 1, |m| {
        m.flags.insert("\\Seen".into());
        m.internal_date_ms = now_ms() - 3 * 86_400_000;
    });
    r.fake.change("INBOX", 2, |m| {
        m.flags.insert("\\Seen".into());
        m.internal_date_ms = now_ms() - 2 * 86_400_000;
    });
    r.fake.change("Sent", 1, |m| m.internal_date_ms = now_ms() - 86_400_000);
    let t = thread(&[("INBOX:1:1", "<a@example.com>"), ("INBOX:1:2", "<b@example.com>"), ("Sent:1:1", "<a-reply@example.com>")]);
    r.provider.apply(RemoteAction::MarkUnread(t)).await.unwrap();
    assert_eq!(flags_of(&r.fake, "INBOX", 1), ["\\Seen"], "older message stays read");
    assert_eq!(flags_of(&r.fake, "INBOX", 2), ["\\Seen"]);
    assert!(flags_of(&r.fake, "Sent", 1).is_empty(), "the newest message, wherever it lives, becomes unread");
}

#[tokio::test]
async fn archives_into_the_archive_folder_creating_it_when_missing() {
    let f = Fake::new(false);
    f.add("INBOX", Some("\\Inbox"));
    f.add("Trash", Some("\\Trash"));
    f.deliver("INBOX", mail("a"), Extra::default());
    f.deliver("INBOX", mail("b"), Extra::default());
    f.deliver("INBOX", mail("other"), Extra::default());
    let mut r = rig(f).await;
    r.provider.apply(RemoteAction::Archive(t_ab())).await.unwrap();
    assert!(r.fake.has_box("Archive"));
    assert_eq!(r.fake.ids("Archive"), ["<a@example.com>", "<b@example.com>"]);
    assert_eq!(r.fake.ids("INBOX"), ["<other@example.com>"]);
    r.provider.apply(RemoteAction::Unarchive(t_ab())).await.unwrap();
    let mut inbox = r.fake.ids("INBOX");
    inbox.sort();
    assert_eq!(inbox, ["<a@example.com>", "<b@example.com>", "<other@example.com>"]);
    assert!(r.fake.ids("Archive").is_empty());
}

#[tokio::test]
async fn does_not_create_an_archive_folder_when_there_is_nothing_to_archive() {
    let f = Fake::new(false);
    f.add("INBOX", Some("\\Inbox"));
    f.deliver("INBOX", mail("a"), Extra::default());
    let mut r = rig(f).await;
    r.provider.apply(RemoteAction::Archive(thread(&[("INBOX:1:99", "<ghost@example.com>")]))).await.unwrap();
    assert!(!r.fake.has_box("Archive"));
}

#[tokio::test]
async fn uses_an_existing_archive_folder() {
    let mut r = actions().await;
    r.provider.apply(RemoteAction::Archive(t_ab())).await.unwrap();
    assert!(r.fake.lines().iter().all(|l| !l.starts_with("CREATE")));
    assert_eq!(r.fake.ids("Archive").len(), 2);
}

#[tokio::test]
async fn trashes_from_every_mailbox_and_restores_to_the_inbox() {
    let mut r = actions().await;
    r.fake.deliver("Sent", mail_from("a-reply", "Me <me@example.com>"), Extra::default());
    let t = thread(&[("INBOX:1:1", "<a@example.com>"), ("Sent:1:1", "<a-reply@example.com>")]);
    r.provider.apply(RemoteAction::Trash(t.clone())).await.unwrap();
    let mut trash = r.fake.ids("Trash");
    trash.sort();
    assert_eq!(trash, ["<a-reply@example.com>", "<a@example.com>"]);
    assert!(r.fake.ids("Sent").is_empty());
    r.provider.apply(RemoteAction::Untrash(t)).await.unwrap();
    assert!(r.fake.ids("Trash").is_empty());
    assert!(r.fake.ids("INBOX").contains(&"<a@example.com>".to_string()));
}

#[tokio::test]
async fn moves_to_junk_and_back() {
    let mut r = actions().await;
    r.provider.apply(RemoteAction::Spam(t_ab())).await.unwrap();
    assert_eq!(r.fake.ids("Junk").len(), 2);
    r.provider.apply(RemoteAction::Unspam(t_ab())).await.unwrap();
    assert!(r.fake.ids("Junk").is_empty());
    assert_eq!(r.fake.ids("INBOX").len(), 3);
}

#[tokio::test]
async fn refuses_to_trash_when_the_account_has_no_trash_folder() {
    let mut r = actions().await;
    r.fake.remove_box("Trash");
    let err = r.provider.apply(RemoteAction::Trash(t_ab())).await.unwrap_err();
    assert!(matches!(err, ProviderError::Permanent(_)), "{err:?}");
}

#[tokio::test]
async fn without_move_it_copies_flags_deleted_and_uid_expunges_only_what_it_moved() {
    let mut r = actions().await;
    r.fake.with(|d| {
        d.capabilities.remove("MOVE");
    });
    // Someone else's \Deleted message must survive.
    r.fake.change("INBOX", 3, |m| {
        m.flags.insert("\\Deleted".into());
    });
    r.provider.apply(RemoteAction::Trash(t_ab())).await.unwrap();
    assert_eq!(r.fake.ids("Trash").len(), 2);
    assert_eq!(r.fake.ids("INBOX"), ["<other@example.com>"], "the bystander is still there");
    let lines = r.fake.lines();
    assert!(lines.iter().any(|l| l.starts_with("UID EXPUNGE")), "{lines:#?}");
    assert!(lines.iter().all(|l| !l.starts_with("EXPUNGE")), "never a bare EXPUNGE");
}

#[tokio::test]
async fn stores_labels_as_imap_keywords_when_the_mailbox_allows_them() {
    let mut r = actions().await;
    let label = Label { remote_id: "l1".into(), name: "Big Clients".into() };
    r.provider.apply(RemoteAction::AddLabel { label: label.clone(), thread: t_ab() }).await.unwrap();
    assert!(r.fake.msg("INBOX", 1).unwrap().flags.contains("Big_Clients"));
    r.provider.apply(RemoteAction::RemoveLabel { label: label.clone(), thread: t_ab() }).await.unwrap();
    assert!(!r.fake.msg("INBOX", 1).unwrap().flags.contains("Big_Clients"));
    r.fake.with(|d| d.boxes.iter_mut().find(|b| b.path == "INBOX").unwrap().permanent_flags = vec!["\\Seen".into(), "\\Flagged".into()]);
    r.provider.apply(RemoteAction::AddLabel { label, thread: t_ab() }).await.unwrap();
    assert!(!r.fake.msg("INBOX", 1).unwrap().flags.contains("Big_Clients"), "no custom keywords: quietly nothing");
}

#[tokio::test]
async fn downloads_an_attachment_by_re_reading_the_message() {
    let pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";
    let b64 = {
        // Tiny base64 encoder: the dev tree has no base64 crate of its own.
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in pdf.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            s.push(T[(n >> 18) as usize & 63] as char);
            s.push(T[(n >> 12) as usize & 63] as char);
            s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        s
    };
    let raw = [
        "Message-ID: <att@example.com>",
        "From: Carol <carol@example.com>",
        "To: me@example.com",
        "Subject: Invoice",
        "Date: Thu, 01 Oct 2026 10:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"b1\"",
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--b1",
        "Content-Type: application/pdf; name=\"invoice.pdf\"",
        "Content-Disposition: attachment; filename=\"invoice.pdf\"",
        "Content-Transfer-Encoding: base64",
        "",
        &b64,
        "--b1--",
        "",
    ]
    .join("\r\n");
    let f = Fake::generic(false);
    let uid = f.deliver("INBOX", raw, Extra::default());
    let mut r = rig(f).await;
    let st = drain(&mut r.provider, None).await;
    let att = &st.messages[0].attachments[0];
    assert_eq!((att.remote_id.as_deref(), att.filename.as_str(), att.mime_type.as_str()), (Some("idx:0"), "invoice.pdf", "application/pdf"));
    assert!(att.content.is_none(), "bytes stay on the server until asked for");
    let bytes = r.provider.fetch_attachment(&format!("INBOX:1:{uid}"), "idx:0").await.unwrap();
    assert_eq!(bytes, pdf);
    r.fake.set_validity("INBOX", 9);
    let err = r.provider.fetch_attachment(&format!("INBOX:1:{uid}"), "idx:0").await.unwrap_err();
    assert!(err.to_string().contains("renumbered"), "{err}");
}

#[test]
fn remote_action_json_matches_the_typescript_union() {
    let a: RemoteAction = serde_json::from_str(r#"{"kind":"addLabel","label":{"remoteId":"l","name":"X"},"threadRemoteId":"t","messages":[{"remoteId":"INBOX:1:2","messageIdHeader":"<a@x>"}]}"#).unwrap();
    assert!(matches!(&a, RemoteAction::AddLabel { label, thread } if label.name == "X" && thread.messages[0].message_id_header.as_deref() == Some("<a@x>")));
    let m: RemoteAction = serde_json::from_str(r#"{"kind":"markUnread","threadRemoteId":"t","messages":[]}"#).unwrap();
    assert!(matches!(m, RemoteAction::MarkUnread(_)));
    let page = SyncPage { messages: vec![], flag_updates: None, deleted_remote_ids: Some(vec!["a".into()]), cursor: Some("c".into()), done: true };
    assert_eq!(serde_json::to_string(&page).unwrap(), r#"{"messages":[],"deletedRemoteIds":["a"],"cursor":"c","done":true}"#);
}

/* ================================================================ gate 5: send */

fn outgoing() -> OutgoingMessage {
    let raw = [
        "Message-ID: <sent1@example.com>",
        "From: Me <me@example.com>",
        "To: Alice <alice@example.com>",
        "Cc: carol@example.com",
        "Bcc: Hidden One <hidden@example.com>,",
        "  second@example.com",
        "Subject: Hello",
        "Date: Thu, 01 Oct 2026 10:00:00 +0000",
        "",
        "Hi Alice",
        "",
    ]
    .join("\r\n")
    .into_bytes();
    let addr = |n: &str, e: &str| Address { name: n.into(), email: e.into() };
    OutgoingMessage {
        from: addr("Me", "me@example.com"),
        to: vec![addr("Alice", "alice@example.com")],
        cc: vec![addr("", "carol@example.com")],
        bcc: vec![addr("Hidden One", "hidden@example.com"), addr("", "Second@example.com"), addr("", "alice@example.com")],
        subject: "Hello".into(),
        html: "<p>Hi Alice</p>".into(),
        text: "Hi Alice".into(),
        raw,
        message_id_header: "<sent1@example.com>".into(),
    }
}

async fn smtp_rig(fake: Fake, imap_host: &str) -> (Rig, support::smtp::Sink) {
    use lettre::transport::smtp::client::Tls;
    let sink = support::smtp::Sink::default();
    let port = support::smtp::start(&sink).await;
    // Plaintext to a loopback sink: lettre's dangerous builder, which the production path never uses.
    let transport = lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::builder_dangerous("127.0.0.1").port(port).tls(Tls::None).build();
    let mailer: Arc<dyn Mailer> = Arc::new(LettreMailer::with_transport(transport, "127.0.0.1"));
    (rig_with(fake, imap_host, Some(mailer)).await, sink)
}

#[tokio::test]
async fn send_hides_bcc_on_the_wire_delivers_to_everyone_and_files_the_original_in_sent() {
    let (mut r, sink) = smtp_rig(Fake::generic(false), "127.0.0.1").await;
    let message = outgoing();
    assert_eq!(r.provider.apply(RemoteAction::Send { message: message.clone() }).await.unwrap(), None);

    let got = sink.received();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].from, "me@example.com");
    assert_eq!(got[0].to, ["alice@example.com", "carol@example.com", "hidden@example.com", "second@example.com"], "deduped, lowercased, Bcc included");
    let wire = String::from_utf8_lossy(&got[0].data).to_string();
    assert!(!wire.to_lowercase().contains("bcc") && !wire.contains("hidden@example.com") && !wire.contains("second@example.com"), "no Bcc on the wire, folded line included:\n{wire}");
    assert!(wire.contains("Cc: carol@example.com\r\nSubject: Hello"), "everything else is untouched");
    assert!(wire.contains("Date: Thu, 01 Oct 2026 10:00:00 +0000\r\n\r\nHi Alice"));
    assert!(got[0].data.starts_with(&mime::strip_bcc_header(&message.raw)), "the bytes are the stripped original");

    let appended = r.fake.with(|d| d.appended.clone());
    assert_eq!(appended.len(), 1);
    assert_eq!(appended[0].0, "Sent");
    assert_eq!(appended[0].2, ["\\Seen"]);
    assert_eq!(appended[0].1, message.raw, "the stored copy keeps its Bcc");
    assert!(r.fake.lines().iter().any(|l| l.starts_with("APPEND \"Sent\"") || l.starts_with("APPEND Sent")));
}

#[tokio::test]
async fn send_leaves_filing_to_gmail_icloud_and_outlook() {
    let (mut r, sink) = smtp_rig(Fake::gmail(), "imap.gmail.com").await;
    r.provider.apply(RemoteAction::Send { message: outgoing() }).await.unwrap();
    assert_eq!(sink.received().len(), 1);
    assert!(r.fake.with(|d| d.appended.is_empty()));
}

#[tokio::test]
async fn a_failed_sent_copy_does_not_fail_a_delivered_message() {
    let f = Fake::generic(false);
    f.with(|d| d.fail_append = true);
    let (mut r, sink) = smtp_rig(f, "127.0.0.1").await;
    r.provider.apply(RemoteAction::Send { message: outgoing() }).await.unwrap();
    assert_eq!(sink.received().len(), 1);
}

#[tokio::test]
async fn send_rejects_a_message_with_nobody_to_send_it_to_and_maps_5xx_to_permanent() {
    let (mut r, sink) = smtp_rig(Fake::generic(false), "127.0.0.1").await;
    let mut empty = outgoing();
    empty.to.clear();
    empty.cc.clear();
    empty.bcc.clear();
    let err = r.provider.apply(RemoteAction::Send { message: empty }).await.unwrap_err();
    assert!(matches!(err, ProviderError::Permanent(_)));
    assert!(sink.received().is_empty());

    *sink.refuse_rcpt.lock().unwrap() = Some("hidden@".into());
    let err = r.provider.apply(RemoteAction::Send { message: outgoing() }).await.unwrap_err();
    assert!(matches!(&err, ProviderError::Permanent(m) if m.contains("refused")), "{err:?}");
    assert!(r.fake.with(|d| d.appended.is_empty()), "nothing is filed for a message that never left");
}

/* ================================================================ gate 6: STARTTLS is required */

fn real_connector(client: Arc<rustls::ClientConfig>) -> Arc<TlsConnector> {
    Arc::new(TlsConnector::with_config(client))
}

#[tokio::test]
async fn never_sends_login_to_a_server_that_does_not_offer_starttls() {
    let f = Fake::generic(false);
    f.deliver("INBOX", mail("a"), Extra::default());
    let server = serve(&f, TlsMode::None).await;
    let (_, client) = tls_pair();
    let mut p = ImapProvider::with_parts(ctx(), settings("localhost", server.port, false), real_connector(client), None);
    let err = p.sync(None).await.unwrap_err();
    assert!(err.to_string().contains("won't send your password unencrypted"), "{err}");
    let log = f.log();
    assert!(log.contains(&"CAPABILITY".to_string()), "it did look: {log:?}");
    assert!(!log.contains(&"LOGIN".to_string()), "the password never went out: {log:?}");
}

#[tokio::test]
async fn never_sends_login_when_the_starttls_upgrade_is_refused() {
    let f = Fake::generic(false);
    let server = serve(&f, TlsMode::StartTlsRefused).await;
    let (_, client) = tls_pair();
    let mut p = ImapProvider::with_parts(ctx(), settings("localhost", server.port, false), real_connector(client), None);
    let err = p.sync(None).await.unwrap_err();
    assert!(err.to_string().contains("won't send your password unencrypted"), "{err}");
    let log = f.log();
    assert_eq!(log, ["CAPABILITY", "STARTTLS"], "{log:?}");
}

#[tokio::test]
async fn never_sends_login_over_plaintext_when_tls_was_expected_from_the_first_byte() {
    let f = Fake::generic(false);
    let server = serve(&f, TlsMode::None).await;
    let (_, client) = tls_pair();
    let mut p = ImapProvider::with_parts(ctx(), settings("localhost", server.port, true), real_connector(client), None);
    assert!(p.sync(None).await.is_err());
    assert!(!f.log().contains(&"LOGIN".to_string()));
}

#[tokio::test]
async fn upgrades_with_starttls_then_logs_in_and_syncs() {
    let f = Fake::generic(true);
    f.deliver("INBOX", mail("a"), Extra::default());
    let (server_cfg, client_cfg) = tls_pair();
    let server = serve(&f, TlsMode::StartTls(server_cfg)).await;
    let mut p = ImapProvider::with_parts(ctx(), settings("localhost", server.port, false), real_connector(client_cfg), None);
    let st = drain(&mut p, None).await;
    assert_eq!(mids(&st), ["<a@example.com>"]);
    let log = f.log();
    let starttls = log.iter().position(|l| l == "STARTTLS").expect("STARTTLS was issued");
    let login = log.iter().position(|l| l == "LOGIN").expect("LOGIN happened");
    assert!(starttls < login, "LOGIN comes only after the upgrade: {log:?}");
    assert_eq!(log.iter().filter(|l| *l == "STARTTLS").count(), 1);
}

#[tokio::test]
async fn implicit_tls_works_and_an_untrusted_certificate_is_refused() {
    let f = Fake::generic(false);
    f.deliver("INBOX", mail("a"), Extra::default());
    let (server_cfg, client_cfg) = tls_pair();
    let server = serve(&f, TlsMode::Implicit(server_cfg)).await;
    let mut p = ImapProvider::with_parts(ctx(), settings("localhost", server.port, true), real_connector(client_cfg), None);
    assert_eq!(drain(&mut p, None).await.messages.len(), 1);

    // A client that trusts a different CA must not log in to this server.
    let (_, other_client) = tls_pair();
    let f2 = Fake::generic(false);
    let (server_cfg2, _) = tls_pair();
    let server2 = serve(&f2, TlsMode::Implicit(server_cfg2)).await;
    let mut p2 = ImapProvider::with_parts(ctx(), settings("localhost", server2.port, true), real_connector(other_client), None);
    let err = p2.sync(None).await.unwrap_err();
    assert!(err.to_string().contains("certificate"), "{err}");
    assert!(!f2.log().contains(&"LOGIN".to_string()), "no password to an unverified server");
}
