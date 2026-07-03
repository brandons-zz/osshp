// /admin/photos/[id]/edit — edit / publish an existing photo post. Server
// component loads the post (admin read — any status) and hands its values to the
// shared editor, configured for the Photos module. notFound() for an unknown id.

import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getPostById } from "@/lib/content/posts";
import { PostEditor } from "@/app/admin/blog/PostEditor";

export default async function EditPhotoPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const post = await getPostById(getDb(), id);
  if (!post) notFound();

  return (
    <PostEditor
      mode="edit"
      postType="photo-post"
      apiBase="/api/admin/photos/posts"
      listHref="/admin/photos"
      publicBase="/photos"
      noun="photo post"
      initial={{
        id: post.id,
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        body: post.body,
        status: post.status,
        publishDate: post.publishDate,
        tags: post.tags.map((t) => t.name).join(", "),
        coverSrc: post.coverImage?.src ?? "",
        coverAlt: post.coverImage?.alt ?? "",
        showInBlog: post.showInBlog,
        featured: post.featured,
      }}
    />
  );
}
