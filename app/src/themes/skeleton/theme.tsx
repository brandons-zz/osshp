// The skeleton reference theme — a minimal, app-bundled ThemeManifest that proves
// public content renders end-to-end through the theme engine for the M1 walking
// skeleton. The polished "Editorial Clarity" reference theme is M1.9 and replaces
// this; M1.9 plugs into the SAME render path (a ThemeManifest with a document
// shell + content templates), so this models the contract the reference theme
// builds against.
//
// Per the theme contract the theme owns COLOR/MATERIAL only: it reads Layer-1
// structural tokens (via the app-provided structural stylesheet href) and Layer-3
// brand tokens (injected by the app guardrail as brandTokenCss), and ships its own
// Layer-2 color sheet (tokenStylesheetHref). It renders only the public-only
// ThemeRenderContext — it never fetches data, sees a secret, or reaches the admin.

import * as React from "react";
import type {
  DocumentShell,
  PublicPostSummary,
  SanitizedSlotOutput,
  ThemeContent,
  ThemeManifest,
  ThemeRenderContext,
} from "@/lib/theme/types";

/** Render a list of already-sanitized slot contributions as raw HTML spans. */
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

function PostList(
  posts: PublicPostSummary[],
  helpers: ThemeRenderContext["helpers"],
) {
  if (posts.length === 0) {
    return <p className="empty">No posts published yet.</p>;
  }
  return (
    <ul className="post-list">
      {posts.map((p) => (
        <li className="post-card" key={p.slug}>
          <h2>
            <a href={`/blog/${p.slug}`}>{p.title}</a>
          </h2>
          <p className="post-meta">{helpers.formatDate(p.publishedAt)}</p>
          {p.excerpt ? <p className="post-excerpt">{p.excerpt}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function contentBody(ctx: ThemeRenderContext): React.ReactNode {
  const { content, helpers } = ctx;
  switch (content.kind) {
    case "post":
    case "photo-post": {
      const post = content.post;
      return (
        <article className="post-article" data-target="post">
          <a className="backlink" href="/blog">
            ← All posts
          </a>
          <h1>{post.title}</h1>
          <p className="post-meta">{helpers.formatDate(post.publishedAt)}</p>
          {/* bodyHtml is SanitizedHtml — produced by the app sanitizer (§9). */}
          <div
            className="post-body"
            data-body
            dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
          />
          {post.tags.length > 0 ? (
            <nav className="post-tags" aria-label="Tags">
              {post.tags.map((t) => (
                <a key={t.slug} href={`/tags/${t.slug}`}>
                  {t.name}
                </a>
              ))}
            </nav>
          ) : null}
          <Slots items={ctx.slots["post.belowBody"]} />
          <Slots items={ctx.slots["post.aside"]} />
        </article>
      );
    }
    case "page":
      return (
        <article className="post-article" data-target="page">
          <h1>{content.page.title}</h1>
          <div
            className="post-body"
            data-body
            dangerouslySetInnerHTML={{ __html: content.page.bodyHtml }}
          />
        </article>
      );
    case "tag":
      return (
        <section data-target="tag">
          <h1>Tagged: {content.tag?.name ?? ""}</h1>
          {PostList(content.posts, helpers)}
        </section>
      );
    case "home":
    case "post-list":
    case "photo-list":
      // The skeleton (dev fallback) has no lightbox grid — it renders the photo
      // list as a plain post list. The polished Editorial theme owns the grid +
      // lightbox.
      return (
        <section data-target={content.kind}>
          {ctx.slots["home.section"].length > 0 ? (
            <Slots items={ctx.slots["home.section"]} />
          ) : null}
          {PostList(content.posts, helpers)}
        </section>
      );
  }
}

function notFoundBody(): React.ReactNode {
  return (
    <section data-target="not-found">
      <h1>Not found</h1>
      <p className="empty">
        That page does not exist. <a href="/">Go home</a>.
      </p>
    </section>
  );
}

export const skeletonTheme: ThemeManifest = {
  id: "skeleton",
  name: "Skeleton",
  version: "0.1.0",
  tokenStylesheetHref: "/themes/skeleton/theme.css",
  schemes: ["light", "dark"],

  document(ctx: ThemeRenderContext, shell: DocumentShell) {
    const { site } = ctx;
    return (
      <html lang={site.locale} data-scheme={shell.scheme}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{site.title || "osshp"}</title>
          {site.description ? (
            <meta name="description" content={site.description} />
          ) : null}
          {/* App-provided no-flash hook, placed before stylesheets (§6).
              nonce-carried so it runs under the nonce-based CSP (A1). */}
          <script
            nonce={shell.nonce}
            dangerouslySetInnerHTML={{ __html: shell.noFlashScript }}
          />
          {/* Layer-1 structural (app-owned) → Layer-2 theme tokens. */}
          <link rel="stylesheet" href={shell.structuralStylesheetHref} />
          <link rel="stylesheet" href={shell.tokenStylesheetHref} />
          {/* Layer-3 brand tokens for BOTH schemes (already AA-safe, §7).
              nonce-carried — the only inline style allowed under the CSP (A1). */}
          <style
            nonce={shell.nonce}
            dangerouslySetInnerHTML={{ __html: shell.brandTokenCss }}
          />
          {/* Module head.meta slot output (already sanitized, §8). */}
          <Slots items={ctx.slots["head.meta"]} />
        </head>
        <body>
          <div className="site">
            <header className="site-header">
              <div>
                <p className="site-title">
                  <a href="/">{site.title || "osshp"}</a>
                </p>
                {site.description ? (
                  <p className="site-desc">{site.description}</p>
                ) : null}
              </div>
              <nav className="site-nav" aria-label="Primary">
                <a href="/blog">Blog</a>
                {site.nav.map((item) => (
                  <a key={item.href} href={item.href}>
                    {item.label}
                  </a>
                ))}
                <Slots items={ctx.slots["header.nav"]} />
              </nav>
            </header>
            <main className="site-main">{shell.body}</main>
            <footer className="site-footer">
              <p>
                {site.title || "osshp"} · powered by{" "}
                <a href="https://osshp.com">osshp</a>
              </p>
              <Slots items={ctx.slots["footer.widgets"]} />
            </footer>
          </div>
        </body>
      </html>
    );
  },

  templates: {
    home: (ctx) => contentBody(ctx),
    post: (ctx) => contentBody(ctx),
    page: (ctx) => contentBody(ctx),
    "post-list": (ctx) => contentBody(ctx),
    "photo-list": (ctx) => contentBody(ctx),
    tag: (ctx) => contentBody(ctx),
    "not-found": () => notFoundBody(),
  },
};
