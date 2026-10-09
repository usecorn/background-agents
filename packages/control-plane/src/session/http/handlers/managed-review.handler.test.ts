import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../../../node/sqlite-storage";
import { MANAGED_REVIEW_TABLE_SQL, ManagedReviewStore } from "../../managed-review";
import { ManagedReviewHandler } from "./managed-review.handler";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(status = "completed", success = true) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    `${MANAGED_REVIEW_TABLE_SQL}; CREATE TABLE messages(id TEXT, status TEXT); CREATE TABLE events(message_id TEXT,type TEXT,data TEXT);`
  );
  const sql = createNodeSqlStorage(db).sql;
  const store = new ManagedReviewStore(sql);
  store.bind("run-1", "message-1");
  db.prepare("INSERT INTO messages VALUES(?,?)").run("message-1", status);
  db.prepare("INSERT INTO events VALUES(?,?,?)").run(
    "message-1",
    "execution_complete",
    JSON.stringify({
      type: "execution_complete",
      messageId: "message-1",
      sandboxId: "sandbox",
      timestamp: 123,
      success,
      finalResponse: {
        assistantMessageId: "assistant",
        parentMessageId: "prompt",
        text: '{"verdict":"CLEAN"}',
      },
    })
  );
  return { db, store, handler: new ManagedReviewHandler(sql, store) };
}
const url = new URL("http://internal/?runId=run-1&messageId=message-1");
it("returns only the bound successful terminal response and seals by exact digest", async () => {
  const { handler, store } = fixture();
  const response = await handler.result(url);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    responseDigest: string;
    state: string;
    response: { text: string };
  };
  expect(body.state).toBe("completed");
  expect(body.response.text).toContain("CLEAN");
  expect(body.responseDigest).toMatch(/^[a-f0-9]{64}$/);
  const request = (digest: string) =>
    new Request("http://internal/", {
      method: "POST",
      body: JSON.stringify({ runId: "run-1", messageId: "message-1", responseDigest: digest }),
    });
  expect((await handler.seal(request("a".repeat(64)))).status).toBe(409);
  expect(store.isLocked()).toBe(true);
  expect((await handler.seal(request(body.responseDigest))).status).toBe(200);
  expect(store.isLocked()).toBe(false);
  expect((await handler.seal(request(body.responseDigest))).status).toBe(200);
});
it("rejects other run identities without exposing transcript", async () => {
  const { handler } = fixture();
  expect(
    (await handler.result(new URL("http://internal/?runId=other&messageId=message-1"))).status
  ).toBe(404);
});
it("never returns a verdict candidate for pending or failed execution", async () => {
  for (const [status, success] of [
    ["processing", true],
    ["failed", false],
  ] as const) {
    const { handler } = fixture(status, success);
    const body = (await (await handler.result(url)).json()) as Record<string, unknown>;
    expect(body.state).toBe(status === "processing" ? "pending" : "incomplete");
    expect(body.response).toBeUndefined();
  }
});
it("does not accept ambiguous or malformed completion evidence", async () => {
  const { handler, db } = fixture();
  db.exec("INSERT INTO events SELECT * FROM events");
  expect(await (await handler.result(url)).json()).toMatchObject({ state: "incomplete" });
});

it("keeps active or missing execution locked even if the caller supplies a null digest", async () => {
  for (const status of ["processing", "unknown"]) {
    const { handler, store } = fixture(status);
    const response = await handler.seal(
      new Request("http://internal/", {
        method: "POST",
        body: JSON.stringify({ runId: "run-1", messageId: "message-1", responseDigest: null }),
      })
    );
    expect(response.status).toBe(409);
    expect(store.isLocked()).toBe(true);
  }
});

it("refuses a completion that claims success but carries an error", async () => {
  const { handler, db } = fixture();
  const row = db.prepare("SELECT data FROM events").get() as { data: string };
  db.prepare("UPDATE events SET data=?").run(
    JSON.stringify({ ...JSON.parse(row.data), error: "execution failed" })
  );
  expect(await (await handler.result(url)).json()).toMatchObject({ state: "incomplete" });
});

it("delivers only a bound controller bundle to the managed launcher", async () => {
  const { db, store } = fixture("pending");
  const launch = vi.fn(async () => true);
  const handler = new ManagedReviewHandler(createNodeSqlStorage(db).sql, store, launch);
  const request = (runId: string, bundleBase64 = "AQID") =>
    new Request("http://internal/", {
      method: "POST",
      body: JSON.stringify({ runId, messageId: "message-1", bundleBase64 }),
    });
  expect((await handler.launch(request("other"))).status).toBe(404);
  expect((await handler.launch(request("run-1", "bad archive!"))).status).toBe(400);
  expect(launch).not.toHaveBeenCalled();
  const response = await handler.launch(request("run-1"));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ launched: true });
  expect(launch).toHaveBeenCalledWith("run-1", "message-1", new Uint8Array([1, 2, 3]));
});
