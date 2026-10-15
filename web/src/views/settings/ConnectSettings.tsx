import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField, Snippet } from "../../components/CopyBlock.tsx";
import { Icon } from "../../components/Icon.tsx";
import { claudeCodeCommand, cliCommand, curlCommand, mcpUrl, openApiUrl, stdioConfig } from "../../lib/connect.ts";
import { navigate } from "../../store/route.ts";
import { openCreateAgent } from "../../store/agents.ts";
import { toast } from "../../store/toasts.ts";
import type { RemoteMode, RemoteStatus } from "../../types.ts";

export function ConnectSettings() {
  const origin = location.origin;

  const openSpec = async (e: React.MouseEvent) => {
    e.preventDefault();
    // The spec needs the client header, so a plain link would be refused; open the fetched copy instead.
    const win = window.open("", "_blank");
    try {
      const spec = await api.openApiSpec();
      const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }));
      if (win) win.location.href = url;
      else toast.error("Your browser blocked the new tab.");
    } catch (err) {
      win?.close();
      toast.error(err instanceof Error ? err.message : "Couldn't open the OpenAPI document");
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Connect an assistant">
        <div className="ag-panel-head">
          <p className="block-lead">
            Give each assistant its own token under <a href="/settings/agents" onClick={(e) => (e.preventDefault(), navigate("/settings/agents"))}>Agents</a>, then paste it where you see {"<token>"}.
          </p>
          <button className="btn" onClick={openCreateAgent}>
            <Icon name="plus" /> Create agent token
          </button>
        </div>
        <div className="ag-snips">
          <Snippet title="Claude Code" hint="Adds Slipstream as an MCP server." text={claudeCodeCommand(origin)} />
          <Snippet title="Claude Desktop, Cursor and other stdio clients" hint="A local install creates its own token." text={stdioConfig} />
          <Snippet
            title="HTTP API"
            hint={
              <>
                Every action over HTTP. Read the{" "}
                <a href={openApiUrl(origin)} onClick={(e) => void openSpec(e)} target="_blank" rel="noopener noreferrer">
                  OpenAPI document
                </a>
                .
              </>
            }
            text={curlCommand(origin)}
          />
          <Snippet title="Command line" hint="Run any action from a terminal." text={cliCommand} />
        </div>
      </section>
      <RemoteAccess />
    </div>
  );
}

type Remote = { kind: "loading" } | { kind: "unavailable" } | { kind: "error"; message: string } | { kind: "ready"; status: RemoteStatus };

function RemoteAccess() {
  const [state, setState] = useState<Remote>({ kind: "loading" });
  const [busy, setBusy] = useState<RemoteMode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmFunnel, setConfirmFunnel] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    api
      .remote()
      .then((status) => setState({ kind: "ready", status }))
      .catch((err: Error) => setState(err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501) ? { kind: "unavailable" } : { kind: "error", message: err.message }));
  }, []);
  useEffect(load, [load]);

  const set = async (mode: RemoteMode) => {
    setBusy(mode);
    setProblem(null);
    try {
      const status = await api.setRemote(mode);
      setState({ kind: "ready", status });
      if (status.tailscale.error) setProblem(status.tailscale.error);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't change remote access");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel-block" aria-label="Remote access">
      <div>
        <h3 className="block-title">Remote access</h3>
        <p className="block-lead">Reach Slipstream from assistants that don't run on this machine, over Tailscale.</p>
      </div>
      {state.kind === "loading" && (
        <div className="rv-skeleton ag-skeleton" aria-busy="true" aria-label="Checking Tailscale">
          <span />
          <span />
        </div>
      )}
      {state.kind === "unavailable" && <p className="ag-meta">Update Slipstream to enable remote access.</p>}
      {state.kind === "error" && (
        <>
          <div className="form-error" role="alert">
            {state.message}
          </div>
          <div className="form-actions start">
            <button className="btn" onClick={load}>
              Try again
            </button>
          </div>
        </>
      )}
      {state.kind === "ready" && !state.status.tailscale.installed && (
        <div className="rm-setup">
          <p>
            Install Tailscale and sign in. That's the only step.
          </p>
          <div className="form-actions start">
            <a className="btn btn-primary" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">
              Download Tailscale <Icon name="external" />
            </a>
            <button className="btn" onClick={load}>
              Check again
            </button>
          </div>
        </div>
      )}
      {state.kind === "ready" && state.status.tailscale.installed && !state.status.tailscale.running && (
        <div className="rm-setup">
          <p>Tailscale is installed but isn't running. Open it and sign in.</p>
          <div className="form-actions start">
            <button className="btn" onClick={load}>
              Check again
            </button>
          </div>
        </div>
      )}
      {state.kind === "ready" && state.status.tailscale.running && (
        <div className="rm-options">
          <RemoteOption
            title="Your devices"
            lines={["Tailscale Serve: private to your tailnet.", "For Claude Code, Cursor and Claude Desktop."]}
            url={state.status.tailscale.serve?.url ?? null}
            busy={busy === "serve" || (busy === "off" && Boolean(state.status.tailscale.serve))}
            disabled={busy !== null}
            onOn={() => void set("serve")}
            onOff={() => void set("off")}
          />
          <RemoteOption
            title="Anywhere"
            lines={["Tailscale Funnel: a public HTTPS address.", "For claude.ai and ChatGPT. They sign in and you approve the connection in Review."]}
            url={state.status.tailscale.funnel?.url ?? null}
            busy={busy === "funnel" || (busy === "off" && Boolean(state.status.tailscale.funnel))}
            disabled={busy !== null}
            onOn={() => setConfirmFunnel(true)}
            onOff={() => void set("off")}
          />
          {problem && (
            <div className="form-error" role="alert">
              {problem}
            </div>
          )}
        </div>
      )}
      {confirmFunnel && (
        <ConfirmDialog
          title="Open Slipstream to the internet?"
          confirmLabel="Turn on Anywhere"
          onConfirm={() => (setConfirmFunnel(false), void set("funnel"))}
          onClose={() => setConfirmFunnel(false)}
        >
          Slipstream gets a public HTTPS address. Assistants sign in, and you approve each connection in Review. You can turn it off here at any time.
        </ConfirmDialog>
      )}
    </section>
  );
}

function RemoteOption({
  title,
  lines,
  url,
  busy,
  disabled,
  onOn,
  onOff,
}: {
  title: string;
  lines: [string, string];
  url: string | null;
  busy: boolean;
  disabled: boolean;
  onOn: () => void;
  onOff: () => void;
}) {
  const on = Boolean(url);
  return (
    <div className={`rm-opt ${on ? "on" : ""}`}>
      <div className="rm-head">
        <div className="rm-text">
          <div className="rm-title">
            {title}
            {on && <span className="rm-state">On</span>}
          </div>
          <div className="rm-hint">{lines[0]}</div>
          <div className="rm-hint">{lines[1]}</div>
        </div>
        <button className="btn" disabled={disabled} onClick={on ? onOff : onOn} aria-label={`${on ? "Turn off" : "Turn on"} ${title.toLowerCase()}`}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? (on ? "Turning off" : "Turning on") : on ? "Turn off" : "Turn on"}
        </button>
      </div>
      {url && <CopyField value={mcpUrl(url.replace(/\/$/, ""))} label={`MCP address for ${title.toLowerCase()}`} />}
    </div>
  );
}
