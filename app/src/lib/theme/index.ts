// Public barrel for the theme engine (theme-rendering-contract implementation).
//
// The swappable theme seam: the app composes a public-only ThemeRenderContext
// per route (context.ts), derives already-AA-safe brand tokens (brand.ts),
// resolves the light/dark scheme with a no-flash pre-paint hook (scheme.ts),
// exposes a theme registry + slot registry (registry.ts), routes render targets
// and assembles the document (engine.ts), and sanitizes all content/slot HTML
// through the app-owned pipeline (sanitize.ts). A theme consumes the context
// only — it never fetches data, touches the admin, or sees a secret.

export * from "./types";
export { renderMarkdown, sanitizeHtmlFragment } from "./sanitize";
export {
  resolveBrandTokens,
  brandTokensToCss,
  sanitizeAccent,
  sanitizeFontFamily,
  type BrandInput,
} from "./brand";
export { contrastRatio, relativeLuminance, hexToRgb } from "./color";
export { resolveScheme, noFlashScript, SCHEME_STORAGE_KEY } from "./scheme";
export {
  createThemeRegistry,
  selectActiveTheme,
  emptySlots,
  collectSlots,
  type ThemeRegistry,
  type SlotContribution,
} from "./registry";
export {
  buildRenderContext,
  buildRenderContextFromSettings,
  composeRenderContext,
  getBrandInput,
  buildSiteIdentity,
  defaultHelpers,
  toPublicPost,
  toPublicPostSummary,
  toPublicPage,
  toPublicPageSummary,
  toPublicTag,
  type RouteRequest,
  type BuildContextOptions,
} from "./context";
export {
  renderRequest,
  renderPage,
  renderContent,
  resolveTarget,
  validateManifest,
  pickTemplate,
  type RenderPageOptions,
  type RenderRequestOptions,
} from "./engine";
