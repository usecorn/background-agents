import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import { initSchema } from "../../session/schema";
import { ManagedReviewStore } from "../../session/managed-review";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockProvider,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const input = {
  runId: "run-1",
  messageId: "message-1",
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  providerApiKey: "synthetic-provider-key",
  trustedBundle: new Uint8Array([1]),
  timeoutSeconds: 1800,
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = createNodeSqlStorage(db).sql;
  initSchema(sql);
  const review = new ManagedReviewStore(sql);
  review.bind(input.runId, input.messageId);
  const session = createMockSession({ harness: "opencode", model: "anthropic/claude-sonnet-4-6" });
  const storage = createMockStorage(session, createMockSandbox({ status: "pending" }));
  const provider = createMockProvider();
  const create = vi.fn(async (config: { sandboxId: string }) => ({
    sandboxId: config.sandboxId,
    providerObjectId: "managed-provider-1",
    createdAt: Date.now(),
    lifetime: noLifetime(),
  }));
  const config = { ...createTestConfig(), managedReview: { store: review, create } };
  const make = () =>
    createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      config
    );
  return { review, storage, provider, create, make };
}
it("launches one explicit managed allocation without ordinary environment or repository resolution", async () => {
  const f = fixture();
  expect(await f.make().launchManagedReview(input)).toBe(true);
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.provider.createSandbox).not.toHaveBeenCalled();
  expect(f.storage.getUserEnvVars).not.toHaveBeenCalled();
  expect(f.storage.getSessionRepositories).not.toHaveBeenCalled();
  expect(f.storage.getSandbox()?.modal_object_id).toBe("managed-provider-1");
  expect(await f.make().launchManagedReview(input)).toBe(false);
  expect(f.create).toHaveBeenCalledOnce();
});
it("keeps ordinary spawn and restore out of managed sessions", async () => {
  const f = fixture();
  await f.make().spawnSandbox();
  expect(f.provider.createSandbox).not.toHaveBeenCalled();
  expect(f.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  expect(f.storage.getUserEnvVars).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
it("does not replay an ambiguous managed allocation after rehydration", async () => {
  const f = fixture();
  f.create.mockRejectedValue(new Error("transport response lost"));
  await expect(f.make().launchManagedReview(input)).rejects.toThrow("MANAGED_REVIEW_LAUNCH_FAILED");
  expect(await f.make().launchManagedReview(input)).toBe(false);
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.provider.createSandbox).not.toHaveBeenCalled();
});
it("rejects a substituted model before consuming the launch claim", async () => {
  const f = fixture();
  await expect(
    f.make().launchManagedReview({ ...input, model: "another-model" })
  ).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
  expect(await f.make().launchManagedReview(input)).toBe(true);
});

it("deduplicates a second request while the first provider allocation is pending", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.create.mockImplementation(async (config) => {
    await gate;
    return {
      sandboxId: config.sandboxId,
      providerObjectId: "managed-provider-1",
      createdAt: Date.now(),
      lifetime: noLifetime(),
    };
  });
  const manager = f.make();
  const first = manager.launchManagedReview(input);
  try {
    expect(await manager.launchManagedReview(input)).toBe(false);
  } finally {
    release();
  }
  expect(await first).toBe(true);
  expect(f.create).toHaveBeenCalledOnce();
});
