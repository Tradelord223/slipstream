//! RFC 5322 bytes to the normalized `IncomingMessage` (mail-parser), plus Bcc stripping for sending.

use std::borrow::Cow;

use mail_parser::{Address as MpAddress, HeaderValue, MessageParser, MimeHeaders};

use crate::types::{Address, Folders, IncomingAttachment, IncomingMessage, Label};

pub struct ParseOptions<'a> {
    pub remote_id: String,
    pub remote_thread_id: Option<String>,
    pub folders: Folders,
    pub unread: bool,
    pub starred: bool,
    pub labels: Option<Vec<Label>>,
    /// Owner address; messages from it are marked outgoing.
    pub self_email: &'a str,
    /// Fallback when the Date header is missing (IMAP INTERNALDATE), epoch ms.
    pub received_at: Option<i64>,
}

fn addresses(field: Option<&MpAddress<'_>>) -> Vec<Address> {
    let mut out = Vec::new();
    let Some(field) = field else { return out };
    for a in field.iter() {
        if let Some(email) = a.address() {
            out.push(Address { name: a.name().unwrap_or("").to_string(), email: email.to_lowercase() });
        }
    }
    out
}

/// mail-parser hands back ids without their angle brackets; the TypeScript core stores and searches with them.
fn bracketed(id: &str) -> String {
    let id = id.trim();
    if id.starts_with('<') {
        id.to_string()
    } else {
        format!("<{id}>")
    }
}

fn text_list(v: &HeaderValue<'_>) -> Vec<String> {
    match v {
        HeaderValue::Text(t) => vec![bracketed(t)],
        HeaderValue::TextList(l) => l.iter().map(|t| bracketed(t)).collect(),
        _ => Vec::new(),
    }
}

/// Parse raw bytes. `None` only when the bytes are not a message at all.
pub fn parse_raw(raw: &[u8], opts: ParseOptions<'_>) -> Option<IncomingMessage> {
    let msg = MessageParser::default().parse(raw)?;
    let from = addresses(msg.from()).into_iter().next().unwrap_or_default();
    let precedence = msg.header_raw("Precedence").map(|s| s.trim().to_lowercase());
    let auto_submitted = msg.header_raw("Auto-Submitted").map(|s| s.trim().to_lowercase());
    let bulk = msg.header_raw("List-Id").is_some()
        || matches!(precedence.as_deref(), Some("bulk" | "list" | "junk"))
        || auto_submitted.as_deref().is_some_and(|a| a != "no");
    // body_html converts a plain-text body to HTML; the contract wants html only when the sender wrote some.
    let has_html = msg.html_part(0).is_some_and(|p| p.is_text_html());
    let body_html = if has_html { msg.body_html(0).map(Cow::into_owned) } else { None };
    let in_reply_to = text_list(msg.in_reply_to()).into_iter().next();
    let references = text_list(msg.references());
    let self_email = opts.self_email.to_lowercase();

    let attachments = msg
        .attachments()
        .enumerate()
        .map(|(i, a)| {
            let inline = a.content_disposition().is_some_and(|d| d.ctype().eq_ignore_ascii_case("inline")) && a.content_id().is_some();
            IncomingAttachment {
                remote_id: Some(format!("idx:{i}")),
                filename: a.attachment_name().unwrap_or("attachment").to_string(),
                mime_type: a
                    .content_type()
                    .map(|c| match c.subtype() {
                        Some(s) => format!("{}/{}", c.ctype(), s),
                        None => c.ctype().to_string(),
                    })
                    .unwrap_or_else(|| "application/octet-stream".into()),
                size: a.contents().len(),
                content_id: a.content_id().map(|c| c.trim_matches(['<', '>']).to_string()),
                inline,
                content: inline.then(|| a.contents().to_vec()),
            }
        })
        .collect();

    Some(IncomingMessage {
        remote_id: opts.remote_id,
        remote_thread_id: opts.remote_thread_id,
        message_id_header: msg.message_id().map(bracketed),
        in_reply_to,
        references: Some(references),
        outgoing: Some(!self_email.is_empty() && from.email == self_email),
        from,
        to: addresses(msg.to()),
        cc: addresses(msg.cc()),
        bcc: addresses(msg.bcc()),
        reply_to: addresses(msg.reply_to()).into_iter().next().map(|a| a.email),
        subject: msg.subject().unwrap_or("").to_string(),
        sent_at: msg.date().map(|d| d.to_timestamp() * 1000).or(opts.received_at).unwrap_or_else(now_ms),
        snippet: None,
        body_text: msg.body_text(0).map(Cow::into_owned).unwrap_or_default(),
        body_html,
        unread: opts.unread,
        starred: opts.starred,
        folders: opts.folders,
        labels: opts.labels,
        list_unsubscribe: msg.header_raw("List-Unsubscribe").map(|s| s.trim().to_string()),
        bulk: Some(bulk),
        attachments,
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Attachment bytes by the "idx:N" handle `parse_raw` assigns.
pub fn extract_attachment(raw: &[u8], remote_id: &str) -> Option<Vec<u8>> {
    let index: usize = remote_id.strip_prefix("idx:")?.parse().ok()?;
    let msg = MessageParser::default().parse(raw)?;
    let found = msg.attachments().nth(index).map(|a| a.contents().to_vec());
    found
}

/// Remove the Bcc header from raw message bytes (including folded continuation lines) without touching
/// anything else: only the header block is inspected and the body is never decoded.
pub fn strip_bcc_header(raw: &[u8]) -> Cow<'_, [u8]> {
    let find = |needle: &[u8]| raw.windows(needle.len()).position(|w| w == needle);
    let head_end = match (find(b"\r\n\r\n"), find(b"\n\n")) {
        (Some(crlf), Some(lf)) if crlf < lf => crlf + 2,
        (Some(crlf), None) => crlf + 2,
        (_, Some(lf)) => lf + 1,
        (None, None) => raw.len(),
    };
    let (head, body) = raw.split_at(head_end);
    let mut out = Vec::with_capacity(raw.len());
    let mut dropping = false;
    let mut removed = false;
    for line in head.split_inclusive(|b| *b == b'\n') {
        let continuation = matches!(line.first(), Some(b' ' | b'\t'));
        if continuation && dropping {
            continue;
        }
        dropping = is_bcc_line(line);
        if dropping {
            removed = true;
            continue;
        }
        out.extend_from_slice(line);
    }
    if !removed {
        return Cow::Borrowed(raw);
    }
    out.extend_from_slice(body);
    Cow::Owned(out)
}

fn is_bcc_line(line: &[u8]) -> bool {
    if line.len() < 3 || !line[..3].eq_ignore_ascii_case(b"bcc") {
        return false;
    }
    let rest = &line[3..];
    let after_ws = rest.iter().position(|b| *b != b' ' && *b != b'\t').unwrap_or(rest.len());
    rest.get(after_ws) == Some(&b':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_a_bcc_header_and_nothing_else() {
        let raw = b"From: a@x\r\nBcc: h@x\r\nSubject: hi\r\n\r\nBcc: in body stays\r\n";
        assert_eq!(strip_bcc_header(raw).as_ref(), b"From: a@x\r\nSubject: hi\r\n\r\nBcc: in body stays\r\n");
    }

    #[test]
    fn removes_folded_continuation_lines() {
        let raw = b"From: a@x\r\nBcc: Hidden <h@x>,\r\n  second@x,\r\n\tthird@x\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(strip_bcc_header(raw).as_ref(), b"From: a@x\r\nSubject: hi\r\n\r\nbody");
    }

    #[test]
    fn handles_first_last_lowercase_and_lf_endings() {
        assert_eq!(strip_bcc_header(b"BCC: h@x\nFrom: a@x\n\nbody").as_ref(), b"From: a@x\n\nbody");
        assert_eq!(strip_bcc_header(b"From: a@x\nbcc : h@x\n\nbody").as_ref(), b"From: a@x\n\nbody");
        assert_eq!(strip_bcc_header(b"From: a@x\r\nBcc: h@x\r\n\r\n").as_ref(), b"From: a@x\r\n\r\n");
    }

    #[test]
    fn ignores_similar_names_and_borrows_when_nothing_to_strip() {
        let raw = b"From: a@x\r\nBccx: no\r\nX-Bcc: no\r\n\r\nbody";
        assert!(matches!(strip_bcc_header(raw), Cow::Borrowed(_)));
    }

    #[test]
    fn keeps_8bit_bytes_untouched_and_copes_with_header_only_messages() {
        let raw = b"Bcc: h@x\r\nSubject: caf\xe9\r\n\r\n\xff\xfe body";
        assert_eq!(strip_bcc_header(raw).as_ref(), b"Subject: caf\xe9\r\n\r\n\xff\xfe body");
        assert_eq!(strip_bcc_header(b"Bcc: h@x\r\nFrom: a@x").as_ref(), b"From: a@x");
    }

    #[test]
    fn parses_ids_with_brackets_addresses_and_flags() {
        let raw = b"Message-ID: <m5@example.com>\r\nIn-Reply-To: <p@example.com>\r\nReferences: <a@x> <b@x>\r\nFrom: Alice <Alice@Example.com>\r\nTo: me@example.com\r\nSubject: Subject m5\r\nDate: Thu, 01 Oct 2026 10:00:00 +0000\r\nList-Id: <l.example.com>\r\n\r\nBody of m5\r\n";
        let m = parse_raw(
            raw,
            ParseOptions { remote_id: "INBOX:1:6".into(), remote_thread_id: None, folders: Folders::default(), unread: true, starred: false, labels: None, self_email: "me@example.com", received_at: None },
        )
        .unwrap();
        assert_eq!(m.message_id_header.as_deref(), Some("<m5@example.com>"));
        assert_eq!(m.in_reply_to.as_deref(), Some("<p@example.com>"));
        assert_eq!(m.references.as_deref(), Some(&["<a@x>".to_string(), "<b@x>".to_string()][..]));
        assert_eq!(m.from, Address { name: "Alice".into(), email: "alice@example.com".into() });
        assert_eq!(m.body_text.trim(), "Body of m5");
        assert_eq!(m.body_html, None);
        assert_eq!(m.bulk, Some(true));
        assert_eq!(m.outgoing, Some(false));
        assert_eq!(m.sent_at, 1_790_848_800_000);
    }
}
