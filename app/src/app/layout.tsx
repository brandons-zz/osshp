import type { Metadata } from "next";
import { headers } from "next/headers";
// App-shell styles (the setup wizard, login, and admin shell — NOT the public
// theme-rendered site, which owns its own document + stylesheets via the theme
// engine). Layer-1 structural tokens are served as a static asset at
// /structural.css (public/structural.css) so the theme route handlers and the
// app shell load the one canonical sheet. kernel.css styles the owned-component
// kernel; shell.css supplies the app-chrome neutral palette + admin/wizard layout
// (the app shell is not theme-rendered, so it carries its own Layer-2 colors).
import "@/styles/kernel.css";
import "@/styles/shell.css";

export const metadata: Metadata = {
  title: "osshp",
  description: "Open-source self-hostable platform",
  // Default osshp brand favicon for the app shell (setup wizard, login,
  // admin console) — every osshp instance gets this out of the box, no
  // per-operator config required. Next's Metadata API expands these into
  // <link rel="icon">/<link rel="apple-touch-icon"> tags; all same-origin
  // static assets under public/, so CSP img-src 'self' already covers them.
  icons: {
    icon: [
      // SVG first — SVG-capable browsers prefer it and get the simplified
      // house-in-hex mark crisp at every size; the .ico + PNG sizes are the
      // fallback (16/32/48 from the simplified mark, 192/512 the full badge).
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the per-request CSP nonce header opts every app-shell page into
  // dynamic rendering (A1). Statically prerendered pages are built with no
  // request context, so their framework <script> tags carry no nonce and the
  // strict-dynamic CSP would block them — dynamic rendering lets Next inject the
  // per-request nonce into those scripts. The public site is rendered by the
  // theme route handlers (already dynamic), not this layout.
  await headers();
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/structural.css" />
        {/* Shiki syntax-highlight CSS — served from 'self'. Loaded here so the
            admin markdown-preview pane (dangerouslySetInnerHTML) shows correct
            token colors for code blocks (V-013 CSP fix). */}
        <link rel="stylesheet" href="/shiki.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
