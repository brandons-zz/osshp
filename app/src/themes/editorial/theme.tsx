// "Editorial" — Direction A "Colophon" — the one polished REFERENCE THEME osshp
// ships with (M1.9; redesigned to the owner-approved Colophon direction). A
// publication's monospace technical apparatus (nav / meta / labels / the ledger
// index / grayscale photo plates / footer) wrapped around serif reading
// (Newsreader). Zero chromatic accent — a cool-grey paper + a graded ink ramp do
// all the work.
//
// Contract discipline (theme-rendering-contract §2, §5, §7, §9):
//   - reads its own self-contained color/material tokens (theme.css) + the app's
//     Layer-1 structural tokens (/structural.css); NEVER redefines a structural
//     token (type scale / spacing / radii / focus geometry / motion).
//   - accent-free by design; the operator's already-AA-safe accent (Layer-3
//     --accent-*/--focus) is honored only on the transient :focus-visible ring
//     (theme.css) — reading + furniture surfaces stay pure ink. The branding
//     pipeline is untouched.
//   - fonts are self-hosted woff2 (OFL) declared in theme.css — no external CDN.
//   - renders only the public-only ThemeRenderContext; never fetches data, sees a
//     secret, or reaches the admin (enforced by the shape of the context).
//   - bodyHtml / slot html are SanitizedHtml produced by the app pipeline (§9);
//     the theme renders them, it does not author its own unsanitized HTML.
//
// The public site is rendered to static markup (no client React), so the visitor
// toggle is a native <button> + a dependency-free inline script that flips
// data-scheme and persists the choice with the same key the no-flash hook reads.

import * as React from "react";
import { SCHEME_STORAGE_KEY } from "@/lib/theme/scheme";
import type {
  DocumentShell,
  PublicPost,
  PublicPostSummary,
  SanitizedSlotOutput,
  Scheme,
  SiteIdentity,
  ThemeManifest,
  ThemeRenderContext,
} from "@/lib/theme/types";

// ── Date formatting: ISO dot-separated (YYYY·MM·DD) ─────────────────────────
// The Colophon typographic identity uses ISO dot-separated dates throughout
// (Direction A §3). Never delegates to helpers.formatDate (locale-aware) — the
// format is part of the visual apparatus, not a locale preference.
function isoDot(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, "·");
}

// ── Slot rendering ───────────────────────────────────────────────────────────

/** Render already-sanitized slot contributions (§8) as raw HTML. */
function Slots({ items }: { items: ReadonlyArray<SanitizedSlotOutput> }) {
  return (
    <>
      {items.map((s, i) => (
        <div
          key={`${s.sourceModuleId}-${i}`}
          dangerouslySetInnerHTML={{ __html: s.html }}
        />
      ))}
    </>
  );
}

/**
 * head.meta slot output (§8.2 rule 2 — MUST be rendered for SEO correctness).
 * Each contribution is already-sanitized HTML destined for <head>. In
 * production the platform layer injects these directly before </head> (no
 * wrapper element) via renderPublicRoute. This component is retained as a
 * fallback for unit tests that invoke renderPage directly and supply head.meta
 * through mockCtx. Uses <template> (valid metadata content in <head>) rather
 * than <span> (invalid — causes browser head-exit) so that direct callers
 * also produce structurally correct markup.
 */
function HeadSlots({ items }: { items: ReadonlyArray<SanitizedSlotOutput> }) {
  return (
    <>
      {items.map((s, i) => (
        <template
          key={`${s.sourceModuleId}-${i}`}
          dangerouslySetInnerHTML={{ __html: s.html }}
        />
      ))}
    </>
  );
}

// ── The signature: the monospace writing ledger (§4 index) ───────────────────

/**
 * One ledger row — the shared horizontal-row primitive behind every listing
 * in the theme (Writing/Photographs index, Pages index, Tags index; issue
 * 059/061). `no` and `meta` are optional (the Pages/Tags indexes have no
 * folio number or date+reading-length); the three slots are keyed by class
 * name (`.no`/`.mid`/`.meta`), not DOM position, so a row that omits one
 * still lands its `.mid` title in the wide middle grid column instead of
 * falling into the narrow `.no` column (issue 059's root cause — see the
 * `.ledger a.row` grid-column rules in theme.css).
 */
function LedgerRow({
  href,
  no,
  title,
  tags,
  meta,
}: {
  href: string;
  no?: React.ReactNode;
  title: string;
  tags?: ReadonlyArray<{ name: string; slug: string }>;
  meta?: React.ReactNode;
}) {
  return (
    <li>
      <a className="row" href={href}>
        {no != null ? <span className="no">{no}</span> : null}
        <span className="mid">
          <span className="title">{title}</span>
          {tags && tags.length > 0 ? (
            <span className="tags">
              {tags.map((t) => (
                <span key={t.slug}>{t.name}</span>
              ))}
            </span>
          ) : null}
        </span>
        {meta != null ? <span className="meta">{meta}</span> : null}
      </a>
    </li>
  );
}

/**
 * The typographic ledger index — the answer to "a blog list needs visual
 * interest," done typographically (no image grid). Posts are newest-first; the
 * folio Nº counts down from the total so the newest carries the highest number.
 */
function Ledger({
  posts,
  total,
}: {
  posts: PublicPostSummary[];
  /** Absolute folio count for numbering. Defaults to posts.length; the home
   *  passes the full published total so a rendered slice keeps true Nº values. */
  total?: number;
}) {
  if (posts.length === 0) {
    return <p className="ledger-empty">No entries published yet.</p>;
  }
  const folioTotal = total ?? posts.length;
  return (
    <ol className="ledger">
      {posts.map((p, i) => (
        <LedgerRow
          key={p.slug}
          href={p.type === "photo-post" ? `/photos/${p.slug}` : `/blog/${p.slug}`}
          no={`Nº ${folioTotal - i}`}
          title={p.title}
          tags={p.tags}
          meta={
            <>
              {isoDot(p.publishedAt)}
              <span className="len">{p.readingLength} min</span>
            </>
          }
        />
      ))}
    </ol>
  );
}

// ── § 00 · Selected — the featured showcase (issue 012) ──────────────────────
//
// One LEAD feature (plate beside serif title + excerpt, a magazine opening) plus
// up to three SUPPORTING plates. Cards are grayscale plates — the theme's single
// committed image treatment; a card with no cover image degrades to a TYPOGRAPHIC
// plate (the title set as serif italic inside the sunken frame). Every card is one
// anchor (one tab stop); the mono kind label discriminates Essay vs Photograph.
// No plate numbers here — the set rotates per load, so a fixed number would lie.

const HOME_LEDGER_CAP = 6; // recent entries shown on the home; full ledger at /blog

/** Listing URL for a featured item: articles → /blog, photo-posts → /photos. */
function featHref(p: PublicPostSummary): string {
  return p.type === "photo-post" ? `/photos/${p.slug}` : `/blog/${p.slug}`;
}

/** Mono kind register: photo-posts read "Photograph", everything else "Essay". */
function featKindLabel(p: PublicPostSummary): string {
  return p.type === "photo-post" ? "Photograph" : "Essay";
}

/** Kind + ISO dot date (+ reading length for essays; omitted for photographs). */
function FeatKind({ p }: { p: PublicPostSummary }) {
  const isPhoto = p.type === "photo-post";
  const dt = isPhoto
    ? isoDot(p.publishedAt)
    : `${isoDot(p.publishedAt)} · ${p.readingLength} min`;
  return (
    <span className="feat-kind">
      {featKindLabel(p)} <span className="dt">{dt}</span>
    </span>
  );
}

/** The image (or typographic) plate. `lead` scales the type + adds the mark. */
function FeatPlate({ p, lead }: { p: PublicPostSummary; lead?: boolean }) {
  if (p.coverImage) {
    return (
      <span className="plate">
        <img
          className="plate-img"
          src={p.coverImage.src}
          alt={p.coverImage.alt}
          loading="lazy"
        />
      </span>
    );
  }
  // Missing cover ⇒ typographic plate: the title moves INTO the sunken frame as
  // serif italic (so the caption below omits it — no duplicate title).
  return (
    <span className="plate typo">
      <span className="t-kind">{featKindLabel(p)}</span>
      {lead ? (
        <span>
          <span className="regmark" aria-hidden="true" />
          <br />
          <span className="t-title">{p.title}</span>
        </span>
      ) : (
        <span className="t-title">{p.title}</span>
      )}
    </span>
  );
}

/** The lead spread — plate beside a title/excerpt column. */
function FeatLead({ p }: { p: PublicPostSummary }) {
  const hasCover = p.coverImage !== null;
  const more =
    p.type === "photo-post" ? "View the photograph →" : "Read the essay →";
  return (
    <li className="lead">
      <a className="feat lead" href={featHref(p)}>
        <FeatPlate p={p} lead />
        <span className="feat-txt">
          <FeatKind p={p} />
          {hasCover ? <span className="feat-title">{p.title}</span> : null}
          {p.excerpt ? <span className="feat-excerpt">{p.excerpt}</span> : null}
          <span className="feat-more">{more}</span>
        </span>
      </a>
    </li>
  );
}

/** A supporting plate — cover/typo plate + a compact caption. */
function FeatCard({ p }: { p: PublicPostSummary }) {
  const hasCover = p.coverImage !== null;
  return (
    <li>
      <a className="feat" href={featHref(p)}>
        <FeatPlate p={p} />
        <FeatKind p={p} />
        {hasCover ? <span className="feat-title">{p.title}</span> : null}
      </a>
    </li>
  );
}

/**
 * The register ghost, stated honestly: when the featured set exceeds the cap the
 * home rotates through it, and the ghost says so ("7 featured · 4 in rotation");
 * otherwise it just reports the count ("2 featured"). Digits (not spelled words)
 * match the theme's tabular-numeral apparatus and scale to any count.
 */
function featuredGhost(total: number, shown: number): string {
  return total > shown
    ? `${total} featured · ${shown} in rotation`
    : `${total} featured`;
}

/** § 00 · Selected. Renders nothing when nothing is featured (section omitted). */
function FeaturedShowcase({
  featured,
  featuredTotal,
}: {
  featured: PublicPostSummary[];
  featuredTotal: number;
}) {
  if (featured.length === 0) return null;
  const [lead, ...rest] = featured;
  return (
    <section className="sel" aria-label="Selected work">
      <p className="register">
        <span className="num">§ 00</span> <b>Selected</b>
        <span className="spacer" />
        <span className="ghost">{featuredGhost(featuredTotal, featured.length)}</span>
      </p>
      <ul className="sel-grid">
        <FeatLead key={lead.slug} p={lead} />
        {rest.map((p) => (
          <FeatCard key={p.slug} p={p} />
        ))}
      </ul>
    </section>
  );
}

// ── Content templates ────────────────────────────────────────────────────────

function homeBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content, site } = ctx;
  if (content.kind !== "home") return null;
  const { posts, featured, featuredTotal, intro } = content;
  const latest = posts[0];
  const recent = posts.slice(0, HOME_LEDGER_CAP);
  const hasMore = posts.length > HOME_LEDGER_CAP;
  return (
    <section className="wrap home" aria-label="Home">
      <h1>{site.title || "osshp"}</h1>
      {/* NEW: the intro deck — the dedicated home.intro setting rendered in the
          theme's serif-italic .deck voice. Omitted entirely when unset. */}
      {intro ? <p className="deck">{intro}</p> : null}
      <p className="specline">
        <span>{posts.length} {posts.length === 1 ? "entry" : "entries"}</span>
        {latest ? <span>latest {isoDot(latest.publishedAt)}</span> : null}
        <span>self-hosted with osshp</span>
      </p>
      <Slots items={ctx.slots["home.section"]} />
      <FeaturedShowcase featured={featured} featuredTotal={featuredTotal} />
      {posts.length > 0 ? (
        <div className="home-ledger">
          <p className="register">
            <span className="num">§ 01</span> <b>Writing</b>
            <span className="spacer" />
            <span className="ghost">{hasMore ? "six most recent" : "newest first"}</span>
          </p>
          <Ledger posts={recent} total={posts.length} />
          {hasMore ? (
            <p className="index-link">
              <a className="linkmono ghost" href="/blog">
                The full index →
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function postListBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "post-list") return null;
  return (
    <section className="wrap ledger-wrap" aria-label="Writing index">
      <p className="register">
        <span className="num">§ 01</span> <b>Writing</b>
        <span className="spacer" />
        <span className="ghost">
          {content.posts.length}{" "}
          {content.posts.length === 1 ? "entry" : "entries"} · newest first
        </span>
      </p>
      <Ledger posts={content.posts} />
    </section>
  );
}

function tagBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "tag") return null;
  const tagName = content.tag?.name ?? content.tag?.slug ?? "";
  return (
    <section className="wrap ledger-wrap" aria-label="Tagged writing">
      {/* Page-level H1 satisfies WCAG 1.3.1 document outline (V-018).
          The .register class overrides all browser default h1 styles so the
          visual appearance is identical to the other section registers. */}
      <h1 className="register">
        <span className="num">§</span> <b>Tagged</b>
        <span className="spacer" />
        <span className="ghost">{tagName}</span>
      </h1>
      <Ledger posts={content.posts} />
    </section>
  );
}

/**
 * Gallery count badge for an index plate (issue 047). A mono glyph + image count
 * ("▤ 24") sitting on the cover plate — the visible cue that a click opens an
 * album, not a single image. aria-hidden (decorative); the accessible signal is
 * carried by the plate anchor's aria-label + an sr-only span. Contrast-safe
 * tokens (--ink over --surface; --rule-strong boundary ≥3:1) — spec §4/§5.
 */
function CountBadge({ count }: { count: number }) {
  return (
    <span className="photo-badge" aria-hidden="true">
      <span className="photo-badge-glyph">▤</span>
      {count}
    </span>
  );
}

/** One index plate. A gallery plate links to its page (badged); a single plate
 *  keeps the shipped in-place lightbox anchor. */
function PhotoIndexTile({ p, i }: { p: PublicPostSummary; i: number }) {
  const plNo = String(i + 1).padStart(2, "0");
  const isGallery = p.galleryCount > 0;
  return (
    <figure className={p.panoramic ? "photo-tile wide" : "photo-tile"}>
      {isGallery ? (
        // Gallery plate: the WHOLE plate links to /photos/<slug> (the point of a
        // gallery is to see all of it). No .glightbox class → the lightbox lib
        // ignores it. The count badge is the visible "opens an album" cue.
        <a
          className="plate-link"
          href={`/photos/${p.slug}`}
          aria-label={`${p.title} — gallery of ${p.galleryCount} photographs`}
        >
          <img
            className="plate-img"
            src={p.coverImage!.src}
            alt={p.coverImage!.alt}
            loading="lazy"
          />
          <CountBadge count={p.galleryCount} />
        </a>
      ) : (
        // Single plate: unchanged — the cover opens the one-image lightbox in place.
        <a
          className="glightbox"
          href={p.coverImage!.src}
          data-gallery="photos"
          data-title={p.title}
          data-description={p.excerpt}
        >
          <img
            className="plate-img"
            src={p.coverImage!.src}
            alt={p.coverImage!.alt}
            loading="lazy"
          />
        </a>
      )}
      <figcaption className="plate-cap">
        <span className="n">Pl. {plNo}</span>
        {/* Title link navigates to the individual photo-item / gallery page so
            the visitor can use the in-page back affordance (← Photographs) and
            the browser Back button restores the grid's scroll position. */}
        <a href={`/photos/${p.slug}`}>{p.title}</a>
      </figcaption>
    </figure>
  );
}

function photoListBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "photo-list") return null;
  // Only photo-posts with a cover become plates (the cover is the plate image AND
  // the lightbox source). The markup is theme-authored (trusted), so the
  // `.glightbox` hook + data-* attributes survive — a module slot's sanitized HTML
  // would strip them, which is why the grid is a render target, not a slot.
  const tiles = content.posts.filter((p) => p.coverImage);
  return (
    <section className="wrap gallery-wrap" aria-label="Photographs" data-target="photo-list">
      <p className="register">
        <span className="num">§ 02</span> <b>Photographs</b>
        <span className="spacer" />
        <span className="ghost">
          {tiles.length}{" "}
          {tiles.length === 1 ? "photograph" : "photographs"}
        </span>
      </p>
      {tiles.length === 0 ? (
        <p className="ledger-empty">No photographs published yet.</p>
      ) : (
        <div className="photo-grid">
          {tiles.map((p, i) => (
            <PhotoIndexTile key={p.slug} p={p} i={i} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The gallery album grid on a photo-post page (issue 047). A uniform plate grid
 * matching the Photographs index (`.photo-grid`), each plate a grouped
 * `.glightbox` anchor (data-gallery="post-<slug>") so the shipped first-party
 * lightbox collects them into one prev/next set. A ≥16:9 landscape spans two
 * columns (.wide). Captions ride the lightbox only (data-title/description);
 * the grid stays clean (plate number only) per owner taste + spec §7. Every
 * image lazy-loads so a 40-image album is cheap on first paint.
 */
function PhotoAlbum({
  slug,
  title,
  images,
}: {
  slug: string;
  title: string;
  images: PublicPost["gallery"];
}) {
  const group = `post-${slug}`;
  return (
    <div className="photo-grid album-grid" data-album>
      {images.map((img, i) => (
        <figure
          className={img.wide ? "photo-tile wide" : "photo-tile"}
          key={`${slug}-${i}`}
        >
          <a
            className="glightbox"
            href={img.src}
            data-gallery={group}
            data-title={img.caption || title}
            data-description={img.caption}
          >
            <img
              className="plate-img"
              src={img.src}
              alt={img.alt}
              loading="lazy"
            />
          </a>
          <figcaption className="plate-cap">
            <span className="n">Pl. {String(i + 1).padStart(2, "0")}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function FiledUnder({ tags }: { tags: { name: string; slug: string }[] }) {
  if (tags.length === 0) return <span>—</span>;
  return (
    <span>
      {tags.map((t, i) => (
        <React.Fragment key={t.slug}>
          {i > 0 ? " · " : ""}
          <a href={`/tags/${t.slug}`}>{t.name}</a>
        </React.Fragment>
      ))}
    </span>
  );
}

function postBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "post" && content.kind !== "photo-post") return null;
  const post = content.post;
  const isPhoto = content.kind === "photo-post";
  // Gallery photo post (issue 047): render the album grid instead of the single
  // cover treatment. A Single photo post keeps galleryless behavior (empty array).
  const isGalleryPost = isPhoto && post.gallery.length > 0;
  // Back affordance: the originating listing is determined by the ROUTE KIND
  // (set by the route handler), not by the post's own type field. /blog/[slug]
  // uses kind:"post" (→ Writing index); /photos/[slug] uses kind:"photo-post"
  // (→ Photographs grid). This keeps the mapping stable: a route change
  // updates the affordance without touching theme logic.
  const backHref = isPhoto ? "/photos" : "/blog";
  const backLabel = isPhoto ? "← Photographs" : "← Writing";
  return (
    <article className="wrap article" data-target="post">
      <a className="backlink label" href={backHref}>
        {backLabel}
      </a>
      <p className="register inline">
        <b>{isPhoto ? "Photo post" : "Essay"}</b>
      </p>
      <h1>{post.title}</h1>

      <div className="spec" aria-label="Article details">
        <div>
          <b>Published</b>
          <span>{isoDot(post.publishedAt)}</span>
        </div>
        <div>
          <b>Filed under</b>
          <FiledUnder tags={post.tags} />
        </div>
      </div>

      {/* Gallery photo post (issue 047): masthead → optional intro → album grid.
          The intro (the Markdown body) is omitted entirely when empty — no empty
          container, no divider (spec §3, owner taste). The single cover figure is
          NOT rendered; the album grid replaces it. */}
      {isGalleryPost ? (
        <>
          {post.bodyHtml ? (
            <div
              className="prose post-body gallery-intro"
              data-body
              dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
            />
          ) : null}
          <PhotoAlbum slug={post.slug} title={post.title} images={post.gallery} />
        </>
      ) : (
        <>
          {post.coverImage ? (
            <figure className="plate cover">
              {isPhoto ? (
                // V-019: wrap the photograph in a glightbox anchor so clicking it
                // opens the vendored, CSP-strict lightbox (loaded via needsLightbox).
                // The anchor carries no inline styles — all state lives in CSS
                // classes (lightbox.css) per the first-party lightbox contract.
                <a
                  className="glightbox"
                  href={post.coverImage.src}
                  data-title={post.title}
                  data-description={post.excerpt}
                >
                  <img
                    className="plate-img"
                    src={post.coverImage.src}
                    alt={post.coverImage.alt}
                  />
                </a>
              ) : (
                <img
                  className="plate-img"
                  src={post.coverImage.src}
                  alt={post.coverImage.alt}
                />
              )}
            </figure>
          ) : null}

          {/* bodyHtml is SanitizedHtml — produced by the app sanitizer (§9). */}
          <div
            className="prose post-body"
            data-body
            dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
          />
        </>
      )}

      {post.tags.length > 0 ? (
        <nav className="ledger-tags" aria-label="Tags">
          {post.tags.map((t) => (
            <a className="linkmono ghost" key={t.slug} href={`/tags/${t.slug}`}>
              {t.name}
            </a>
          ))}
        </nav>
      ) : null}

      <Slots items={ctx.slots["post.belowBody"]} />
      <Slots items={ctx.slots["post.aside"]} />

      <p className="folio">— end —</p>
    </article>
  );
}

function pageBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "page") return null;
  return (
    <article className="wrap article" data-target="page">
      <h1>{content.page.title}</h1>
      <div
        className="prose post-body"
        data-body
        dangerouslySetInnerHTML={{ __html: content.page.bodyHtml }}
      />
    </article>
  );
}

// ── Pages index (V-010) ──────────────────────────────────────────────────────
// A minimal, on-identity listing of all published pages: title as a linked
// entry, arranged in the same ledger register as other listing pages. No
// gratuitous dividers; generous vertical spacing comes from the ledger CSS.
// Renders through the shared LedgerRow (issue 059) so /pages reads as
// horizontal rows identical to the /blog ledger, not stacked/vertical titles.

function pageListBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "page-list") return null;
  return (
    <section className="wrap ledger-wrap" aria-label="Pages index" data-target="page-list">
      <p className="register">
        <span className="num">§</span> <b>Pages</b>
        <span className="spacer" />
        <span className="ghost">
          {content.pages.length}{" "}
          {content.pages.length === 1 ? "page" : "pages"}
        </span>
      </p>
      {content.pages.length === 0 ? (
        <p className="ledger-empty">No pages published yet.</p>
      ) : (
        <ol className="ledger">
          {content.pages.map((p) => (
            <LedgerRow key={p.slug} href={`/pages/${p.slug}`} title={p.title} />
          ))}
        </ol>
      )}
    </section>
  );
}

// ── Tags index (issue 061) ────────────────────────────────────────────────────
// Mirrors the Pages index treatment exactly: same ledger register header, same
// shared LedgerRow, same empty-state paragraph. Each row's meta column carries
// the visible-post count instead of a date, linking to /tags/<slug>.

function tagListBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content } = ctx;
  if (content.kind !== "tag-list") return null;
  return (
    <section className="wrap ledger-wrap" aria-label="Tags index" data-target="tag-list">
      <p className="register">
        <span className="num">§</span> <b>Tags</b>
        <span className="spacer" />
        <span className="ghost">
          {content.tags.length}{" "}
          {content.tags.length === 1 ? "tag" : "tags"}
        </span>
      </p>
      {content.tags.length === 0 ? (
        <p className="ledger-empty">No tags published yet.</p>
      ) : (
        <ol className="ledger">
          {content.tags.map((t) => (
            <LedgerRow
              key={t.slug}
              href={`/tags/${t.slug}`}
              title={t.name}
              meta={`${t.count} ${t.count === 1 ? "post" : "posts"}`}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function notFoundBody(): React.ReactNode {
  return (
    <section className="wrap article" data-target="not-found">
      <p className="register inline">
        <b>404</b>
      </p>
      <h1>Page not found</h1>
      <p className="prose">
        That page doesn’t exist.{" "}
        <a href="/">Return to the notebook</a>.
      </p>
    </section>
  );
}

// ── Scroll-position restoration (listing pages — issue 004) ─────────────────
//
// Problem: the browser's native scroll restoration can be unreliable when a
// page is rebuilt after a non-BFCache Back navigation (font-swap reflow, no
// ETags). The affordance link ("← Writing" / "← Photographs") also triggers a
// forward navigation to the listing URL, which always starts at scroll=0.
//
// Solution: a tiny sessionStorage save/restore script, emitted ONLY on listing
// render targets (post-list, photo-list, home, tag). It:
//   • sets history.scrollRestoration="manual" so the browser doesn't race with us
//   • saves window.scrollY to sessionStorage on pagehide (before any navigation)
//   • restores the saved position on pageshow (after a non-BFCache reload)
//   • clears the entry on a BFCache pageshow (browser already preserved scroll)
//
// All script state is keyed to location.pathname so it is isolated per listing
// URL.  The script is nonce-carried (strict-dynamic CSP; see A1).

function scrollRestoreScript(): string {
  return [
    "(function(){",
    "'use strict';",
    "if(window.history&&history.scrollRestoration){history.scrollRestoration='manual';}",
    "var KEY='osshp-scroll:'+location.pathname;",
    "window.addEventListener('pageshow',function(e){",
    "if(e.persisted){",
    // BFCache: browser preserved exact page state — clear any stale entry so a
    // subsequent fresh load doesn't pick up an out-of-date position.
    "sessionStorage.removeItem(KEY);",
    "return;",
    "}",
    "var y=sessionStorage.getItem(KEY);",
    "if(y!==null){",
    "sessionStorage.removeItem(KEY);",
    "requestAnimationFrame(function(){window.scrollTo(0,parseInt(y,10));});",
    "}",
    "});",
    "window.addEventListener('pagehide',function(){",
    "sessionStorage.setItem(KEY,String(window.scrollY));",
    "});",
    "})();",
  ].join("");
}

/**
 * True on routes whose content is a navigable listing — the back-affordance
 * link on each item page returns here, so this page must restore scroll.
 */
function isListingRoute(ctx: ThemeRenderContext): boolean {
  const k = ctx.route.kind;
  return k === "post-list" || k === "photo-list" || k === "home" || k === "tag";
}

// ── Visitor light/dark toggle ────────────────────────────────────────────────

/**
 * Dependency-free inline script for the visitor toggle. The public site is static
 * markup (no client React), so the toggle is vanilla JS. It flips `data-scheme` +
 * `color-scheme` on <html> live and persists the choice with the SAME key the app
 * no-flash hook reads (cookie → localStorage), so the choice survives reloads with
 * no flash. `sync()` corrects the button label/aria after the no-flash hook may
 * have flipped the scheme post-SSR.
 */
function schemeToggleScript(): string {
  const k = JSON.stringify(SCHEME_STORAGE_KEY);
  return [
    "(function(){",
    "var k=" + k + ";",
    "var btn=document.querySelector('[data-scheme-toggle]');",
    "if(!btn)return;",
    "var icon=btn.querySelector('[data-scheme-icon]');",
    "var label=btn.querySelector('[data-scheme-label]');",
    "function sync(){",
    "var dark=document.documentElement.getAttribute('data-scheme')==='dark';",
    "var next=dark?'light':'dark';",
    "if(icon)icon.textContent=dark?'\\u25D1':'\\u25D0';",
    "if(label)label.textContent=dark?'Light':'Dark';",
    "btn.setAttribute('aria-label','Switch to '+next+' theme');",
    "btn.setAttribute('aria-pressed',String(dark));",
    "}",
    "sync();",
    "btn.addEventListener('click',function(){",
    "var dark=document.documentElement.getAttribute('data-scheme')==='dark';",
    "var next=dark?'light':'dark';",
    "var e=document.documentElement;",
    "e.setAttribute('data-scheme',next);",
    "e.style.colorScheme=next;",
    "try{document.cookie=k+'='+next+';path=/;max-age=31536000;SameSite=Lax';}catch(_){}",
    "try{localStorage.setItem(k,next);}catch(_){}",
    "sync();",
    "});",
    "})();",
  ].join("");
}

function SchemeToggle({ scheme }: { scheme: Scheme }) {
  const dark = scheme === "dark";
  return (
    <button
      type="button"
      className="scheme-toggle"
      data-scheme-toggle
      aria-pressed={dark}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span className="scheme-toggle-icon" data-scheme-icon aria-hidden="true">
        {dark ? "◑" : "◐"}
      </span>
      <span className="scheme-toggle-label" data-scheme-label>
        {dark ? "Light" : "Dark"}
      </span>
    </button>
  );
}

// ── Site header (masthead — sticky nav, issue 003) ───────────────────────────

function SiteHeader({ ctx }: { ctx: ThemeRenderContext }) {
  const { site } = ctx;
  return (
    <header className="site-head-bar">
      <div className="masthead-inner">
        {site.description ? (
          <p className="runline">{site.description}</p>
        ) : null}
        <div className="site-head">
          <a className="wordmark" href="/">
            {site.logo ? (
              <img className="glyph-img" src={site.logo.src} alt={site.logo.alt} />
            ) : (
              <span className="regmark" aria-hidden="true" />
            )}
            <span>{site.title || "osshp"}</span>
          </a>
          <nav className="site-nav" aria-label="Primary">
            {site.nav.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
            <Slots items={ctx.slots["header.nav"]} />
            <SchemeToggle scheme={ctx.scheme} />
          </nav>
        </div>
      </div>
    </header>
  );
}

// ── Per-page SEO metadata ────────────────────────────────────────────────────
//
// The theme owns the <head> shell (theme-rendering-contract §3.2 `document`
// target) and derives all per-page metadata from ThemeRenderContext only —
// no hardcoded values, no operator-config data beyond what the context carries.

/**
 * Per-page <title> — unique per page type (AC-1). Falls back to the site title
 * for the home route (which is intentionally title-only).
 */
function metaTitle(site: SiteIdentity, ctx: ThemeRenderContext): string {
  const base = site.title || "osshp";
  // A not-found route reuses the empty post-list content shape, so key the 404
  // title off route.kind (not content.kind) — otherwise it mislabels as "Writing".
  if (ctx.route.kind === "not-found") return `Not found — ${base}`;
  const { content } = ctx;
  switch (content.kind) {
    case "post":
    case "photo-post":
      return `${content.post.title} — ${base}`;
    case "page":
      return `${content.page.title} — ${base}`;
    case "photo-list":
      return `Photographs — ${base}`;
    case "post-list":
      return `Writing — ${base}`;
    case "tag":
      return content.tag ? `${content.tag.name} — ${base}` : `Writing — ${base}`;
    case "page-list":
      return `Pages — ${base}`;
    case "tag-list":
      return `Tags — ${base}`;
    default:
      return base; // home, not-found
  }
}

/**
 * Per-page meta description — derived from content where available, falls back
 * to the operator's site description.
 */
function metaDescription(site: SiteIdentity, ctx: ThemeRenderContext): string {
  const { content } = ctx;
  switch (content.kind) {
    case "post":
    case "photo-post":
      return content.post.excerpt;
    case "page":
      // Strip sanitized HTML tags to get text, max 160 chars.
      return content.page.bodyHtml.replace(/<[^>]*>/g, "").trim().slice(0, 160);
    case "photo-list":
      return site.description
        ? site.description
        : `Photographs published on ${site.title || "osshp"}`;
    case "tag":
      return content.tag
        ? `Writing tagged "${content.tag.name}" on ${site.title || "osshp"}`
        : site.description;
    case "tag-list":
      return site.description
        ? site.description
        : `All tags used on ${site.title || "osshp"}`;
    default:
      return site.description; // home, post-list, page-list, not-found
  }
}

/**
 * Make a potentially-relative media URL absolute. og:image requires an absolute
 * URL for social-card scrapers. In production OSSHP_ORIGIN is always set; in
 * unit tests the cover image src should already be absolute or this is a no-op.
 *
 * Phase-2 note: when the theme API admits untrusted themes, move the origin into
 * ThemeRenderContext.site so themes don't read process.env directly.
 */
function absoluteUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  const origin = (process.env.OSSHP_ORIGIN ?? "").replace(/\/$/, "");
  return `${origin}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * Open Graph + Twitter Card tags.
 * - og:title / og:description — same values as <title> / <meta name=description>
 * - og:type — "article" for posts, "website" for all other surfaces
 * - og:url — the canonical URL (absolute in production after context.ts change)
 * - og:image — cover image when available, made absolute for social scrapers
 * - twitter:card — "summary_large_image" when an image is present, else "summary"
 */
function OgMeta({ ctx }: { ctx: ThemeRenderContext }): React.ReactNode {
  const { site, route, content } = ctx;
  const title = metaTitle(site, ctx);
  const description = metaDescription(site, ctx);
  const isPostLike = content.kind === "post" || content.kind === "photo-post";
  const ogType = isPostLike ? "article" : "website";
  const coverSrc = isPostLike ? (content.post.coverImage?.src ?? null) : null;
  const ogImage = coverSrc ? absoluteUrl(coverSrc) : null;
  return (
    <>
      <meta property="og:title" content={title} />
      {description ? (
        <meta property="og:description" content={description} />
      ) : null}
      <meta property="og:type" content={ogType} />
      <meta property="og:url" content={route.canonicalUrl} />
      {ogImage ? <meta property="og:image" content={ogImage} /> : null}
      {site.title ? <meta property="og:site_name" content={site.title} /> : null}
      <meta
        name="twitter:card"
        content={ogImage ? "summary_large_image" : "summary"}
      />
    </>
  );
}

// ── Photo lightbox (osshp first-party, CSP-strict — see CREDITS.md) ──────────
// Vanilla-JS module (the public site is static markup, no client React). CSS + JS
// are app-owned static assets under /vendor/lightbox/, loaded ONLY on the Photos
// grid route. It writes NO inline style attributes (all visual state via CSS
// classes + element properties), so the nonce-based CSP (style-src) is never
// violated. The <script src> carries the per-request nonce (strict-dynamic).

/** True on routes that render a `.glightbox` element and need the lightbox lib. */
function needsLightbox(ctx: ThemeRenderContext): boolean {
  // photo-list: the photograph grid (multiple photos).
  // photo-post: the individual photo item page — the cover IS the photograph (V-019).
  return ctx.route.kind === "photo-list" || ctx.route.kind === "photo-post";
}

export const editorialTheme: ThemeManifest = {
  id: "editorial",
  name: "Editorial — Colophon",
  version: "2.0.0",
  tokenStylesheetHref: "/themes/editorial/theme.css",
  schemes: ["light", "dark"],

  document(ctx: ThemeRenderContext, shell: DocumentShell) {
    const { site } = ctx;
    const year = new Date().getUTCFullYear();
    const description = metaDescription(site, ctx);
    return (
      <html lang={site.locale || "en"} data-scheme={shell.scheme}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{metaTitle(site, ctx)}</title>
          {description ? (
            <meta name="description" content={description} />
          ) : null}
          <link rel="canonical" href={ctx.route.canonicalUrl} />
          {/* osshp brand favicon — default for every instance, no operator
              config required. Same-origin static assets under public/, so CSP
              img-src 'self' already covers them; plain <link> tags need no
              nonce. The SVG comes first: SVG-capable browsers prefer it and get
              the simplified house-in-hex mark crisp at every size. The .ico +
              PNG sizes (16/32/48 rendered from the same simplified mark; 192/512
              the full badge) are the fallback for browsers without SVG-favicon
              support. */}
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="icon" href="/favicon.ico" sizes="any" />
          <link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16" />
          <link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32" />
          <link rel="icon" href="/favicon-48x48.png" type="image/png" sizes="48x48" />
          <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
          <link rel="icon" href="/icon-512.png" type="image/png" sizes="512x512" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          {/* Open Graph + Twitter Card tags — derived from content, not hardcoded. */}
          <OgMeta ctx={ctx} />
          {/* App-provided no-flash hook, before any stylesheet or body (§6).
              nonce-carried so it runs under the nonce-based CSP (A1). */}
          <script
            nonce={shell.nonce}
            dangerouslySetInnerHTML={{ __html: shell.noFlashScript }}
          />
          {/* Layer-1 structural (app-owned) → Layer-2 theme tokens (§4). The
              theme sheet also declares the self-hosted @font-face (font-src 'self'). */}
          <link rel="stylesheet" href={shell.structuralStylesheetHref} />
          <link rel="stylesheet" href={shell.tokenStylesheetHref} />
          {/* Shiki syntax-highlight CSS — served from 'self' at /shiki.css.
              Class-based output (V-013 CSP fix): no inline styles on token spans,
              so style-src 'self' nonce-… remains unviolated. Loaded on all pages
              because any post or page body may contain a fenced code block. */}
          <link rel="stylesheet" href="/shiki.css" />
          {/* Lightbox CSS — only on the Photos grid. External stylesheet from
              'self' (style-src 'self'); no nonce needed for a <link>. */}
          {needsLightbox(ctx) ? (
            <link rel="stylesheet" href="/vendor/lightbox/lightbox.css" />
          ) : null}
          {/* Layer-3 brand tokens for BOTH schemes (already AA-safe, §7).
              nonce-carried — the only inline style allowed under the CSP (A1). The
              Colophon theme is accent-free, but honors --focus if the operator
              sets an accent. */}
          <style
            nonce={shell.nonce}
            dangerouslySetInnerHTML={{ __html: shell.brandTokenCss }}
          />
          {/* Module head.meta slot output (already sanitized, §8). The Blog module
              contributes the RSS autodiscovery <link> here when enabled — so a
              Blog-disabled operator's head never points to a 404 /rss.xml. */}
          <HeadSlots items={ctx.slots["head.meta"]} />
        </head>
        <body>
          <SiteHeader ctx={ctx} />
          <main>{shell.body}</main>
          <footer className="colophon">
            <div className="inner">
              {/* issue 043: the footer page-nav duplicated the header nav
                  (site.nav) and, laid out as a stacked column next to the
                  horizontal socials, read as visually mismatched. Pages are
                  already reachable from the header — the footer keeps only
                  the socials (horizontal, issue 038) and the colophon. */}
              {site.social.length > 0 ? (
                <nav className="fnav" aria-label="Social">
                  {site.social.map((item, i) => (
                    <React.Fragment key={item.href}>
                      {i > 0 ? (
                        <span className="fsep" aria-hidden="true">
                          ·
                        </span>
                      ) : null}
                      {/* issue 060: social links leave the site, so they open in
                          a NEW tab (visitor keeps their place on steili.com).
                          rel="noopener noreferrer" is required alongside
                          target="_blank" — noopener blocks the opened page from
                          reaching back via window.opener (reverse-tabnabbing),
                          noreferrer additionally suppresses the Referer header.
                          Internal nav links (site.nav, above) stay same-tab. */}
                      <a href={item.href} target="_blank" rel="noopener noreferrer">
                        {item.network}
                      </a>
                    </React.Fragment>
                  ))}
                </nav>
              ) : null}
              <p className="stamp">
                © {year} {site.title || "osshp"} · powered by{" "}
                <a href="https://osshp.com">osshp</a>
              </p>
              <div className="footer-extra">
                <Slots items={ctx.slots["footer.widgets"]} />
              </div>
            </div>
          </footer>
          {/* Visitor toggle behavior — vanilla, no client React on the public
              site. nonce-carried so it runs under the nonce-based CSP (A1). */}
          <script
            nonce={shell.nonce}
            dangerouslySetInnerHTML={{ __html: schemeToggleScript() }}
          />
          {/* Scroll-position restoration — listing pages only (issue 004).
              Saves/restores scroll so Back and the in-page affordance link both
              land the visitor at their prior position in the index. nonce-carried
              so it runs under the nonce-based CSP (A1). */}
          {isListingRoute(ctx) ? (
            <script
              nonce={shell.nonce}
              dangerouslySetInnerHTML={{ __html: scrollRestoreScript() }}
            />
          ) : null}
          {/* Photo lightbox (osshp first-party, CSP-strict) — Photos grid only. */}
          {needsLightbox(ctx) ? (
            <script src="/vendor/lightbox/lightbox.js" nonce={shell.nonce} />
          ) : null}
        </body>
      </html>
    );
  },

  templates: {
    home: (ctx) => homeBody(ctx),
    post: (ctx) => postBody(ctx),
    page: (ctx) => pageBody(ctx),
    "post-list": (ctx) => postListBody(ctx),
    "photo-list": (ctx) => photoListBody(ctx),
    "page-list": (ctx) => pageListBody(ctx),
    "tag-list": (ctx) => tagListBody(ctx),
    tag: (ctx) => tagBody(ctx),
    "not-found": () => notFoundBody(),
  },
};
