import type { Routine, RoutineInput, RoutineTrigger } from "../types.ts";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** "08:00" -> "8:00 AM". */
export function clock(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function daysPhrase(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(",");
  if (key === EVERY_DAY.join(",")) return "Every day";
  if (key === WEEKDAYS.join(",")) return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (set.length === 1) return DAY_PLURAL[set[0]!]!;
  return set.map((d) => DAY_SHORT[d]).join(", ");
}

/** "Weekdays at 8:00 AM" / "When mail matches from:@fernpoint.co". */
export function triggerSummary(t: RoutineTrigger): string {
  if (t.type === "mail") return `When mail matches ${t.query}`;
  const zone = t.timezone !== browserZone() ? ` (${t.timezone.replace(/_/g, " ")})` : "";
  return `${daysPhrase(t.days)} at ${clock(t.time)}${zone}`;
}

const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** "Today 8:00 AM", "Tomorrow 8:00 AM", "Mon 8:00 AM". */
export function nextRunPhrase(r: Routine, now = Date.now()): string {
  if (!r.enabled) return "Paused";
  if (r.trigger.type === "mail" || !r.nextRunAt) return "Watching your inbox";
  const at = new Date(r.nextRunAt);
  const t = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  if (at.toDateString() === today.toDateString()) return `Next: today ${t}`;
  if (at.toDateString() === tomorrow.toDateString()) return `Next: tomorrow ${t}`;
  return `Next: ${dayFmt.format(at)} ${t}`;
}

export function timeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const own = browserZone();
  // Some browsers report a zone (such as UTC) that the list leaves out.
  return zones.includes(own) ? zones : [own, ...zones];
}

export interface Starter {
  id: string;
  name: string;
  blurb: string;
  input: RoutineInput;
}

export const STARTERS: Starter[] = [
  {
    id: "morning",
    name: "Morning sweep",
    blurb: "Weekdays at 8:00 AM. Clears newsletters, flags what needs you, drafts replies.",
    input: {
      name: "Morning sweep",
      instruction:
        "Triage the inbox: mark newsletters and notifications done, remind me about anything I need to act on later this week, and draft replies to people waiting on me.",
      trigger: { type: "schedule", days: WEEKDAYS, time: "08:00", timezone: browserZone() },
      enabled: true,
    },
  },
  {
    id: "clients",
    name: "Client replies",
    blurb: "When new mail from a client arrives, draft a reply.",
    input: {
      name: "Client replies",
      instruction: "Draft a reply to each new client message. Keep it short and plain, and leave placeholders for anything you don't know.",
      trigger: { type: "mail", query: "" },
      enabled: true,
    },
  },
  {
    id: "friday",
    name: "Friday clean-up",
    blurb: "Fridays at 4:00 PM. Gets the inbox to zero and lists what's left.",
    input: {
      name: "Friday clean-up",
      instruction: "Get the inbox to zero: mark done anything older than a week that doesn't need me, then list what's left.",
      trigger: { type: "schedule", days: [5], time: "16:00", timezone: browserZone() },
      enabled: true,
    },
  },
];
