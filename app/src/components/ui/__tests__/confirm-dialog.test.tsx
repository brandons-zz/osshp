// Intent: ConfirmDialog renders a native <dialog> with title, description, and
// correct action buttons (Batch A — themed accessible confirm modal). Structural
// contract tests — behavior (focus-trap, Esc, backdrop click) is browser-native
// and verified separately at runtime.

import { expect, test, describe } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "../confirm-dialog";

function noop() {}

describe("ConfirmDialog (Batch A — themed delete confirm modal)", () => {
  test("renders a <dialog> element (native focus-trap + Esc behavior)", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete post?"
        description="This cannot be undone."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("<dialog");
  });

  test("dialog has the osshp-dialog kernel class", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete post?"
        description="This cannot be undone."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("osshp-dialog");
  });

  test("dialog has aria-label from the title (accessible name)", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete post?"
        description="This cannot be undone."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('aria-label="Delete post?"');
  });

  test("renders title as a heading", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete post?"
        description="This cannot be undone."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("Delete post?");
  });

  test("renders description text", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete?"
        description="Permanent and irreversible."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Permanent and irreversible.");
  });

  test("renders Cancel button before Confirm (safe default focus order)", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete?"
        description="."
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const cancelIdx = html.indexOf("Cancel");
    const confirmIdx = html.indexOf("Confirm");
    expect(cancelIdx).toBeLessThan(confirmIdx);
  });

  test("danger=true: confirm button carries the danger modifier class", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete?"
        description="."
        danger
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("osshp-button--danger");
  });

  test("custom labels are used", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Remove?"
        description="."
        confirmLabel="Yes, remove"
        cancelLabel="Keep it"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Yes, remove");
    expect(html).toContain("Keep it");
  });
});
