import { z } from "zod";
import { managedReviewInitSchema } from "@open-inspect/shared/types/session-api";
import { SUBSCRIPTION_PROVIDER_IDS } from "@open-inspect/shared/types/provider-accounts";
import { UserStore } from "../db/user-store";
import { HttpError, type RequestContext } from "../routes/shared";
import type { Env } from "../types";
import { emptySelection } from "../memory/selection";
import { resolvedPin } from "./pinned";
import { resolveManagedSkills } from "./skill-resolution";
import { initializeSession } from "./initialize";

const inputSchema = z.strictObject({
  runId: z.uuid(),
  content: managedReviewInitSchema.shape.content,
});

/** Controller-only creation: identity, model and repository scope are server-owned. */
export async function createManagedReview(request: Request, env: Env, ctx: RequestContext) {
  let input;
  try {
    input = inputSchema.parse(await request.json());
  } catch {
    throw new HttpError("INVALID_MANAGED_REVIEW", 400);
  }
  const owner = env.MANAGED_REVIEW_OWNER_USER_ID;
  if (!owner || !(await new UserStore(ctx.db).getUserById(owner))) {
    throw new HttpError("MANAGED_REVIEW_OWNER_UNAVAILABLE", 503);
  }
  const managedSkills = await resolveManagedSkills(
    ctx.db,
    { repositories: [], environmentId: null },
    { mode: "none" },
    owner
  );
  const result = await initializeSession(
    env,
    {
      sessionId: `managed-review-${input.runId}`,
      managedReview: { ...input, messageId: `review-${input.runId}` },
      repoOwner: null,
      repoName: null,
      title: "Malicious code review",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      codeServerEnabled: false,
      vncEnabled: false,
      participantUserId: owner,
      platformUserId: owner,
      participantCanonicalUserId: owner,
      ownerTeamId: null,
      visibility: "private",
      memory: resolvedPin(await emptySelection(Date.now())),
      managedSkills: resolvedPin(managedSkills),
      providerAuth: SUBSCRIPTION_PROVIDER_IDS.map((provider) => ({
        provider,
        authMode: "api_key",
        selectionSource: "explicit",
      })),
    },
    ctx
  );
  return Response.json(result, { status: 201 });
}
