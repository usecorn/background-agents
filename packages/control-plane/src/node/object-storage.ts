import type { ObjectStorage } from "../storage/object-storage";
import type { ConfigSource } from "./config";
import {
  createGcsObjectStorage,
  readGcsObjectStorageConfig,
  type GcsObjectStorageConfig,
} from "./gcs-object-storage";
import {
  createS3ObjectStorage,
  OBJECT_STORAGE_VARIABLE_NAMES,
  readS3ObjectStorageConfig,
  type S3ObjectStorageConfig,
} from "./s3-object-storage";

export const NODE_OBJECT_STORAGE_VARIABLE_NAMES = [
  "OBJECT_STORE_PROVIDER",
  ...OBJECT_STORAGE_VARIABLE_NAMES,
] as const;

export type NodeObjectStorageConfig =
  (S3ObjectStorageConfig & { provider?: "s3" }) | (GcsObjectStorageConfig & { provider: "gcs" });

export function readNodeObjectStorageConfig(source: ConfigSource): NodeObjectStorageConfig {
  const provider = source.OBJECT_STORE_PROVIDER || "s3";
  switch (provider) {
    case "gcs":
      return { provider, ...readGcsObjectStorageConfig(source) };
    case "s3":
      return { provider, ...readS3ObjectStorageConfig(source) };
    default:
      throw new Error("OBJECT_STORE_PROVIDER must be s3 or gcs");
  }
}

export function createNodeObjectStorage(config: NodeObjectStorageConfig): ObjectStorage {
  return config.provider === "gcs" ? createGcsObjectStorage(config) : createS3ObjectStorage(config);
}
