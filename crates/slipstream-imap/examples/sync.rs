//! A tiny binary that syncs one account and prints what it found: the unit used for the size and compile-time numbers.
//!
//!   sync <imap-host> <imap-port> <tls|starttls> <user> <password> [cursor-file]
//!
//! Syncs pages until the provider says it is done, writes the cursor back to `cursor-file` (when given),
//! and prints one line per page.

use slipstream_imap::{ImapProvider, ImapSettings, ProviderContext};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 6 {
        eprintln!("usage: sync <imap-host> <imap-port> <tls|starttls> <user> <password> [cursor-file]");
        std::process::exit(2);
    }
    let settings = ImapSettings {
        username: a[4].clone(),
        password: a[5].clone(),
        imap_host: a[1].clone(),
        imap_port: a[2].parse().expect("port"),
        imap_secure: a[3] == "tls",
        smtp_host: a[1].clone(),
        smtp_port: 465,
        smtp_secure: true,
    };
    let ctx = ProviderContext { account_id: "cli".into(), email: a[4].clone(), initial_sync_days: 30 };
    let cursor_file = a.get(6);
    let mut cursor = cursor_file.and_then(|f| std::fs::read_to_string(f).ok());
    let mut provider = ImapProvider::new(ctx, settings);
    let (mut messages, mut flags, mut deleted) = (0, 0, 0);
    loop {
        match provider.sync(cursor.as_deref()).await {
            Ok(page) => {
                messages += page.messages.len();
                flags += page.flag_updates.as_ref().map_or(0, Vec::len);
                deleted += page.deleted_remote_ids.as_ref().map_or(0, Vec::len);
                cursor = page.cursor;
                if page.done {
                    break;
                }
            }
            Err(e) => {
                eprintln!("sync failed: {e}");
                std::process::exit(1);
            }
        }
    }
    if let (Some(f), Some(c)) = (cursor_file, &cursor) {
        let _ = std::fs::write(f, c);
    }
    provider.close().await;
    println!("synced: {messages} new, {flags} flag updates, {deleted} deleted");
}
