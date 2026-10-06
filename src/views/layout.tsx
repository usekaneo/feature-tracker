import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { Viewer } from "../http";
import { asset } from "../lib/assets";

export interface PageProps {
  title?: string;
  viewer: Viewer | null;
  csrf: string | null;
  /** Load htmx on this page. */
  htmx?: boolean;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  /** Current path, used for the login return target. */
  path?: string;
  children?: Child;
}

// No injected <style> or eval, so the strict CSP holds.
const HTMX_CONFIG = JSON.stringify({ includeIndicatorStyles: false, allowEval: false, allowScriptTags: false });

export function Layout(props: PageProps) {
  const title = props.title ? `${props.title} · Kaneo Feature Track` : "Kaneo Feature Track";
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
          {props.description && <meta name="description" content={props.description} />}
          {props.canonical && <link rel="canonical" href={props.canonical} />}
          {props.noindex && <meta name="robots" content="noindex" />}
          <meta name="color-scheme" content="light dark" />
          <link rel="preload" href="/assets/geist.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href={asset("app.css")} />
          <script src={asset("theme.js")}></script>
          <script src={asset("keys.js")} defer></script>
          <link rel="alternate" type="application/rss+xml" title="Kaneo Feature Track" href="/feed.xml" />
          <link rel="icon" href="data:," />
          {props.htmx && <meta name="htmx-config" content={HTMX_CONFIG} />}
          {props.htmx && <script src={asset("htmx.min.js")} defer></script>}
        </head>
        <body hx-headers={props.csrf ? JSON.stringify({ "x-csrf-token": props.csrf }) : undefined}>
          <div class="mx-auto w-full max-w-[1080px] px-4 sm:px-6">
            <Header viewer={props.viewer} csrf={props.csrf} path={props.path} />
            <main class="pb-16">{props.children}</main>
            <footer class="flex flex-wrap items-center gap-3 border-t border-line py-6 text-xs text-muted">
              <a href="/feed.xml" class="hover:text-ink">
                RSS
              </a>
              <a href="https://kaneo.app" class="hover:text-ink">
                kaneo.app
              </a>
              <a href="/privacy" class="ml-auto hover:text-ink">
                Privacy Policy
              </a>
              {/* keys.js reveals the button; without it there are no shortcuts. */}
              <button type="button" data-shortcuts-open aria-keyshortcuts="?" class="hidden hover:text-ink sm:inline" hidden>
                Keyboard shortcuts
              </button>
            </footer>
          </div>
          <ShortcutsDialog />
        </body>
      </html>
    </>
  );
}

function Header(props: { viewer: Viewer | null; csrf: string | null; path?: string }) {
  const next = props.path && props.path !== "/" ? `?next=${encodeURIComponent(props.path)}` : "";
  return (
    <header class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 py-3 sm:flex sm:h-16 sm:justify-between sm:py-0">
      <a href="/" class="flex shrink-0 items-center" aria-label="Kaneo home">
        <img src={asset("kaneo-logo-dark.svg")} alt="" width="450" height="104" class="kaneo-logo-dark h-6 w-auto shrink-0" />
        <img src={asset("kaneo-logo-light.svg")} alt="" width="450" height="104" class="kaneo-logo-light h-6 w-auto shrink-0" />
      </a>
      <nav aria-label="Main navigation" class="col-span-2 row-start-2 flex items-center justify-end gap-4 sm:ml-auto sm:mr-1">
        <a href="/" class="flex h-9 items-center text-sm text-muted whitespace-nowrap hover:text-ink sm:h-8">
          Feature Track
        </a>
        <a href="/changelog" class="flex h-9 items-center text-sm text-muted hover:text-ink sm:h-8">
          Changelog
        </a>
      </nav>
      <div class="col-start-2 row-start-1 flex shrink-0 items-center justify-self-end gap-0.5 sm:gap-1">
        <ThemeToggle />
        {props.viewer && <NotificationBell unread={props.viewer.unread} />}
        {props.viewer ? (
          <details class="relative" data-menu>
            <summary class="flex h-9 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-subtle sm:h-8 sm:px-2" aria-label="Account">
              <span class="grid size-6 place-items-center rounded-full bg-subtle text-xs font-medium uppercase sm:size-5 sm:text-[11px]">
                {props.viewer.name.trim().charAt(0) || "?"}
              </span>
              <span class="hidden max-w-36 truncate sm:block">{props.viewer.name}</span>
            </summary>
            <div class="menu">
              <div class="px-3 py-1.5">
                <div class="truncate text-sm font-medium sm:hidden">{props.viewer.name}</div>
                <div class="truncate text-xs text-muted">{props.viewer.email}</div>
              </div>
              {props.viewer.role === "maintainer" && (
                <>
                  <a href="/moderation" class="menu-item flex items-center justify-between">
                    Moderation
                    {props.viewer.openReports > 0 && <span class="chip">{props.viewer.openReports}</span>}
                  </a>
                  <a href="/labels" class="menu-item">
                    Labels
                  </a>
                </>
              )}
              <form method="post" action="/logout">
                <CsrfField token={props.csrf} />
                <button type="submit" class="menu-item">
                  Sign out
                </button>
              </form>
            </div>
          </details>
        ) : (
          <a href={`/login${next}`} class="flex h-9 items-center px-2 text-sm font-medium hover:underline underline-offset-2 sm:h-8 sm:px-0">
            Login
          </a>
        )}
      </div>
    </header>
  );
}

function NotificationBell(props: { unread: number }) {
  const label = props.unread ? `Notifications (${props.unread} unread)` : "Notifications";
  return (
    <a href="/notifications" class="relative grid size-9 place-items-center rounded-md text-muted hover:bg-subtle hover:text-ink sm:size-8" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6.5a4 4 0 0 1 8 0v2.75l1.25 2H2.75L4 9.25z" />
        <path d="M6.5 13.25a1.5 1.5 0 0 0 3 0" stroke-linecap="round" />
      </svg>
      {props.unread > 0 && (
        <span class="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-1 text-[10px] leading-none font-medium text-canvas tabular-nums" aria-hidden="true">
          {props.unread > 99 ? "99+" : props.unread}
        </span>
      )}
    </a>
  );
}

function ThemeToggle() {
  return (
    <button type="button" data-theme-toggle class="grid size-9 place-items-center rounded-md text-muted hover:bg-subtle hover:text-ink sm:size-8" aria-label="Toggle dark mode" title="Toggle dark mode">
      <svg viewBox="0 0 16 16" class="size-4 dark:hidden" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" stroke-linejoin="round" />
      </svg>
      <svg viewBox="0 0 16 16" class="hidden size-4 dark:block" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.75" />
        <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.2 3.2l1.06 1.06M11.74 11.74l1.06 1.06M3.2 12.8l1.06-1.06M11.74 4.26l1.06-1.06" />
      </svg>
    </button>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Anywhere",
    [
      ["g h", "Go to requests"],
      ["g c", "Go to changelog"],
      ["g n", "Go to notifications"],
      ["n / p", "Next or previous page"],
      ["Esc", "Leave a text field or close a menu"],
      ["?", "Show this list"],
    ],
  ],
  [
    "Requests",
    [
      ["j / k", "Move to the next or previous request"],
      ["o / Enter", "Open the selected request"],
      ["v", "Vote on the selected request"],
      ["/", "Search"],
      ["c", "New request"],
    ],
  ],
  [
    "Request",
    [
      ["v", "Vote"],
      ["c", "Write a comment"],
      ["e", "Edit"],
    ],
  ],
];

function ShortcutsDialog() {
  return (
    <dialog id="shortcuts" aria-labelledby="shortcuts-title" class="m-auto w-full max-w-sm rounded-md border border-line bg-canvas p-0 text-ink shadow-sm backdrop:bg-black/40">
      <div class="p-4">
        <div class="flex items-center justify-between">
          <h2 id="shortcuts-title" class="text-sm font-semibold">
            Keyboard shortcuts
          </h2>
          <form method="dialog">
            <button type="submit" class="btn-link">
              Close
            </button>
          </form>
        </div>
        {SHORTCUTS.map(([heading, keys]) => (
          <section class="mt-4">
            <h3 class="text-xs font-medium text-muted">{heading}</h3>
            <dl class="mt-1 space-y-1">
              {keys.map(([key, label]) => (
                <div class="flex items-center justify-between gap-4">
                  <dt>{label}</dt>
                  <dd class="flex shrink-0 gap-1">
                    {key.split(" ").map((part) => (part === "/" && key !== "/" ? <span class="text-muted">or</span> : <kbd>{part}</kbd>))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}

export function CsrfField(props: { token: string | null }) {
  return props.token ? <input type="hidden" name="_csrf" value={props.token} /> : null;
}
