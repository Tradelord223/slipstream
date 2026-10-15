import DOMPurify from "dompurify";
import type { Message } from "../types.ts";
import { escapeHtml } from "./format.ts";

export type BodyKind = "plain" | "simple" | "rich";

export interface PreparedBody {
  kind: BodyKind;
  html: string;
  /** How many remote images or backgrounds were held back. */
  blocked: number;
}

const SIMPLE_TAGS = new Set([
  "p", "br", "div", "span", "a", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "sub", "sup", "small", "details", "summary",
]);

// Inline styling that means the sender designed the message. Spacing and quote borders (Gmail adds these to replies) do not.
const STYLE_IS_DESIGN = /(^|;)\s*(color|background|font-family|font-size|font-weight|text-align|float|position)\s*:/i;
const REMOTE_URL_IN_CSS = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*?\1\s*\)/gi;
const QUOTE_LEAD = /^\s*(?:On\b[\s\S]{3,300}?\bwrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+\bSent:)\s*$/i;

let hooksReady = false;
function ensureHooks() {
  if (hooksReady) return;
  hooksReady = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|tel:)/i.test(href)) node.removeAttribute("href");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim());
}

function sanitizeToBody(html: string): HTMLElement {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "svg", "math", "audio", "video", "source", "canvas", "dialog"],
    FORBID_ATTR: ["srcset", "formaction", "ping"],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
    RETURN_DOM: true,
  }) as HTMLElement;
}

function detectKind(body: HTMLElement): BodyKind {
  if (body.querySelector("style, table, [bgcolor], [background], font[color], center")) return "rich";
  for (const el of body.querySelectorAll("*")) {
    if (!SIMPLE_TAGS.has(el.tagName.toLowerCase())) return "rich";
    const style = el.getAttribute("style");
    if (style && !el.closest("blockquote") && STYLE_IS_DESIGN.test(style)) return "rich";
  }
  return "simple";
}

function rewriteImages(body: HTMLElement, msg: Message, allowImages: boolean): number {
  let blocked = 0;
  const byCid = new Map(msg.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.replace(/^<|>$/g, "").toLowerCase(), a]));
  for (const img of body.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      const att = byCid.get(src.slice(4).replace(/^<|>$/g, "").toLowerCase());
      if (att) img.setAttribute("src", `${location.origin}/api/attachments/${att.id}?inline=1`);
      else img.removeAttribute("src");
    } else if (isRemote(src)) {
      if (allowImages && /^(https:)?\/\//i.test(src)) img.setAttribute("src", src.startsWith("//") ? `https:${src}` : src);
      else {
        img.setAttribute("data-src", src);
        img.removeAttribute("src");
        blocked++;
      }
    } else if (src && !/^data:image\//i.test(src) && !src.startsWith(`${location.origin}/api/attachments/`)) {
      img.removeAttribute("src");
    }
  }
  for (const el of body.querySelectorAll("[background]")) {
    const bg = el.getAttribute("background") ?? "";
    if (isRemote(bg)) {
      if (!allowImages) {
        el.removeAttribute("background");
        blocked++;
      }
    } else el.removeAttribute("background");
  }
  const scrub = (css: string) => {
    let hit = 0;
    const out = css.replace(/@import[^;]+;?/gi, "").replace(REMOTE_URL_IN_CSS, () => {
      hit++;
      return allowImages ? "" : 'url("data:,")';
    });
    return { out: allowImages ? css.replace(/@import[^;]+;?/gi, "") : out, hit };
  };
  for (const el of body.querySelectorAll("[style]")) {
    const { out, hit } = scrub(el.getAttribute("style") ?? "");
    if (hit && !allowImages) blocked++;
    el.setAttribute("style", out);
  }
  for (const s of body.querySelectorAll("style")) {
    const { out, hit } = scrub(s.textContent ?? "");
    if (hit && !allowImages) blocked++;
    s.textContent = out;
  }
  return blocked;
}

function wrapQuote(doc: Document, nodes: Element[]) {
  const first = nodes[0]!;
  const details = doc.createElement("details");
  details.className = "ss-quote";
  const summary = doc.createElement("summary");
  summary.textContent = "···";
  summary.setAttribute("aria-label", "Show quoted text");
  details.append(summary);
  first.before(details);
  for (const n of nodes) details.append(n);
}

/** Collapse "On … wrote:" history and blockquotes behind a toggle (a plain <details>, so it works without scripts). */
function collapseQuotes(body: HTMLElement) {
  const doc = body.ownerDocument;
  const candidates = [...body.querySelectorAll("blockquote, .gmail_quote, .yahoo_quoted, #divRplyFwdMsg, #appendonsend")].filter(
    (el) => !el.parentElement?.closest("blockquote, .gmail_quote, .yahoo_quoted"),
  );
  const first = candidates[0];
  if (!first) return;
  const groups: Element[] = [first];
  const prev = first.previousElementSibling;
  if (prev && (/\bwrote:\s*$/i.test(prev.textContent?.trim() ?? "") || prev.classList.contains("gmail_attr"))) groups.unshift(prev);
  // Everything after the first quote is history too.
  let next = first.nextElementSibling;
  while (next) {
    groups.push(next);
    next = next.nextElementSibling;
  }
  const before = (body.textContent ?? "").replace(groups.map((g) => g.textContent ?? "").join(""), "").trim();
  if (before.length < 2) return; // a forwarded message with nothing above the quote: show it all
  wrapQuote(doc, groups);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"').,;:!?\]]/g;
function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (u) => `<a href="${u.replace(/&amp;/g, "&").replace(/"/g, "%22")}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

function plainToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    const two = `${l} ${lines[i + 1] ?? ""}`.trim();
    if (QUOTE_LEAD.test(l) || (/^On\b/.test(l) && QUOTE_LEAD.test(two) && !/\n/.test(two))) {
      cut = i;
      break;
    }
    if (/^>/.test(l) && i > 0) {
      cut = i;
      break;
    }
  }
  const render = (s: string) => linkify(escapeHtml(s));
  if (cut === -1 || lines.slice(0, cut).join("").trim().length < 2) return `<div class="ss-plain">${render(text.trim())}</div>`;
  const head = lines.slice(0, cut).join("\n").trim();
  const tail = lines.slice(cut).join("\n").trim();
  return `<div class="ss-plain">${render(head)}</div><details class="ss-quote"><summary aria-label="Show quoted text">···</summary><div class="ss-plain">${render(tail)}</div></details>`;
}

export function prepareBody(msg: Message, allowImages: boolean): PreparedBody {
  if (!msg.html || !msg.html.trim()) {
    return { kind: "plain", html: plainToHtml(msg.text || msg.snippet || ""), blocked: 0 };
  }
  const body = sanitizeToBody(msg.html);
  const kind = detectKind(body);
  const blocked = rewriteImages(body, msg, allowImages);
  if (kind === "simple") for (const el of body.querySelectorAll("[style]")) el.removeAttribute("style");
  collapseQuotes(body);
  return { kind, html: body.innerHTML, blocked };
}

/** Sanitized HTML for quoting an earlier message inside a reply or forward. */
export function quotableHtml(msg: Message): string {
  if (!msg.html) return `<div>${escapeHtml(msg.text).replace(/\n/g, "<br>")}</div>`;
  const body = sanitizeToBody(msg.html);
  for (const img of body.querySelectorAll("img")) img.remove();
  for (const s of body.querySelectorAll("style")) s.remove();
  return body.innerHTML;
}

/** Keep what the composer needs (text, links, lists, quotes) and drop everything else. */
export function sanitizeDraftHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "link", "meta", "base", "svg", "math", "img"],
    FORBID_ATTR: ["srcset", "style"],
    ALLOW_DATA_ATTR: false,
  });
}

/** The document placed in the sandboxed frame. The CSP is the second wall behind the sanitizer. */
export function frameDocument(bodyHtml: string, allowImages: boolean): string {
  const csp = `default-src 'none'; img-src data: 'self'${allowImages ? " https:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><meta name="color-scheme" content="light"><style>${FRAME_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

const FRAME_CSS = `
html{background:#fff}
body{margin:0;padding:0;background:#fff;color:#1b1f27;font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;overflow-wrap:anywhere;word-break:normal}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#2457c5}
pre{white-space:pre-wrap}
details.ss-quote{margin:10px 0}
details.ss-quote>summary{list-style:none;display:inline-block;cursor:pointer;padding:0 8px;line-height:16px;border-radius:5px;background:#e9ecf1;color:#4a5262;user-select:none}
details.ss-quote>summary::-webkit-details-marker{display:none}
details.ss-quote[open]>summary{margin-bottom:8px}
.ss-plain{white-space:pre-wrap}
`;
