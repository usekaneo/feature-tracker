import { Hono } from "hono";
import type { AppEnv } from "../http";
import { plainText } from "../lib/markdown";
import { feedItems, feedLastModified } from "../services/requests";

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderFeed(appUrl: string, items: ReturnType<typeof feedItems>, lastBuild: Date): string {
  const entries = items
    .map((item) => {
      const url = `${appUrl}/requests/${item.id}`;
      return `    <item>
      <title>${xmlEscape(item.title)}</title>
      <link>${xmlEscape(url)}</link>
      <guid isPermaLink="true">${xmlEscape(url)}</guid>
      <pubDate>${item.createdAt.toUTCString()}</pubDate>
      <description>${xmlEscape(plainText(item.bodyHtml, 500))}</description>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Kaneo Feature Track</title>
    <link>${xmlEscape(`${appUrl}/`)}</link>
    <description>New feature requests for Kaneo</description>
    <language>en</language>
    <lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>
    <atom:link href="${xmlEscape(`${appUrl}/feed.xml`)}" rel="self" type="application/rss+xml" />
${entries}
  </channel>
</rss>
`;
}

export function feedRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/feed.xml", (c) => {
    const { db, config } = c.get("deps");
    const lastModified = feedLastModified(db) ?? new Date(0);
    const xml = renderFeed(config.appUrl, feedItems(db), lastModified);
    const etag = `"${Bun.hash(xml).toString(36)}"`;
    c.header("ETag", etag);
    c.header("Last-Modified", lastModified.toUTCString());
    c.header("Cache-Control", "public, max-age=300");
    c.header("Content-Type", "application/rss+xml; charset=utf-8");

    const ifNoneMatch = c.req.header("if-none-match");
    const ifModifiedSince = c.req.header("if-modified-since");
    // If-None-Match takes precedence over If-Modified-Since (RFC 9110 §13.2.2).
    const notModified = ifNoneMatch
      ? ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*")
      : ifModifiedSince
        ? Math.floor(lastModified.getTime() / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000)
        : false;
    if (notModified) return c.body(null, 304);
    return c.body(xml);
  });

  return app;
}
