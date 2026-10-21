import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal surface: role=dialog, aria-modal, focus trapped inside, focus returned on close.
 * The scrim click and Escape both close it.
 */
export function Dialog({
  label,
  onClose,
  children,
  className = "",
  placement = "center",
  initialFocus,
  lockScrim = false,
  trapKeys = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: "center" | "top";
  /** Selector for the element that gets focus first; defaults to the first focusable. */
  initialFocus?: string;
  /** A click outside doesn't close it (Escape still does), for steps that can't be redone. */
  lockScrim?: boolean;
  /** The dialog handles its own keys: single-key shortcuts (E, #, J...) don't reach the mailbox underneath. */
  trapKeys?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const target = (initialFocus && node?.querySelector<HTMLElement>(initialFocus)) || node?.querySelector<HTMLElement>(FOCUSABLE) || node;
    target?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`scrim ${placement === "top" ? "scrim-top" : ""}`} onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // A locked dialog ignores the click but keeps focus inside, so Escape still reaches it.
        if (lockScrim) e.preventDefault();
        else onClose();
      }}>
      <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} data-trap-keys={trapKeys || undefined}>
        <h2 id={titleId} className="sr-only">
          {label}
        </h2>
        {children}
      </div>
    </div>
  );
}
