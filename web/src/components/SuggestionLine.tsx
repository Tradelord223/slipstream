import { useEffect, useState } from "react";
import { plural } from "../lib/format.ts";
import { useSession } from "../store/session.ts";
import { acceptSuggestion, dismissSuggestion, refreshSuggestions, useSuggestions } from "../store/suggestions.ts";
import { Icon } from "./Icon.tsx";

/** One quiet offer at the end of the tab strip: "Split out GitHub? 23 conversations · Add · ✕". Nothing shows while there is none. */
export function SuggestionLine({ placement }: { placement: "tabs" | "bar" }) {
  const current = useSuggestions((s) => s.current);
  const tabCount = useSession((s) => s.splits.length);
  const [busy, setBusy] = useState(false);

  // Look again when the tabs change (a split was added or removed), and when the strip first appears.
  useEffect(() => {
    void refreshSuggestions();
  }, [tabCount]);

  if (!current) return null;
  const add = async () => {
    setBusy(true);
    const ok = await acceptSuggestion(current);
    setBusy(false);
    if (ok) void refreshSuggestions(true);
  };
  return (
    <div className={`suggest-line suggest-${placement}`} role="group" aria-label="Suggested split">
      <span className="suggest-text">
        <span className="ellipsis">
          Split out <strong>{current.name}</strong>?
        </span>
        <span className="suggest-count num">{plural(current.count, "conversation")}</span>
      </span>
      <button className="suggest-add" disabled={busy} onClick={() => void add()} aria-label={`Add ${current.name} as a split`}>
        Add
      </button>
      <button className="icon-btn suggest-x" disabled={busy} aria-label={`Don't suggest ${current.name}`} title="Not now" onClick={() => void dismissSuggestion(current)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
