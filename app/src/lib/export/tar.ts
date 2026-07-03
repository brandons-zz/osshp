// A minimal, dependency-free USTAR (POSIX tar) archive writer.
//
// The export/CLI download path needs a single-file, streamable archive format
// with zero new runtime dependencies (matches the codebase's hand-rolled-
// serializer convention — see lib/content/feed.ts's hand-assembled RSS XML).
// USTAR is a simple, universally-readable format (`tar xf`, 7-Zip, Archive
// Utility, Python's tarfile, Node's `tar` package all read it) so an operator
// (or the future import service, issue 002) never needs osshp-specific
// unpacking code.
//
// Only what buildTar() needs is implemented: regular files, no directory
// entries (directories are implied by file paths, same as `tar` does with
// `--no-recursion` on a flat file list), no symlinks/special files.

export interface TarEntry {
  /** Path inside the archive, e.g. "posts/hello-world.md". Forward slashes only. */
  path: string;
  data: Buffer;
  /** Defaults to the build time if omitted. */
  mtime?: Date;
}

const BLOCK_SIZE = 512;

/** Zero-padded octal field, NUL-terminated, matching USTAR header conventions. */
function octalField(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * Split a path into USTAR's separate `name` (100 bytes) + `prefix` (155 bytes)
 * fields. Returns null if the path cannot be represented (name segment alone
 * exceeds 100 bytes, or the whole path exceeds 255 bytes) — callers must fail
 * loud rather than silently truncate a path.
 */
function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path, "utf8") <= 100) {
    return { name: path, prefix: "" };
  }
  if (Buffer.byteLength(path, "utf8") > 255) return null;

  // Find the rightmost '/' such that the tail (name) fits in 100 bytes and the
  // head (prefix) fits in 155 bytes — the standard USTAR splitting algorithm.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (
      Buffer.byteLength(name, "utf8") <= 100 &&
      Buffer.byteLength(prefix, "utf8") <= 155
    ) {
      return { name, prefix };
    }
  }
  return null;
}

function buildHeader(entry: TarEntry, mtime: Date): Buffer {
  const split = splitUstarPath(entry.path);
  if (!split) {
    throw new Error(
      `buildTar: path cannot be represented in a USTAR header (too long): ${entry.path}`,
    );
  }

  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(split.name, 0, 100, "utf8");
  header.write(octalField(0o644, 8), 100, 8, "ascii"); // mode
  header.write(octalField(0, 8), 108, 8, "ascii"); // uid
  header.write(octalField(0, 8), 116, 8, "ascii"); // gid
  header.write(octalField(entry.data.length, 12), 124, 12, "ascii"); // size
  header.write(
    octalField(Math.floor(mtime.getTime() / 1000), 12),
    136,
    12,
    "ascii",
  ); // mtime
  header.write("        ", 148, 8, "ascii"); // checksum placeholder (8 spaces)
  header.write("0", 156, 1, "ascii"); // typeflag: '0' = regular file
  header.write("ustar\0", 257, 6, "ascii"); // magic
  header.write("00", 263, 2, "ascii"); // version
  header.write(split.prefix, 345, 155, "utf8");

  // Checksum: unsigned sum of all header bytes with the checksum field treated
  // as 8 spaces (already written above), written as a 6-digit zero-padded
  // octal followed by NUL and a space.
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(checksum, 148, 8, "ascii");

  return header;
}

function padToBlock(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/**
 * Build an uncompressed USTAR archive from a flat list of entries. Deterministic
 * for a given input (no timestamps unless `mtime` is passed per-entry), so it is
 * safe to compare byte-for-byte in tests.
 */
export function buildTar(entries: TarEntry[], now: Date = new Date()): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const mtime = entry.mtime ?? now;
    chunks.push(buildHeader(entry, mtime));
    chunks.push(entry.data);
    const pad = padToBlock(entry.data.length);
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  // Two 512-byte zero blocks terminate a tar archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
}
