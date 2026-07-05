// A trivial test theme — proves public content renders end-to-end through the
// engine (theme-rendering-contract acceptance). NOT a shipped theme; the polished
// reference theme is M1.9. It composes ONLY the public render context, renders
// sanitized bodyHtml, places the head.meta slot, and emits the app-provided
// no-flash hook + Layer-3 brand CSS in the document shell.

import * as React from "react";
import type {
  DocumentShell,
  ThemeContent,
  ThemeManifest,
  ThemeRenderContext,
} from "../types";

function PostListBody(posts: { title: string; slug: string }[]) {
  return (
    <main data-target="post-list">
      <ul>
        {posts.map((p) => (
          <li key={p.slug}>{p.title}</li>
        ))}
      </ul>
    </main>
  );
}

function contentBody(content: ThemeContent): React.ReactNode {
  switch (content.kind) {
    case "post":
    case "photo-post":
      return (
        <article data-target="post">
          <h1>{content.post.title}</h1>
          {/* bodyHtml is SanitizedHtml — produced by the app sanitizer (§9). */}
          <div
            data-body
            dangerouslySetInnerHTML={{ __html: content.post.bodyHtml }}
          />
        </article>
      );
    case "page":
      return (
        <main data-target="page">
          <h1>{content.page.title}</h1>
          <div
            data-body
            dangerouslySetInnerHTML={{ __html: content.page.bodyHtml }}
          />
        </main>
      );
    case "home":
    case "post-list":
    case "tag":
      return PostListBody(content.posts);
  }
}

export const testTheme: ThemeManifest = {
  id: "test-theme",
  name: "Test Theme",
  version: "0.0.0",
  tokenStylesheetHref: "/themes/test-theme/tokens.css",
  schemes: ["light", "dark"],
  document(ctx: ThemeRenderContext, shell: DocumentShell) {
    return (
      <html lang={ctx.site.locale} data-scheme={shell.scheme}>
        <head>
          <title>{ctx.site.title}</title>
          {/* App-provided no-flash hook, placed before stylesheets (§6). */}
          <script dangerouslySetInnerHTML={{ __html: shell.noFlashScript }} />
          <link rel="stylesheet" href={shell.structuralStylesheetHref} />
          <link rel="stylesheet" href={shell.tokenStylesheetHref} />
          <style dangerouslySetInnerHTML={{ __html: shell.brandTokenCss }} />
          {/* head.meta slot output (already sanitized, §8). */}
          {ctx.slots["head.meta"].map((s) => (
            <span
              key={s.sourceModuleId}
              dangerouslySetInnerHTML={{ __html: s.html }}
            />
          ))}
        </head>
        <body>{shell.body}</body>
      </html>
    );
  },
  templates: {
    home: (ctx) => contentBody(ctx.content),
    post: (ctx) => contentBody(ctx.content),
    page: (ctx) => contentBody(ctx.content),
    "post-list": (ctx) => contentBody(ctx.content),
    // intentionally NO tag / not-found templates — exercises engine fallback.
  },
};
