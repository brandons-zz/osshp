// Domain types for the osshp content + settings model (spec §8).
// These are the app-internal shapes the stores read and write. The PUBLIC
// projections the theme receives (PublicPost, PublicPage, etc.) are derived by
// the theme engine (M1.4) from the published-only reads exposed here.

export type ContentStatus = "draft" | "published" | "scheduled";
export type PostType = "article" | "photo-post";

export const CONTENT_STATUSES: readonly ContentStatus[] = [
  "draft",
  "published",
  "scheduled",
];
export const POST_TYPES: readonly PostType[] = ["article", "photo-post"];

export interface ImageRef {
  src: string;
  alt: string;
}

/**
 * One image in a gallery photo post (issue 047), as read back from the store.
 * `src` is the public /media/<key> URL derived from the referenced media row;
 * `alt` is the canonical alt on that media row; `caption` is the optional
 * per-post text stored on the post_media join; width/height drive the auto
 * wide-plate decision (≥16:9 landscape → span-2). Ordered by `position`.
 */
export interface GalleryImage {
  mediaId: string;
  src: string;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
}

/**
 * Write shape for one gallery image (create/update). `mediaId` references an
 * existing media row (uploaded through the shared pipeline); `alt` is written
 * back to that media row (canonical alt); `caption` is stored on the join.
 */
export interface GalleryInput {
  mediaId: string;
  caption?: string;
  /** Canonical alt for the referenced media row; written through on save. */
  alt?: string;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
}

export interface Post {
  id: string;
  title: string;
  slug: string;
  /** Markdown source. The sanitized HTML the theme renders is produced by the M2.3 pipeline. */
  body: string;
  excerpt: string;
  coverImage: ImageRef | null;
  type: PostType;
  /** When true the photo-grid tile renders as a span-2 panoramic (.wide). */
  panoramic: boolean;
  /**
   * Photo-posts only: when true this post is a GALLERY (an ordered set of
   * images in `gallery`), rendered as an album. When false it is a Single photo
   * post (today's flow, one cover image). Default false. Ignored for articles.
   */
  isGallery: boolean;
  /**
   * Gallery mode only: the media id chosen as the post's card/index/OG cover.
   * Null ⇒ the first gallery image is the cover. Ignored when isGallery=false.
   */
  coverMediaId: string | null;
  /**
   * Gallery mode only: the ordered images (empty for a Single post). Each entry
   * carries the derived public src, the canonical media alt, the per-post
   * caption, and dimensions (for the auto wide-plate decision).
   */
  gallery: GalleryImage[];
  /**
   * Photo-posts only: when true, this photo-post also appears in the /blog
   * listing stream (linking to its /photos/<slug> home). Default false — photo-
   * posts are excluded from the blog stream unless opted in. Ignored for articles.
   */
  showInBlog: boolean;
  /**
   * When true, this post (article OR photo-post) is eligible for the home
   * "Selected" showcase (issue 012). The home renders up to four featured items
   * at a time, rotating through the set when more than four are flagged. Default
   * false. Applies to both post types.
   */
  featured: boolean;
  status: ContentStatus;
  publishDate: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  tags: Tag[];
}

export interface NewPost {
  title: string;
  slug: string;
  body: string;
  excerpt?: string;
  coverImage?: ImageRef | null;
  type?: PostType;
  /** Span-2 panoramic tile in the photo grid. Defaults false. */
  panoramic?: boolean;
  /** Photo-post only: opt this post into the /blog listing stream. Defaults false. */
  showInBlog?: boolean;
  /** Feature this post in the home "Selected" showcase (issue 012). Defaults false. */
  featured?: boolean;
  /** Photo-post only: mark this post a gallery (see Post.isGallery). Defaults false. */
  isGallery?: boolean;
  /** Gallery only: chosen cover media id (null/omitted ⇒ first image). */
  coverMediaId?: string | null;
  /**
   * Gallery only: the ordered image references to persist. When provided it
   * REPLACES the post's gallery membership (the post_media rows) and writes each
   * entry's alt through to its media row. Omit to leave the gallery unchanged.
   */
  gallery?: GalleryInput[];
  status?: ContentStatus;
  publishDate?: string | null;
  /** Tags to ensure-and-attach at creation; created if their slug is new. */
  tags?: Array<{ name: string; slug: string }>;
  /**
   * Override the DB-defaulted now() timestamp. Used ONLY by content import
   * (issue 002) to restore a post's original createdAt/updatedAt for a
   * lossless export -> import round-trip; every other caller omits these and
   * gets the normal now()-at-insert behavior.
   */
  createdAt?: string;
  updatedAt?: string;
}

export interface PostUpdate {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  coverImage?: ImageRef | null;
  type?: PostType;
  panoramic?: boolean;
  /** Photo-post only: opt this post into the /blog listing stream. */
  showInBlog?: boolean;
  /** Feature this post in the home "Selected" showcase (issue 012). */
  featured?: boolean;
  /** Photo-post only: mark this post a gallery (see Post.isGallery). */
  isGallery?: boolean;
  /** Gallery only: chosen cover media id (null ⇒ first image). */
  coverMediaId?: string | null;
  /**
   * Gallery only: when present, REPLACES the post's gallery membership
   * (post_media rows) and writes each entry's alt through to its media row.
   */
  gallery?: GalleryInput[];
  status?: ContentStatus;
  publishDate?: string | null;
  /** When present, replaces the post's tag set. */
  tags?: Array<{ name: string; slug: string }>;
  /**
   * Override the auto now() updated_at write. Used ONLY by content import
   * (issue 002) "overwrite existing" mode, to restore the source's original
   * updatedAt (and createdAt, which is otherwise immutable after creation)
   * instead of stamping the moment of re-import.
   */
  createdAt?: string;
  updatedAt?: string;
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  body: string;
  status: ContentStatus;
  /** When true, this published page is merged into the rendered site nav (V-010). */
  showInNav: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewPage {
  title: string;
  slug: string;
  body: string;
  status?: ContentStatus;
  /** Opt this page into the site nav on publish. Defaults false. */
  showInNav?: boolean;
  /** See NewPost.createdAt/updatedAt — same import-only override. */
  createdAt?: string;
  updatedAt?: string;
}

export interface PageUpdate {
  title?: string;
  slug?: string;
  body?: string;
  status?: ContentStatus;
  /** Toggle the page's appearance in the site nav. */
  showInNav?: boolean;
  /** See PostUpdate.createdAt/updatedAt — same import-only override. */
  createdAt?: string;
  updatedAt?: string;
}

/** One generated responsive variant of a media item (populated by M2.4/M2.5). */
export interface ResponsiveSize {
  width: number;
  height: number;
  key: string; // storage key of this variant
}

/** A reference to a media binary stored in Garage — not the binary itself. */
export interface MediaRef {
  id: string;
  /** Object-storage key of the original (S3/Garage). */
  storageKey: string;
  alt: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  /** Modeled now; the resize pipeline that fills it is M2.4/M2.5. */
  responsiveSizes: ResponsiveSize[];
  /** Modeled now; set true once the EXIF/GPS strip step (M2) has run. */
  exifStripped: boolean;
  /**
   * Attribution metadata (issue 077). `sourceUrl` is set only for images the
   * auto-import pipeline fetched from an external host; null for an ordinary
   * upload. `attribution`/`license` are optional credit text — see
   * db/migrations.ts 0012 for the full rationale.
   */
  sourceUrl: string | null;
  attribution: string | null;
  license: string | null;
  createdAt: string;
}

export interface NewMediaRef {
  storageKey: string;
  alt?: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  responsiveSizes?: ResponsiveSize[];
  exifStripped?: boolean;
  /** Issue 077 — see MediaRef.sourceUrl/attribution/license. */
  sourceUrl?: string | null;
  attribution?: string | null;
  license?: string | null;
}

export type SettingVisibility = "public" | "admin";

export interface SettingRow {
  key: string;
  value: unknown;
  visibility: SettingVisibility;
}

/**
 * A single stored passkey credential (shape modeled now; the WebAuthn ceremony
 * that creates/verifies these is M1.6). Kept loose so M1.6 can refine it.
 */
export interface PasskeyCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface AdminUser {
  id: string;
  passkeyCredentials: PasskeyCredential[];
  /** argon2id hash — set by the M2.2 recovery lane; null until provisioned. */
  passwordHash: string | null;
  /** AES-256-GCM-encrypted at rest (M2.2 secret-box); null until enrolled. */
  totpSecret: string | null;
  /** True once a TOTP enrollment has been confirmed by a valid code (verify-before-enable). */
  totpEnabled: boolean;
  /** Last consumed TOTP time-step — one-time-per-step replay guard (M2.2). */
  totpLastStep: number;
  /** Hashed, single-use recovery codes (M2.2 fills them). */
  recoveryCodes: string[];
  createdAt: string;
}

/** Fields accepted when provisioning the admin (M1.6 bootstrap). */
export interface NewAdminUser {
  passkeyCredentials?: PasskeyCredential[];
  passwordHash?: string | null;
  totpSecret?: string | null;
  recoveryCodes?: string[];
}

export interface AdminUserUpdate {
  passkeyCredentials?: PasskeyCredential[];
  passwordHash?: string | null;
  totpSecret?: string | null;
  totpEnabled?: boolean;
  totpLastStep?: number;
  recoveryCodes?: string[];
}
