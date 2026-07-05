// /admin/photos/new — write a new photo post. The admin-editor render target for
// the Photos module (default-deny via middleware + the admin layout's session
// check). Reuses the shared PostEditor, configured for the Photos module.

import { PostEditor } from "@/app/admin/blog/PostEditor";

export default function NewPhotoPostPage() {
  return (
    <PostEditor
      mode="new"
      postType="photo-post"
      apiBase="/api/admin/photos/posts"
      listHref="/admin/photos"
      publicBase="/photos"
      noun="photo post"
    />
  );
}
