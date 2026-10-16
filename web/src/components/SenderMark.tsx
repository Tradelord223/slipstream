import { useState, type ReactNode } from "react";
import { Avatar } from "./Avatar.tsx";

/** How long a missing logo is left alone before one more try; a transient error shouldn't hide a mark until reload. */
const MISS_MS = 10 * 60 * 1000;
/** Domains whose logo came back missing, and when. */
const missed = new Map<string, number>();

function isMissed(domain: string): boolean {
  const at = missed.get(domain);
  if (at === undefined) return false;
  if (Date.now() - at < MISS_MS) return true;
  missed.delete(domain);
  return false;
}

/** A company's mark as a small rounded square; `fallback` shows when the logo isn't there. */
function SenderMark({ domain, size, fallback = null }: { domain: string; size: number; fallback?: ReactNode }) {
  const [, rerender] = useState(0);
  if (isMissed(domain)) return <>{fallback}</>;
  return (
    <img
      className="mark"
      src={`/api/logos/${encodeURIComponent(domain)}`}
      alt=""
      width={size}
      height={size}
      style={{ borderRadius: Math.round(size * 0.24) }}
      decoding="async"
      draggable={false}
      onError={() => {
        missed.set(domain, Date.now());
        rerender((n) => n + 1);
      }}
    />
  );
}

/** The mark at the start of a list row's sender column. Only company senders with a logo get one; people's rows stay flush. */
export function RowMark({ domain }: { domain: string | null }) {
  return domain ? <SenderMark domain={domain} size={18} /> : null;
}

/** The sender's avatar in a conversation: their company's mark when there is one, initials otherwise. */
export function SenderAvatar({ name, email, size, domain }: { name: string; email: string; size: number; domain: string | null }) {
  const initials = <Avatar name={name} email={email} size={size} />;
  return domain ? <SenderMark domain={domain} size={size} fallback={initials} /> : initials;
}
