// Public barrel for the media subsystem (M2.7 processor + M2.9 storage/pipeline).
// Server-only: the storage + pipeline modules use node: builtins and the minio
// client — never import this from a client component or the public render graph.

export {
  processImage,
  DEFAULT_WIDTHS,
  DEFAULT_FORMAT,
  type ImageVariant,
  type ProcessorOptions,
} from "./processor";

export {
  getMediaStorage,
  type MediaStorage,
  type StoredObject,
} from "./storage";

export {
  storeUploadedImage,
  type StoreImageInput,
  type StoredImage,
} from "./upload";
