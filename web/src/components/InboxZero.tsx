import { useMemo } from "react";
import { plural } from "../lib/format.ts";
import { useCounts } from "../store/counts.ts";

function seedFromDate(d = new Date()): number {
  const s = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Soft layered horizon bands, hued by today's date. Static; fades in once. */
function Horizon() {
  const { hue, bands, sun } = useMemo(() => {
    const seed = seedFromDate();
    let state = seed;
    const rnd = () => {
      state = Math.imul(state ^ (state >>> 15), 2246822507) >>> 0;
      state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
      return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
    };
    const w = 800;
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const base = 150 + i * 34;
      const amp = 10 + rnd() * 20;
      const f1 = 0.8 + rnd() * 1.4;
      const f2 = 1.6 + rnd() * 2;
      const p1 = rnd() * Math.PI * 2;
      const p2 = rnd() * Math.PI * 2;
      let d = `M0 ${base}`;
      for (let x = 0; x <= w; x += 20) {
        const t = x / w;
        const y = base + Math.sin(t * Math.PI * f1 + p1) * amp + Math.sin(t * Math.PI * f2 + p2) * amp * 0.35;
        d += ` L${x} ${y.toFixed(1)}`;
      }
      out.push(`${d} L${w} 360 L0 360 Z`);
    }
    return { hue: 150 + (seed % 130), bands: out, sun: { x: 180 + rnd() * 440, y: 118 + rnd() * 30 } };
  }, []);

  return (
    <svg className="zero-art" viewBox="0 0 800 360" preserveAspectRatio="xMidYMax slice" aria-hidden="true" style={{ ["--h" as string]: hue }}>
      <circle className="zero-sun" cx={sun.x} cy={sun.y} r="46" />
      {bands.map((d, i) => (
        <path key={i} d={d} className="zero-band" style={{ ["--i" as string]: i }} />
      ))}
    </svg>
  );
}

export function InboxZero({ title = "Inbox zero" }: { title?: string }) {
  const counts = useCounts();
  const done = counts?.doneToday ?? 0;
  return (
    <div className="zero" role="status">
      <Horizon />
      <div className="zero-copy">
        <h2>{title}</h2>
        <p>{done > 0 ? `You cleared ${plural(done, "conversation")} today.` : "Nothing is waiting on you."}</p>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty" role="status">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}
