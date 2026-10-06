import { STATUSES, type Status } from "../db/schema";
import type { Viewer } from "../http";
import type { ListItem, Sort } from "../services/requests";
import { Labels, Pager, STATUS_LABELS, StatusBadge, Time, VoteButton } from "./components";
import { Layout } from "./layout";

export interface ListState {
  q: string;
  status?: Status;
  sort: Sort;
  page: number;
}

export function listHref(state: ListState, page = state.page) {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.status) params.set("status", state.status);
  if (state.sort !== (state.q ? "relevance" : "new")) params.set("sort", state.sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

interface ListProps {
  viewer: Viewer | null;
  csrf: string | null;
  state: ListState;
  items: ListItem[];
  hasNext: boolean;
}

export function ListPage(props: ListProps & { canonical: string }) {
  const { state } = props;
  return (
    <Layout title={state.q ? `Search: ${state.q}` : undefined} viewer={props.viewer} csrf={props.csrf} htmx path={listHref(state)} canonical={props.canonical}>
      <h1 class="sr-only">Feature requests</h1>
      <form
        method="get"
        action="/"
        class="flex flex-wrap items-center gap-2 border-b border-line pb-3"
        hx-get="/"
        hx-target="#results"
        hx-swap="outerHTML"
        hx-trigger="submit, change, input changed delay:300ms from:#q"
        role="search"
      >
        <input id="q" type="search" aria-keyshortcuts="/" name="q" value={state.q} placeholder="Search" aria-label="Search" class="input min-w-0 basis-full sm:flex-1 sm:basis-40" autocomplete="off" />
        <select name="status" class="input min-w-0 flex-1 sm:flex-none" aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option value={s} selected={state.status === s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <SortSelect state={state} />
        <noscript>
          <button type="submit" class="btn">
            Apply
          </button>
        </noscript>
        <a href="/requests/new" class="btn btn-primary sm:ml-auto" aria-label="New request" aria-keyshortcuts="c">
          <span class="sm:hidden">New</span>
          <span class="hidden sm:inline">New request</span>
        </a>
      </form>
      <Results {...props} />
    </Layout>
  );
}

export function SortSelect(props: { state: ListState; oob?: boolean }) {
  const { q, sort } = props.state;
  // The empty value is the default order: best match while searching, newest otherwise.
  const options: [string, string][] = [
    ["", q ? "Best match" : "Newest"],
    ...(q ? ([["new", "Newest"]] as [string, string][]) : []),
    ["votes", "Most votes"],
    ["activity", "Recent activity"],
  ];
  const selected = sort === (q ? "relevance" : "new") ? "" : sort;
  return (
    <select id="sort" name="sort" class="input min-w-0 flex-1 sm:flex-none" aria-label="Sort" hx-swap-oob={props.oob ? "true" : undefined}>
      {options.map(([value, label]) => (
        <option value={value} selected={selected === value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function Results(props: ListProps) {
  const { state } = props;
  const returnTo = listHref(state);
  return (
    <div id="results">
      {props.items.length === 0 ? (
        <p class="py-10 text-center text-muted">{state.q || state.status ? "No matching requests." : "No requests yet."}</p>
      ) : (
        <ul class="divide-y divide-line">
          {props.items.map((item) => (
            <li class="nav-item flex items-center gap-3 py-2" data-nav-item>
              <VoteButton requestId={item.id} count={item.voteCount} voted={item.voted} signedIn={!!props.viewer} csrf={props.csrf} returnTo={returnTo} />
              <div class="min-w-0 flex-1">
                <a href={`/requests/${item.id}`} data-nav-link class="block truncate font-medium hover:underline underline-offset-2">
                  {item.title}
                </a>
                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                  <StatusBadge status={item.status} />
                  <Labels labels={item.labels} />
                  <span class="inline-flex items-center gap-1" title={`${item.commentCount} comments`}>
                    <svg viewBox="0 0 16 16" class="size-3" aria-hidden="true">
                      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3 3v-3h0A1.5 1.5 0 0 1 2 9.5z" fill="none" stroke="currentColor" stroke-width="1.3" />
                    </svg>
                    {item.commentCount}
                  </span>
                  <span class="truncate">
                    {item.authorName} · <Time date={item.createdAt} />
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager page={state.page} hasNext={props.hasNext} href={(p) => listHref(state, p)} />
    </div>
  );
}
