import { toggleAssistant, useAssistant } from "../store/assistant.ts";
import { Icon } from "./Icon.tsx";

/** The quiet "Claude" button at the right end of a header; the sidebar opens beside whatever is on screen. */
export function AssistantButton() {
  const open = useAssistant((s) => s.open);
  return (
    <button className="claude-btn" aria-pressed={open} aria-label={open ? "Close Claude" : "Ask Claude"} title="Claude (⌘.)" onClick={toggleAssistant}>
      <Icon name="sparkle" size={15} />
      <span className="claude-btn-label">Claude</span>
    </button>
  );
}
