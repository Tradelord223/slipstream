import { keycaps } from "../keys/keys.ts";

/** Keycaps for one binding, e.g. <Keys binding="mod+shift+k" /> or <Keys binding="g i" />. */
export function Keys({ binding, className }: { binding: string; className?: string }) {
  const caps = keycaps(binding);
  return (
    <span className={`keys ${className ?? ""}`} aria-label={caps.join(" ")}>
      {caps.map((k, i) => (
        <kbd className="keycap" key={i} aria-hidden="true">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function Keycap({ children }: { children: string }) {
  return <kbd className="keycap">{children}</kbd>;
}
