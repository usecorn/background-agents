import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNodeSqlStorage } from "../../../node/sqlite-storage";
import { MANAGED_REVIEW_TABLE_SQL, ManagedReviewStore } from "../../managed-review";
import { ManagedReviewHandler } from "./managed-review.handler";
import { ReviewRunStore } from "../../../../../review-controller/src/run-store";
import {
  OpenInspectReviewClient,
  reviewMessageId,
} from "../../../../../review-controller/src/openinspect-client";
import { ResultReconciler } from "../../../../../review-controller/src/result-reconciler";
import { REVIEW_CATEGORIES } from "../../../../../review-controller/src/review-result";

it("seals the OpenInspect SQLite terminal before the controller accepts its verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "review-roundtrip-"));
  const store = new ReviewRunStore(join(directory, "runs.db"));
  const db = new DatabaseSync(":memory:");
  try {
    const id = store.start(
      {
        repositoryId: "123",
        pullRequest: 7,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyDigest: "c".repeat(64),
        modelDigest: "d".repeat(64),
      },
      1000,
      2000
    ).run.id;
    store.attachSession(id, "session-1");
    const clean = JSON.stringify({
      schemaVersion: 1,
      verdict: "CLEAN",
      findings: [],
      coverage: Object.fromEntries(REVIEW_CATEGORIES.map((key) => [key, "clean"])),
      reviewedPaths: ["head/example.ts"],
      incompleteReasons: [],
    });
    db.exec(
      `${MANAGED_REVIEW_TABLE_SQL}; CREATE TABLE messages(id TEXT, status TEXT); CREATE TABLE events(message_id TEXT,type TEXT,data TEXT);`
    );
    const sql = createNodeSqlStorage(db).sql;
    const managed = new ManagedReviewStore(sql);
    const messageId = reviewMessageId(id);
    managed.bind(id, messageId);
    db.prepare("INSERT INTO messages VALUES(?,?)").run(messageId, "completed");
    db.prepare("INSERT INTO events VALUES(?,?,?)").run(
      messageId,
      "execution_complete",
      JSON.stringify({
        type: "execution_complete",
        messageId,
        sandboxId: "sandbox-1",
        timestamp: 1100,
        success: true,
        finalResponse: {
          assistantMessageId: "assistant-1",
          parentMessageId: "prompt-1",
          text: clean,
        },
      })
    );
    const handler = new ManagedReviewHandler(sql, managed);
    const request: typeof fetch = async (url, init) => {
      expect(store.get(id)?.verdict).toBeNull();
      return init?.method === "POST"
        ? handler.seal(new Request(String(url), init))
        : handler.result(new URL(String(url)));
    };
    const client = new OpenInspectReviewClient(
      "https://control.example",
      "synthetic-controller-service-secret",
      request
    );
    const reconciler = new ResultReconciler(
      store,
      client,
      {
        readSourceComparison: async () => ({
          manifest: [{ path: "head/example.ts", reviewable: true }],
        }),
      },
      () => 1200
    );
    expect(await reconciler.tick()).toEqual({ completed: [id], pending: [], failed: [] });
    expect(managed.isLocked()).toBe(false);
    expect(store.get(id)).toMatchObject({ state: "completed", verdict: "CLEAN" });
  } finally {
    store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
