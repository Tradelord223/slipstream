import { categoryName } from "../lib/sorting.ts";
import { openMoveMenu } from "../store/sorting.ts";
import type { Sorting } from "../types.ts";
import { Icon } from "./Icon.tsx";

/** "Promotions · It has an unsubscribe link". Provider sentences already name the tab ("Gmail filed it under Promotions"), so they stand alone. */
function chipText(s: Sorting): string | null {
  if (!s.reasonText) return null;
  const name = categoryName(s.category);
  return s.reasonText.toLowerCase().includes(name.toLowerCase()) ? s.reasonText : `${name} · ${s.reasonText}`;
}

/** Where this conversation was sorted and why; opens the menu that moves its sender's mail. */
export function WhyChip({ threadId, sorting }: { threadId: string; sorting: Sorting }) {
  const text = chipText(sorting);
  if (!text) return null;
  return (
    <button
      className="why-chip"
      aria-haspopup="dialog"
      aria-label={`Sorted into ${categoryName(sorting.category)}. ${sorting.reasonText}. Move this mail to another tab`}
      title="Move this mail to another tab (Shift+I)"
      onClick={() => openMoveMenu(threadId)}
    >
      <span className="why-chip-text ellipsis">{text}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  );
}
