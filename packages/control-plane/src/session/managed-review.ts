import type { SqlStorage } from "./sql-storage";

export const MANAGED_REVIEW_TABLE_SQL = `CREATE TABLE IF NOT EXISTS managed_review (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  launch_claimed INTEGER NOT NULL DEFAULT 0 CHECK (launch_claimed IN (0, 1)),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1))
)`;

/** Controller-owned metadata only; ordinary prompts must never write this table. */
export class ManagedReviewStore {
  constructor(private readonly sql: SqlStorage) {}

  isManaged(): boolean {
    return this.sql.exec("SELECT 1 FROM managed_review").toArray().length > 0;
  }

  /** Persist before provider I/O. An ambiguous allocation must never be replayed. */
  claimLaunch(runId: string, messageId: string): boolean {
    return (
      this.sql
        .exec(
          `UPDATE managed_review SET launch_claimed=1
       WHERE run_id=? AND message_id=? AND sealed=0 AND launch_claimed=0 RETURNING singleton`,
          runId,
          messageId
        )
        .toArray().length === 1
    );
  }

  bind(runId: string, messageId: string): boolean {
    for (const id of [runId, messageId]) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid managed review identity");
    }
    this.sql.exec(
      "INSERT OR IGNORE INTO managed_review(singleton,run_id,message_id) VALUES(1,?,?)",
      runId,
      messageId
    );
    return this.matches(runId, messageId);
  }

  isLocked(): boolean {
    return this.sql.exec("SELECT 1 FROM managed_review WHERE sealed=0").toArray().length > 0;
  }

  seal(runId: string, messageId: string): boolean {
    this.sql.exec(
      "UPDATE managed_review SET sealed=1 WHERE run_id=? AND message_id=?",
      runId,
      messageId
    );
    return this.matches(runId, messageId);
  }

  matches(runId: string, messageId: string): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM managed_review WHERE run_id=? AND message_id=?", runId, messageId)
        .toArray().length === 1
    );
  }
}

export class ManagedReviewLockedError extends Error {
  constructor() {
    super(
      "Automated review is in progress. Follow-up prompts are available after its result is sealed."
    );
    this.name = "ManagedReviewLockedError";
  }
}
