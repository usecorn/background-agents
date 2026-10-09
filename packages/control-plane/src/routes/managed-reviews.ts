import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import { serviceAuthorized } from "./shared";
import { dispatchSession } from "./session-route";

export const managedReviewRoutes = new Hono<ControlPlaneHonoEnv>();
const controller = admit({
  authentication: { kind: "service" },
  supportedScmProviders: "all",
  cacheControl: "private, no-store",
  authorization: serviceAuthorized("review-controller"),
});
managedReviewRoutes.get("/managed-reviews/:id/result", controller, (c) =>
  dispatchSession(c, async (request, _env, params, ctx) =>
    ctx.sessionRuntime.fetch(
      params.id,
      SessionInternalPaths.managedReviewResult,
      { signal: request.signal },
      new URL(request.url).search
    )
  )
);
managedReviewRoutes.post("/managed-reviews/:id/seal", controller, (c) =>
  dispatchSession(c, async (request, _env, params, ctx) =>
    ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.managedReviewSeal, {
      method: "POST",
      body: await request.text(),
      signal: request.signal,
    })
  )
);
