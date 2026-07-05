// /admin/blog/new — write a new post. The admin-editor render target for the
// Blog module (default-deny via middleware + the admin layout's session check).

import { PostEditor } from "../PostEditor";

export default function NewPostPage() {
  return <PostEditor mode="new" />;
}
