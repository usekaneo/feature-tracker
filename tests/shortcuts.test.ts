import { describe, expect, test } from "bun:test";
import { setup, signedIn, submitRequest } from "./helpers";

// keys.js drives these; the server only renders the hooks it looks for.
describe("keyboard shortcuts", () => {
  test("list rows, search and new request are bound", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    await submitRequest(alice.browser);
    const html = await (await alice.browser.get("/")).text();
    expect(html).toContain("keys.js");
    expect(html).toContain('id="shortcuts"');
    expect(html).toContain("data-nav-item");
    expect(html).toContain("data-nav-link");
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toContain('aria-keyshortcuts="c"');
  });

  test("request page binds vote, comment and edit for the author", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    const html = await (await alice.browser.get(`/requests/${id}`)).text();
    expect(html).toMatch(/<article[^>]*data-request/);
    expect(html).toContain("data-vote");
    expect(html).toMatch(/<textarea[^>]*aria-keyshortcuts="c"/);
    expect(html).toContain('aria-keyshortcuts="e"');
  });

  test("the htmx vote partial keeps its hook", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get(`/requests/${id}`);
    const res = await alice.browser.post(`/requests/${id}/vote`, { value: "1", next: `/requests/${id}` }, { htmx: true });
    expect(await res.text()).toContain("data-vote");
  });
});
