import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  repositoryId: z.string().regex(/^[1-9][0-9]*$/),
  pullRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  baseSha: sha,
  headSha: sha,
  policyDigest: digest,
  modelDigest: digest,
});
export type ReviewBinding = z.infer<typeof bindingSchema>;
type Verdict = "CLEAN" | "SUSPICIOUS" | "MALICIOUS";
export type IncompleteReason =
  | "TIMEOUT"
  | "EXECUTION_FAILED"
  | "RESULT_TOO_LARGE"
  | "INVALID_RESULT"
  | "UNREVIEWABLE_SCOPE"
  | "INCOMPLETE_COVERAGE"
  | "INCONSISTENT_RESULT";

export interface ReviewRun {
  id: string;
  logicalKey: string;
  binding: ReviewBinding;
  sessionId: string | null;
  state: "queued" | "running" | "completed" | "incomplete" | "superseded";
  verdict: Verdict | null;
  reason: IncompleteReason | null;
  responseDigest: string | null;
  createdAt: number;
  deadline: number;
  completedAt: number | null;
  contentExpiresAt: number | null;
  checkId: string | null;
  revision: number;
  publishedRevision: number;
}
type Row = Omit<ReviewRun, "binding"> & { binding: string };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENT = "id IN (SELECT runId FROM current_runs)";

/**
 * Stores opaque binding and verdict metadata only. Findings and other free text
 * remain in the sealed OpenInspect transcript, identified by responseDigest.
 */
export class ReviewRunStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if ((statSync(dirname(path)).mode & 0o077) !== 0) {
      throw new Error("Review store requires a private data directory");
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error("Unsupported review store schema version");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY, logicalKey TEXT NOT NULL, binding TEXT NOT NULL,
        sessionId TEXT UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','incomplete','superseded')),
        verdict TEXT CHECK(verdict IN ('CLEAN','SUSPICIOUS','MALICIOUS')),
        reason TEXT, responseDigest TEXT, createdAt INTEGER NOT NULL, deadline INTEGER NOT NULL,
        completedAt INTEGER, contentExpiresAt INTEGER, checkId TEXT,
        revision INTEGER NOT NULL DEFAULT 1, publishedRevision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS current_runs (
        repositoryId TEXT NOT NULL, pullRequest INTEGER NOT NULL,
        runId TEXT NOT NULL REFERENCES review_runs(id),
        PRIMARY KEY(repositoryId,pullRequest)
      );
      CREATE TABLE IF NOT EXISTS check_creation_intents (
        runId TEXT PRIMARY KEY REFERENCES review_runs(id)
      );
      PRAGMA user_version=2;
    `);
  }

  start(binding: ReviewBinding, now: number, timeoutMs: number, options?: { rerun?: boolean }) {
    const verified = bindingSchema.parse(binding);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Invalid review deadline");
    }
    const logicalKey = createHash("sha256").update(JSON.stringify(verified)).digest("hex");
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT runId FROM current_runs WHERE repositoryId=? AND pullRequest=?")
        .get(verified.repositoryId, verified.pullRequest);
      if (current) {
        const previous = this.get(String(current.runId))!;
        if (previous.logicalKey === logicalKey && !options?.rerun) {
          return { created: false, run: previous };
        }
        this.db
          .prepare(
            `UPDATE review_runs SET state='superseded', revision=revision+1,
            completedAt=COALESCE(completedAt,?), contentExpiresAt=COALESCE(contentExpiresAt,?)
            WHERE id=?`
          )
          .run(now, now + RETENTION_MS, previous.id);
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO review_runs(id,logicalKey,binding,state,createdAt,deadline)
          VALUES(?,?,?,'queued',?,?)`
        )
        .run(id, logicalKey, JSON.stringify(verified), now, now + timeoutMs);
      this.db
        .prepare(
          `INSERT INTO current_runs(repositoryId,pullRequest,runId) VALUES(?,?,?)
          ON CONFLICT(repositoryId,pullRequest) DO UPDATE SET runId=excluded.runId`
        )
        .run(verified.repositoryId, verified.pullRequest, id);
      return { created: true, run: this.get(id)! };
    });
  }

  get(id: string): ReviewRun | null {
    const row = this.db.prepare("SELECT * FROM review_runs WHERE id=?").get(id);
    return row ? decode(row as unknown as Row) : null;
  }

  isCurrent(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM current_runs WHERE runId=?").get(id) !== undefined;
  }

  attachSession(id: string, sessionId: string): boolean {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session ID");
    const changed = this.db
      .prepare(
        `UPDATE review_runs SET sessionId=?,state='running',revision=revision+1
        WHERE id=? AND state='queued' AND sessionId IS NULL AND ${CURRENT}`
      )
      .run(sessionId, id).changes;
    if (changed === 1) return true;
    const run = this.get(id);
    return run?.state === "running" && run.sessionId === sessionId && this.isCurrent(id);
  }

  complete(id: string, sessionId: string, verdict: Verdict, responseDigest: string, now: number) {
    digest.parse(responseDigest);
    return (
      this.db
        .prepare(
          `UPDATE review_runs SET state='completed',verdict=?,responseDigest=?,
          completedAt=?,contentExpiresAt=?,revision=revision+1
          WHERE id=? AND sessionId=? AND state='running' AND deadline>? AND ${CURRENT}`
        )
        .run(verdict, responseDigest, now, now + RETENTION_MS, id, sessionId, now).changes === 1
    );
  }

  fail(id: string, reason: IncompleteReason, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE review_runs SET state='incomplete',reason=?,completedAt=?,
          contentExpiresAt=?,revision=revision+1
          WHERE id=? AND state IN ('queued','running') AND ${CURRENT}`
        )
        .run(reason, now, now + RETENTION_MS, id).changes === 1
    );
  }

  expire(now: number): string[] {
    return this.db
      .prepare(
        `UPDATE review_runs SET state='incomplete',reason='TIMEOUT',completedAt=deadline,
        contentExpiresAt=deadline+?,revision=revision+1
        WHERE state IN ('queued','running') AND deadline<=? RETURNING id`
      )
      .all(RETENTION_MS, now)
      .map((row) => String(row.id));
  }

  pendingPublication(): ReviewRun[] {
    return this.db
      .prepare(`SELECT * FROM review_runs WHERE revision>publishedRevision AND ${CURRENT}`)
      .all()
      .map((row) => decode(row as unknown as Row));
  }

  /** Commit before POST; after a crash, reconcile by external_id, never POST again. */
  claimCheckCreation(id: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO check_creation_intents(runId)
       SELECT id FROM review_runs WHERE id=? AND checkId IS NULL AND ${CURRENT}`
        )
        .run(id).changes === 1
    );
  }

  bindCheck(id: string, checkId: string): boolean {
    if (!/^[1-9][0-9]*$/.test(checkId)) throw new Error("Invalid check ID");
    return (
      this.db
        .prepare(`UPDATE review_runs SET checkId=? WHERE id=? AND (checkId IS NULL OR checkId=?)`)
        .run(checkId, id, checkId).changes === 1
    );
  }

  markPublished(id: string, checkId: string, revision: number): boolean {
    if (!/^[1-9][0-9]*$/.test(checkId)) throw new Error("Invalid check ID");
    return (
      this.db
        .prepare(
          `UPDATE review_runs SET publishedRevision=?,checkId=?
          WHERE id=? AND revision=? AND ${CURRENT}`
        )
        .run(revision, checkId, id, revision).changes === 1
    );
  }

  close(): void {
    if (!this.closed) this.db.close();
    this.closed = true;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function decode(row: Row): ReviewRun {
  return { ...row, binding: bindingSchema.parse(JSON.parse(row.binding)) };
}
