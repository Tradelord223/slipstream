import { useRef, useState } from "react";
import { api } from "../../api.ts";
import { importState, useImportJob } from "../../store/events.ts";
import { refreshSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import { Icon } from "../Icon.tsx";

/** Choose or drop an .mbox/.eml file. The import runs on the server; its progress arrives as events. */
export function ImportMail({ defaultOwner = "", onStarted, autoFocus = false }: { defaultOwner?: string; onStarted?: (accountId: string) => void | Promise<void>; autoFocus?: boolean }) {
  const job = useImportJob();
  const [over, setOver] = useState(false);
  const [owner, setOwner] = useState(defaultOwner);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = job?.status === "running" || starting;

  const start = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!/\.(mbox|mbx|eml)$/i.test(file.name)) {
      setProblem("Choose an .mbox or .eml file.");
      return;
    }
    setProblem(null);
    setStarting(true);
    importState.set({ job: null });
    try {
      const { accountId } = await api.importMail(file, owner.trim());
      // Callers that take over (onStarted) refresh themselves; otherwise the new archive account should show up now.
      if (onStarted) await onStarted(accountId);
      else await refreshSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start the import";
      setProblem(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="import-mail">
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void start([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={20} />
        <span>Drop an .mbox or .eml file here</span>
        <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={running} data-autofocus={autoFocus ? "" : undefined}>
          Choose a file
        </button>
        <input ref={input} type="file" accept=".mbox,.mbx,.eml" hidden onChange={(e) => (void start([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </div>
      <label className="form-row import-owner">
        <span>Your address in this archive (optional)</span>
        <input className="field" type="email" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="you@example.com" autoComplete="off" />
        <small className="form-hint">Helps Slipstream tell which messages you sent.</small>
      </label>
      {problem && (
        <div className="form-error" role="alert">
          {problem}
        </div>
      )}
      {!onStarted && running && (
        <div className="import-progress" role="status">
          <span className="spinner" />
          <span className="num">{job?.imported ? `Imported ${job.imported.toLocaleString("en-US")} messages…` : "Reading the archive…"}</span>
        </div>
      )}
      {!onStarted && job?.status === "done" && (
        <div className="import-progress done" role="status">
          <Icon name="check-circle" /> <span className="num">Imported {job.imported.toLocaleString("en-US")} messages.</span>
        </div>
      )}
      {!onStarted && job?.status === "failed" && (
        <div className="form-error" role="alert">
          The import stopped after {job.imported.toLocaleString("en-US")} messages{job.error ? `: ${job.error}` : "."}
        </div>
      )}
    </div>
  );
}
