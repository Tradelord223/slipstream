import { useEffect } from "react";
import { setUnauthorizedHandler } from "./api.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Composer, type Placement } from "./components/Composer.tsx";
import { Logo } from "./components/Icon.tsx";
import { Rail } from "./components/Rail.tsx";
import { RemindPopover } from "./components/RemindPopover.tsx";
import { ShortcutsSheet } from "./components/ShortcutsSheet.tsx";
import { TipsBar, Toasts } from "./components/Toasts.tsx";
import { installKeys } from "./keys/dispatcher.ts";
import { useViewport } from "./lib/hooks.ts";
import { viewParams } from "./lib/views.ts";
import { useCompose } from "./store/compose.ts";
import { refreshCounts, useCounts } from "./store/counts.ts";
import { connectEvents, disconnectEvents } from "./store/events.ts";
import { focusId, openView, useList } from "./store/list.ts";
import { navigate, useRoute, type MailView as MailViewType } from "./store/route.ts";
import { loadSession, session, useSession } from "./store/session.ts";
import { ui, useUi } from "./store/ui.ts";
import { AuthView } from "./views/AuthView.tsx";
import { MailView } from "./views/MailView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SharedView } from "./views/SharedView.tsx";
import { ThreadView } from "./views/ThreadView.tsx";

export function App() {
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => session.set({ status: "signin", mode: "team" }));
    void loadSession();
  }, []);

  useEffect(() => {
    if (status === "signin" && route.name !== "join" && route.name !== "login") navigate("/login", { replace: true });
    if (status === "setup" && route.name !== "join" && route.name !== "setup") navigate("/setup", { replace: true });
  }, [status, route.name]);

  if (status === "loading") {
    return (
      <div className="splash" role="status" aria-label="Loading Slipstream">
        <Logo size={34} />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="splash splash-error" role="alert">
        <Logo size={34} />
        <h1>Can't reach Slipstream</h1>
        <p>{error}</p>
        <button className="btn" onClick={() => void loadSession()}>
          Try again
        </button>
      </div>
    );
  }
  if (status === "signin" || status === "setup") return <AuthView />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const viewport = useViewport();
  const railOpen = useUi((s) => s.railOpen);
  const sheetOpen = useUi((s) => s.sheetOpen);
  const splits = useSession((s) => s.splits);
  const accountFilter = useSession((s) => s.accountFilter);
  const density = useSession((s) => s.settings.density);
  const listView = useList((s) => s.view);
  const counts = useCounts();

  useEffect(() => {
    connectEvents();
    refreshCounts(true);
    const off = installKeys();
    return () => {
      off();
      disconnectEvents();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  // Which mailbox sits behind the screen: the one in the URL, or the one the open conversation came from.
  const view: MailViewType | null = route.name === "mail" ? route.view : route.name === "thread" ? (listView ?? { kind: "inbox" }) : null;
  const params = view ? viewParams(view, splits, accountFilter) : null;
  const key = view ? JSON.stringify(params ?? view) : "";
  useEffect(() => {
    if (view) openView(key, view, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (route.name === "thread") focusId(route.id);
  }, [route]);

  useEffect(() => {
    const n = counts?.inbox.unread;
    document.title = n ? `Inbox (${n}) · Slipstream` : "Slipstream";
  }, [counts]);

  useEffect(() => {
    if (viewport === "desktop") ui.set({ sheetOpen: false });
  }, [viewport]);

  const showRail = viewport === "desktop" && railOpen;
  let main: React.ReactNode;
  if (route.name === "thread") {
    const fallback: MailViewType = view ?? { kind: "inbox" };
    main =
      viewport === "tablet" ? (
        <div className="split-pane">
          <MailView view={fallback} compact />
          <ThreadView id={route.id} showContext={false} />
        </div>
      ) : (
        <ThreadView id={route.id} showContext />
      );
  } else if (route.name === "mail") main = <MailView view={route.view} />;
  else if (route.name === "settings") main = <SettingsView section={route.section} />;
  else if (route.name === "shared") main = <SharedView id={route.id} />;
  else main = <JoinOrHome />;

  return (
    <div className={`app app-${viewport} ${showRail ? "with-rail" : ""}`}>
      {showRail && <Rail />}
      {viewport !== "desktop" && sheetOpen && (
        <div className="sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.set({ sheetOpen: false })}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Menu">
            <Rail />
          </div>
        </div>
      )}
      <main className="main">{main}</main>
      <ComposerHost />
      <TipsBar />
      <Toasts />
      <CommandPalette />
      <RemindPopover />
      <ShortcutsSheet />
      <ChordHint />
    </div>
  );
}

function JoinOrHome() {
  useEffect(() => navigate("/", { replace: true }), []);
  return null;
}

function ComposerHost() {
  const open = useCompose((s) => s.open);
  const mode = useCompose((s) => s.mode);
  const inline = useCompose((s) => s.inline);
  const threadId = useCompose((s) => s.threadId);
  const route = useRoute();
  const viewport = useViewport();
  if (!open) return null;
  let placement: Placement;
  if (viewport === "mobile") placement = "full";
  else if (mode === "modal") placement = "modal";
  else if (inline && route.name === "thread" && route.id === threadId) return null; // the conversation draws it
  else placement = "dock";
  return <Composer placement={placement} />;
}

function ChordHint() {
  const chord = useUi((s) => s.chord);
  if (!chord) return null;
  return (
    <div className="chord-hint" role="status">
      <kbd className="keycap">{chord.toUpperCase()}</kbd> then…
    </div>
  );
}
