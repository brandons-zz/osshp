// Public barrel for the content + settings core (spec §8).
// The data substrate the theme engine (M1.4), module system (M1.5), and auth
// (M1.6) read from. Stores take a Db handle (see @/lib/db) — getDb() in app
// code, a PGlite Db in tests.

export * from "./types";
export {
  createPost,
  getPostById,
  getPostBySlug,
  listPosts,
  updatePost,
  deletePost,
  getPublishedPostBySlug,
  listPublishedPosts,
  listPublishedFeatured,
} from "./posts";
export {
  ensureTag,
  getTagBySlug,
  listTags,
  listPublishedTagCounts,
} from "./tags";
export {
  createPage,
  getPageById,
  getPageBySlug,
  listPages,
  updatePage,
  deletePage,
  getPublishedPageBySlug,
  listPublishedPages,
  listPublishedPagesForNav,
} from "./pages";
export {
  createMedia,
  getMediaById,
  getMediaByKey,
  listMedia,
  updateMediaAttribution,
  type MediaAttributionPatch,
} from "./media";
export {
  setSetting,
  getSetting,
  listSettings,
  getPublicSettings,
  selectPublic,
  seedCoreSettings,
  CORE_SETTING_DEFAULTS,
} from "./settings";
export { getAdminUser, createAdminUser, updateAdminUser } from "./admin-user";
