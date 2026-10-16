import { useEffect, useRef, useState } from "react";
import type { SyncProgress } from "../types.ts";

/**
 * The time left in a sync stage is an estimate from the measured speed, so it is built never to contradict itself:
 * it only ever goes down, it counts down on its own between events, and below a second it says "Almost there" and
 * stays there until the stage ends. Nothing is shown until the stage has both a measured rate and a known total.
 */

/** How quickly a new reading takes over from the running estimate (milliseconds). Longer is steadier. */
const SETTLE_MS = 1500;

export class EtaTracker {
  private stage: SyncProgress["stage"] | null = null;
  private highest = 0;
  /** Remaining milliseconds as of `at`. */
  private left: number | null = null;
  private at = 0;
  private latched = false;

  /** Take a reading. Stale or rate-less readings are ignored; a new stage starts over. */
  feed(p: SyncProgress | null | undefined, now: number): void {
    if (!p) return;
    if (p.stage !== this.stage) {
      this.stage = p.stage;
      this.highest = 0;
      this.left = null;
      this.latched = false;
    }
    if (p.done < this.highest) return;
    this.highest = p.done;
    if (p.total === null || !p.rate || p.rate <= 0 || p.stage === "signin" || p.stage === "done") return;
    const reading = (Math.max(0, p.total - p.done) / p.rate) * 1000;
    if (this.left === null) {
      this.left = reading;
    } else {
      const carried = Math.max(0, this.left - (now - this.at));
      const weight = 1 - Math.exp(-Math.max(0, now - this.at) / SETTLE_MS);
      // Never later than what was already promised, however the speed moves.
      this.left = Math.min(carried, carried + (reading - carried) * weight);
    }
    this.at = now;
  }

  /** Whole seconds left, 0 for "almost there", or null when there is nothing honest to say yet. */
  seconds(now: number): number | null {
    if (this.left === null) return null;
    if (this.latched) return 0;
    const ms = Math.max(0, this.left - (now - this.at));
    if (ms < 1000) {
      this.latched = true;
      return 0;
    }
    return Math.round(ms / 1000);
  }
}

/** Highest value seen for a key, so a late answer carrying older numbers can't move a count backwards. */
export function useNoBackwards(key: string, value: number): number {
  const kept = useRef({ key, value });
  if (kept.current.key !== key) kept.current = { key, value };
  else if (value > kept.current.value) kept.current.value = value;
  return kept.current.value;
}

/**
 * The line under a progress list: "About 3 seconds left", "Almost there", or null. `scope` (the account) and the
 * stage start a fresh estimate. Ticks once a second at most while there is one to show.
 */
export function useEta(scope: string, progress: SyncProgress | null | undefined): string | null {
  const tracker = useRef<{ scope: string; t: EtaTracker }>({ scope, t: new EtaTracker() });
  if (tracker.current.scope !== scope) tracker.current = { scope, t: new EtaTracker() };
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    tracker.current.t.feed(progress, Date.now());
    setSeconds(tracker.current.t.seconds(Date.now()));
  }, [scope, progress?.stage, progress?.done, progress?.total, progress?.rate]);

  const active = seconds !== null && seconds > 0;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setSeconds(tracker.current.t.seconds(Date.now())), 250);
    return () => clearInterval(id);
  }, [active, scope]);

  // A new stage must not show the old stage's estimate for even one frame.
  if (!progress || progress.stage === "done" || progress.stage === "signin") return null;
  return etaText(seconds);
}

export function etaText(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 1) return "Almost there";
  return seconds === 1 ? "About 1 second left" : `About ${seconds} seconds left`;
}

/**
 * What the rest of the sync is doing, in plain words, for the rail and Settings. Null when the mailbox isn't in a stage
 * worth mentioning (or isn't syncing: an old stage is left on the account after the run ends).
 */
export function syncDetail(a: { syncStatus: string; progress?: SyncProgress | null }): string | null {
  const p = a.progress;
  if (a.syncStatus !== "syncing" || !p) return null;
  switch (p.stage) {
    case "history": {
      if (p.total !== null) return `Getting older mail · ${p.done.toLocaleString("en-US")} of ${p.total.toLocaleString("en-US")}`;
      return p.done > 0 ? `Getting older mail · ${p.done.toLocaleString("en-US")}` : "Getting older mail";
    }
    case "previews":
      return "Adding previews";
    case "recent":
      return "Downloading recent messages";
    default:
      return null;
  }
}
