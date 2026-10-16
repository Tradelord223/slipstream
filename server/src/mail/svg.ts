import sanitizeHtml from "sanitize-html";

/** Drawing elements and presentation attributes only: no script, style sheets, text, animation, links or embedded documents. */
const TAGS = [
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient",
  "radialGradient", "stop", "clipPath", "mask", "symbol", "use",
];
const COMMON = [
  "id", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "clip-path", "clip-rule",
  "mask", "style", "display", "visibility", "color",
];
const ATTRIBUTES: Record<string, string[]> = {
  svg: ["xmlns", "viewBox", "width", "height", "preserveAspectRatio", ...COMMON],
  g: COMMON,
  path: ["d", "pathLength", ...COMMON],
  circle: ["cx", "cy", "r", ...COMMON],
  ellipse: ["cx", "cy", "rx", "ry", ...COMMON],
  rect: ["x", "y", "width", "height", "rx", "ry", ...COMMON],
  line: ["x1", "y1", "x2", "y2", ...COMMON],
  polyline: ["points", ...COMMON],
  polygon: ["points", ...COMMON],
  defs: ["id"],
  linearGradient: ["id", "x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  radialGradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  stop: ["offset", "stop-color", "stop-opacity", "style", "id"],
  clipPath: ["id", "clipPathUnits", "transform"],
  mask: ["id", "x", "y", "width", "height", "maskUnits", "maskContentUnits"],
  symbol: ["id", "viewBox", "preserveAspectRatio"],
  use: ["x", "y", "width", "height", "href", "xlink:href", ...COMMON],
};
/** The inner text of these goes with the tag instead of surfacing as stray text. */
const NON_TEXT = ["script", "style", "textarea", "option", "foreignObject", "title", "desc", "metadata", "text", "tspan", "animate", "set"];

const SAME_DOCUMENT_ID = /^#[A-Za-z_][\w.-]*$/;
const URL_REFS = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi;

/** Attribute values: `url(#id)` is the only reference form allowed, and href must point inside the document. */
function safeValue(name: string, value: string): boolean {
  if (/[<>&\\]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (name === "href" || name === "xlink:href") return SAME_DOCUMENT_ID.test(value);
  if (/@import|javascript:|data:|expression\(|image-set|src\(/i.test(value)) return false;
  for (const m of value.matchAll(URL_REFS)) if (!SAME_DOCUMENT_ID.test(m[2]!.trim())) return false;
  const rest = value.replace(URL_REFS, "");
  return !/url\s*\(/i.test(rest) && !/[a-z][a-z0-9+.-]*:\/\//i.test(rest);
}

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i, /^rgba?\([\d\s.,%]+\)$/i, /^hsla?\([\d\s.,%deg]+\)$/i, /^url\(#[\w.-]+\)$/i];
const NUMBER = [/^-?[\d.]+(%|px)?$/];
const ALLOWED_STYLES: Record<string, RegExp[]> = {
  fill: COLOR,
  stroke: COLOR,
  "stop-color": COLOR,
  color: COLOR,
  opacity: NUMBER,
  "fill-opacity": NUMBER,
  "stroke-opacity": NUMBER,
  "stop-opacity": NUMBER,
  "stroke-width": NUMBER,
  "fill-rule": [/^(nonzero|evenodd)$/],
  "clip-rule": [/^(nonzero|evenodd)$/],
  "stroke-linecap": [/^(butt|round|square)$/],
  "stroke-linejoin": [/^(miter|round|bevel)$/],
};

/**
 * Reduces an SVG from the internet to plain vector drawing. Returns null when nothing drawable is left.
 * Run on every SVG before it is stored; the route also serves it with a locked-down CSP.
 */
export function sanitizeSvg(input: string): string | null {
  if (input.length > 400_000) return null;
  // Prolog, DOCTYPE (with any entity definitions) and comments carry nothing a logo needs.
  const text = input
    .replace(/^﻿/, "")
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (!/<svg[\s>]/i.test(text)) return null;
  const out = sanitizeHtml(text, {
    allowedTags: TAGS,
    allowedAttributes: ATTRIBUTES,
    allowedStyles: { "*": ALLOWED_STYLES },
    nonTextTags: NON_TEXT,
    allowedSchemes: [],
    allowProtocolRelative: false,
    // A logo is shapes only; any text node is junk (or an attempt to smuggle markup as escaped text).
    textFilter: () => "",
    parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false, decodeEntities: true },
    transformTags: {
      "*": (tagName, attribs) => {
        const clean: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) if (safeValue(name, value)) clean[name] = value;
        if (tagName === "svg") clean.xmlns = "http://www.w3.org/2000/svg";
        return { tagName, attribs: clean };
      },
    },
  }).trim();
  if (!out.startsWith("<svg") || !/<(path|circle|ellipse|rect|line|polyline|polygon|use)[\s>/]/.test(out)) return null;
  return out;
}
