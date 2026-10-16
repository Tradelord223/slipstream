import { toggleAssistant, useAssistant } from "../store/assistant.ts";
import { useAssistantName } from "../store/engines.ts";
import { useAssistantOn } from "../store/session.ts";
import { Icon } from "./Icon.tsx";

/** The quiet assistant button at the right end of a header; the sidebar opens beside whatever is on screen. */
export function AssistantButton({ compact = false }: { compact?: boolean }) {
  const open = useAssistant((s) => s.open);
  const name = useAssistantName();
  if (!useAssistantOn()) return null;
  return (
    <button className={`claude-btn ${compact ? "compact" : ""}`} aria-pressed={open} aria-label={open ? `Close ${name}` : `Ask ${name}`} title={`${name} (⌘.)`} onClick={toggleAssistant}>
      <Icon name="sparkle" size={15} />
      <span className="claude-btn-label">{name}</span>
    </button>
  );
}
