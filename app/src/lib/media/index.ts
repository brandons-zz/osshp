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
  replaceUploadedImage,
  type StoreImageInput,
  type StoredImage,
  type ReplacedImage,
} from "./upload";

export {
  sniffImageFormat,
  isHeicFormat,
  classifyUpload,
  type SniffedFormat,
  type UploadClassification,
} from "./detect";

export { transcodeHeicToJpeg, ensureProcessable } from "./heic";

export {
  isBlockedIp,
  isPrivateIPv4,
  isPrivateIPv6,
  resolvePublicHost,
  type ResolvedHost,
  type HostValidation,
  type LookupFn,
} from "./ssrf";

export {
  fetchExternalImage,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  type ExternalFetchDeps,
  type ExternalFetchResult,
  type ExternalFetchFailure,
} from "./externalFetch";

export {
  autoImportExternalImages,
  type AutoImportResult,
  type ImageImportResult,
  type ImageImportOutcome,
} from "./autoImport";
