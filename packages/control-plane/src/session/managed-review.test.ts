import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { ManagedReviewStore } from "./managed-review";

describe("managed review seal", () => {
  it("persists the immutable attempt/message binding and lock across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "managed-review-"));
    let db = new DatabaseSync(join(dir, "session.db"));
    try {
      let sql = createNodeSqlStorage(db).sql;
      initSchema(sql);
      let review = new ManagedReviewStore(sql);
      expect(review.isLocked()).toBe(false);
      expect(review.bind("attempt-1", "message-1")).toBe(true);
      expect(review.bind("attempt-1", "message-1")).toBe(true);
      expect(review.bind("attempt-2", "message-1")).toBe(false);
      expect(review.bind("attempt-1", "message-2")).toBe(false);
      db.close();
      db = new DatabaseSync(join(dir, "session.db"));
      sql = createNodeSqlStorage(db).sql;
      initSchema(sql);
      review = new ManagedReviewStore(sql);
      expect(review.isLocked()).toBe(true);
      expect(review.seal("attempt-2", "message-1")).toBe(false);
      expect(review.isLocked()).toBe(true);
      expect(review.seal("attempt-1", "message-1")).toBe(true);
      expect(review.isLocked()).toBe(false);
      expect(review.bind("attempt-1", "message-1")).toBe(true);
      expect(review.isLocked()).toBe(false);
      expect(review.bind("attempt-2", "message-2")).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
