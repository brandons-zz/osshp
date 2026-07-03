// Object-storage seam for media binaries (spec §4 — Garage v2 via the minio
// S3 client). The store holds the binaries; the `media` table (lib/content/media)
// holds only references. Real S3 later requires no code change — only S3_ENDPOINT.
//
// Server-only: the minio client uses node: builtins. Never import from a client
// component or from a module reachable by the public theme render graph.
//
// The MediaStorage interface is the seam the upload pipeline (upload.ts) and the
// media-serve route consume; tests inject an in-memory implementation so the
// pipeline is verifiable without a live Garage.

import { Client as MinioClient } from "minio";
import type { Readable } from "node:stream";
import { config } from "@/lib/config";

/** A stored object's bytes + content type, as read back from the store. */
export interface StoredObject {
  stream: Readable;
  contentType: string;
  size: number;
}

/** The storage operations the media pipeline + serve route need. */
export interface MediaStorage {
  /** Create the media bucket if it does not already exist (idempotent). */
  ensureBucket(): Promise<void>;
  /** Upload bytes under `key` with the given content type. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read an object back (bytes stream + content type). Throws if absent. */
  get(key: string): Promise<StoredObject>;
}

/** Parse an S3 endpoint URL into the host/port/TLS shape minio expects. */
function parseEndpoint(url: string): {
  endPoint: string;
  port: number;
  useSSL: boolean;
} {
  const u = new URL(url);
  const useSSL = u.protocol === "https:";
  const port = u.port ? Number.parseInt(u.port, 10) : useSSL ? 443 : 80;
  return { endPoint: u.hostname, port, useSSL };
}

class GarageStorage implements MediaStorage {
  private readonly client: MinioClient;
  private readonly bucket: string;
  private readonly region: string;
  private ensured = false;

  constructor() {
    const { endPoint, port, useSSL } = parseEndpoint(config.s3Endpoint);
    this.bucket = config.s3Bucket;
    this.region = config.s3Region;
    this.client = new MinioClient({
      endPoint,
      port,
      useSSL,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
      region: this.region,
    });
  }

  async ensureBucket(): Promise<void> {
    if (this.ensured) return;
    const exists = await this.client.bucketExists(this.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.bucket, this.region);
    }
    this.ensured = true;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, key, body, body.length, {
      "Content-Type": contentType,
    });
  }

  async get(key: string): Promise<StoredObject> {
    const stat = await this.client.statObject(this.bucket, key);
    const stream = await this.client.getObject(this.bucket, key);
    const contentType =
      (stat.metaData?.["content-type"] as string | undefined) ??
      "application/octet-stream";
    return { stream, contentType, size: stat.size };
  }
}

let cached: MediaStorage | null = null;

/** The process-wide Garage-backed storage (lazy — never throws at import). */
export function getMediaStorage(): MediaStorage {
  if (!cached) cached = new GarageStorage();
  return cached;
}
