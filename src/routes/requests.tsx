import { Hono, type MiddlewareHandler } from "hono";
import type { Child } from "hono/jsx";
import { STATUSES, type Status } from "../db/schema";
import { formString, hasSessionCookie, isHtmx, isMaintainer, limited, noStore, parseId, safeNext, type AppEnv, type Ctx, type Viewer } from "../http";
import { plainText } from "../lib/markdown";
import {
  addComment,
  createLabel,
  createRequest,
  deleteLabel,
  getComment,
  getCommentSource,
  getRequest,
  getRequestMeta,
  LIMITS,
  listComments,
  listLabels,
  listRequests,
  setRequestLabels,
  setStatus,
  setVote,
  SORTS,
  updateComment,
  updateRequest,
  validateComment,
  validateRequest,
  type Sort,
} from "../services/requests";
import { VoteButton } from "../views/components";
import { Layout } from "../views/layout";
import { listHref, ListPage, Results, SortSelect, type ListState } from "../views/list";
import { LabelsPage, MessagePage } from "../views/misc";
import { CommentComposer, CommentEditForm, CommentView, MoreComments, RequestForm, RequestPage } from "../views/request";
import { isFollowing, markRequestRead, unreadCount } from "../services/notifications";
import { setCommentHidden, setRequestHidden, setRequestLocked } from "../services/moderation";

const isStatus = (value: string | undefined): value is Status => STATUSES.includes(value as Status);

export function notFound(c: Ctx) {
  return c.html(<MessagePage viewer={c.get("viewer")} csrf={c.get("csrf")} title="Not found" message="This page doesn't exist or was removed." />, 404);
}

export function forbidden(c: Ctx, message = "You can't do that.") {
  if (isHtmx(c)) return c.text(message, 403);
  return c.html(<MessagePage viewer={c.get("viewer")} csrf={c.get("csrf")} title="Not allowed" message={message} />, 403);
}

/** Viewer guaranteed by requireUser. */
export const viewerOf = (c: Ctx) => c.get("viewer") as Viewer;

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  noStore(c);
  if (c.get("viewer")) return next();
  const back = c.req.method === "GET" ? c.req.path : (c.req.header("hx-current-url") ? new URL(c.req.header("hx-current-url")!).pathname : "/");
  const login = `/login?next=${encodeURIComponent(safeNext(back))}`;
  if (isHtmx(c)) {
    c.header("HX-Redirect", login);
    return c.body(null, 401);
  }
  return c.redirect(login, 303);
};

/** requireUser, and the account isn't suspended. Guards posting, editing, voting and reporting. */
export const requireActive: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("viewer")) return requireUser(c, next);
  noStore(c);
  if (viewerOf(c).banned) return forbidden(c, "Your account is suspended.");
  return next();
};

export const requireMaintainer: MiddlewareHandler<AppEnv> = async (c, next) => {
  noStore(c);
  if (!c.get("viewer")) return requireUser(c, next);
  if (!isMaintainer(c.get("viewer"))) return forbidden(c);
  const blocked = limited(c, c.get("deps").limits.moderation, viewerOf(c).id);
  return blocked ?? next();
};

function publicCache(c: Ctx) {
  // Shared caches may store anonymous pages briefly; anything tied to a session cookie is private.
  c.header("Vary", "Cookie, HX-Request, HX-Target");
  if (c.get("viewer") || hasSessionCookie(c)) noStore(c);
  else c.header("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
}

export function requestRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const { db, config } = c.get("deps");
    const viewer = c.get("viewer");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const statusParam = c.req.query("status");
    const sortParam = c.req.query("sort") as Sort | undefined;
    const sort: Sort = sortParam && SORTS.includes(sortParam) && (sortParam !== "relevance" || q) ? sortParam : q ? "relevance" : "new";
    const page = Math.min(Math.max(Number.parseInt(c.req.query("page") ?? "1", 10) || 1, 1), 1000);
    const state: ListState = { q, status: isStatus(statusParam) ? statusParam : undefined, sort, page };
    const result = listRequests(db, { ...state, viewerId: viewer?.id });
    publicCache(c);
    const props = { viewer, csrf: c.get("csrf"), state, items: result.items, hasNext: result.hasNext };
    if (isHtmx(c) && c.req.header("hx-target") === "results") {
      c.header("HX-Push-Url", listHref(state));
      return c.html(
        <>
          <Results {...props} />
          <SortSelect state={state} oob />
        </>,
      );
    }
    return c.html(<ListPage {...props} canonical={`${config.appUrl}/`} />);
  });

  // Submission

  app.get("/requests/new", requireActive, (c) =>
    c.html(<RequestForm viewer={viewerOf(c)} csrf={c.get("csrf")} action="/requests" title="" body="" heading="New request" submit="Submit" cancel="/" />),
  );

  app.post("/requests", requireActive, async (c) => {
    const { db, limits } = c.get("deps");
    const viewer = viewerOf(c);
    const body = await c.req.parseBody();
    const title = formString(body, "title").replace(/\s+/g, " ");
    const text = formString(body, "body");
    const errors = validateRequest(title, text);
    if (errors.title || errors.body) {
      return c.html(
        <RequestForm viewer={viewer} csrf={c.get("csrf")} action="/requests" title={title} body={text} errors={errors} heading="New request" submit="Submit" cancel="/" />,
        422,
      );
    }
    const blocked = limited(c, limits.request, viewer.id);
    if (blocked) return blocked;
    const id = createRequest(db, { title, body: text, authorId: viewer.id });
    c.get("deps").labeler.kick(id);
    return c.redirect(`/requests/${id}`, 303);
  });

  // Detail

  app.get("/requests/:id", (c) => renderRequest(c));

  app.get("/requests/:id/comments", (c) => {
    const { db } = c.get("deps");
    const id = parseId(c.req.param("id"));
    const afterId = parseId(c.req.query("after")) ?? 0;
    const viewer = c.get("viewer");
    const meta = id ? getRequestMeta(db, id) : null;
    if (!meta || (meta.hidden && !isMaintainer(viewer))) return notFound(c);
    const { items, hasMore } = listComments(db, meta.id, { includeHidden: isMaintainer(viewer), afterId });
    publicCache(c);
    return c.html(
      <>
        {items.map((comment) => (
          <CommentView comment={comment} viewer={viewer} csrf={c.get("csrf")} locked={meta.locked} />
        ))}
        {hasMore && <MoreComments requestId={meta.id} afterId={items.at(-1)!.id} />}
      </>,
    );
  });

  // Votes

  app.post("/requests/:id/vote", requireActive, async (c) => {
    const { db, limits } = c.get("deps");
    const viewer = viewerOf(c);
    const id = parseId(c.req.param("id"));
    if (!id) return notFound(c);
    const body = await c.req.parseBody();
    const value = formString(body, "value");
    const blocked = limited(c, limits.vote, viewer.id);
    if (blocked) return blocked;
    const result = setVote(db, id, viewer.id, value === "1" ? true : value === "0" ? false : undefined);
    if (!result) return notFound(c);
    if (isHtmx(c)) {
      return c.html(
        <VoteButton requestId={id} count={result.voteCount} voted={result.voted} signedIn csrf={c.get("csrf")} returnTo={safeNext(formString(body, "next"), `/requests/${id}`)} />,
      );
    }
    return c.redirect(safeNext(formString(body, "next"), `/requests/${id}`), 303);
  });

  // Comments

  app.post("/requests/:id/comments", requireActive, async (c) => {
    const { db, limits } = c.get("deps");
    const viewer = viewerOf(c);
    const id = parseId(c.req.param("id"));
    const meta = id ? getRequestMeta(db, id) : null;
    if (!meta || (meta.hidden && !isMaintainer(viewer))) return notFound(c);
    if (meta.locked && !isMaintainer(viewer)) return forbidden(c, "Discussion is locked.");
    const body = await c.req.parseBody();
    const text = formString(body, "body");
    const error = validateComment(text);
    if (error) {
      if (isHtmx(c)) {
        c.header("HX-Retarget", "#comment-form");
        c.header("HX-Reswap", "outerHTML");
        return c.html(<CommentComposer requestId={meta.id} viewer={viewer} csrf={c.get("csrf")} locked={meta.locked} error={error} body={text} />);
      }
      return renderRequest(c, { commentError: error });
    }
    const blocked = limited(c, limits.comment, viewer.id);
    if (blocked) return blocked;
    const commentId = addComment(db, { requestId: meta.id, authorId: viewer.id, body: text });
    c.get("deps").notifier.kick();
    if (!isHtmx(c)) return c.redirect(`/requests/${meta.id}#comment-${commentId}`, 303);
    const created = getComment(db, commentId)!;
    const count = getRequest(db, meta.id)?.commentCount ?? 0;
    return c.html(
      <>
        <CommentView comment={created} viewer={viewer} csrf={c.get("csrf")} locked={meta.locked} />
        <CommentComposer requestId={meta.id} viewer={viewer} csrf={c.get("csrf")} locked={meta.locked} oob />
        <span id="comment-count" class="font-normal text-muted" hx-swap-oob="true">
          {count}
        </span>
        {count === 1 && <p id="no-comments" hx-swap-oob="delete"></p>}
      </>,
    );
  });

  /** Loads a comment the viewer may edit, or returns an error response. */
  function editableComment(c: Ctx) {
    const { db } = c.get("deps");
    const viewer = viewerOf(c);
    const id = parseId(c.req.param("id"));
    const source = id ? getCommentSource(db, id) : null;
    const meta = source ? getRequestMeta(db, source.requestId) : null;
    if (!source || !meta || ((source.hidden || meta.hidden) && !isMaintainer(viewer))) return { ok: false as const, response: notFound(c) };
    if (source.authorId !== viewer.id) return { ok: false as const, response: forbidden(c, "You can only edit your own comments.") };
    if (meta.locked && !isMaintainer(viewer)) return { ok: false as const, response: forbidden(c, "Discussion is locked.") };
    return { ok: true as const, source, meta };
  }

  app.get("/comments/:id", (c) => {
    const { db } = c.get("deps");
    const viewer = c.get("viewer");
    const id = parseId(c.req.param("id"));
    const comment = id ? getComment(db, id) : null;
    const meta = comment ? getRequestMeta(db, comment.requestId) : null;
    if (!comment || !meta || ((comment.hidden || meta.hidden) && !isMaintainer(viewer))) return notFound(c);
    if (!isHtmx(c)) return c.redirect(`/requests/${comment.requestId}#comment-${comment.id}`);
    noStore(c);
    return c.html(<CommentView comment={comment} viewer={viewer} csrf={c.get("csrf")} locked={meta.locked} />);
  });

  app.get("/comments/:id/edit", requireActive, (c) => {
    const found = editableComment(c);
    if (!found.ok) return found.response;
    const form = <CommentEditForm id={found.source.id} requestId={found.source.requestId} body={found.source.body} csrf={c.get("csrf")} />;
    if (isHtmx(c)) return c.html(form);
    return c.html(
      <RequestPageShell c={c} title="Edit comment">
        {form}
      </RequestPageShell>,
    );
  });

  app.post("/comments/:id", requireActive, async (c) => {
    const { db } = c.get("deps");
    const found = editableComment(c);
    if (!found.ok) return found.response;
    const body = await c.req.parseBody();
    const text = formString(body, "body");
    const error = validateComment(text);
    if (error) {
      const form = <CommentEditForm id={found.source.id} requestId={found.source.requestId} body={text} csrf={c.get("csrf")} error={error} />;
      return isHtmx(c) ? c.html(form) : c.html(<RequestPageShell c={c} title="Edit comment">{form}</RequestPageShell>, 422);
    }
    updateComment(db, found.source.id, text);
    if (!isHtmx(c)) return c.redirect(`/requests/${found.source.requestId}#comment-${found.source.id}`, 303);
    return c.html(<CommentView comment={getComment(db, found.source.id)!} viewer={viewerOf(c)} csrf={c.get("csrf")} locked={found.meta.locked} />);
  });

  // Author edits

  app.get("/requests/:id/edit", requireActive, (c) => {
    const { db } = c.get("deps");
    const id = parseId(c.req.param("id"));
    const req = id ? getRequest(db, id) : null;
    if (!req || (req.hidden && !isMaintainer(c.get("viewer")))) return notFound(c);
    if (req.authorId !== viewerOf(c).id) return forbidden(c, "You can only edit your own requests.");
    return c.html(
      <RequestForm viewer={viewerOf(c)} csrf={c.get("csrf")} action={`/requests/${req.id}/edit`} title={req.title} body={req.body} heading="Edit request" submit="Save" cancel={`/requests/${req.id}`} />,
    );
  });

  app.post("/requests/:id/edit", requireActive, async (c) => {
    const { db } = c.get("deps");
    const id = parseId(c.req.param("id"));
    const meta = id ? getRequestMeta(db, id) : null;
    if (!meta || (meta.hidden && !isMaintainer(c.get("viewer")))) return notFound(c);
    if (meta.authorId !== viewerOf(c).id) return forbidden(c, "You can only edit your own requests.");
    const body = await c.req.parseBody();
    const title = formString(body, "title").replace(/\s+/g, " ");
    const text = formString(body, "body");
    const errors = validateRequest(title, text);
    if (errors.title || errors.body) {
      return c.html(
        <RequestForm viewer={viewerOf(c)} csrf={c.get("csrf")} action={`/requests/${meta.id}/edit`} title={title} body={text} errors={errors} heading="Edit request" submit="Save" cancel={`/requests/${meta.id}`} />,
        422,
      );
    }
    updateRequest(db, meta.id, { title, body: text });
    c.get("deps").labeler.kick(meta.id);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  // Maintainer actions

  const withRequest = (c: Ctx) => {
    const id = parseId(c.req.param("id"));
    return id ? getRequestMeta(c.get("deps").db, id) : null;
  };

  app.post("/requests/:id/status", requireMaintainer, async (c) => {
    const { db, issues, notifier } = c.get("deps");
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    const status = formString(await c.req.parseBody(), "status");
    if (!isStatus(status)) return renderRequest(c, { flash: "Choose a valid status." }, 400);
    const result = setStatus(db, meta.id, status, viewerOf(c).id);
    // The GitHub call happens after the transaction committed.
    if (result?.syncIssue) issues.kick(meta.id);
    if (result?.changed) notifier.kick();
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/labels", requireMaintainer, async (c) => {
    const { db } = c.get("deps");
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    const body = await c.req.parseBody({ all: true });
    const raw = body.label;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v) => parseId(String(v))).filter((v): v is number => v !== null);
    setRequestLabels(db, meta.id, ids);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/lock", requireMaintainer, async (c) => {
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    setRequestLocked(c.get("deps").db, meta.id, formString(await c.req.parseBody(), "locked") === "1", viewerOf(c).id);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/labels/auto", requireMaintainer, (c) => {
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    const { labeler } = c.get("deps");
    if (!labeler.enabled) return renderRequest(c, { flash: "Configure OPENROUTER_API_KEY or TYPESAFE_API_KEY to enable auto-labeling." }, 400);
    if (meta.hidden) return renderRequest(c, { flash: "Unhide this request before auto-labeling it." }, 400);
    labeler.requeue(meta.id);
    labeler.kick(meta.id);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/hide", requireMaintainer, async (c) => {
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    setRequestHidden(c.get("deps").db, meta.id, formString(await c.req.parseBody(), "hidden") === "1", viewerOf(c).id);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/github/retry", requireMaintainer, (c) => {
    const { issues } = c.get("deps");
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    if (issues.retry(meta.id)) issues.kick(meta.id);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/github/link", requireMaintainer, async (c) => {
    const { issues } = c.get("deps");
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    const result = await issues.linkExisting(meta.id, formString(await c.req.parseBody(), "issue"));
    if (!result.ok) return renderRequest(c, { flash: result.error }, 400);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/requests/:id/github/check", requireMaintainer, async (c) => {
    const { issues } = c.get("deps");
    const meta = withRequest(c);
    if (!meta) return notFound(c);
    const result = await issues.check(meta.id);
    if (!result.ok) return renderRequest(c, { flash: result.error }, 400);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  app.post("/comments/:id/hide", requireMaintainer, async (c) => {
    const { db } = c.get("deps");
    const id = parseId(c.req.param("id"));
    const source = id ? getCommentSource(db, id) : null;
    if (!source) return notFound(c);
    setCommentHidden(db, source.id, formString(await c.req.parseBody(), "hidden") === "1", viewerOf(c).id);
    return c.redirect(`/requests/${source.requestId}#comment-${source.id}`, 303);
  });

  // Labels

  app.get("/labels", requireMaintainer, (c) =>
    c.html(<LabelsPage viewer={viewerOf(c)} csrf={c.get("csrf")} labels={listLabels(c.get("deps").db)} />),
  );

  app.post("/labels", requireMaintainer, async (c) => {
    const { db } = c.get("deps");
    const name = formString(await c.req.parseBody(), "name").replace(/\s+/g, " ");
    const error =
      !name || name.length > LIMITS.labelMax ? `Use 1–${LIMITS.labelMax} characters.` : createLabel(db, name) === "exists" ? "That label exists." : null;
    if (error) return c.html(<LabelsPage viewer={viewerOf(c)} csrf={c.get("csrf")} labels={listLabels(db)} error={error} />, 422);
    return c.redirect("/labels", 303);
  });

  app.post("/labels/:id/delete", requireMaintainer, (c) => {
    const id = parseId(c.req.param("id"));
    if (id) deleteLabel(c.get("deps").db, id);
    return c.redirect("/labels", 303);
  });

  return app;
}

function renderRequest(c: Ctx, extra: { flash?: string; commentError?: string } = {}, status: 200 | 400 | 422 = 200) {
  const { db, config, issues } = c.get("deps");
  const viewer = c.get("viewer");
  const id = parseId(c.req.param("id"));
  const req = id ? getRequest(db, id, viewer?.id) : null;
  if (!req || (req.hidden && !isMaintainer(viewer))) return notFound(c);
  const afterId = parseId(c.req.query("after")) ?? 0;
  const comments = listComments(db, req.id, { includeHidden: isMaintainer(viewer), afterId });
  // Opening a request reads its notifications; refresh the header count to match.
  if (viewer && markRequestRead(db, viewer.id, req.id) > 0) c.set("viewer", { ...viewer, unread: unreadCount(db, viewer.id, isMaintainer(viewer)) });
  if (status === 200 && !extra.commentError) publicCache(c);
  else noStore(c);
  return c.html(
    <RequestPage
      viewer={c.get("viewer")}
      following={viewer ? isFollowing(db, req.id, viewer.id) : false}
      csrf={c.get("csrf")}
      req={req}
      comments={comments.items}
      hasMoreComments={comments.hasMore}
      allLabels={isMaintainer(viewer) ? listLabels(db) : []}
      issueRepo={issues.repoName}
      autoLabelEnabled={c.get("deps").labeler.enabled}
      canonical={`${config.appUrl}/requests/${req.id}`}
      description={plainText(req.bodyHtml, 160)}
      flash={extra.flash ?? extra.commentError}
    />,
    extra.commentError ? 422 : status,
  );
}

function RequestPageShell(props: { c: Ctx; title: string; children: Child }) {
  return (
    <Layout title={props.title} viewer={props.c.get("viewer")} csrf={props.c.get("csrf")} noindex>
      <h1 class="mb-2 text-base font-semibold">{props.title}</h1>
      {props.children}
    </Layout>
  );
}
