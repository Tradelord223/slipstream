//! Modified UTF-7 (RFC 3501 section 5.1.3) for mailbox names, so "Gelöschte Elemente" is the same path
//! here as in imapflow (which decodes) while the wire carries "Gel&APY-schte Elemente".

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    let mut pending: Vec<u16> = Vec::new();
    let flush = |pending: &mut Vec<u16>, out: &mut String| {
        if pending.is_empty() {
            return;
        }
        let bytes: Vec<u8> = pending.iter().flat_map(|u| u.to_be_bytes()).collect();
        out.push('&');
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
            let chars = match chunk.len() {
                1 => 2,
                2 => 3,
                _ => 4,
            };
            for i in 0..chars {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out.push('-');
        pending.clear();
    };
    for ch in s.chars() {
        if ch == '&' {
            flush(&mut pending, &mut out);
            out.push_str("&-");
        } else if (' '..='~').contains(&ch) {
            flush(&mut pending, &mut out);
            out.push(ch);
        } else {
            let mut buf = [0u16; 2];
            pending.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    flush(&mut pending, &mut out);
    out
}

/// Decode; anything malformed is returned untouched, since a server's own name for a mailbox must stay usable.
pub fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let Some(end) = after.find('-') else { return s.to_string() };
        let run = &after[..end];
        if run.is_empty() {
            out.push('&');
        } else {
            let mut bits: u32 = 0;
            let mut nbits = 0;
            let mut bytes = Vec::new();
            for c in run.bytes() {
                let Some(v) = B64.iter().position(|b| *b == c) else { return s.to_string() };
                bits = (bits << 6) | v as u32;
                nbits += 6;
                if nbits >= 8 {
                    nbits -= 8;
                    bytes.push((bits >> nbits) as u8);
                    bits &= (1 << nbits) - 1;
                }
            }
            let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            match String::from_utf16(&units) {
                Ok(t) => out.push_str(&t),
                Err(_) => return s.to_string(),
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_rfc_examples() {
        for (plain, wire) in [("~peter/mail/台北/日本語", "~peter/mail/&U,BTFw-/&ZeVnLIqe-"), ("Gelöschte Elemente", "Gel&APY-schte Elemente"), ("R&D", "R&-D"), ("INBOX", "INBOX"), ("😀", "&2D3eAA-")] {
            assert_eq!(encode(plain), wire, "{plain}");
            assert_eq!(decode(wire), plain, "{wire}");
        }
        assert_eq!(decode("bad&!!-"), "bad&!!-");
        assert_eq!(decode("no terminator&abc"), "no terminator&abc");
    }
}
