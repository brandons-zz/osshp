"use client";

// Settings form — admin branding/identity editor.
//
// Server component (page.tsx) reads the current settings from the DB and passes
// them here as props. This component owns the client-side editing state and
// submits changes to PATCH /api/admin/settings. The accent picker reuses
// AccentSwatch from the setup wizard (same WCAG 1.4.1 pattern: value displayed
// as text, not color alone). All values flow through the server-side
// sanitizeSettingValue before persistence — this form sends the raw string input
// and trusts the API to sanitize/clamp.
//
// V-011: nav and social are structured row editors (no raw JSON textarea).

import { useState } from "react";
import { Button } from "@/components/ui";
import { AccentSwatch } from "@/app/setup/AccentSwatch";

export interface NavItem {
  label: string;
  href: string;
}

export interface SocialItem {
  network: string;
  href: string;
}

export interface SettingsFormProps {
  title: string;
  description: string;
  homeIntro: string;
  locale: string;
  accent: string;
  fontHeading: string;
  fontBody: string;
  defaultScheme: "light" | "dark" | "auto";
  navJson: string;
  socialJson: string;
  logoSrc: string;
  logoAlt: string;
}

// ── URL safety (mirrors settings-validate.ts isSafeHref; client-side warning) ─
function isSafeHref(href: string): boolean {
  if (href.startsWith("/") || href.startsWith("#")) return true;
  const lower = href.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  );
}

function parseNavJson(json: string): NavItem[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (i): i is NavItem =>
        typeof i === "object" &&
        i !== null &&
        typeof i.label === "string" &&
        typeof i.href === "string",
    );
  } catch {
    return [];
  }
}

function parseSocialJson(json: string): SocialItem[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (i): i is SocialItem =>
        typeof i === "object" &&
        i !== null &&
        typeof i.network === "string" &&
        typeof i.href === "string",
    );
  } catch {
    return [];
  }
}

// ── Structured row editors ────────────────────────────────────────────────────

interface NavRowEditorProps {
  items: NavItem[];
  onChange: (items: NavItem[]) => void;
  disabled?: boolean;
}

function NavRowEditor({ items, onChange, disabled }: NavRowEditorProps) {
  function update(i: number, field: keyof NavItem, value: string) {
    const next = items.map((row, idx) => (idx === i ? { ...row, [field]: value } : row));
    onChange(next);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function moveUp(i: number) {
    if (i === 0) return;
    const next = [...items];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  }
  function moveDown(i: number) {
    if (i === items.length - 1) return;
    const next = [...items];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    onChange(next);
  }
  function addRow() {
    onChange([...items, { label: "", href: "" }]);
  }

  return (
    <div className="row-editor">
      {items.map((row, i) => {
        const unsafe = row.href.trim() && !isSafeHref(row.href.trim());
        return (
          <div key={i} className="row-editor-row">
            <div className="row-editor-fields">
              <div className="field">
                <label htmlFor={`nav-label-${i}`}>Label</label>
                <input
                  id={`nav-label-${i}`}
                  value={row.label}
                  onChange={(e) => update(i, "label", e.target.value)}
                  placeholder="e.g. About"
                  disabled={disabled}
                />
              </div>
              <div className="field">
                <label htmlFor={`nav-href-${i}`}>URL</label>
                <input
                  id={`nav-href-${i}`}
                  value={row.href}
                  onChange={(e) => update(i, "href", e.target.value)}
                  placeholder="/about or https://…"
                  disabled={disabled}
                  aria-describedby={unsafe ? `nav-href-warn-${i}` : undefined}
                />
                {unsafe ? (
                  <span className="field-warn" id={`nav-href-warn-${i}`} role="alert">
                    Unsafe URL — only relative paths, http/https, and mailto: are allowed.
                  </span>
                ) : null}
              </div>
            </div>
            <div className="row-editor-actions">
              <button
                type="button"
                className="row-editor-btn"
                onClick={() => moveUp(i)}
                disabled={disabled || i === 0}
                aria-label={`Move "${row.label || "row"}" up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="row-editor-btn"
                onClick={() => moveDown(i)}
                disabled={disabled || i === items.length - 1}
                aria-label={`Move "${row.label || "row"}" down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="row-editor-btn row-editor-btn--danger"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={`Remove "${row.label || "row"}"`}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="row-editor-add"
        onClick={addRow}
        disabled={disabled}
      >
        + Add navigation item
      </button>
    </div>
  );
}

interface SocialRowEditorProps {
  items: SocialItem[];
  onChange: (items: SocialItem[]) => void;
  disabled?: boolean;
}

function SocialRowEditor({ items, onChange, disabled }: SocialRowEditorProps) {
  function update(i: number, field: keyof SocialItem, value: string) {
    const next = items.map((row, idx) => (idx === i ? { ...row, [field]: value } : row));
    onChange(next);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function moveUp(i: number) {
    if (i === 0) return;
    const next = [...items];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  }
  function moveDown(i: number) {
    if (i === items.length - 1) return;
    const next = [...items];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    onChange(next);
  }
  function addRow() {
    onChange([...items, { network: "", href: "" }]);
  }

  return (
    <div className="row-editor">
      {items.map((row, i) => {
        const unsafe = row.href.trim() && !isSafeHref(row.href.trim());
        return (
          <div key={i} className="row-editor-row">
            <div className="row-editor-fields">
              <div className="field">
                <label htmlFor={`social-network-${i}`}>Network / Label</label>
                <input
                  id={`social-network-${i}`}
                  value={row.network}
                  onChange={(e) => update(i, "network", e.target.value)}
                  placeholder="e.g. GitHub"
                  disabled={disabled}
                />
              </div>
              <div className="field">
                <label htmlFor={`social-href-${i}`}>URL</label>
                <input
                  id={`social-href-${i}`}
                  value={row.href}
                  onChange={(e) => update(i, "href", e.target.value)}
                  placeholder="https://github.com/…"
                  disabled={disabled}
                  aria-describedby={unsafe ? `social-href-warn-${i}` : undefined}
                />
                {unsafe ? (
                  <span className="field-warn" id={`social-href-warn-${i}`} role="alert">
                    Unsafe URL — only http/https and mailto: are allowed.
                  </span>
                ) : null}
              </div>
            </div>
            <div className="row-editor-actions">
              <button
                type="button"
                className="row-editor-btn"
                onClick={() => moveUp(i)}
                disabled={disabled || i === 0}
                aria-label={`Move "${row.network || "row"}" up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="row-editor-btn"
                onClick={() => moveDown(i)}
                disabled={disabled || i === items.length - 1}
                aria-label={`Move "${row.network || "row"}" down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="row-editor-btn row-editor-btn--danger"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={`Remove "${row.network || "row"}"`}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="row-editor-add"
        onClick={addRow}
        disabled={disabled}
      >
        + Add social link
      </button>
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────

export function SettingsForm(props: SettingsFormProps) {
  const [title, setTitle] = useState(props.title);
  const [description, setDescription] = useState(props.description);
  const [homeIntro, setHomeIntro] = useState(props.homeIntro);
  const [locale, setLocale] = useState(props.locale);
  const [accent, setAccent] = useState(props.accent);
  const [fontHeading, setFontHeading] = useState(props.fontHeading);
  const [fontBody, setFontBody] = useState(props.fontBody);
  const [defaultScheme, setDefaultScheme] = useState(props.defaultScheme);
  // V-011: structured arrays instead of raw JSON strings.
  const [navItems, setNavItems] = useState<NavItem[]>(() => parseNavJson(props.navJson));
  const [socialItems, setSocialItems] = useState<SocialItem[]>(() => parseSocialJson(props.socialJson));
  const [logoSrc, setLogoSrc] = useState(props.logoSrc);
  const [logoAlt, setLogoAlt] = useState(props.logoAlt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);

    setBusy(true);
    try {
      // Build logo from the src/alt fields — null if no URL provided.
      const logo =
        logoSrc.trim()
          ? { src: logoSrc.trim(), alt: logoAlt.trim() }
          : null;

      // Pass the structured arrays directly — the server-side sanitizeSettingValue
      // drops any item with an unsafe href (javascript:, data:, etc.) by construction.
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "site.title": title,
          "site.description": description,
          "home.intro": homeIntro,
          "site.locale": locale,
          "site.nav": navItems,
          "site.social": socialItems,
          "site.logo": logo,
          "branding.accent": accent,
          "branding.fontHeading": fontHeading.trim() || null,
          "branding.fontBody": fontBody.trim() || null,
          "branding.defaultScheme": defaultScheme,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Server error (${res.status})`);
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={handleSave}>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" role="status">
          Settings saved.
        </p>
      ) : null}

      {/* ── Site identity ── */}
      <section className="shell-card stack">
        <h2>Site identity</h2>

        <div className="field">
          <label htmlFor="s-title">Site title</label>
          <input
            id="s-title"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setSaved(false); }}
          />
        </div>

        <div className="field">
          <label htmlFor="s-description">Description</label>
          <input
            id="s-description"
            value={description}
            onChange={(e) => { setDescription(e.target.value); setSaved(false); }}
          />
          <span className="field-hint">
            Used as the subtitle in the masthead and meta description.
          </span>
        </div>

        <div className="field">
          <label htmlFor="s-home-intro">Home page intro</label>
          <textarea
            id="s-home-intro"
            rows={3}
            value={homeIntro}
            onChange={(e) => { setHomeIntro(e.target.value); setSaved(false); }}
            placeholder="A sentence or two introducing who this site is."
          />
          <span className="field-hint">
            Shown as the lead paragraph on the home page. Leave blank to omit it.
          </span>
        </div>

        <div className="field">
          <label htmlFor="s-locale">Locale</label>
          <input
            id="s-locale"
            value={locale}
            onChange={(e) => { setLocale(e.target.value); setSaved(false); }}
            placeholder="en"
          />
          <span className="field-hint">
            BCP 47 language tag (e.g. <code>en</code>, <code>fr</code>, <code>de</code>).
          </span>
        </div>
      </section>

      {/* ── Logo ── */}
      <section className="shell-card stack">
        <h2>Logo</h2>
        <p className="muted">
          Optional. Leave blank to use the site title as a text wordmark.
        </p>

        <div className="field">
          <label htmlFor="s-logo-src">Logo URL</label>
          <input
            id="s-logo-src"
            type="url"
            value={logoSrc}
            onChange={(e) => { setLogoSrc(e.target.value); setSaved(false); }}
            placeholder="https://example.com/logo.png"
          />
        </div>

        <div className="field">
          <label htmlFor="s-logo-alt">Logo alt text</label>
          <input
            id="s-logo-alt"
            value={logoAlt}
            onChange={(e) => { setLogoAlt(e.target.value); setSaved(false); }}
            placeholder="My site logo"
          />
        </div>
      </section>

      {/* ── Navigation & social ── */}
      <section className="shell-card stack">
        <h2>Navigation &amp; social</h2>
        <p className="muted">
          Add, remove, and reorder nav items and social links. Pages with "Show in
          navigation" enabled appear automatically after these entries.
        </p>

        <div className="field">
          <span className="field-label">Navigation items</span>
          <NavRowEditor
            items={navItems}
            onChange={(items) => { setNavItems(items); setSaved(false); }}
            disabled={busy}
          />
        </div>

        <div className="field">
          <span className="field-label">Social links</span>
          <SocialRowEditor
            items={socialItems}
            onChange={(items) => { setSocialItems(items); setSaved(false); }}
            disabled={busy}
          />
        </div>
      </section>

      {/* ── Branding ── */}
      <section className="shell-card stack">
        <h2>Branding</h2>

        <div className="field">
          <label htmlFor="s-accent">Accent color</label>
          <div className="accent-row">
            <input
              id="s-accent"
              type="color"
              value={accent}
              onChange={(e) => { setAccent(e.target.value); setSaved(false); }}
            />
            <AccentSwatch value={accent} />
          </div>
          <span className="field-hint">
            Any hue — the platform keeps text and controls AA-accessible automatically.
          </span>
        </div>

        <div className="field">
          <label htmlFor="s-scheme">Default color scheme</label>
          <select
            id="s-scheme"
            value={defaultScheme}
            onChange={(e) => {
              setDefaultScheme(e.target.value as "light" | "dark" | "auto");
              setSaved(false);
            }}
          >
            <option value="auto">Auto (follows visitor's OS preference)</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="s-font-heading">Heading font family</label>
          <input
            id="s-font-heading"
            value={fontHeading}
            onChange={(e) => { setFontHeading(e.target.value); setSaved(false); }}
            placeholder="System default"
          />
          <span className="field-hint">
            CSS font-family value (e.g. <code>Georgia, serif</code>). Leave blank for
            the system default.
          </span>
        </div>

        <div className="field">
          <label htmlFor="s-font-body">Body font family</label>
          <input
            id="s-font-body"
            value={fontBody}
            onChange={(e) => { setFontBody(e.target.value); setSaved(false); }}
            placeholder="System default"
          />
          <span className="field-hint">
            CSS font-family value. Leave blank for the system default.
          </span>
        </div>
      </section>

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
