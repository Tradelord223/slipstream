import * as chrono from "chrono-node";

/** Natural-language times for Remind Me and Send Later, in the browser's timezone. */

export interface Preset {
  id: string;
  label: string;
  at: Date;
}

const startOfDay = (d: Date) => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};

const atHour = (d: Date, hour: number) => {
  const c = new Date(d);
  c.setHours(hour, 0, 0, 0);
  return c;
};

const addDays = (d: Date, n: number) => {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
};

/** Parse "tomorrow 9am", "fri", "in 3 days", "next week". Date-only results land on the default hour. */
export function parseWhen(text: string, defaultHour: number, now = new Date()): Date | null {
  const input = text.trim();
  if (!input) return null;
  const hit = chrono.parse(input, { instant: now, timezone: undefined }, { forwardDate: true })[0];
  if (!hit) return null;
  const date = hit.start.date();
  if (!hit.start.isCertain("hour")) date.setHours(defaultHour, 0, 0, 0);
  // "9am" typed at 3pm means tomorrow; chrono's forwardDate handles dates, so only guard stray past results.
  if (date.getTime() <= now.getTime()) {
    if (hit.start.isCertain("day") || hit.start.isCertain("weekday")) return null;
    date.setDate(date.getDate() + 1);
  }
  return date;
}

export function presets(defaultHour: number, now = new Date()): Preset[] {
  const out: Preset[] = [];
  // Later today: three hours out, rounded up to the hour, and still today.
  const later = new Date(now.getTime() + 3 * 3_600_000);
  if (later.getMinutes() > 0 || later.getSeconds() > 0) later.setHours(later.getHours() + 1);
  later.setMinutes(0, 0, 0);
  if (later.getDate() === now.getDate()) out.push({ id: "later", label: "Later today", at: later });

  out.push({ id: "tomorrow", label: "Tomorrow", at: atHour(addDays(now, 1), defaultHour) });

  const toSat = ((6 - now.getDay() + 7) % 7) || 7;
  out.push({ id: "weekend", label: "This weekend", at: atHour(addDays(now, toSat), defaultHour) });

  const toMon = ((1 - now.getDay() + 7) % 7) || 7;
  out.push({ id: "week", label: "Next week", at: atHour(addDays(now, toMon), defaultHour) });

  const month = new Date(now);
  month.setMonth(month.getMonth() + 1);
  out.push({ id: "month", label: "In a month", at: atHour(month, defaultHour) });
  return out;
}

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Tomorrow 8:00 AM", "Fri 8:00 AM", "Nov 14, 8:00 AM". */
export function formatWhen(d: Date, now = new Date()): string {
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const t = time.format(d);
  if (days === 0) return `Today ${t}`;
  if (days === 1) return `Tomorrow ${t}`;
  if (days > 1 && days < 7) return `${weekday.format(d)} ${t}`;
  const day = d.getFullYear() === now.getFullYear() ? monthDay.format(d) : monthDayYear.format(d);
  return `${day}, ${t}`;
}

/** A compact label for a reminder due time in a list. */
export function formatDue(ms: number, now = new Date()): string {
  return formatWhen(new Date(ms), now);
}
