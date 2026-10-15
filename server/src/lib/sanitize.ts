import sanitizeHtml from "sanitize-html";

/**
 * Outgoing mail and snippet bodies come from our own editor, but the API accepts any HTML,
 * so it's reduced to the formatting the editor can produce before it's stored or sent.
 */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "div", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "a", "ul", "ol", "li",
      "blockquote", "pre", "code", "h1", "h2", "h3", "hr", "img", "table", "thead", "tbody", "tr", "td", "th",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
      "*": ["style", "dir"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "cid"],
    allowedSchemesByTag: { img: ["https", "cid", "data"] },
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
        "font-weight": [/^(bold|normal|\d{3})$/],
        "font-style": [/^(italic|normal)$/],
        "text-decoration": [/^[a-z\s-]+$/],
        "text-align": [/^(left|right|center|justify)$/],
        "margin-left": [/^\d+(px|em)$/],
        "padding-left": [/^\d+(px|em)$/],
      },
    },
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
    },
  });
}

/** Plain text with no markup at all (comments, names). */
export function stripAllHtml(text: string): string {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}
