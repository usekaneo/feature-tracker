import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const marked = new Marked({ gfm: true, breaks: true, async: false });

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "span", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: { a: ["href", "rel"], ol: ["start"], th: ["align"], td: ["align"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  // Headings are demoted so user content never competes with page headings.
  transformTags: {
    h1: "h3",
    h2: "h4",
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "nofollow ugc noopener noreferrer" },
    }),
    // Images are rendered as plain links to avoid tracking pixels and mixed content.
    img: (_tagName, attribs) => {
      const src = attribs.src ?? "";
      const text = attribs.alt || src || "image";
      return /^https?:\/\//i.test(src)
        ? { tagName: "a", attribs: { href: src, rel: "nofollow ugc noopener noreferrer" }, text }
        : { tagName: "span", attribs: {} as Record<string, string>, text };
    },
  },
};

export function renderMarkdown(source: string): string {
  const html = marked.parse(source) as string;
  return sanitizeHtml(html, SANITIZE);
}

/** Plain text excerpt for feeds and meta descriptions. */
export function plainText(html: string, max = 280): string {
  const spaced = html.replace(/<(br|\/p|\/li|\/h\d|\/tr|\/td|\/th|\/blockquote|\/pre)\b[^>]*>/gi, "$& ");
  const text = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
