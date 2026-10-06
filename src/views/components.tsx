import type { Status } from "../db/schema";
import { formatDateTime, timeAgo } from "../lib/time";
import { CsrfField } from "./layout";

export const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  accepted: "Accepted",
  in_progress: "In progress",
  merged: "Merged",
  nightly: "In nightly",
  released: "Released",
  declined: "Declined",
};

const STATUS_DOT: Record<Status, string> = {
  open: "bg-zinc-400",
  accepted: "bg-sky-500",
  in_progress: "bg-amber-500",
  merged: "bg-violet-500",
  nightly: "bg-teal-500",
  released: "bg-emerald-500",
  declined: "bg-rose-400",
};

export function StatusBadge(props: { status: Status }) {
  return (
    <span class="inline-flex items-center gap-1.5 text-xs text-muted">
      <span class={`size-1.5 rounded-full ${STATUS_DOT[props.status]}`} aria-hidden="true"></span>
      {STATUS_LABELS[props.status]}
    </span>
  );
}

export function Time(props: { date: Date }) {
  return (
    <time datetime={props.date.toISOString()} title={formatDateTime(props.date)}>
      {timeAgo(props.date)}
    </time>
  );
}

export function Labels(props: { labels: { id: number; name: string }[] }) {
  if (!props.labels.length) return null;
  return (
    <>
      {props.labels.map((l) => (
        <span class="chip">{l.name}</span>
      ))}
    </>
  );
}

export interface VoteProps {
  requestId: number;
  count: number;
  voted: boolean;
  signedIn: boolean;
  csrf: string | null;
  returnTo: string;
}

/** Vote control. Without htmx it's a normal form post; with htmx it swaps itself. */
export function VoteButton(props: VoteProps) {
  const base =
    "flex size-10 shrink-0 flex-col items-center justify-center rounded-md border text-xs font-medium tabular-nums leading-none";
  const style = props.voted ? "border-accent text-accent" : "border-line text-ink hover:bg-subtle";
  const content = (
    <>
      <svg viewBox="0 0 10 6" class="mb-1 h-1.5 w-2.5" aria-hidden="true">
        <path d="M5 0 10 6H0z" fill="currentColor" />
      </svg>
      <span>{props.count}</span>
    </>
  );
  if (!props.signedIn) {
    return (
      <a href={`/login?next=${encodeURIComponent(props.returnTo)}`} class={`${base} ${style}`} title="Sign in to vote" data-vote>
        {content}
      </a>
    );
  }
  return (
    <form
      method="post"
      action={`/requests/${props.requestId}/vote`}
      hx-post={`/requests/${props.requestId}/vote`}
      hx-swap="outerHTML"
      class="shrink-0"
    >
      <CsrfField token={props.csrf} />
      <input type="hidden" name="value" value={props.voted ? "0" : "1"} />
      <input type="hidden" name="next" value={props.returnTo} />
      <button
        type="submit"
        class={`${base} ${style}`}
        data-vote
        aria-pressed={props.voted ? "true" : "false"}
        aria-label={`${props.voted ? "Remove vote" : "Vote"} (${props.count} ${props.count === 1 ? "vote" : "votes"})`}
      >
        {content}
      </button>
    </form>
  );
}

export function Field(props: { label: string; name: string; error?: string; children: any; hint?: string }) {
  return (
    <div>
      <label class="label" for={props.name}>
        {props.label}
      </label>
      {props.children}
      {props.error ? <p class="error">{props.error}</p> : props.hint ? <p class="mt-1 text-xs text-muted">{props.hint}</p> : null}
    </div>
  );
}

export function Pager(props: { page: number; hasNext: boolean; href: (page: number) => string }) {
  if (props.page <= 1 && !props.hasNext) return null;
  return (
    <nav class="flex justify-between pt-4 text-sm" aria-label="Pagination">
      {props.page > 1 ? (
        <a class="link" href={props.href(props.page - 1)} aria-keyshortcuts="p">
          ← Previous
        </a>
      ) : (
        <span />
      )}
      {props.hasNext && (
        <a class="link" href={props.href(props.page + 1)} aria-keyshortcuts="n">
          Next →
        </a>
      )}
    </nav>
  );
}
