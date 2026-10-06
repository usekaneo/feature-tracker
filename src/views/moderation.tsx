import { REPORT_REASONS, type ModerationAction, type ReportReason } from "../db/schema";
import type { Viewer } from "../http";
import { BAN_REASON_MAX, REPORT_NOTE_MAX, type LogEntry, type ModeratedUser, type QueueItem } from "../services/moderation";
import { Time } from "./components";
import { CsrfField, Layout } from "./layout";

export const REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  abuse: "Harassment or abuse",
  off_topic: "Off-topic",
  other: "Something else",
};

const ACTION_LABELS: Record<ModerationAction, string> = {
  hide_request: "hid request",
  unhide_request: "unhid request",
  lock_request: "locked request",
  unlock_request: "unlocked request",
  hide_comment: "hid a comment on request",
  unhide_comment: "unhid a comment on request",
  dismiss_reports: "dismissed reports on request",
  ban_user: "suspended",
  unban_user: "lifted the suspension of",
};

const targetHref = (t: { requestId: number; commentId: number | null }) =>
  t.commentId === null ? `/requests/${t.requestId}` : `/requests/${t.requestId}#comment-${t.commentId}`;

export function ReportPage(props: {
  viewer: Viewer;
  csrf: string | null;
  action: string;
  kind: "request" | "comment";
  title: string;
  excerpt: string;
  cancel: string;
  reason?: string;
  note?: string;
  error?: string;
}) {
  return (
    <Layout title={`Report ${props.kind}`} viewer={props.viewer} csrf={props.csrf} noindex>
      <h1 class="mb-1 text-base font-semibold">Report {props.kind}</h1>
      <p class="mb-4 text-xs text-muted">Maintainers review reports. The author isn't told who reported them.</p>
      <blockquote class="mb-4 border-l-2 border-line pl-3 text-muted">
        <p class="font-medium text-ink">{props.title}</p>
        {props.excerpt && <p class="mt-1 break-words">{props.excerpt}</p>}
      </blockquote>
      <form method="post" action={props.action} class="space-y-4">
        <CsrfField token={props.csrf} />
        <fieldset class="space-y-1.5">
          <legend class="label">Reason</legend>
          {REPORT_REASONS.map((r) => (
            <label class="flex items-center gap-2">
              <input type="radio" name="reason" value={r} checked={props.reason === r} required />
              {REASON_LABELS[r]}
            </label>
          ))}
        </fieldset>
        <div>
          <label class="label" for="note">
            Details <span class="font-normal text-muted">(optional)</span>
          </label>
          <textarea id="note" name="note" rows={3} class="textarea" maxlength={REPORT_NOTE_MAX}>
            {props.note ?? ""}
          </textarea>
        </div>
        {props.error && <p class="error">{props.error}</p>}
        <div class="flex justify-end gap-2">
          <a href={props.cancel} class="btn">
            Cancel
          </a>
          <button type="submit" class="btn btn-primary">
            Send report
          </button>
        </div>
      </form>
    </Layout>
  );
}

export function ModerationPage(props: {
  viewer: Viewer;
  csrf: string | null;
  queue: QueueItem[];
  banned: { id: string; name: string; email: string; bannedAt: Date; banReason: string | null }[];
  log: LogEntry[];
}) {
  return (
    <Layout title="Moderation" viewer={props.viewer} csrf={props.csrf} noindex>
      <h1 class="mb-4 text-base font-semibold">Moderation</h1>

      <section>
        <h2 class="border-b border-line pb-2 text-sm font-semibold">
          Reports <span class="font-normal text-muted">{props.queue.length}</span>
        </h2>
        {props.queue.length === 0 && <p class="py-4 text-muted">Nothing to review.</p>}
        <div class="divide-y divide-line">
          {props.queue.map((item) => (
            <QueueRow item={item} csrf={props.csrf} />
          ))}
        </div>
      </section>

      <section class="mt-10">
        <h2 class="border-b border-line pb-2 text-sm font-semibold">
          Suspended accounts <span class="font-normal text-muted">{props.banned.length}</span>
        </h2>
        {props.banned.length === 0 && <p class="py-4 text-muted">No suspended accounts.</p>}
        <ul class="divide-y divide-line">
          {props.banned.map((u) => (
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <a href={`/moderation/users/${u.id}`} class="link font-medium">
                {u.name}
              </a>
              <span class="text-xs text-muted">{u.email}</span>
              <span class="text-xs text-muted">
                <Time date={u.bannedAt} />
                {u.banReason && ` · ${u.banReason}`}
              </span>
              <form method="post" action={`/moderation/users/${u.id}/unban`} class="ml-auto">
                <CsrfField token={props.csrf} />
                <button type="submit" class="btn-link">
                  Lift suspension
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section class="mt-10">
        <h2 class="border-b border-line pb-2 text-sm font-semibold">Recent actions</h2>
        {props.log.length === 0 && <p class="py-4 text-muted">No actions yet.</p>}
        <ul class="mt-2 space-y-1 text-xs text-muted">
          {props.log.map((e) => (
            <li>
              <span class="text-ink">{e.actorName}</span> {ACTION_LABELS[e.action]}{" "}
              {e.requestId !== null ? (
                <a href={targetHref({ requestId: e.requestId, commentId: e.commentId })} class="link">
                  #{e.requestId}
                </a>
              ) : e.targetUserId ? (
                <a href={`/moderation/users/${e.targetUserId}`} class="link">
                  {e.targetUserName ?? "deleted user"}
                </a>
              ) : null}
              {e.note && ` · ${e.note}`} · <Time date={e.createdAt} />
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  );
}

function QueueRow(props: { item: QueueItem; csrf: string | null }) {
  const { item } = props;
  const target = (
    <>
      <CsrfField token={props.csrf} />
      <input type="hidden" name="requestId" value={String(item.requestId)} />
      {item.commentId !== null && <input type="hidden" name="commentId" value={String(item.commentId)} />}
    </>
  );
  return (
    <article class="py-3">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span class="chip">{item.commentId === null ? "Request" : "Comment"}</span>
        <a href={targetHref(item)} class="link font-medium text-ink">
          {item.commentId === null ? item.title : `On “${item.title}”`}
        </a>
        <span>
          by{" "}
          <a href={`/moderation/users/${item.authorId}`} class="link">
            {item.authorName}
          </a>
        </span>
        {item.authorBanned && <span class="chip">Suspended</span>}
        {item.hidden && <span class="chip">Hidden</span>}
      </div>
      {item.excerpt && <p class="mt-1 text-sm break-words">{item.excerpt}</p>}
      <ul class="mt-2 space-y-0.5 text-xs text-muted">
        {item.reports.map((r) => (
          <li>
            <span class="text-ink">{REASON_LABELS[r.reason]}</span> · {r.reporterName} · <Time date={r.createdAt} />
            {r.note && <span class="block break-words pl-3">{r.note}</span>}
          </li>
        ))}
      </ul>
      <div class="mt-2 flex flex-wrap gap-2">
        {!item.hidden && (
          <form method="post" action="/moderation/reports/hide">
            {target}
            <button type="submit" class="btn btn-sm">
              Hide {item.commentId === null ? "request" : "comment"}
            </button>
          </form>
        )}
        <form method="post" action="/moderation/reports/dismiss">
          {target}
          <button type="submit" class="btn btn-sm">
            {item.hidden ? "Close" : "Dismiss"}
          </button>
        </form>
        {item.authorRole !== "maintainer" && !item.authorBanned && (
          <a href={`/moderation/users/${item.authorId}`} class="btn btn-sm">
            Suspend author…
          </a>
        )}
      </div>
    </article>
  );
}

export function ModeratedUserPage(props: { viewer: Viewer; csrf: string | null; user: ModeratedUser; error?: string }) {
  const u = props.user;
  return (
    <Layout title={u.name} viewer={props.viewer} csrf={props.csrf} noindex>
      <a href="/moderation" class="btn-link">
        ← Moderation
      </a>
      <h1 class="mt-4 text-base font-semibold">{u.name}</h1>
      <p class="mt-1 text-xs text-muted">
        {u.email} · joined <Time date={u.createdAt} /> · {u.requests} {u.requests === 1 ? "request" : "requests"} · {u.comments}{" "}
        {u.comments === 1 ? "comment" : "comments"} · {u.reports} open {u.reports === 1 ? "report" : "reports"}
      </p>
      {props.error && <p class="notice mt-3">{props.error}</p>}
      {u.role === "maintainer" ? (
        <p class="mt-4 text-muted">Maintainers can't be suspended. Revoke the role on the server first.</p>
      ) : u.bannedAt ? (
        <div class="mt-4 space-y-2">
          <p class="notice">
            Suspended <Time date={u.bannedAt} />
            {u.banReason && `: ${u.banReason}`}
          </p>
          <form method="post" action={`/moderation/users/${u.id}/unban`}>
            <CsrfField token={props.csrf} />
            <button type="submit" class="btn btn-sm">
              Lift suspension
            </button>
          </form>
          <p class="text-xs text-muted">Hidden requests and comments stay hidden.</p>
        </div>
      ) : (
        <form method="post" action={`/moderation/users/${u.id}/ban`} class="mt-4 space-y-3">
          <CsrfField token={props.csrf} />
          <div>
            <label class="label" for="reason">
              Reason <span class="font-normal text-muted">(internal)</span>
            </label>
            <input id="reason" name="reason" class="input" maxlength={BAN_REASON_MAX} />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="hideContent" value="1" />
            Also hide all of their requests and comments
          </label>
          <p class="text-xs text-muted">Suspended accounts can still sign in and read, but can't post, edit, vote or report.</p>
          <button type="submit" class="btn btn-primary btn-sm">
            Suspend account
          </button>
        </form>
      )}
    </Layout>
  );
}
