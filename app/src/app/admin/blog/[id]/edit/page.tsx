// /admin/blog/[id]/edit — edit / publish an existing post. Server component loads
// the post (admin read — any status) and hands its current values to the client
// editor. notFound() for an unknown id.

import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getPostById } from "@/lib/content/posts";
import { PostEditor } from "../../PostEditor";

export default async function EditPostPage({
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
        featured: post.featured,
      }}
    />
  );
}
