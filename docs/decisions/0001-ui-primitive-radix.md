# ADR 0001 — Headless UI primitive: Radix UI

**Status:** Accepted · **Date:** 2026-06-29
**Milestone:** Phase 1 / M1.2 · **Decides:** the owned-component headless primitive pick (Radix UI vs. React Aria)

## Context

osshp's UI must be its own design on **owned, vendored** components and must never sit on an
upgrade treadmill (spec §6). The UI component contract validated **both** candidate headless
primitives and deliberately deferred the choice to Phase 1, because the reference theme and the
admin shell both build on the resulting owned-component kernel and the pick is expensive to undo
(ui-component-contract §3, §8.4).

The contract's two-layer model (§2): **Layer A** = a vendored headless accessibility primitive
(keyboard, focus, ARIA — 2.1.1 / 4.1.2, zero visual design); **Layer B** = osshp's owned styling +
public API, reading semantic tokens only. Layer B wraps Layer A and never reimplements behavior.

Both options are license-clean for distribution (per the project's license audit):

| Option | Package(s) | License | Model |
| --- | --- | --- | --- |
| **A — Radix UI** | `@radix-ui/react-*` / unified `radix-ui` | **MIT** | Component-part composition |
| **B — React Aria** | `react-aria` / `@react-aria/*` / `@react-stately/*` | **Apache-2.0** | Hook-based behavior |

(There is **no** `@adobe/react-aria` package. React Aria's package is `react-aria`.)

## Decision

**Pick Radix UI.** Exactly one primitive, used consistently — the two are not mixed
(ui-component-contract §3).

## Rationale

1. **It is the primitive the named vendoring pattern is built on.** The contract specifies the
   *shadcn pattern* — owned, styled components copied into the repo with no forced upstream
   upgrade path (§1, §4). shadcn/ui is Radix primitives + owned styling vendored into the repo.
   Adopting Radix means adopting the exact vendoring workflow the contract names, rather than
   re-deriving an equivalent on top of hooks.
2. **Maximizes behavior owned by Layer A, minimizes it in Layer B.** Radix's component-part
   composition (`<Dialog.Root><Dialog.Trigger>…`) keeps focus trapping, ESC handling,
   `aria-modal`, roving tabindex, etc. inside the upstream primitive. The contract's §6 AA clause
   requires that 2.1.1 / 4.1.2 come *from* the primitive and that "Layer B MUST NOT reimplement";
   Radix lands more of that behavior upstream than React Aria's hook model, where assembling parts
   is the integrator's job and more wiring lands in owned code.
3. **MIT is the cleanest license for AGPL-3.0 distribution.** Both are compatible; MIT carries no
   patent/NOTICE-propagation obligations, the lightest compliance surface for the distributed
   image. Attribution is still recorded (release blocker, principle 7 — see `CREDITS.md`).
4. **Full primitive coverage for the reference inventory.** The owned-component inventory
   (header/nav, dialog, dropdown, accordion, lightbox trigger, tabs, tooltip — design-language
   §8.2) maps directly onto existing Radix primitives (Dialog, DropdownMenu, NavigationMenu,
   Accordion, Tabs, Tooltip), so Phase-1 component work is composition, not behavior authoring.

## Composition-model independence (what the contract buys us)

The owned component's **public API (Layer B) is stable regardless of the backing primitive**
(ui-component-contract §3). If a future major version swaps Radix for React Aria, that is an
internal Layer-A change behind the same Layer-B API — themes, admin, and modules do not change.
Radix is the chosen Layer A *today*; the abstraction keeps that reversible.

## Consequences

- **Vendoring model (no forced upgrade).** The owned, composed, styled components live in
  `osshp/app/src/components/ui/` as osshp's code, reviewed and AA-gated as osshp's code. The Radix
  packages themselves are normal, low-churn npm dependencies (unstyled behavior modules) — we do
  **not** copy large amounts of external source into the repo. "Vendored" = osshp owns the
  composed component and its API; upgrades to the Radix dependency are deliberate, never forced
  (ui-component-contract §4).
- **Kernel established (M1.2).** `Button` composes `@radix-ui/react-slot` (the `asChild` pattern);
  `Link` and `Prose` are owned components over native elements (an `<a>`/`<div>` already carry
  correct keyboard/role, so the kernel does not reimplement them). The global `:focus-visible`
  ring (structural sheet) is the focus-ring element. All read semantic tokens only.
- **Attribution.** `@radix-ui/react-slot` (MIT, Radix UI / WorkOS) added to `osshp/CREDITS.md`
  (release blocker).
- **Phase-1 build constraint.** Every owned component composes Radix, reads only semantic tokens,
  respects the structural-token invariant, and passes the ui-component-contract §6 AA gate under an
  independent gater (author ≠ QA). Do not introduce React Aria alongside Radix.
