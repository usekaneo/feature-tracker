import { Hono } from "hono";
import { REPORT_REASONS, type ReportReason } from "../db/schema";
import { formString, isMaintainer, limited, parseId, type AppEnv, type Ctx } from "../http";
import { plainText } from "../lib/markdown";
import {
  BAN_REASON_MAX,
  banUser,
  bannedUsers,
  dismissReports,
  fileReport,
  getModeratedUser,
  recentActions,
  REPORT_NOTE_MAX,
  reportQueue,
  setCommentHidden,
  setRequestHidden,
  unbanUser,
  type Target,
} from "../services/moderation";
import { getComment, getRequest } from "../services/requests";
import { MessagePage } from "../views/misc";
import { ModeratedUserPage, ModerationPage, ReportPage } from "../views/moderation";
import { forbidden, notFound, requireActive, requireMaintainer, viewerOf } from "./requests";

const isReason = (value: string): value is ReportReason => REPORT_REASONS.includes(value as ReportReason);

/** Better Auth ids are random strings; anything else can't match a user. */
const userIdParam = (c: Ctx) => {
  const id = c.req.param("id");
  return id && /^[\w-]{1,64}$/.test(id) ? id : null;
};

interface ReportTarget extends Target {
  kind: "request" | "comment";
  title: string;
  excerpt: string;
  authorId: string;
  path: string;
}

/** Loads something the viewer may report: visible to them and not their own. */
function reportTarget(c: Ctx, kind: "request" | "comment"): { ok: true; target: ReportTarget } | { ok: false; response: Response | Promise<Response> } {
  const { db } = c.get("deps");
  const viewer = viewerOf(c);
  const id = parseId(c.req.param("id"));
  const comment = kind === "comment" && id ? getComment(db, id) : null;
  const requestId = kind === "request" ? id : (comment?.requestId ?? null);
  const req = requestId ? getRequest(db, requestId) : null;
  const visible = req && (!req.hidden || isMaintainer(viewer)) && (kind === "request" || (comment && (!comment.hidden || isMaintainer(viewer))));
  if (!req || !visible) return { ok: false, response: notFound(c) };
  const authorId = comment?.authorId ?? req.authorId;
  if (authorId === viewer.id) return { ok: false, response: forbidden(c, `You can't report your own ${kind}.`) };
  return {
    ok: true,
    target: {
      kind,
      requestId: req.id,
      commentId: comment?.id ?? null,
      title: req.title,
      excerpt: plainText(comment?.bodyHtml ?? req.bodyHtml, 280),
      authorId,
      path: comment ? `/requests/${req.id}#comment-${comment.id}` : `/requests/${req.id}`,
    },
  };
}

/** Target from the hidden requestId/commentId fields of the queue forms. */
function queueTarget(c: Ctx, body: Record<string, unknown>): Target | null {
  const { db } = c.get("deps");
  const requestId = parseId(formString(body, "requestId"));
  const rawComment = formString(body, "commentId");
  const commentId = rawComment ? parseId(rawComment) : null;
  if (!requestId || (rawComment && !commentId)) return null;
  if (commentId === null) return getRequest(db, requestId) ? { requestId, commentId } : null;
  return getComment(db, commentId)?.requestId === requestId ? { requestId, commentId } : null;
}

export function moderationRoutes() {
  const app = new Hono<AppEnv>();

  // Reports from users

  for (const kind of ["request", "comment"] as const) {
    const path = `/${kind === "request" ? "requests" : "comments"}/:id/report`;

    app.get(path, requireActive, (c) => {
      const found = reportTarget(c, kind);
      if (!found.ok) return found.response;
      const { target } = found;
      return c.html(<ReportPage viewer={viewerOf(c)} csrf={c.get("csrf")} action={c.req.path} kind={kind} title={target.title} excerpt={target.excerpt} cancel={target.path} />);
    });

    app.post(path, requireActive, async (c) => {
      const { db, limits } = c.get("deps");
      const found = reportTarget(c, kind);
      if (!found.ok) return found.response;
      const { target } = found;
      const body = await c.req.parseBody();
      const reason = formString(body, "reason");
      const note = formString(body, "note");
      const error = !isReason(reason) ? "Choose a reason." : note.length > REPORT_NOTE_MAX ? `Keep the details under ${REPORT_NOTE_MAX} characters.` : null;
      if (error || !isReason(reason)) {
        return c.html(
          <ReportPage viewer={viewerOf(c)} csrf={c.get("csrf")} action={c.req.path} kind={kind} title={target.title} excerpt={target.excerpt} cancel={target.path} reason={reason} note={note} error={error ?? undefined} />,
          422,
        );
      }
      const blocked = limited(c, limits.report, viewerOf(c).id);
      if (blocked) return blocked;
      fileReport(db, { requestId: target.requestId, commentId: target.commentId, reporterId: viewerOf(c).id, reason, note });
      return c.html(<MessagePage viewer={viewerOf(c)} csrf={c.get("csrf")} title="Report sent" message="Thanks. A maintainer will review it." />);
    });
  }

  // Maintainer queue

  app.get("/moderation", requireMaintainer, (c) => {
    const { db } = c.get("deps");
    return c.html(<ModerationPage viewer={viewerOf(c)} csrf={c.get("csrf")} queue={reportQueue(db)} banned={bannedUsers(db)} log={recentActions(db)} />);
  });

  app.post("/moderation/reports/hide", requireMaintainer, async (c) => {
    const { db } = c.get("deps");
    const target = queueTarget(c, await c.req.parseBody());
    if (!target) return notFound(c);
    if (target.commentId === null) setRequestHidden(db, target.requestId, true, viewerOf(c).id);
    else setCommentHidden(db, target.commentId, true, viewerOf(c).id);
    return c.redirect("/moderation", 303);
  });

  app.post("/moderation/reports/dismiss", requireMaintainer, async (c) => {
    const target = queueTarget(c, await c.req.parseBody());
    if (!target) return notFound(c);
    dismissReports(c.get("deps").db, target, viewerOf(c).id);
    return c.redirect("/moderation", 303);
  });

  // Accounts

  app.get("/moderation/users/:id", requireMaintainer, (c) => {
    const id = userIdParam(c);
    const user = id ? getModeratedUser(c.get("deps").db, id) : null;
    if (!user) return notFound(c);
    return c.html(<ModeratedUserPage viewer={viewerOf(c)} csrf={c.get("csrf")} user={user} />);
  });

  app.post("/moderation/users/:id/ban", requireMaintainer, async (c) => {
    const { db } = c.get("deps");
    const id = userIdParam(c);
    if (!id) return notFound(c);
    const body = await c.req.parseBody();
    const reason = formString(body, "reason").replace(/\s+/g, " ").slice(0, BAN_REASON_MAX);
    const result = banUser(db, { userId: id, actorId: viewerOf(c).id, reason, hideContent: formString(body, "hideContent") === "1" });
    if (result === "not_found") return notFound(c);
    if (result === "maintainer") {
      return c.html(<ModeratedUserPage viewer={viewerOf(c)} csrf={c.get("csrf")} user={getModeratedUser(db, id)!} error="Maintainers can't be suspended." />, 400);
    }
    return c.redirect(`/moderation/users/${id}`, 303);
  });

  app.post("/moderation/users/:id/unban", requireMaintainer, (c) => {
    const id = userIdParam(c);
    if (!id || !getModeratedUser(c.get("deps").db, id)) return notFound(c);
    unbanUser(c.get("deps").db, id, viewerOf(c).id);
    return c.redirect(`/moderation/users/${id}`, 303);
  });

  return app;
}
