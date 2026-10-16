import { useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Link } from "../../components/Link.tsx";
import { refreshSession, updateSettings, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import { Segmented } from "./GeneralSettings.tsx";

export function AiSettings() {
  const enabled = useSession((s) => s.features.ai);
  const mode = useSession((s) => s.mode);
  const assistantOn = useSession((s) => s.settings.assistant === "on");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (apiKey: string) => {
    setBusy(true);
    try {
      await api.saveAiKey(apiKey);
      await refreshSession();
      setKey("");
      toast.info(apiKey ? "Writing help is on" : "Key removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-labelledby="ai-assistant">
        <div className="block-head">
          <h3 className="block-title" id="ai-assistant">
            Built-in assistant
          </h3>
          <Segmented
            label="Built-in assistant"
            value={assistantOn ? "on" : "off"}
            onChange={(v) => void updateSettings({ assistant: v })}
            options={[
              { id: "off", label: "Off" },
              { id: "on", label: "On" },
            ]}
          />
        </div>
        <p className="block-lead">Slipstream works fully without AI. Turn this on to ask a model about your mail or let Autopilot sort new mail. Your own agents can connect either way.</p>
        <ul className="link-list" role="list">
          <li>
            <Link to="/settings/models" className="link-row">
              <span className="link-row-main">
                <span className="link-row-title">Models &amp; accounts</span>
                <span className="link-row-sub">Choose what the assistant thinks with</span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          </li>
          {assistantOn && (
            <li>
              <Link to="/autopilot" className="link-row">
                <span className="link-row-main">
                  <span className="link-row-title">Autopilot</span>
                  <span className="link-row-sub">Sort new mail as it arrives</span>
                </span>
                <Icon name="chevron-right" />
              </Link>
            </li>
          )}
          <li>
            <Link to="/settings/connect" className="link-row">
              <span className="link-row-main">
                <span className="link-row-title">Connect an assistant</span>
                <span className="link-row-sub">Use Claude Desktop, Cursor or an agent of your own</span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          </li>
        </ul>
      </section>

      <section className="panel-block" aria-labelledby="ai-writing">
        <h3 className="block-title" id="ai-writing">
          Writing help
        </h3>
        <p className="block-lead">
          Paste an Anthropic API key to turn on drafting and summaries. They use this key, which stays {mode === "team" ? "on this server" : "on this machine"}, stored encrypted, and is never sent to your browser again.
        </p>
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void save(key.trim());
          }}
        >
          <input
            className="field"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={enabled ? "A key is saved. Paste a new one to replace it." : "sk-ant-…"}
            aria-label="Anthropic API key"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={busy || !key.trim()}>
            Save key
          </button>
        </form>
        {enabled && (
          <div className="ai-on">
            <span className="ai-state">
              <Icon name="check-circle" /> Writing help is on
            </span>
            <button className="btn btn-sm btn-danger" onClick={() => void save("")} disabled={busy}>
              Remove key
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
