import * as React from "react";

/**
 * Link — osshp owned component. A native `<a>` already carries correct
 * keyboard operability (2.1.1) and link role/name (4.1.2); the kernel does not
 * reimplement that. Layer B supplies only the `osshp-link` semantic-token-only
 * styling and inherits the global `:focus-visible` ring (2.4.7). For internal
 * client-side navigation, callers pass `next/link` as the child of `Button
 * asChild` or render this with an `href` — routing semantics are a later
 * concern, out of scope for the kernel.
 */
export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {}

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  function Link({ className, ...props }, ref) {
    const merged = className ? `osshp-link ${className}` : "osshp-link";
    return <a ref={ref} className={merged} {...props} />;
  },
);
