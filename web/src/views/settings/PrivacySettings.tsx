import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Link } from "../../components/Link.tsx";
import { useSession } from "../../store/session.ts";
import { safetyFacts as SAFETY_FACTS } from "../../lib/safetyFacts.ts";

/** Settings → Privacy & safety: what Slipstream does and doesn't do with your mail, and what is switched on right now. */
export function PrivacySettings() {
  const remoteImages = useSession((s) => s.settings.remoteImages);
  const logos = useSession((s) => s.settings.senderLogos);
  const assistant = useSession((s) => s.settings.assistant === "on");
  const agents = useAgentCount();

  return (
    <div className="settings-list">
      {SAFETY_FACTS.length > 0 && (
        <section className="panel-block" aria-label="How Slipstream treats your mail">
          <ul className="facts" role="list">
            {SAFETY_FACTS.map((f) => (
              <li key={f.title} className="fact">
                <h3 className="fact-title">{f.title}</h3>
                <p className="fact-body">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-block" aria-labelledby="privacy-status">
        <h3 className="block-title" id="privacy-status">
          What's on right now
        </h3>
        <ul className="status-list" role="list">
          <StatusRow
            icon="image"
            title="Remote images"
            value={remoteImages === "always" ? "Always shown" : "Ask first"}
            on={remoteImages === "always"}
            to="/settings/general"
            action="Change in General"
          />
          <StatusRow icon="tag" title="Company logos" value={logos ? "On" : "Off"} on={logos} to="/settings/general" action="Change in General" />
          <StatusRow icon="sparkle" title="Built-in assistant" value={assistant ? "On" : "Off"} on={assistant} to="/settings/ai" action="Change in AI & agents" />
          <StatusRow
            icon="shield"
            title="Connected agents"
            value={agents.state === "ready" ? (agents.count === 0 ? "None" : `${agents.count} connected`) : agents.state === "error" ? "Couldn't load" : "Checking…"}
            on={agents.state === "ready" && agents.count > 0}
            to="/settings/agents"
            action="Manage agents"
          />
        </ul>
      </section>

      <p className="block-lead privacy-check">
        Check this yourself: <code>npm run test:render</code> renders hostile emails and fails if any of them reach the network.
      </p>
    </div>
  );
}

function StatusRow({ icon, title, value, on, to, action }: { icon: IconName; title: string; value: string; on: boolean; to: string; action: string }) {
  return (
    <li className="status-row">
      <Icon name={icon} size={16} className="status-icon" />
      <span className="status-title">{title}</span>
      <span className={`status-value ${on ? "on" : ""}`}>{value}</span>
      <Link to={to} className="status-link" aria-label={`${action}: ${title}`}>
        {action}
      </Link>
    </li>
  );
}

function useAgentCount(): { state: "loading" | "ready" | "error"; count: number } {
  const [res, setRes] = useState<{ state: "loading" | "ready" | "error"; count: number }>({ state: "loading", count: 0 });
  useEffect(() => {
    let live = true;
    api
      .agents()
      .then((r) => live && setRes({ state: "ready", count: r.agents.length }))
      .catch(() => live && setRes({ state: "error", count: 0 }));
    return () => {
      live = false;
    };
  }, []);
  return res;
}
