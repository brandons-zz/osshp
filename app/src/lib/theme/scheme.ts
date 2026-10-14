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

/**
 * Pre-paint hook for the APP SHELL (admin console, login, setup — issue 081).
 * The app shell is not theme-rendered, so it cannot rely on a theme resolving
 * "auto" for it. The root layout SSRs `data-scheme` on <html> when the scheme
 * is known server-side (persisted cookie, else an explicit operator default);
 * this script then, before first paint:
 *   1. applies a persisted override (cookie → localStorage), exactly as
 *      noFlashScript() does — so a localStorage-only choice still wins;
 *   2. else keeps the server-resolved operator default if one was emitted;
 *   3. else ("auto") resolves via prefers-color-scheme, and keeps following
 *      the OS while the page is open.
 * shell.css keys its dark tokens solely on `[data-scheme="dark"]`, so this is
 * the one place "auto" becomes a concrete scheme in the app shell.
 */
export function appShellSchemeScript(): string {
  return [
    "(function(){try{",
    "var k=" + JSON.stringify(SCHEME_STORAGE_KEY) + ";",
    "var e=document.documentElement;",
    "function set(v){e.setAttribute('data-scheme',v);e.style.colorScheme=v;}",
    "var m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));",
    "var v=null;try{v=m?decodeURIComponent(m[1]):null}catch(x){}",
    "if(v!=='light'&&v!=='dark'){try{v=localStorage.getItem(k)}catch(x){}}",
    "if(v==='light'||v==='dark'){set(v);return;}",
    "var s=e.getAttribute('data-scheme');",
    "if(s==='light'||s==='dark'){set(s);return;}",
    "var q=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');",
    "set(q&&q.matches?'dark':'light');",
    "e.setAttribute('data-scheme-auto','');",
    "if(q&&q.addEventListener)q.addEventListener('change',function(ev){",
    "if(e.hasAttribute('data-scheme-auto'))set(ev.matches?'dark':'light');",
    "});",
    "}catch(x){}})();",
  ].join("");
}

/**
 * Server-side half of the app-shell resolution (issue 081): the scheme the root
 * layout can SSR on <html>, or null when it depends on the client ("auto" with
 * no persisted override — appShellSchemeScript() resolves it pre-paint).
 * Same §6 order as resolveScheme(): persisted override, then operator default.
 */
export function resolveAppShellScheme(
  persisted: string | null | undefined,
  operatorDefault: unknown,
): Scheme | null {
  if (persisted === "light" || persisted === "dark") return persisted;
  if (operatorDefault === "light" || operatorDefault === "dark") {
    return operatorDefault;
  }
  return null;
}

/**
 * The FIRST `name` cookie in a Cookie header, decoded, or null. Matches what
 * the pre-paint scripts' regex picks when duplicate cookies exist (e.g. the
 * same name set on two paths), so server and client never disagree. A
 * malformed percent-encoding yields null rather than throwing (cf. issue 076).
 */
export function firstCookieValue(
  header: string | null | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
