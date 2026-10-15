import { useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { refreshSession, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";

export function AiSettings() {
  const enabled = useSession((s) => s.features.ai);
  const mode = useSession((s) => s.mode);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (apiKey: string) => {
    setBusy(true);
    try {
      await api.saveAiKey(apiKey);
      await refreshSession();
      setKey("");
      toast.info(apiKey ? "AI is on" : "Key removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block">
        <h3 className="block-title">Use your own Anthropic key</h3>
        <p className="block-lead">
          Paste an API key to turn on drafting and summaries. The key stays {mode === "team" ? "on this server" : "on this machine"}, stored encrypted, and is never sent to your browser again.
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
              <Icon name="check-circle" /> AI features are on
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
