// A minimal, dependency-free USTAR (POSIX tar) archive READER — the inverse of
// lib/export/tar.ts's writer (issue 002).
//
// TRUST BOUNDARY: this is the first code to touch bytes from an archive an
// operator uploads, which may have come from anywhere (their own prior export,
// a third party, a download). It must defend against:
//
//   1. Path traversal / zip-slip — an entry name like "../../etc/passwd" or an
//      absolute path. We never extract to disk from a tar entry name (import
//      never writes files to the local filesystem — parsed entries go into an
//      in-memory Map keyed by a VALIDATED relative path, then into Postgres /
//      object storage through typed APIs). Every entry path is validated
//      before it is used as a map key.
//   2. Oversized / malicious entries — a forged header `size` field could claim
//      an enormous or negative value. Every declared size is checked against a
//      hard per-entry cap AND against the bytes actually remaining in the
//      buffer before we slice; a corrupt/truncated archive is a parse error,
//      never a read past the buffer end.
//   3. Non-regular-file entries — symlinks/hardlinks/devices are a classic tar
//      attack surface (a symlink entry's "data" is attacker-controlled and can
//      point anywhere). We accept ONLY regular files and (as no-ops) directory
//      entries; every other typeflag is reported as an unsupported entry — see
//      TarReadEntry.error below — rather than silently processed as data.
//
// Only what parseTar() needs is implemented — regular files, one directory
// no-op case, GNU/pax extension headers explicitly rejected (our own writer
// never emits them; see lib/export/tar.ts).

import { createGunzip } from "node:zlib";

const BLOCK_SIZE = 512;

/** Hard caps — defense against zip-bomb-shaped and hostile archives. */
export const MAX_TAR_ENTRIES = 20_000;
export const MAX_ENTRY_BYTES = 100 * 1024 * 1024; // 100 MB, e.g. one large media file
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB across the whole archive

export interface TarReadOk {
  path: string;
  data: Buffer;
}
export interface TarReadError {
  /** Best-effort path for the offending entry; may be "" if the header itself is unreadable. */
  path: string;
  error: string;
}
export type TarReadEntry = TarReadOk | TarReadError;

export function isTarReadError(e: TarReadEntry): e is TarReadError {
  return "error" in e;
}

/** True if the buffer starts with the gzip magic bytes (0x1f 0x8b). */
export function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Reject anything that is not a clean, relative, forward-slash path with no
 * `.`/`..` segments, no leading slash, and no NUL bytes. This is the zip-slip
 * guard — every path parseTar() returns has already passed this check.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path === "" || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  // Windows drive-letter absolute paths (defense in depth; this repo only
  // targets POSIX, but a hostile archive could still be crafted with one).
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function octalFieldToNumber(buf: Buffer, offset: number, length: number): number {
  const raw = buf.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  if (raw === "") return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : Number.NaN;
}

function readCString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Parse a USTAR archive (already decompressed, if it was gzipped) into a flat
 * list of read results. Never throws — every failure mode (corrupt header,
 * oversized entry, unsupported entry type, unsafe path) becomes a
 * TarReadError for that entry so a caller can report it and continue, per
 * issue 002's "malformed files reported with a reason, batch not aborted" AC.
 * A structurally unrecoverable archive (can't even locate a valid next header)
 * stops iteration and appends one final TarReadError.
 */
export function parseTar(archive: Buffer): TarReadEntry[] {
  const entries: TarReadEntry[] = [];
  let offset = 0;
  let total = 0;

  while (offset < archive.length) {
    // Two consecutive zero blocks terminate the archive (USTAR convention).
    if (offset + BLOCK_SIZE > archive.length) break;
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break;

    if (entries.length >= MAX_TAR_ENTRIES) {
      entries.push({ path: "", error: `archive exceeds ${MAX_TAR_ENTRIES} entries` });
      break;
    }

    const magic = header.toString("ascii", 257, 263);
    if (!magic.startsWith("ustar")) {
      entries.push({ path: "", error: "corrupt archive: bad USTAR magic in header" });
      break;
    }

    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = octalFieldToNumber(header, 124, 12);
    const typeflag = header.toString("ascii", 156, 157);

    if (!Number.isFinite(size) || size < 0) {
      entries.push({ path, error: "corrupt archive: unreadable size field" });
      break;
    }
    if (size > MAX_ENTRY_BYTES) {
      entries.push({ path, error: `entry exceeds ${MAX_ENTRY_BYTES} bytes` });
      break;
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      entries.push({ path, error: `archive exceeds ${MAX_TOTAL_BYTES} total bytes` });
      break;
    }

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      entries.push({ path, error: "corrupt archive: entry data runs past end of archive" });
      break;
    }
    const data = Buffer.from(archive.subarray(dataStart, dataEnd));
    const padded = size % BLOCK_SIZE === 0 ? size : size + (BLOCK_SIZE - (size % BLOCK_SIZE));
    offset = dataStart + padded;

    // Directory entries carry no file data of interest — accept and skip.
    if (typeflag === "5") continue;
    // Only regular files ('0' or legacy '\0') are accepted as data-bearing
    // entries. Everything else (symlink '1'/'2', device/fifo '3'/'4'/'6',
    // GNU longname 'L', pax 'x'/'g', ...) is rejected — see module doc.
    if (typeflag !== "0" && typeflag !== "\0") {
      entries.push({ path, error: `unsupported tar entry type: ${JSON.stringify(typeflag)}` });
      continue;
    }

    if (!isSafeArchivePath(path)) {
      entries.push({ path, error: "unsafe archive path (traversal or absolute path rejected)" });
      continue;
    }

    entries.push({ path, data });
  }

  return entries;
}

type BoundedGunzipResult =
  | { ok: true; data: Buffer }
  | { ok: false; error: string };

/**
 * Streaming-inflate `bytes` through node:zlib's Gunzip transform, aborting the
 * moment cumulative output crosses `maxBytes` — WITHOUT ever materializing the
 * full decompressed payload. This is the decompression-bomb defense (issue
 * 026): `Bun.gunzipSync` inflates everything into one allocation before any
 * size check can run, so a small, highly-compressible upload can OOM the
 * container before the cap is ever consulted. Feeding the stream's own 'data'
 * chunks and destroying it as soon as the running total exceeds `maxBytes`
 * bounds peak memory to roughly `maxBytes` plus one zlib chunk, regardless of
 * how large the archive would have decompressed to.
 */
function boundedGunzip(bytes: Buffer, maxBytes: number): Promise<BoundedGunzipResult> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BoundedGunzipResult) => {
      if (settled) return;
      settled = true;
      gunzip.removeAllListeners();
      gunzip.destroy();
      resolve(result);
    };

    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, error: `archive exceeds ${maxBytes} total bytes after decompression` });
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => finish({ ok: true, data: Buffer.concat(chunks) }));
    gunzip.on("error", () => finish({ ok: false, error: "corrupt gzip stream" }));

    gunzip.end(bytes);
  });
}

/**
 * Gunzip if needed (auto-detected by magic bytes), then parse as USTAR.
 *
 * `maxTotalBytes` is a TEST-INJECTION SEAM only: it exists so the
 * decompression-bomb test can prove the streaming-abort behavior of
 * boundedGunzip through the real readArchive path with a scaled-down cap,
 * instead of allocating/gzipping/inflating ~1 GB of real data per run (which
 * made the test wall-clock-sensitive under full-suite parallel load — issue
 * 058). Production callers must never pass it; the default is the production
 * cap and the guard's behavior is unchanged.
 */
export async function readArchive(
  bytes: Buffer,
  maxTotalBytes: number = MAX_TOTAL_BYTES,
): Promise<TarReadEntry[]> {
  let tarBytes = bytes;
  if (isGzip(bytes)) {
    const result = await boundedGunzip(bytes, maxTotalBytes);
    if (!result.ok) {
      return [{ path: "", error: result.error }];
    }
    tarBytes = result.data;
  }
  return parseTar(tarBytes);
}
