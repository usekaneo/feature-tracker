import { STATUSES } from "../db/schema";
import { isMaintainer, type Viewer } from "../http";
import { ISSUE_STATUSES, LIMITS, type CommentItem, type RequestDetail } from "../services/requests";
import { Field, Labels, STATUS_LABELS, StatusBadge, Time, VoteButton } from "./components";
import { CsrfField, Layout } from "./layout";
import { FollowButton } from "./notifications";

interface PageProps {
  viewer: Viewer | null;
  csrf: string | null;
  req: RequestDetail;
  comments: CommentItem[];
  hasMoreComments: boolean;
  allLabels: { id: number; name: string }[];
  /** owner/name of the issue repository, null when not configured. */
  issueRepo: string | null;
  autoLabelEnabled: boolean;
  /** Whether the viewer follows this request. */
  following: boolean;
  canonical: string;
  description: string;
  flash?: string;
}

export function RequestPage(props: PageProps) {
  const { req, viewer } = props;
  const path = `/requests/${req.id}`;
  const canEdit = viewer?.id === req.authorId && !viewer.banned;
  return (
    <Layout title={req.title} viewer={viewer} csrf={props.csrf} htmx path={path} canonical={props.canonical} description={props.description} noindex={req.hidden}>
      <a href="/" class="btn-link">
        ← All requests
      </a>
      {props.flash && <p class="notice mt-3">{props.flash}</p>}
      {req.hidden && <p class="notice mt-3">This request is hidden from the public.</p>}
      {/* Below sm the body spans the full width instead of sitting beside the vote button. */}
      <article class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3" data-request>
        <VoteButton requestId={req.id} count={req.voteCount} voted={req.voted} signedIn={!!viewer} csrf={props.csrf} returnTo={path} />
        <div>
          <h1 class="text-base font-semibold leading-snug break-words">{req.title}</h1>
          <div class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
            <StatusBadge status={req.status} />
            <Labels labels={req.labels} />
            <span>
              <AuthorName id={req.authorId} name={req.authorName} viewer={viewer} /> · <Time date={req.createdAt} />
              {req.editedAt && " · edited"}
            </span>
            {canEdit && (
              <a href={`${path}/edit`} class="btn-link" aria-keyshortcuts="e">
                Edit
              </a>
            )}
            {viewer && <FollowButton requestId={req.id} following={props.following} csrf={props.csrf} />}
            {viewer && !viewer.banned && viewer.id !== req.authorId && (
              <a href={`${path}/report`} class="btn-link">
                Report
              </a>
            )}
          </div>
        </div>
        <div class="col-span-2 sm:col-span-1 sm:col-start-2">
          <div class="prose-ft mt-4" dangerouslySetInnerHTML={{ __html: req.bodyHtml }} />
          <IssueLine req={req} />
          {req.history.length > 0 && (
            <ul class="mt-4 space-y-0.5 text-xs text-muted" aria-label="Status history">
              {req.history.map((h) => (
                <li>
                  {STATUS_LABELS[h.toStatus]} · {h.actorName ?? "GitHub"} · <Time date={h.createdAt} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </article>
      {isMaintainer(viewer) && <MaintainerPanel {...props} />}
      <section id="discussion" class="mt-10">
        <h2 class="border-b border-line pb-2 text-sm font-semibold">
          Discussion <span id="comment-count" class="font-normal text-muted">{req.commentCount}</span>
        </h2>
        <div id="comments" class="divide-y divide-line">
          {props.comments.map((c) => (
            <CommentView comment={c} viewer={viewer} csrf={props.csrf} locked={req.locked} />
          ))}
          {props.hasMoreComments && <MoreComments requestId={req.id} afterId={props.comments.at(-1)!.id} />}
        </div>
        {props.comments.length === 0 && !props.hasMoreComments && (
          <p id="no-comments" class="py-4 text-muted">
            No comments yet.
          </p>
        )}
        <div class="mt-4">
          <CommentComposer requestId={req.id} viewer={viewer} csrf={props.csrf} locked={req.locked} />
        </div>
      </section>
    </Layout>
  );
}

function IssueLine(props: { req: RequestDetail }) {
  const issue = props.req.issue;
  if (!issue) return null;
  if (issue.state !== "created" || !issue.issueUrl) {
    return (
      <p class="mt-4 text-xs text-muted">
        GitHub issue <span class={issue.state === "failed" ? "text-danger" : ""}>{issue.state === "failed" ? "couldn't be opened" : "pending"}</span>
      </p>
    );
  }
  return (
    <p class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <a href={issue.issueUrl} class="link text-ink" rel="noopener">
        Issue #{issue.issueNumber}
      </a>
      {issue.prUrl && (
        <a href={issue.prUrl} class="link text-ink" rel="noopener">
          PR #{issue.prNumber}
        </a>
      )}
      {issue.nightlyUrl && !issue.releaseUrl && (
        <a href={issue.nightlyUrl} class="link text-ink" rel="noopener">
          {issue.nightlyTag}
        </a>
      )}
      {issue.releaseUrl && (
        <a href={issue.releaseUrl} class="link text-ink" rel="noopener">
          {issue.releaseTag}
        </a>
      )}
    </p>
  );
}

/** Maintainers get a link to the author's moderation page. */
function AuthorName(props: { id: string; name: string; viewer: Viewer | null }) {
  if (!isMaintainer(props.viewer)) return <>{props.name}</>;
  return (
    <a href={`/moderation/users/${props.id}`} class="hover:underline">
      {props.name}
    </a>
  );
}

export function MoreComments(props: { requestId: number; afterId: number }) {
  const href = `/requests/${props.requestId}/comments?after=${props.afterId}`;
  return (
    <div id="more-comments" class="py-3">
      <a href={`/requests/${props.requestId}?after=${props.afterId}#discussion`} hx-get={href} hx-target="#more-comments" hx-swap="outerHTML" class="btn btn-sm">
        Show more comments
      </a>
    </div>
  );
}

export function CommentView(props: { comment: CommentItem; viewer: Viewer | null; csrf: string | null; locked: boolean }) {
  const { comment: c, viewer } = props;
  const canEdit = viewer?.id === c.authorId && !viewer.banned && (!props.locked || isMaintainer(viewer));
  return (
    <article id={`comment-${c.id}`} class={`py-3 ${c.hidden ? "opacity-60" : ""}`}>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span class="font-medium text-ink">
          <AuthorName id={c.authorId} name={c.authorName} viewer={viewer} />
        </span>
        {c.authorRole === "maintainer" && <span class="chip">Maintainer</span>}
        <a href={`#comment-${c.id}`} class="hover:underline">
          <Time date={c.createdAt} />
        </a>
        {c.editedAt && <span>edited</span>}
        {c.hidden && <span class="chip">Hidden</span>}
        <span class="ml-auto flex items-center gap-4 sm:gap-3">
          {canEdit && (
            <a href={`/comments/${c.id}/edit`} hx-get={`/comments/${c.id}/edit`} hx-target={`#comment-${c.id}`} hx-swap="outerHTML" class="btn-link">
              Edit
            </a>
          )}
          {viewer && !viewer.banned && viewer.id !== c.authorId && (
            <a href={`/comments/${c.id}/report`} class="btn-link">
              Report
            </a>
          )}
          {isMaintainer(viewer) && (
            <form method="post" action={`/comments/${c.id}/hide`} class="contents">
              <CsrfField token={props.csrf} />
              <input type="hidden" name="hidden" value={c.hidden ? "0" : "1"} />
              <button type="submit" class="btn-link">
                {c.hidden ? "Unhide" : "Hide"}
              </button>
            </form>
          )}
        </span>
      </div>
      <div class="prose-ft mt-1" dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
    </article>
  );
}

export function CommentEditForm(props: { id: number; requestId: number; body: string; csrf: string | null; error?: string }) {
  return (
    <form id={`comment-${props.id}`} method="post" action={`/comments/${props.id}`} hx-post={`/comments/${props.id}`} hx-target="this" hx-swap="outerHTML" class="space-y-2 py-3">
      <CsrfField token={props.csrf} />
      <textarea name="body" rows={4} class="textarea" maxlength={LIMITS.commentMax} required aria-label="Comment">
        {props.body}
      </textarea>
      {props.error && <p class="error">{props.error}</p>}
      <div class="flex justify-end gap-2">
        <a href={`/requests/${props.requestId}#comment-${props.id}`} hx-get={`/comments/${props.id}`} hx-target={`#comment-${props.id}`} hx-swap="outerHTML" class="btn btn-sm">
          Cancel
        </a>
        <button type="submit" class="btn btn-primary btn-sm">
          Save
        </button>
      </div>
    </form>
  );
}

export function CommentComposer(props: { requestId: number; viewer: Viewer | null; csrf: string | null; locked: boolean; error?: string; body?: string; oob?: boolean }) {
  if (!props.viewer) {
    return (
      <p class="text-muted">
        <a class="link text-ink" href={`/login?next=${encodeURIComponent(`/requests/${props.requestId}#discussion`)}`}>
          Sign in
        </a>{" "}
        to comment.
      </p>
    );
  }
  if (props.viewer.banned) {
    return <p class="text-muted">Your account is suspended.</p>;
  }
  if (props.locked && !isMaintainer(props.viewer)) {
    return <p class="text-muted">Discussion is locked.</p>;
  }
  return (
    <form
      id="comment-form"
      method="post"
      action={`/requests/${props.requestId}/comments`}
      hx-post={`/requests/${props.requestId}/comments`}
      hx-target="#comments"
      hx-swap="beforeend"
      hx-swap-oob={props.oob ? "true" : undefined}
    >
      <CsrfField token={props.csrf} />
      <textarea name="body" rows={3} class="textarea" placeholder="Add a comment" aria-keyshortcuts="c" maxlength={LIMITS.commentMax} required aria-label="Comment">
        {props.body ?? ""}
      </textarea>
      {props.error && <p class="error">{props.error}</p>}
      <div class="mt-2 flex items-center justify-between">
        <span class="text-xs text-muted">{props.locked ? "Locked · maintainers only" : "Markdown supported"}</span>
        <button type="submit" class="btn btn-primary btn-sm">
          Comment
        </button>
      </div>
    </form>
  );
}

function MaintainerPanel(props: PageProps) {
  const { req, csrf } = props;
  const base = `/requests/${req.id}`;
  const assigned = new Set(req.labels.map((l) => l.id));
  const k = req.issue;
  return (
    <details class="mt-6 rounded-md border border-line" open={!!props.flash}>
      <summary class="flex items-center justify-between px-3 py-3 text-sm font-medium sm:py-2">
        Manage <span class="text-xs font-normal text-muted">Maintainer</span>
      </summary>
      <div class="space-y-4 border-t border-line p-3">
        <form method="post" action={`${base}/status`} class="flex flex-wrap items-center gap-2">
          <CsrfField token={csrf} />
          <label for="status" class="w-full text-xs text-muted sm:w-20">
            Status
          </label>
          <select id="status" name="status" class="input">
            {STATUSES.map((s) => (
              <option value={s} selected={req.status === s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <button type="submit" class="btn btn-sm">
            Update
          </button>
          {!k && props.issueRepo && (
            <span class="text-xs text-muted">
              {ISSUE_STATUSES.map((s) => STATUS_LABELS[s]).join(" or ")} opens an issue in {props.issueRepo}.
            </span>
          )}
        </form>

        <form method="post" action={`${base}/labels`} class="flex flex-wrap items-center gap-2">
          <CsrfField token={csrf} />
          <span class="w-full text-xs text-muted sm:w-20">Labels</span>
          {props.allLabels.length === 0 ? (
            <a href="/labels" class="btn-link">
              Create labels
            </a>
          ) : (
            <>
              {props.allLabels.map((l) => (
                <label class="inline-flex items-center gap-1.5 py-1 text-sm sm:gap-1 sm:py-0 sm:text-xs">
                  <input type="checkbox" name="label" value={String(l.id)} checked={assigned.has(l.id)} />
                  {l.name}
                </label>
              ))}
              <button type="submit" class="btn btn-sm">
                Save
              </button>
            </>
          )}
        </form>

        <div class="space-y-2 text-xs text-muted">
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-full sm:w-20">Auto-labeler</span>
            {!props.autoLabelEnabled ? <span>Disabled. Configure a labeling provider on the server.</span> : (
              <>
                <span>{req.labeling?.manualOverride ? "Maintainer labels preserved" : req.labeling?.state === "failed" ? "Labeling failed" : req.labeling?.state === "done" ? "Labeled automatically" : req.labeling ? "Labeling pending" : "Not labeled yet"}</span>
                {!req.hidden && <form method="post" action={`${base}/labels/auto`}>
                  <CsrfField token={csrf} />
                  <button type="submit" class="btn btn-sm">{req.labeling ? "Re-run auto-labeler" : "Run auto-labeler"}</button>
                </form>}
              </>
            )}
          </div>
          {req.labeling?.assessment && <p>
            {req.labeling.assessment.band} priority ({req.labeling.assessment.priority}/100) · {req.labeling.assessment.assessment.category.choice}
            {req.labeling.assessment.reviewReasons.length > 0 && ` · Review: ${req.labeling.assessment.reviewReasons.join(" ")}`}
          </p>}
          {req.labeling?.lastError && <p class="text-danger">{req.labeling.lastError}</p>}
          {props.autoLabelEnabled && <p>Saving labels preserves your choice through future edits. Re-running replaces previous automatic labels.</p>}
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="w-full text-xs text-muted sm:w-20">Moderation</span>
          <form method="post" action={`${base}/lock`}>
            <CsrfField token={csrf} />
            <input type="hidden" name="locked" value={req.locked ? "0" : "1"} />
            <button type="submit" class="btn btn-sm">
              {req.locked ? "Unlock discussion" : "Lock discussion"}
            </button>
          </form>
          <form method="post" action={`${base}/hide`}>
            <CsrfField token={csrf} />
            <input type="hidden" name="hidden" value={req.hidden ? "0" : "1"} />
            <button type="submit" class="btn btn-sm">
              {req.hidden ? "Unhide request" : "Hide request"}
            </button>
          </form>
        </div>

        {k && (
          <div class="flex flex-wrap items-start gap-2">
            <span class="w-full text-xs text-muted sm:w-20 sm:pt-1">GitHub</span>
            <div class="min-w-0 flex-1 basis-full space-y-2 sm:basis-0">
              <p class="text-xs">
                {k.state === "created"
                  ? k.checkedAt
                    ? "Issue linked. Checked "
                    : "Issue linked. Not checked yet."
                  : !props.issueRepo
                    ? "GitHub isn't configured. The issue will be opened once it is."
                    : k.state === "failed"
                      ? `Failed after ${k.attempts} attempt${k.attempts === 1 ? "" : "s"}.`
                      : k.state === "processing"
                        ? "Opening issue…"
                        : k.attempts > 0
                          ? `Waiting to retry (${k.attempts} attempt${k.attempts === 1 ? "" : "s"}).`
                          : "Queued."}
                {k.state === "created" && k.checkedAt && <Time date={k.checkedAt} />}
                {k.lastError && k.state !== "created" && <span class="block text-muted">{k.lastError}</span>}
                {k.checkError && k.state === "created" && <span class="block text-danger">{k.checkError}</span>}
              </p>
              {k.state === "created" && props.issueRepo && !k.releaseTag && (
                <form method="post" action={`${base}/github/check`}>
                  <CsrfField token={csrf} />
                  <button type="submit" class="btn btn-sm">
                    Check now
                  </button>
                </form>
              )}
              {k.state === "failed" && props.issueRepo && (
                <form method="post" action={`${base}/github/retry`}>
                  <CsrfField token={csrf} />
                  <button type="submit" class="btn btn-sm">
                    Retry
                  </button>
                </form>
              )}
              {(k.state === "failed" || k.state === "pending") && props.issueRepo && (
                <form method="post" action={`${base}/github/link`} class="flex gap-2">
                  <CsrfField token={csrf} />
                  <input name="issue" class="input min-w-0 sm:h-7 sm:text-xs" placeholder="Existing issue number or URL" aria-label="Existing GitHub issue" required />
                  <button type="submit" class="btn btn-sm">
                    Link
                  </button>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export function RequestForm(props: {
  viewer: Viewer;
  csrf: string | null;
  action: string;
  title: string;
  body: string;
  errors?: { title?: string; body?: string };
  heading: string;
  submit: string;
  cancel: string;
}) {
  return (
    <Layout title={props.heading} viewer={props.viewer} csrf={props.csrf} noindex>
      <h1 class="mb-4 text-base font-semibold">{props.heading}</h1>
      <form method="post" action={props.action} class="space-y-4">
        <CsrfField token={props.csrf} />
        <Field label="Title" name="title" error={props.errors?.title}>
          <input id="title" name="title" class="input" value={props.title} maxlength={LIMITS.titleMax} required autofocus />
        </Field>
        <Field label="Description" name="body" error={props.errors?.body} hint="Markdown supported.">
          <textarea id="body" name="body" rows={10} class="textarea" maxlength={LIMITS.bodyMax} required>
            {props.body}
          </textarea>
        </Field>
        <div class="flex justify-end gap-2">
          <a href={props.cancel} class="btn">
            Cancel
          </a>
          <button type="submit" class="btn btn-primary">
            {props.submit}
          </button>
        </div>
      </form>
    </Layout>
  );
}
