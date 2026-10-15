import { Icon } from "../components/Icon.tsx";
import { Link } from "../components/Link.tsx";
import { useViewport } from "../lib/hooks.ts";
import { useSession } from "../store/session.ts";
import { ui } from "../store/ui.ts";
import { AccountsSettings } from "./settings/AccountsSettings.tsx";
import { AiSettings } from "./settings/AiSettings.tsx";
import { GeneralSettings } from "./settings/GeneralSettings.tsx";
import { ShortcutsSettings } from "./settings/ShortcutsSettings.tsx";
import { SnippetsSettings } from "./settings/SnippetsSettings.tsx";
import { SplitsSettings } from "./settings/SplitsSettings.tsx";
import { TeamSettings } from "./settings/TeamSettings.tsx";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "splits", label: "Splits" },
  { id: "snippets", label: "Snippets" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "team", label: "Team" },
  { id: "ai", label: "AI" },
] as const;

export function SettingsView({ section }: { section: string }) {
  const viewport = useViewport();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const mode = useSession((s) => s.mode);
  void mode;
  return (
    <section className="settings" aria-label="Settings">
      <header className="mail-header">
        {viewport !== "desktop" && (
          <button className="icon-btn tap" aria-label="Open menu" onClick={() => ui.set({ sheetOpen: true })}>
            <Icon name="menu" size={18} />
          </button>
        )}
        <h1 className="view-title">Settings</h1>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <Link key={s.id} to={`/settings/${s.id}`} className="settings-link" aria-current={s.id === current.id ? "page" : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          <h2 className="settings-title">{current.label}</h2>
          {current.id === "general" && <GeneralSettings />}
          {current.id === "accounts" && <AccountsSettings />}
          {current.id === "splits" && <SplitsSettings />}
          {current.id === "snippets" && <SnippetsSettings />}
          {current.id === "shortcuts" && <ShortcutsSettings />}
          {current.id === "team" && <TeamSettings />}
          {current.id === "ai" && <AiSettings />}
        </div>
      </div>
    </section>
  );
}
