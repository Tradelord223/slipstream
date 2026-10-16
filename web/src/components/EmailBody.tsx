import { useEffect, useMemo, useRef, useState } from "react";
import { frameDocument, prepareBody } from "../lib/emailHtml.ts";
import type { Message } from "../types.ts";
import { useSession } from "../store/session.ts";
import { Link } from "./Link.tsx";

const KEY = "ss-image-senders";

function loadSenders(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveSender(email: string) {
  const s = loadSenders();
  s.add(email.toLowerCase());
  try {
    localStorage.setItem(KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* private mode: the choice just lasts for this view */
  }
}

export function EmailBody({ message }: { message: Message }) {
  const always = useSession((s) => s.settings.remoteImages === "always");
  const [shown, setShown] = useState(false);
  const [trusted, setTrusted] = useState(() => loadSenders().has(message.from.email.toLowerCase()));
  const allow = always || shown || trusted;
  const prepared = useMemo(() => prepareBody(message, allow), [message, allow]);
  const hidden = !allow && prepared.blocked > 0;

  return (
    <div className="body-wrap">
      {hidden && (
        <div className="image-banner" role="status">
          <span>Images are hidden to keep your reading private</span>
          <span className="image-banner-actions">
            <button className="link-btn" onClick={() => setShown(true)}>
              Show images
            </button>
            <span aria-hidden="true">·</span>
            <button
              className="link-btn"
              onClick={() => {
                saveSender(message.from.email);
                setTrusted(true);
              }}
            >
              Always for this sender
            </button>
            <span aria-hidden="true">·</span>
            <Link to="/settings/privacy" className="link-btn">
              How this works
            </Link>
          </span>
        </div>
      )}
      {prepared.kind === "rich" ? (
        <PaperFrame html={prepared.html} allowImages={allow} title={`Message from ${message.from.name || message.from.email}`} />
      ) : (
        <div className="body-native" dangerouslySetInnerHTML={{ __html: prepared.html }} />
      )}
    </div>
  );
}

/** Designed emails sit on light paper, in a sandboxed frame: no scripts, no network beyond what the CSP allows. */
function PaperFrame({ html, allowImages, title }: { html: string; allowImages: boolean; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = useMemo(() => frameDocument(html, allowImages), [html, allowImages]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let ro: ResizeObserver | null = null;
    const fit = () => {
      const d = el.contentDocument;
      if (!d?.documentElement) return;
      const h = Math.ceil(Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0));
      setHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    const attach = () => {
      const d = el.contentDocument;
      if (!d?.documentElement) return;
      fit();
      ro?.disconnect();
      ro = new ResizeObserver(fit);
      ro.observe(d.documentElement);
      if (d.body) ro.observe(d.body);
      for (const img of d.images) img.addEventListener("load", fit);
    };
    el.addEventListener("load", attach);
    if (el.contentDocument?.readyState === "complete") attach();
    const outer = new ResizeObserver(fit);
    outer.observe(el);
    return () => {
      el.removeEventListener("load", attach);
      ro?.disconnect();
      outer.disconnect();
    };
  }, [doc]);

  return (
    <div className="paper">
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
        scrolling="no"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
