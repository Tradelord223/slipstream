import { useSession } from "../../store/session.ts";

const REPO = "https://github.com/Tradelord223/slipstream";

/** Version, license and where the source lives (the AGPL asks a network service to offer it). */
export function AboutSettings() {
  const sourceUrl = useSession((s) => s.features.sourceUrl) ?? REPO;
  return (
    <div className="settings-list">
      <section className="panel-block">
        <h3 className="block-title">Slipstream</h3>
        <p className="block-lead">
          An open-source, keyboard-first email client for people and their agents. Licensed under the{" "}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU AGPL v3.0</a>.
        </p>
        <p className="block-lead">
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">Source code</a>
          {" · "}
          <a href="/THIRD_PARTY_LICENSES.txt" target="_blank" rel="noopener noreferrer">Third-party licenses</a>
          {" · "}
          <a href={`${REPO}/blob/main/docs/security.md`} target="_blank" rel="noopener noreferrer">Security</a>
        </p>
      </section>
    </div>
  );
}
