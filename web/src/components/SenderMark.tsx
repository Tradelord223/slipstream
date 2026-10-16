import { useState, type ReactNode } from "react";
import { Avatar } from "./Avatar.tsx";

/** Domains whose logo came back missing. Kept for the session so a miss never asks again. */
const missed = new Set<string>();

/** A company's mark as a small rounded square; `fallback` shows when the logo isn't there. */
function SenderMark({ domain, size, fallback = null }: { domain: string; size: number; fallback?: ReactNode }) {
  const [, rerender] = useState(0);
  if (missed.has(domain)) return <>{fallback}</>;
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
        missed.add(domain);
        rerender((n) => n + 1);
      }}
    />
  );
}

/** The mark at the start of a list row's sender column. Keeps its slot when logos are on, so names stay aligned. */
export function RowMark({ domain }: { domain: string | null }) {
  return <span className="mark-slot">{domain && <SenderMark domain={domain} size={18} />}</span>;
}

/** The sender's avatar in a conversation: their company's mark when there is one, initials otherwise. */
export function SenderAvatar({ name, email, size, domain }: { name: string; email: string; size: number; domain: string | null }) {
  const initials = <Avatar name={name} email={email} size={size} />;
  return domain ? <SenderMark domain={domain} size={size} fallback={initials} /> : initials;
}
