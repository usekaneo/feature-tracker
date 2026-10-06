import { Hono } from "hono";
import { PRODUCTS, type Product } from "../db/schema";
import { noStore, type AppEnv } from "../http";
import { listChangelog } from "../services/changelog";
import { ChangelogPage, changelogHref } from "../views/changelog";

export function changelogRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/changelog", (c) => {
    const { db, config, changelog } = c.get("deps");
    const param = c.req.query("product");
    const product: Product = PRODUCTS.includes(param as Product) ? (param as Product) : "kaneo";
    const page = Math.min(Math.max(Number.parseInt(c.req.query("page") ?? "1", 10) || 1, 1), 1000);
    const result = listChangelog(db, product, page);
    c.header("Vary", "Cookie");
    if (c.get("viewer")) noStore(c);
    else c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.html(
      <ChangelogPage
        viewer={c.get("viewer")}
        csrf={c.get("csrf")}
        product={product}
        page={page}
        enabled={changelog.enabled}
        items={result.items}
        hasNext={result.hasNext}
        requests={result.requests}
        canonical={`${config.appUrl}${changelogHref(product, page)}`}
      />,
    );
  });

  return app;
}
