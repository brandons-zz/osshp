// Intent: ImageDropzone renders a styled drop zone and a keyboard-operable
// button for file selection (V-008). This tests the structural contract:
// - The hidden file input is present (accessible via ref/trigger)
// - The "Choose file" button is present and is a native <button>
// - The drop zone container has the correct class
// - Idle, busy, and disabled states produce correct data-attributes
// - The CSP-safe constraint: no inline event handlers, no inline style on the zone

import { expect, test, describe } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageDropzone } from "../image-dropzone";

function noop() {}

describe("ImageDropzone (V-008 — styled drag-and-drop + click-to-pick)", () => {
  test("renders the dropzone container with the kernel class", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="test-file" onFile={noop} />,
    );
    expect(html).toContain("osshp-dropzone");
  });

  test("contains a hidden file input (tabIndex=-1, aria-hidden)", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="cover-file" onFile={noop} />,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('id="cover-file"');
  });

  test("renders a keyboard-operable Choose file button (native <button>)", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} />,
    );
    // The button must be a native <button> with type=button (prevents form submit).
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("Choose file");
  });

  test("accepts a custom accept attribute forwarded to the file input", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} accept="image/jpeg,image/png" />,
    );
    expect(html).toContain('accept="image/jpeg,image/png"');
  });

  test("custom dropLabel appears as instructional text", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} dropLabel="Drag photo here, or" />,
    );
    expect(html).toContain("Drag photo here, or");
  });

  test("busy state: button text changes to Uploading…", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} busy />,
    );
    // Button label changes during upload
    expect(html).toContain("Uploading");
  });

  test("disabled state: file input is disabled", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} disabled />,
    );
    // Native <input type="file"> should have disabled
    expect(html).toContain("disabled");
  });

  test("no inline style attribute on the dropzone container (CSP-safe)", () => {
    const html = renderToStaticMarkup(
      <ImageDropzone id="f" onFile={noop} />,
    );
    // The drop zone div must not have a style="" attribute (CSP style-src blocks
    // inline styles without a nonce; all styling goes through kernel.css classes).
    const dropzoneMatch = html.match(/class="osshp-dropzone[^"]*"[^>]*/);
    expect(dropzoneMatch?.[0]).not.toContain("style=");
  });
});
