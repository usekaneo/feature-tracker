import type { Viewer } from "../http";
import { plainText } from "../lib/markdown";
import type { EmailPrefs, NotificationItem } from "../services/notifications";
import { Pager, StatusBadge, Time } from "./components";
import { CsrfField, Layout } from "./layout";

export function NotificationsPage(props: {
  viewer: Viewer;
  csrf: string | null;
  items: NotificationItem[];
  page: number;
  hasNext: boolean;
  prefs: EmailPrefs;
  flash?: string;
}) {
  const unread = props.items.some((n) => !n.read);
  return (
    <Layout title="Notifications" viewer={props.viewer} csrf={props.csrf} noindex>
      <div class="mb-2 flex items-center justify-between border-b border-line pb-2">
        <h1 class="text-base font-semibold">Notifications</h1>
        {unread && (
          <form method="post" action="/notifications/read">
            <CsrfField token={props.csrf} />
            <button type="submit" class="btn btn-sm">
              Mark all as read
            </button>
          </form>
        )}
      </div>
      {props.flash && <p class="notice mb-3">{props.flash}</p>}
      {props.items.length === 0 ? (
        <p class="py-10 text-center text-muted">
          {props.page > 1 ? "No more notifications." : "No notifications yet. You follow requests you submit, vote on or comment on."}
        </p>
      ) : (
        <ul class="divide-y divide-line">
          {props.items.map((n) => (
            <NotificationRow item={n} />
          ))}
        </ul>
      )}
      <Pager page={props.page} hasNext={props.hasNext} href={(p) => (p > 1 ? `/notifications?page=${p}` : "/notifications")} />

      <section class="mt-10">
        <h2 class="border-b border-line pb-2 text-sm font-semibold">Email</h2>
        <form method="post" action="/notifications/settings" class="mt-3 space-y-2">
          <CsrfField token={props.csrf} />
          <label class="flex items-center gap-2">
            <input type="checkbox" name="status" value="1" checked={props.prefs.status} />
            Status changes on requests I follow
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" name="comment" value="1" checked={props.prefs.comment} />
            New comments on requests I follow
          </label>
          <p class="text-xs text-muted">Sent to {props.viewer.email}.</p>
          <button type="submit" class="btn btn-sm">
            Save
          </button>
        </form>
      </section>
    </Layout>
  );
}

function NotificationRow(props: { item: NotificationItem }) {
  const n = props.item;
  const href = n.commentId ? `/requests/${n.requestId}#comment-${n.commentId}` : `/requests/${n.requestId}`;
  return (
    <li class="nav-item flex gap-3 py-2.5" data-nav-item>
      <span class={`mt-2 size-1.5 shrink-0 rounded-full ${n.read ? "" : "bg-accent"}`} aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <a href={href} data-nav-link class={`block truncate hover:underline underline-offset-2 ${n.read ? "" : "font-medium"}`}>
          {n.requestTitle}
          {!n.read && <span class="sr-only"> (unread)</span>}
        </a>
        <div class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          {n.kind === "status" ? (
            <>
              <span>{n.actorName ?? "GitHub"} changed the status to</span>
              <StatusBadge status={n.toStatus!} />
            </>
          ) : (
            <span>{n.actorName ?? "Someone"} commented</span>
          )}
          <span>·</span>
          <Time date={n.createdAt} />
        </div>
        {n.kind === "comment" && n.commentHtml && <p class="mt-0.5 truncate text-muted">{plainText(n.commentHtml, 160)}</p>}
      </div>
    </li>
  );
}

/** Follow toggle on the request page. Without htmx it's a normal form post; with htmx it swaps itself. */
export function FollowButton(props: { requestId: number; following: boolean; csrf: string | null }) {
  const action = `/requests/${props.requestId}/follow`;
  return (
    <form method="post" action={action} hx-post={action} hx-swap="outerHTML" class="contents">
      <CsrfField token={props.csrf} />
      <input type="hidden" name="value" value={props.following ? "0" : "1"} />
      <button
        type="submit"
        class="btn-link"
        aria-pressed={props.following ? "true" : "false"}
        title={props.following ? "You get notified about status changes and comments" : "Get notified about status changes and comments"}
      >
        {props.following ? "Following" : "Follow"}
      </button>
    </form>
  );
}

export function UnfollowPage(props: {
  viewer: Viewer | null;
  csrf: string | null;
  request: { id: number; title: string } | null;
  userId: string;
  token: string;
  done?: boolean;
}) {
  const req = props.request;
  return (
    <Layout title="Unfollow" viewer={props.viewer} csrf={props.csrf} noindex>
      <div class="py-16 text-center">
        {!req ? (
          <>
            <h1 class="text-base font-semibold">Link not valid</h1>
            <p class="mt-1 text-muted">This unfollow link is broken or the request no longer exists.</p>
          </>
        ) : props.done ? (
          <>
            <h1 class="text-base font-semibold">Unfollowed</h1>
            <p class="mt-1 text-muted">You won't get notifications about “{req.title}” anymore.</p>
            <p class="mt-4">
              <a href={`/requests/${req.id}`} class="link">
                View request
              </a>
            </p>
          </>
        ) : (
          <>
            <h1 class="text-base font-semibold">Unfollow this request?</h1>
            <p class="mt-1 text-muted">You'll stop getting notifications about “{req.title}”.</p>
            <form method="post" action="/unfollow" class="mt-4">
              <CsrfField token={props.csrf} />
              <input type="hidden" name="u" value={props.userId} />
              <input type="hidden" name="r" value={String(req.id)} />
              <input type="hidden" name="t" value={props.token} />
              <button type="submit" class="btn btn-primary">
                Unfollow
              </button>
            </form>
          </>
        )}
      </div>
    </Layout>
  );
}
