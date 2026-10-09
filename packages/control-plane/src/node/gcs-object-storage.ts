import { Storage, type FileMetadata } from "@google-cloud/storage";
import { Readable } from "node:stream";
import { readBoundedBytes } from "../http/bounded-body";
import { VIDEO_MAX_BYTES } from "../media";
import type { ObjectStorage, ObjectStorageMetadata } from "../storage/object-storage";
import type { ConfigSource } from "./config";

export interface GcsObjectStorageConfig {
  bucket: string;
  maxObjectBytes?: number;
}

export function readGcsObjectStorageConfig(source: ConfigSource): GcsObjectStorageConfig {
  if (!source.OBJECT_STORE_BUCKET) {
    throw new Error("OBJECT_STORE_BUCKET is required to use GCS object storage");
  }
  return { bucket: source.OBJECT_STORE_BUCKET };
}

/** Native GCS with Application Default Credentials (the pilot VM identity). */
export function createGcsObjectStorage(config: GcsObjectStorageConfig): ObjectStorage {
  const bucket = new Storage().bucket(config.bucket);
  const maxBytes = config.maxObjectBytes ?? VIDEO_MAX_BYTES;

  async function metadata(key: string): Promise<FileMetadata | null> {
    try {
      const [result] = await bucket.file(key).getMetadata();
      return result;
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A nonexistent bucket must remain a deployment failure, not an absent file.
      await bucket.getMetadata();
      return null;
    }
  }

  return {
    async put(key, value, options) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else {
        const result = await readBoundedBytes(value, maxBytes);
        if (!result.ok) throw new RangeError(`GCS object exceeds ${maxBytes} bytes`);
        bytes = result.bytes;
      }
      if (bytes.byteLength > maxBytes) {
        throw new RangeError(`GCS object exceeds ${maxBytes} bytes`);
      }
      await bucket.file(key).save(Buffer.from(bytes), {
        resumable: false,
        metadata: { contentType: options?.contentType },
      });
    },

    async delete(key) {
      try {
        await bucket.file(key).delete();
      } catch (error) {
        if (!isMissing(error)) throw error;
        await bucket.getMetadata();
      }
    },

    async head(key) {
      const stored = await metadata(key);
      return stored ? metadataOf(stored) : null;
    },

    async get(key, options) {
      const stored = await metadata(key);
      if (!stored) return null;
      const result = metadataOf(stored);
      // Pin the bytes to the metadata version so overwrites cannot mix size/etag/body.
      const file = bucket.file(key, { generation: stored.generation });
      const range = options?.range;
      const body = file.createReadStream({
        ...(range ? { start: range.offset, end: range.offset + range.length - 1 } : {}),
        decompress: false,
      });
      // The shared port is typed with Workers' stream extensions; this Node-only
      // adapter supplies the standard Web Stream methods used by its consumers.
      return { ...result, body: Readable.toWeb(body) as unknown as ReadableStream };
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 404;
}

function metadataOf(stored: FileMetadata): ObjectStorageMetadata {
  const size = Number(stored.size);
  if (
    stored.size === undefined ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !stored.etag ||
    !stored.generation
  ) {
    throw new Error("GCS returned incomplete or invalid object metadata");
  }
  const fields: Array<[string, string | undefined]> = [
    ["Content-Type", stored.contentType],
    ["Content-Language", stored.contentLanguage],
    ["Content-Disposition", stored.contentDisposition],
    ["Content-Encoding", stored.contentEncoding],
    ["Cache-Control", stored.cacheControl],
  ];
  return {
    size,
    httpEtag: stored.etag.startsWith('"') ? stored.etag : `"${stored.etag}"`,
    writeHttpMetadata(headers) {
      for (const [key, value] of fields) {
        if (value !== undefined) headers.set(key, value);
      }
    },
  };
}
