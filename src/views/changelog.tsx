import type { Product } from "../db/schema";
import type { Viewer } from "../http";
import { formatDate } from "../lib/time";
import { Pager } from "./components";
import { Layout } from "./layout";

export const PRODUCT_LABELS: Record<Product, string> = { kaneo: "Kaneo", mcp: "MCP" };

export function changelogHref(product: Product, page = 1) {
  const params = new URLSearchParams();
  if (product !== "kaneo") params.set("product", product);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/changelog?${qs}` : "/changelog";
}

export function ChangelogPage(props: {
  viewer: Viewer | null;
  csrf: string | null;
  product: Product;
  page: number;
  enabled: boolean;
  items: { tag: string; version: string; url: string; publishedAt: Date; bodyHtml: string }[];
  hasNext: boolean;
  requests: Map<string, { id: number; title: string }[]>;
  canonical: string;
}) {
  return (
    <Layout title={`${PRODUCT_LABELS[props.product]} changelog`} viewer={props.viewer} csrf={props.csrf} path={changelogHref(props.product, props.page)} canonical={props.canonical}>
      <div class="flex items-center justify-between gap-3 border-b border-line pb-3">
        <h1 class="text-base font-semibold">Changelog</h1>
        <nav class="flex rounded-md border border-line p-0.5 text-sm" aria-label="Product">
          {(Object.keys(PRODUCT_LABELS) as Product[]).map((p) => (
            <a
              href={changelogHref(p)}
              class={`rounded px-3 py-1 ${p === props.product ? "bg-subtle font-medium" : "text-muted hover:text-ink"}`}
              aria-current={p === props.product ? "page" : undefined}
            >
              {PRODUCT_LABELS[p]}
            </a>
          ))}
        </nav>
      </div>
      {props.items.length === 0 ? (
        <p class="py-10 text-center text-muted">{props.enabled ? "No releases yet." : "Changelog isn't available yet."}</p>
      ) : (
        <div class="divide-y divide-line">
          {props.items.map((release) => {
            const shipped = props.requests.get(release.tag) ?? [];
            return (
              <article id={release.tag} class="py-6">
                <header class="mb-3 flex items-baseline gap-3">
                  <h2 class="text-base font-semibold">
                    <a href={`#${release.tag}`} class="hover:underline underline-offset-2">
                      {release.version}
                    </a>
                  </h2>
                  <time datetime={release.publishedAt.toISOString()} class="text-xs text-muted">
                    {formatDate(release.publishedAt)}
                  </time>
                  <a href={release.url} class="ml-auto text-xs text-muted hover:text-ink" rel="noopener">
                    GitHub ↗
                  </a>
                </header>
                {shipped.length > 0 && (
                  <div class="notice mb-4 text-xs">
                    <span class="font-medium">Requested here:</span>{" "}
                    {shipped.map((r, i) => (
                      <>
                        {i > 0 && ", "}
                        <a href={`/requests/${r.id}`} class="link">
                          {r.title}
                        </a>
                      </>
                    ))}
                  </div>
                )}
                <div class="prose-ft prose-changelog" dangerouslySetInnerHTML={{ __html: release.bodyHtml }} />
              </article>
            );
          })}
        </div>
      )}
      <Pager page={props.page} hasNext={props.hasNext} href={(p) => changelogHref(props.product, p)} />
    </Layout>
  );
}
