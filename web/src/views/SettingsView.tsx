import { useEffect, useRef } from "react";
import { AssistantButton } from "../components/AssistantButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { Link } from "../components/Link.tsx";
import { useViewport } from "../lib/hooks.ts";
import { useSession } from "../store/session.ts";
import { ui } from "../store/ui.ts";
import { AccountsSettings } from "./settings/AccountsSettings.tsx";
import { AgentsSettings } from "./settings/AgentsSettings.tsx";
import { ConnectSettings } from "./settings/ConnectSettings.tsx";
import { AiSettings } from "./settings/AiSettings.tsx";
import { ModelsSettings } from "./settings/ModelsSettings.tsx";
import { LabelsSettings } from "./settings/LabelsSettings.tsx";
import { GeneralSettings } from "./settings/GeneralSettings.tsx";
import { ShortcutsSettings } from "./settings/ShortcutsSettings.tsx";
import { SnippetsSettings } from "./settings/SnippetsSettings.tsx";
import { SplitsSettings } from "./settings/SplitsSettings.tsx";
import { TeamSettings } from "./settings/TeamSettings.tsx";
import { AboutSettings } from "./settings/AboutSettings.tsx";
import { HelpersSettings } from "./settings/HelpersSettings.tsx";
import { PrivacySettings } from "./settings/PrivacySettings.tsx";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "splits", label: "Splits" },
  { id: "labels", label: "Labels" },
  { id: "helpers", label: "Helpers" },
  { id: "snippets", label: "Snippets" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "team", label: "Team" },
  { id: "ai", label: "AI & agents" },
  { id: "models", label: "Models & accounts" },
  { id: "agents", label: "Agents" },
  { id: "connect", label: "Connect" },
  { id: "privacy", label: "Privacy & safety" },
  { id: "about", label: "About" },
] as const;

const TITLES: Record<string, string> = { connect: "Connect an assistant" };

export function SettingsView({ section }: { section: string }) {
  const viewport = useViewport();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const mode = useSession((s) => s.mode);
  void mode;
  const nav = useRef<HTMLElement>(null);
  // On narrow screens the section links scroll sideways; keep the current one in view.
  useEffect(() => {
    nav.current?.querySelector("[aria-current=page]")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [current.id]);
  return (
    <section className="settings" aria-label="Settings">
      <header className="mail-header">
        {viewport !== "desktop" && (
          <button className="icon-btn tap" aria-label="Open menu" onClick={() => ui.set({ sheetOpen: true })}>
            <Icon name="menu" size={18} />
          </button>
        )}
        <h1 className="view-title">Settings</h1>
        <span className="grow" />
        <AssistantButton />
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections" ref={nav}>
          {SECTIONS.map((s) => (
            <Link key={s.id} to={`/settings/${s.id}`} className="settings-link" aria-current={s.id === current.id ? "page" : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          <h2 className="settings-title">{TITLES[current.id] ?? current.label}</h2>
          {current.id === "general" && <GeneralSettings />}
          {current.id === "about" && <AboutSettings />}
          {current.id === "accounts" && <AccountsSettings />}
          {current.id === "splits" && <SplitsSettings />}
          {current.id === "labels" && <LabelsSettings />}
          {current.id === "helpers" && <HelpersSettings />}
          {current.id === "snippets" && <SnippetsSettings />}
          {current.id === "shortcuts" && <ShortcutsSettings />}
          {current.id === "team" && <TeamSettings />}
          {current.id === "ai" && <AiSettings />}
          {current.id === "models" && <ModelsSettings />}
          {current.id === "agents" && <AgentsSettings />}
          {current.id === "connect" && <ConnectSettings />}
          {current.id === "privacy" && <PrivacySettings />}
        </div>
      </div>
    </section>
  );
}
