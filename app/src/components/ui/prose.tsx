import * as React from "react";

/**
 * Prose — osshp owned component. A constrained reading container that pins the
 * measure to the Layer-1 structural `--measure-prose` (68ch) and applies the
 * reading type step, satisfying the design language's content-first measure
 * (design-language §1, §5) using structural + semantic tokens only.
 */
export interface ProseProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Prose = React.forwardRef<HTMLDivElement, ProseProps>(
  function Prose({ className, ...props }, ref) {
    const merged = className ? `osshp-prose ${className}` : "osshp-prose";
    return <div ref={ref} className={merged} {...props} />;
  },
);
