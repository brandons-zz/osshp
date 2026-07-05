// The theme engine — render-target routing + document shell assembly
// (theme-rendering-contract §3.2, §4, §6).
//
// At request time the app: resolves the active theme → builds the public-only
// ThemeRenderContext (context.ts) → routes the request to a render target →
// invokes the theme's template → wraps it in the theme's document shell, with the
// app-provided no-flash hook and Layer-3 brand token CSS injected (§4, §6, §7).

import * as React from "react";
import type { Db } from "@/lib/db/types";
import { getPublicSettings } from "@/lib/content";
import { brandTokensToCss } from "./brand";
import {
  buildRenderContextFromSettings,
  getBrandInput,
  type BuildContextOptions,
  type RouteRequest,
} from "./context";
import { noFlashScript } from "./scheme";
import {
  REQUIRED_CONTENT_TARGETS,
  type ContentTargetId,
  type DocumentShell,
  type ThemeManifest,
  type ThemeRenderContext,
  type ThemeTemplate,
} from "./types";

const DEFAULT_STRUCTURAL_HREF = "/structural.css";

/** Map a resolved route kind to the content render target it uses (§3.2). */
export function resolveTarget(kind: ThemeRenderContext["route"]["kind"]): ContentTargetId {
  switch (kind) {
    case "home":
      return "home";
    case "post":
    case "photo-post":
      return "post";
    case "page":
      return "page";
    case "post-list":
      return "post-list";
    case "photo-list":
      return "photo-list";
    case "tag":
      return "tag";
    case "page-list":
      return "page-list";
    case "tag-list":
      return "tag-list";
    case "not-found":
      return "not-found";
  }
}

/**
 * Validate a manifest provides the required render targets (§3.2). The document
 * shell and the four required content targets must exist; tag/not-found are
 * optional (they fall back). Throws with a precise message on a missing target.
 */
export function validateManifest(manifest: ThemeManifest): void {
  if (typeof manifest.document !== "function") {
    throw new Error(
      `Theme "${manifest.id}": missing required "document" template.`,
    );
  }
  for (const t of REQUIRED_CONTENT_TARGETS) {
    if (typeof manifest.templates[t] !== "function") {
      throw new Error(
        `Theme "${manifest.id}": missing required render target "${t}".`,
      );
    }
  }
}

/** A minimal app-provided 404 used when a theme ships no not-found template. */
function defaultNotFound(): React.ReactNode {
  return React.createElement("main", null, "Not found");
}

/**
 * Pick the template for a target, applying the contract fallbacks (§3.2):
 * `tag` / `photo-list` → `post-list`; `not-found` → app default. (A `photo-list`
 * content reuses the post-list summary shape, so the post-list template renders
 * it correctly when a theme ships no dedicated grid template.)
 */
export function pickTemplate(
  manifest: ThemeManifest,
  target: ContentTargetId,
): ThemeTemplate {
  const direct = manifest.templates[target];
  if (direct) return direct;
  if (
    (target === "tag" || target === "photo-list") &&
    manifest.templates["post-list"]
  ) {
    return manifest.templates["post-list"];
  }
  if (target === "not-found") {
    return manifest.templates["not-found"] ?? (() => defaultNotFound());
  }
  // Required targets are guaranteed by validateManifest; this is unreachable for
  // them. Any other gap falls back to a default node rather than throwing mid-render.
  return () => defaultNotFound();
}

/** Render the route's content body through the active theme's template. */
export function renderContent(
  manifest: ThemeManifest,
  ctx: ThemeRenderContext,
): React.ReactNode {
  const target = resolveTarget(ctx.route.kind);
  return pickTemplate(manifest, target)(ctx);
}

export interface RenderPageOptions {
  /** Layer-1 structural stylesheet href (loads before the token sheet, §4). */
  structuralStylesheetHref?: string;
  /** Layer-3 brand token CSS for both schemes (from brandTokensToCss, §6/§7). */
  brandTokenCss: string;
  /** Per-request CSP nonce (A1) the theme stamps on its inline script/style. */
  nonce?: string;
}

/**
 * Render the full document for a route: content body wrapped in the theme's
 * document shell, with the app-provided no-flash hook and brand token CSS.
 */
export function renderPage(
  manifest: ThemeManifest,
  ctx: ThemeRenderContext,
  opts: RenderPageOptions,
): React.ReactNode {
  validateManifest(manifest);
  const body = renderContent(manifest, ctx);
  const shell: DocumentShell = {
    scheme: ctx.scheme,
    noFlashScript: noFlashScript(),
    structuralStylesheetHref:
      opts.structuralStylesheetHref ?? DEFAULT_STRUCTURAL_HREF,
    tokenStylesheetHref: manifest.tokenStylesheetHref,
    brandTokenCss: opts.brandTokenCss,
    nonce: opts.nonce,
    body,
  };
  return manifest.document(ctx, shell);
}

export interface RenderRequestOptions
  extends BuildContextOptions,
    Pick<RenderPageOptions, "structuralStylesheetHref" | "nonce"> {}

/**
 * End-to-end render: build the public-only context for the request and render the
 * full document. Reads public settings once and reuses them for the brand CSS.
 */
export async function renderRequest(
  db: Db,
  manifest: ThemeManifest,
  req: RouteRequest,
  opts: RenderRequestOptions = {},
): Promise<React.ReactNode> {
  const publicSettings = await getPublicSettings(db);
  const ctx = await buildRenderContextFromSettings(
    db,
    req,
    publicSettings,
    opts,
  );
  const brandTokenCss = brandTokensToCss(getBrandInput(publicSettings));
  return renderPage(manifest, ctx, {
    structuralStylesheetHref: opts.structuralStylesheetHref,
    brandTokenCss,
    nonce: opts.nonce,
  });
}
