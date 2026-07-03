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
