import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

/**
 * Button — osshp owned component (Layer B) composing the Radix `Slot` primitive
 * (Layer A). Native `<button>` supplies keyboard operability (2.1.1) and
 * role/name/value (4.1.2); `asChild` uses Radix `Slot` to merge the kernel
 * styling onto a single child element (e.g. an anchor) without reimplementing
 * behavior — the vendored-primitive composition pattern (ui-component-contract
 * §2–§4). Visual identity is semantic-token-only via the `osshp-button` class.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render as the single child element (Radix Slot `asChild` pattern). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ asChild = false, className, type, ...props }, ref) {
    const Comp = asChild ? Slot : "button";
    const merged = className ? `osshp-button ${className}` : "osshp-button";
    return (
      <Comp
        ref={ref}
        className={merged}
        // Default native buttons to type="button" to avoid accidental form
        // submits; honored only for the real <button> (Slot forwards a child's).
        type={asChild ? type : (type ?? "button")}
        {...props}
      />
    );
  },
);
