//! The per-mailbox sync cursor. The JSON is the same shape `server/src/providers/imap.ts` persists
//! (`{v:1, step, boxes:{<path>:{uidValidity, lastUid, highestModseq?, window?, initial?}}}`), so an
//! account synced by the TypeScript provider carries on from its stored cursor.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Messages re-read per change check (the newest N).
pub const WINDOW: u32 = 500;
/// New messages handed over per page.
pub const BATCH: usize = 50;
pub const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Initial {
    /// Epoch milliseconds: the first sync reaches back to here.
    pub since: i64,
    pub ceiling: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxState {
    /// A u32 as a string: JSON consumers can't be trusted with 64-bit numbers.
    pub uid_validity: String,
    /// Everything up to here has been handed to the store.
    pub last_uid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highest_modseq: Option<String>,
    /// UIDs of the newest messages at the last change check, as "1:5,7".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// Set while the first sync of this mailbox is still working through its backlog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<Initial>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub v: u8,
    /// Where in the current round we are: first one change check per mailbox, then one new-mail pass per mailbox.
    pub step: usize,
    pub boxes: BTreeMap<String, BoxState>,
}

impl Default for Cursor {
    fn default() -> Self {
        Cursor { v: 1, step: 0, boxes: BTreeMap::new() }
    }
}

impl Cursor {
    /// Tolerant like the TypeScript `parseCursor`: garbage gives a fresh cursor, one bad box is dropped alone.
    pub fn parse(raw: Option<&str>) -> Cursor {
        let Some(raw) = raw else { return Cursor::default() };
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(raw) else { return Cursor::default() };
        if o.get("v").and_then(Value::as_u64) != Some(1) {
            return Cursor::default();
        }
        let Some(Value::Object(boxes)) = o.get("boxes") else { return Cursor::default() };
        let mut out = Cursor::default();
        for (path, b) in boxes {
            if let Ok(state) = serde_json::from_value::<BoxState>(b.clone()) {
                out.boxes.insert(path.clone(), state);
            }
        }
        out.step = o.get("step").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(0);
        out
    }

    pub fn serialize(&self) -> String {
        serde_json::to_string(self).expect("cursor serializes")
    }
}

/// Record that a batch of new mail was handed over. `remaining` is how many UIDs are still queued behind it.
pub fn finish_batch(st: &mut BoxState, last_in_batch: Option<u32>, remaining: usize) {
    if remaining > 0 {
        st.last_uid = last_in_batch.unwrap_or(st.last_uid);
        return;
    }
    // Nothing left: the first sync is complete up to the UIDNEXT it started from, later ones up to the newest UID seen.
    let ceiling = st.initial.as_ref().and_then(|i| i.ceiling).unwrap_or(0);
    st.last_uid = st.last_uid.max(last_in_batch.unwrap_or(0)).max(ceiling);
    st.initial = None;
}

/// "1:5,7,9:12" for a sorted list of UIDs.
pub fn compress_uids(uids: &[u32]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < uids.len() {
        let mut j = i;
        while j + 1 < uids.len() && uids[j + 1] == uids[j] + 1 {
            j += 1;
        }
        out.push(if j > i { format!("{}:{}", uids[i], uids[j]) } else { uids[i].to_string() });
        i = j + 1;
    }
    out.join(",")
}

pub fn expand_uids(set: Option<&str>) -> Vec<u32> {
    let mut out = Vec::new();
    for part in set.map(|s| s.split(',')).into_iter().flatten() {
        let mut it = part.split(':');
        let Some(Ok(a)) = it.next().map(str::parse::<u32>) else { continue };
        let b = it.next().and_then(|b| b.parse::<u32>().ok()).unwrap_or(a);
        out.extend(a..=b);
    }
    out
}

/// Compare the newest messages now against the previous check. A UID we saw before that falls inside today's
/// window but is missing from it was expunged (or marked \Deleted). When the window is only the tail of a larger
/// mailbox, older UIDs merely left it, which proves nothing; when it is the whole mailbox, they're gone.
pub fn find_expunged(previous: &[u32], current: &[(u32, bool)], whole_mailbox: bool) -> Vec<u32> {
    let alive: HashSet<u32> = current.iter().filter(|(_, deleted)| !deleted).map(|(u, _)| *u).collect();
    let low = if whole_mailbox { 0 } else { current.first().map(|(u, _)| *u).unwrap_or(0) };
    previous.iter().copied().filter(|u| *u >= low && !alive.contains(u)).collect()
}

/// `<mailbox>:<uidvalidity>:<uid>`
pub fn remote_id_for(path: &str, validity: &str, uid: u32) -> String {
    format!("{path}:{validity}:{uid}")
}

pub fn parse_remote_id(id: &str) -> Option<(String, String, u32)> {
    let (rest, uid) = id.rsplit_once(':')?;
    let (path, validity) = rest.rsplit_once(':')?;
    if uid.is_empty() || validity.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) || !validity.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((path.to_string(), validity.to_string(), uid.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_survives_garbage() {
        assert_eq!(Cursor::parse(None), Cursor::default());
        assert_eq!(Cursor::parse(Some("not json")), Cursor::default());
        assert_eq!(Cursor::parse(Some(r#"{"v":2,"boxes":{}}"#)), Cursor::default());
        let mut c = Cursor::default();
        c.boxes.insert(
            "INBOX".into(),
            BoxState { uid_validity: "1".into(), last_uid: 5, highest_modseq: Some("9".into()), window: Some("1:5".into()), initial: None },
        );
        c.step = 3;
        assert_eq!(Cursor::parse(Some(&c.serialize())), c);
        // One bad box is dropped alone.
        let mixed = Cursor::parse(Some(r#"{"v":1,"step":1,"boxes":{"A":{"uidValidity":"1","lastUid":2},"B":{"uidValidity":1}}}"#));
        assert_eq!(mixed.boxes.keys().collect::<Vec<_>>(), ["A"]);
        assert_eq!(mixed.step, 1);
    }

    /// A cursor string exactly as the TypeScript provider writes it (JSON.stringify of its Cursor object).
    #[test]
    fn reads_a_cursor_written_by_the_typescript_provider() {
        let ts = r#"{"v":1,"step":4,"boxes":{"INBOX":{"uidValidity":"1700000000","lastUid":121,"highestModseq":"4521","window":"1:121"},"[Gmail]/All Mail":{"uidValidity":"7","lastUid":0,"initial":{"since":1760000000000,"ceiling":null}}}}"#;
        let c = Cursor::parse(Some(ts));
        assert_eq!(c.step, 4);
        let inbox = &c.boxes["INBOX"];
        assert_eq!((inbox.uid_validity.as_str(), inbox.last_uid, inbox.highest_modseq.as_deref(), inbox.window.as_deref()), ("1700000000", 121, Some("4521"), Some("1:121")));
        let all = &c.boxes["[Gmail]/All Mail"];
        assert_eq!(all.initial, Some(Initial { since: 1_760_000_000_000, ceiling: None }));
        // And what Rust writes parses back to the same structure through a generic JSON reader (what TS does).
        let v: Value = serde_json::from_str(&c.serialize()).unwrap();
        assert_eq!(v["boxes"]["INBOX"]["lastUid"], 121);
        assert_eq!(v["boxes"]["[Gmail]/All Mail"]["initial"]["ceiling"], Value::Null);
        assert!(v["boxes"]["INBOX"].get("initial").is_none());
    }

    #[test]
    fn advances_batch_by_batch_and_closes_the_first_sync_at_its_ceiling() {
        let mut st = BoxState { uid_validity: "1".into(), last_uid: 0, highest_modseq: None, window: None, initial: Some(Initial { since: 0, ceiling: Some(120) }) };
        finish_batch(&mut st, Some(50), 70);
        assert_eq!((st.last_uid, st.initial.is_some()), (50, true));
        finish_batch(&mut st, Some(90), 0);
        assert_eq!((st.last_uid, st.initial.is_some()), (120, false));
        finish_batch(&mut st, Some(130), 0);
        assert_eq!(st.last_uid, 130);
    }

    #[test]
    fn compresses_uid_windows() {
        assert_eq!(compress_uids(&[1, 2, 3, 5, 7, 8]), "1:3,5,7:8");
        assert_eq!(expand_uids(Some("1:3,5,7:8")), vec![1, 2, 3, 5, 7, 8]);
        assert!(expand_uids(None).is_empty());
    }

    #[test]
    fn finds_expunges_only_inside_the_current_window() {
        let current = [(10, false), (11, false), (12, true)];
        assert_eq!(find_expunged(&[5, 10, 11, 12], &current, false), vec![12]);
        assert_eq!(find_expunged(&[5, 10, 11, 12], &current, true), vec![5, 12]);
    }

    #[test]
    fn remote_ids_round_trip_even_with_colons_in_the_path() {
        let id = remote_id_for("A:B/C", "42", 7);
        assert_eq!(parse_remote_id(&id), Some(("A:B/C".into(), "42".into(), 7)));
        assert_eq!(parse_remote_id("Stale"), None);
    }
}
