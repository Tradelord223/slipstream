import { useEffect } from "react";
import { setUnauthorizedHandler } from "./api.ts";
import { AssistantHost } from "./components/assistant/AssistantPanel.tsx";
import { CloudAccessDialog } from "./components/assistant/CloudForm.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { oauthErrorText } from "./components/connect/hosts.ts";
import { Composer, type Placement } from "./components/Composer.tsx";
import { LabelDialogHost } from "./components/labels/LabelDialogs.tsx";
import { Logo } from "./components/Icon.tsx";
import { Rail } from "./components/Rail.tsx";
import { RemindPopover } from "./components/RemindPopover.tsx";
import { ShortcutsSheet } from "./components/ShortcutsSheet.tsx";
import { TipsBar, Toasts } from "./components/Toasts.tsx";
import { installKeys } from "./keys/dispatcher.ts";
import { useViewport, useWindowWidth } from "./lib/hooks.ts";
import { viewParams } from "./lib/views.ts";
import { useCompose } from "./store/compose.ts";
import { refreshApprovals } from "./store/agents.ts";
import { ASSISTANT_INLINE_MIN, assistant, effectiveWidth, useAssistant } from "./store/assistant.ts";
import { refreshCloud, useCloud } from "./store/cloud.ts";
import { refreshEngines } from "./store/engines.ts";
import { refreshAutopilot } from "./store/autopilot.ts";
import { refreshLabels } from "./store/labels.ts";
import { refreshCounts, useCounts } from "./store/counts.ts";
import { connectEvents, disconnectEvents } from "./store/events.ts";
import { focusId, openView, useList } from "./store/list.ts";
import { currentUrl, navigate, useRoute, type MailView as MailViewType } from "./store/route.ts";
import { loadSession, rememberView, session, useAssistantOn, useSession } from "./store/session.ts";
import { toast } from "./store/toasts.ts";
import { ui, useUi } from "./store/ui.ts";
import { AuthView, JoinSignedIn } from "./views/AuthView.tsx";
import { ActivityView } from "./views/ActivityView.tsx";
import { OnboardingView } from "./views/OnboardingView.tsx";
import { AgentView } from "./views/AgentView.tsx";
import { AutopilotView } from "./views/AutopilotView.tsx";
import { MailView } from "./views/MailView.tsx";
import { ReviewView } from "./views/ReviewView.tsx";
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
  // First run: no rail, no inbox, no shortcuts until a real mailbox is connected. An invite link still comes first,
  // so opening one never loses it.
  if (status === "onboarding") {
    return (
      <>
        {route.name === "join" ? <JoinSignedIn invite={route.invite} /> : <OnboardingView />}
        <Toasts />
      </>
    );
  }
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
  const assistantOn = useAssistantOn();
  const assistantOpen = useAssistant((s) => s.open) && assistantOn;
  const assistantWidth = useAssistant((s) => s.width);
  const accessOpen = useAssistant((s) => s.accessOpen);
  const cloudStatus = useCloud((s) => s.status);
  const windowWidth = useWindowWidth();

  useEffect(() => {
    connectEvents();
    refreshCounts(true);
    refreshApprovals(true);
    void refreshCloud();
    void refreshEngines();
    refreshAutopilot(true);
    refreshLabels(true);
    const off = installKeys();
    return () => {
      off();
      disconnectEvents();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  // Results of an OAuth round trip arrive as ?connected= or ?error=.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const connected = q.get("connected");
    const error = q.get("error");
    if (!connected && !error) return;
    if (connected) toast.info(q.get("provider") === "microsoft" ? "Outlook connected" : "Gmail connected");
    else if (error) toast.error(oauthErrorText(error));
    navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (route.name === "mail") rememberView(currentUrl());
  }, [route]);

  useEffect(() => {
    const n = counts?.inbox.unread;
    document.title = n ? `Inbox (${n}) · Slipstream` : "Slipstream";
  }, [counts]);

  // Agent and Autopilot belong to the built-in assistant; with it off their page is Settings → AI & agents.
  const assistantPage = route.name === "agent" || route.name === "autopilot";
  useEffect(() => {
    if (assistantPage && !assistantOn) navigate("/settings/ai", { replace: true });
  }, [assistantPage, assistantOn]);

  useEffect(() => {
    if (viewport === "desktop") ui.set({ sheetOpen: false });
  }, [viewport]);

  // The slide-over menu: Escape closes it, focus moves into it and comes back.
  useEffect(() => {
    if (!sheetOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(".sheet a, .sheet button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ui.set({ sheetOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [sheetOpen]);

  const showRail = viewport === "desktop" && railOpen;
  const inlineAssistant = viewport === "desktop" && windowWidth >= ASSISTANT_INLINE_MIN;
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
        <ThreadView id={route.id} showContext={!(inlineAssistant && assistantOpen)} />
      );
  } else if (route.name === "mail") main = <MailView view={route.view} />;
  else if (route.name === "settings") main = <SettingsView section={route.section} />;
  else if (route.name === "shared") main = <SharedView id={route.id} />;
  else if (route.name === "review") main = <ReviewView tab={route.tab} />;
  else if (route.name === "activity") main = <ActivityView />;
  else if (route.name === "agent") main = assistantOn ? <AgentView /> : null;
  else if (route.name === "autopilot") main = assistantOn ? <AutopilotView /> : null;
  else if (route.name === "join") main = <JoinSignedIn invite={route.invite} />;
  else main = <JoinOrHome />;

  return (
    <div
      className={`app app-${viewport} ${showRail ? "with-rail" : ""} ${inlineAssistant && assistantOpen ? "with-assistant" : ""}`}
      style={{ ["--assistant-w" as string]: `${effectiveWidth(assistantWidth, showRail, windowWidth)}px` }}
    >
      {showRail && <Rail />}
      {viewport !== "desktop" && sheetOpen && (
        <div className="sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.set({ sheetOpen: false })}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Menu">
            <Rail />
          </div>
        </div>
      )}
      <main className="main">{main}</main>
      <AssistantHost />
      <LabelDialogHost />
      {accessOpen && cloudStatus?.connected && <CloudAccessDialog status={cloudStatus} onClose={() => assistant.set({ accessOpen: false })} />}
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
