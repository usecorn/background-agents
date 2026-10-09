import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGcsObjectStorage, readGcsObjectStorageConfig } from "./gcs-object-storage";

const sdk = vi.hoisted(() => ({
  save: vi.fn(),
  delete: vi.fn(),
  getMetadata: vi.fn(),
  bucketMetadata: vi.fn(),
  createReadStream: vi.fn(),
  file: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return { file: sdk.file, getMetadata: sdk.bucketMetadata };
    }
  },
}));

describe("GCS object storage contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.file.mockReturnValue(sdk);
    sdk.bucketMetadata.mockResolvedValue([{}]);
    sdk.getMetadata.mockResolvedValue([
      { size: "10", etag: "version-one", generation: "123", contentType: "text/plain" },
    ]);
    sdk.createReadStream.mockReturnValue(Readable.from([Buffer.from("345")]));
  });

  it("requires a bucket without static GCP credentials", () => {
    expect(() => readGcsObjectStorageConfig({})).toThrow("OBJECT_STORE_BUCKET");
    expect(readGcsObjectStorageConfig({ OBJECT_STORE_BUCKET: "pilot-media" })).toEqual({
      bucket: "pilot-media",
    });
  });

  it("keeps whole size and stored metadata for generation-bound range reads", async () => {
    const store = createGcsObjectStorage({ bucket: "pilot-media" });
    const object = await store.get("session/file", { range: { offset: 3, length: 3 } });
    expect(object?.size).toBe(10);
    expect(object?.httpEtag).toBe('"version-one"');
    expect(await new Response(object!.body).text()).toBe("345");
    const headers = new Headers();
    object!.writeHttpMetadata(headers);
    expect(headers.get("Content-Type")).toBe("text/plain");
    expect(headers.has("Content-Length")).toBe(false);
    expect(sdk.file).toHaveBeenCalledWith("session/file", { generation: "123" });
    expect(sdk.createReadStream).toHaveBeenCalledWith({
      start: 3,
      end: 5,
      decompress: false,
    });
  });

  it("returns null only for missing objects, not permission or bucket failures", async () => {
    const store = createGcsObjectStorage({ bucket: "pilot-media" });
    sdk.getMetadata.mockRejectedValue({ code: 404 });
    expect(await store.head("missing")).toBeNull();
    expect(await store.get("missing")).toBeNull();
    sdk.bucketMetadata.mockRejectedValue({ code: 404 });
    await expect(store.head("missing-bucket")).rejects.toMatchObject({ code: 404 });
    sdk.getMetadata.mockRejectedValue({ code: 403 });
    await expect(store.get("forbidden")).rejects.toMatchObject({ code: 403 });
  });

  it("refuses missing or invalid metadata instead of reporting an empty artifact", async () => {
    const store = createGcsObjectStorage({ bucket: "pilot-media" });
    for (const metadata of [
      { size: "10" },
      { size: "not-a-number", etag: "e", generation: "1" },
      { size: "9007199254740992", etag: "e", generation: "1" },
    ]) {
      sdk.getMetadata.mockResolvedValue([metadata]);
      await expect(store.head("invalid")).rejects.toThrow("metadata");
    }
  });

  it("uploads only the requested typed-array view and enforces byte limits", async () => {
    const store = createGcsObjectStorage({ bucket: "pilot-media", maxObjectBytes: 3 });
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    await store.put("view", bytes.subarray(1, 4), { contentType: "application/octet-stream" });
    expect(sdk.save).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), {
      resumable: false,
      metadata: { contentType: "application/octet-stream" },
    });
    await expect(store.put("large", "four")).rejects.toThrow("exceeds");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await expect(store.put("large-stream", stream)).rejects.toThrow("exceeds");
    expect(sdk.save).toHaveBeenCalledTimes(1);
  });

  it("deletes idempotently while propagating denied writes", async () => {
    const store = createGcsObjectStorage({ bucket: "pilot-media" });
    sdk.delete.mockRejectedValue({ code: 404 });
    await expect(store.delete("gone")).resolves.toBeUndefined();
    sdk.delete.mockRejectedValue({ code: 403 });
    await expect(store.delete("denied")).rejects.toMatchObject({ code: 403 });
  });
});
