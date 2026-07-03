// Two-state color-scheme resolution + the no-flash pre-paint hook
// (theme-rendering-contract §6).
//
// osshp supports exactly two schemes (light/dark) on a `data-scheme` attribute on
// <html>. The operator sets a default (light/dark/auto); a visitor may toggle
// (persisted client-side). The app resolves "auto" to a concrete scheme BEFORE
// handoff — a theme never receives "auto". The pre-paint hook corrects for a
// visitor override synchronously before first paint so there is no flash.

import type { Scheme, SchemeSetting } from "./types";

/** Client-side persistence key for the visitor's scheme override. */
export const SCHEME_STORAGE_KEY = "osshp-scheme";

/**
 * Resolve the concrete scheme for a render (§6 resolution order):
 *   1. visitor's persisted choice (cookie, then localStorage), if valid;
 *   2. else operator default — light/dark as-is, "auto" → prefers-color-scheme.
 */
export function resolveScheme(
  persisted: string | null | undefined,
  operatorDefault: SchemeSetting,
  prefersDark = false,
): Scheme {
  if (persisted === "light" || persisted === "dark") return persisted;
  if (operatorDefault === "light" || operatorDefault === "dark") {
    return operatorDefault;
  }
  return prefersDark ? "dark" : "light";
}

/**
 * The inline pre-paint script (app-provided, §6). Runs before any stylesheet or
 * body content: reads the persisted override (cookie → localStorage), and only
 * if present sets `data-scheme` + the `color-scheme` property on <html> before
 * first paint. SSR already emits the operator-default scheme on <html>, so this
 * only corrects a visitor override — eliminating a light→dark flash. The theme
 * must not re-implement this; it places the returned string in <head>.
 */
export function noFlashScript(): string {
  // Minified, dependency-free IIFE. Self-contained; reads only the persisted key.
  return [
    "(function(){try{",
    "var k=" + JSON.stringify(SCHEME_STORAGE_KEY) + ";",
    "var m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));",
    "var v=m?decodeURIComponent(m[1]):null;",
    "if(v!=='light'&&v!=='dark'){try{v=localStorage.getItem(k)}catch(e){}}",
    "if(v==='light'||v==='dark'){",
    "var e=document.documentElement;",
    "e.setAttribute('data-scheme',v);",
    "e.style.colorScheme=v;",
    "}",
    "}catch(e){}})();",
  ].join("");
}
