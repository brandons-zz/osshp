// Public barrel for the auth core (M1.6).
//
// First-party sessions + SimpleWebAuthn passkey ceremony + single-use bootstrap
// + default-deny access logic + per-lane rate limiting. NOT Auth.js
// (auth-security-assessment §4). Layered recovery (password+TOTP, recovery
// codes, CLI break-glass) is M2.

export {
  SESSION_COOKIE_NAME,
  signToken,
  verifyTokenSignature,
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessions,
  rotateSession,
  sessionCookieHeader,
  clearedSessionCookieHeader,
  readSessionCookie,
  type SessionRecord,
  type IssuedSession,
  type SessionMetadata,
} from "./sessions";

export {
  rpConfig,
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  WebAuthnVerificationError,
  type RegistrationResult,
  type AuthenticationResult,
  type AuthenticationCeremony,
} from "./webauthn";

export {
  isBootstrapAvailable,
  resolveRegistrationMode,
  RegistrationForbiddenError,
  type RegistrationMode,
} from "./bootstrap";

export {
  storeChallenge,
  consumeChallenge,
  type ChallengeType,
  LOGIN_CHALLENGE_COOKIE_NAME,
  newCeremonyId,
  storeLoginChallenge,
  consumeLoginChallenge,
  sweepExpiredLoginChallenges,
  loginChallengeCookieHeader,
  clearedLoginChallengeCookieHeader,
  readLoginChallengeCookie,
  STEPUP_CHALLENGE_COOKIE_NAME,
  stepupChallengeCookieHeader,
  clearedStepupChallengeCookieHeader,
  readStepupChallengeCookie,
} from "./challenges";

export {
  decideAccess,
  isPublicPath,
  normalizePath,
  stripPrincipalHeaders,
  PRINCIPAL_HEADERS,
  type AccessDecision,
} from "./access";

export {
  createRateLimiter,
  loginLimiter,
  registrationLimiter,
  bootstrapLimiter,
  passwordTotpLimiter,
  recoveryCodeLimiter,
  stepupLimiter,
  stepupFallbackLimiter,
  clientKey,
  clientIp,
  sessionMetadataFromRequest,
  type RateLimiter,
  type RateLimitResult,
} from "./rate-limit";

export {
  guardMutation,
  isSameOrigin,
  isMutatingMethod,
  withNoStore,
} from "./csrf";

export {
  recordAuthEvent,
  buildAuditRecord,
  redactDetails,
  setAuditSink,
  type AuthAuditEvent,
  type AuthAuditOutcome,
  type AuthAuditRecord,
} from "./audit";

export {
  persistAuditEvent,
  listAuditEvents,
  AUDIT_RETENTION_DAYS,
  AUDIT_MAX_ROWS,
  AUDIT_PAGE_MAX,
  AUDIT_PAGE_DEFAULT,
  type AuditPersistOptions,
  type AuditEventPage,
} from "./audit-store";

// ── Security notifications (Slice 2, §6) — vendor-neutral dispatch + transports ─

export {
  shouldNotify,
  buildNotification,
  dispatchNotification,
  getConfiguredNotifiers,
  WebhookNotifier,
  PushoverNotifier,
  setTestNotifiers,
  resetNotifyCoalescing,
  type SecurityNotification,
  type SecurityNotifier,
  type DispatchOptions,
} from "./notify";

// ── Security Center (Slice 2) read surfaces + revoke-others primitive ─────────

export {
  listSessionsView,
  buildSecurityOverview,
  revokeOtherSessions,
  type SessionView,
  type SecurityOverview,
} from "./security-center";

export {
  assessSessionSecret,
  assertSessionSecretStrength,
  MIN_SECRET_LENGTH,
  MIN_DISTINCT_CHARS,
  type SecretAssessment,
} from "./secret-strength";

// ── Layered recovery lanes (M2.2) ─────────────────────────────────────────────

export {
  setPassword,
  enrollTotp,
  confirmTotp,
  verifyPasswordAndTotp,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
  removePasskey,
  breakGlassReset,
  type TotpEnrollment,
  type BreakGlassResult,
  type PasskeyRemovalResult,
} from "./recovery";

// ── Step-up re-authentication grants (A1) ─────────────────────────────────────

export {
  STEPUP_GRANT_TTL_MS,
  STEPUP_GRANT_HEADER,
  STEPUP_REQUIRED_ERROR,
  stepUpRequiredResponse,
  issueStepUpGrant,
  consumeStepUpGrant,
  type StepUpFactor,
  type IssuedStepUpGrant,
} from "./stepup";

export { hashPassword, verifyPassword } from "./password";

export {
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotp,
  currentTotpToken,
  type TotpVerifyResult,
} from "./totp";

export { encryptSecret, decryptSecret, isBoxed } from "./secret-box";

export {
  generateRecoveryCodes,
  verifyAndConsumeRecoveryCode,
  normalizeCode,
  type GeneratedRecoveryCodes,
  type RecoveryCodeConsumeResult,
} from "./recovery-codes";

export {
  grantReenrollment,
  isReenrollmentOpen,
  isReenrollmentTokenValid,
  clearReenrollment,
} from "./reenroll";
