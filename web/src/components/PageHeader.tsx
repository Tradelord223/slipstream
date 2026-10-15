import { useViewport } from "../lib/hooks.ts";
import { useReview } from "../store/agents.ts";
import { toggleRail, ui, useUi } from "../store/ui.ts";
import { AssistantButton } from "./AssistantButton.tsx";
import { Icon } from "./Icon.tsx";

/** Opens the rail on phones and tablets; brings it back on desktop when it's hidden. Carries the amber dot when a request is waiting unseen. */
export function MenuButton() {
  const viewport = useViewport();
  const railOpen = useUi((s) => s.railOpen);
  const unseen = useReview((s) => s.unseen);
  if (viewport === "desktop") {
    return railOpen ? null : (
      <button className="icon-btn" aria-label="Show sidebar" onClick={toggleRail}>
        <Icon name="sidebar" />
      </button>
    );
  }
  return (
    <button className="icon-btn tap menu-btn" aria-label={unseen ? "Open menu, a request is waiting in Review" : "Open menu"} onClick={() => ui.set({ sheetOpen: true })}>
      <Icon name="menu" size={18} />
      {unseen && <span className="notice-dot" aria-hidden="true" />}
    </button>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="mail-header">
      <MenuButton />
      <h1 className="view-title">{title}</h1>
      <span className="grow" />
      {children}
      <AssistantButton />
    </header>
  );
}
