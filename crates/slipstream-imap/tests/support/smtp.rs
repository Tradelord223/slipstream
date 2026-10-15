//! A tiny in-process SMTP sink: accepts any message, records the envelope and the DATA bytes (dot-unstuffed).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Default)]
pub struct Received {
    pub from: String,
    pub to: Vec<String>,
    pub data: Vec<u8>,
}

#[derive(Clone, Default)]
pub struct Sink {
    pub messages: Arc<Mutex<Vec<Received>>>,
    /// RCPT TO addresses containing this text get a 550.
    pub refuse_rcpt: Arc<Mutex<Option<String>>>,
    /// MAIL FROM addresses containing this text get a 535 (the server rejects the account).
    pub reject_auth_for: Arc<Mutex<Option<String>>>,
}

impl Sink {
    pub fn received(&self) -> Vec<Received> {
        self.messages.lock().unwrap().clone()
    }
}

pub async fn start(sink: &Sink) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let sink = sink.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let sink = sink.clone();
            tokio::spawn(async move {
                let _ = talk(tcp, sink).await;
            });
        }
    });
    port
}

async fn talk(tcp: tokio::net::TcpStream, sink: Sink) -> std::io::Result<()> {
    let (r, mut w) = tcp.into_split();
    let mut r = BufReader::new(r);
    w.write_all(b"220 sink ESMTP\r\n").await?;
    let mut cur = Received::default();
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let up = line.trim_end().to_ascii_uppercase();
        if up.starts_with("EHLO") || up.starts_with("HELO") {
            w.write_all(b"250-sink\r\n250 8BITMIME\r\n").await?;
        } else if up.starts_with("MAIL FROM:") {
            cur = Received { from: addr_of(&line), ..Default::default() };
            let reject = sink.reject_auth_for.lock().unwrap().clone();
            if reject.is_some_and(|x| cur.from.contains(&x)) {
                w.write_all(b"535 5.7.8 Authentication credentials invalid\r\n").await?;
            } else {
                w.write_all(b"250 ok\r\n").await?;
            }
        } else if up.starts_with("RCPT TO:") {
            let to = addr_of(&line);
            let refuse = sink.refuse_rcpt.lock().unwrap().clone();
            if refuse.is_some_and(|x| to.contains(&x)) {
                w.write_all(b"550 5.1.1 Mailbox unavailable\r\n").await?;
            } else {
                cur.to.push(to);
                w.write_all(b"250 ok\r\n").await?;
            }
        } else if up == "DATA" {
            w.write_all(b"354 go ahead\r\n").await?;
            let mut data = Vec::new();
            loop {
                let mut l = Vec::new();
                if r.read_until(b'\n', &mut l).await? == 0 {
                    return Ok(());
                }
                if l == b".\r\n" {
                    break;
                }
                // Undo dot-stuffing.
                if l.starts_with(b"..") {
                    l.remove(0);
                }
                data.extend_from_slice(&l);
            }
            cur.data = data;
            sink.messages.lock().unwrap().push(std::mem::take(&mut cur));
            w.write_all(b"250 queued\r\n").await?;
        } else if up == "QUIT" {
            w.write_all(b"221 bye\r\n").await?;
            return Ok(());
        } else if up == "RSET" || up == "NOOP" {
            w.write_all(b"250 ok\r\n").await?;
        } else {
            w.write_all(b"502 not implemented\r\n").await?;
        }
    }
}

fn addr_of(line: &str) -> String {
    let start = line.find('<').map(|i| i + 1).unwrap_or(0);
    let end = line.find('>').unwrap_or(line.len());
    line[start..end].to_string()
}
