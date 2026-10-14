// The running osshp build version (issue 082), from the app's own package.json.
// The JSON import is resolved and inlined by the bundler at BUILD time, so the
// value is baked into the image — it always reflects the build that is actually
// running, never a runtime lookup that could drift from it.

import pkg from "../../package.json";

export const OSSHP_VERSION: string = pkg.version;
