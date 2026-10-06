import { Hono } from "hono";
import { formString, isHtmx, isMaintainer, limited, noStore, parseId, type AppEnv, type Ctx } from "../http";
import {
  getEmailPrefs,
  listNotifications,
  markAllRead,
  setEmailPrefs,
  setFollowing,
  verifyUnfollowToken,
} from "../services/notifications";
import { getRequest, getRequestMeta } from "../services/requests";
import { FollowButton, NotificationsPage, UnfollowPage } from "../views/notifications";
import { notFound, requireUser, viewerOf } from "./requests";

export function notificationRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/notifications", requireUser, (c) => {
    const { db } = c.get("deps");
    const viewer = viewerOf(c);
    const page = Math.min(Math.max(Number.parseInt(c.req.query("page") ?? "1", 10) || 1, 1), 1000);
    const { items, hasNext } = listNotifications(db, viewer.id, { page, includeHidden: isMaintainer(viewer) });
    const flash = c.req.query("saved") ? "Email settings saved." : undefined;
    return c.html(
      <NotificationsPage viewer={viewer} csrf={c.get("csrf")} items={items} page={page} hasNext={hasNext} prefs={getEmailPrefs(db, viewer.id)} flash={flash} />,
    );
  });

  app.post("/notifications/read", requireUser, (c) => {
    markAllRead(c.get("deps").db, viewerOf(c).id);
    return c.redirect("/notifications", 303);
  });

  app.post("/notifications/settings", requireUser, async (c) => {
    const body = await c.req.parseBody();
    setEmailPrefs(c.get("deps").db, viewerOf(c).id, { status: formString(body, "status") === "1", comment: formString(body, "comment") === "1" });
    return c.redirect("/notifications?saved=1", 303);
  });

  app.post("/requests/:id/follow", requireUser, async (c) => {
    const { db, limits } = c.get("deps");
    const viewer = viewerOf(c);
    const id = parseId(c.req.param("id"));
    const meta = id ? getRequestMeta(db, id) : null;
    if (!meta || (meta.hidden && !isMaintainer(viewer))) return notFound(c);
    const following = formString(await c.req.parseBody(), "value") === "1";
    const blocked = limited(c, limits.vote, viewer.id);
    if (blocked) return blocked;
    setFollowing(db, meta.id, viewer.id, following);
    if (isHtmx(c)) return c.html(<FollowButton requestId={meta.id} following={following} csrf={c.get("csrf")} />);
    return c.redirect(`/requests/${meta.id}`, 303);
  });

  // Unfollow links in emails: GET shows a confirmation so link scanners can't unfollow anyone.

  /** Resolves a signed unfollow link, or null when it's invalid. */
  const unfollowTarget = (c: Ctx, input: { u?: string; r?: string; t?: string }) => {
    const { db, config } = c.get("deps");
    const requestId = parseId(input.r);
    if (!requestId || !input.u || !input.t || !verifyUnfollowToken(config.authSecret, input.u, requestId, input.t)) return null;
    const req = getRequest(db, requestId);
    return req ? { userId: input.u, requestId, token: input.t, request: { id: req.id, title: req.title } } : null;
  };

  const renderUnfollow = (c: Ctx, target: ReturnType<typeof unfollowTarget>, done = false) => {
    noStore(c);
    return c.html(
      <UnfollowPage viewer={c.get("viewer")} csrf={c.get("csrf")} request={target?.request ?? null} userId={target?.userId ?? ""} token={target?.token ?? ""} done={done} />,
      target ? 200 : 400,
    );
  };

  app.get("/unfollow", (c) => renderUnfollow(c, unfollowTarget(c, c.req.query())));

  app.post("/unfollow", async (c) => {
    const body = await c.req.parseBody();
    const target = unfollowTarget(c, { u: formString(body, "u"), r: formString(body, "r"), t: formString(body, "t") });
    if (target) setFollowing(c.get("deps").db, target.requestId, target.userId, false);
    return renderUnfollow(c, target, !!target);
  });

  return app;
}
