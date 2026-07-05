// /admin/photos/[id]/edit — edit / publish an existing photo post. Server
// component loads the post (admin read — any status) and hands its values to the
// shared editor, configured for the Photos module. notFound() for an unknown id.

import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getPostById } from "@/lib/content/posts";
import { getMediaByKey } from "@/lib/content/media";
import { PostEditor } from "@/app/admin/blog/PostEditor";

/** Resolve the media id behind a /media/<key> cover URL so Single→Gallery can
 *  seed the existing cover as the first gallery image (issue 047). */
async function coverMediaIdFor(src: string | undefined): Promise<string | null> {
  if (!src) return null;
  const key = src.startsWith("/media/") ? src.slice("/media/".length) : "";
  if (!key) return null;
  const media = await getMediaByKey(getDb(), key);
  return media?.id ?? null;
}

export default async function EditPhotoPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const post = await getPostById(getDb(), id);
  if (!post) notFound();

  // Single covers: resolve the media id (best-effort) so a mode switch can carry
  // the photograph over. Gallery covers already carry their media id.
  const singleCoverMediaId = post.isGallery
    ? post.coverMediaId
    : await coverMediaIdFor(post.coverImage?.src);

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
        coverMediaId: singleCoverMediaId,
        showInBlog: post.showInBlog,
        featured: post.featured,
        isGallery: post.isGallery,
        galleryImages: post.gallery.map((g) => ({
          mediaId: g.mediaId,
          src: g.src,
          alt: g.alt,
          caption: g.caption,
        })),
      }}
    />
  );
}
