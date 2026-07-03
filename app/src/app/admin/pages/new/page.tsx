// /admin/pages/new — create a new page. The admin-editor render target for the
// Pages module (default-deny via middleware + the admin layout's session check).

import { PageEditor } from "../PageEditor";

export default function NewPagePage() {
  return <PageEditor mode="new" />;
}
