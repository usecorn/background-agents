import { describe, expect, it } from "vitest";
import { readNodeObjectStorageConfig } from "./object-storage";

describe("Node object storage selection", () => {
  it("preserves S3 as the default for existing deployments", () => {
    expect(readNodeObjectStorageConfig({ OBJECT_STORE_BUCKET: "media" })).toMatchObject({
      provider: "s3",
      bucket: "media",
      region: "us-east-1",
    });
  });

  it("selects native GCS without inheriting S3 endpoint or credentials", () => {
    expect(
      readNodeObjectStorageConfig({
        OBJECT_STORE_PROVIDER: "gcs",
        OBJECT_STORE_BUCKET: "pilot-media",
        OBJECT_STORE_ENDPOINT: "http://object-store:9000",
        AWS_ACCESS_KEY_ID: "unused-fixture",
      })
    ).toEqual({ provider: "gcs", bucket: "pilot-media" });
  });

  it("rejects an unknown provider instead of silently writing elsewhere", () => {
    expect(() =>
      readNodeObjectStorageConfig({ OBJECT_STORE_PROVIDER: "typo", OBJECT_STORE_BUCKET: "media" })
    ).toThrow("OBJECT_STORE_PROVIDER");
  });
});
