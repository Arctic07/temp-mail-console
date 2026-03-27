/**
 * Internal service authentication helpers.
 *
 * This project now acts as a mail capability base, so management and query
 * routes should only be accessed by trusted internal services such as the
 * Python business layer.
 */

const BEARER_PREFIX = "Bearer ";

/**
 * Normalize a token value.
 */
function normalizeToken(value) {
  return String(value || "").trim();
}

/**
 * Extract a bearer token from the Authorization header.
 */
export function getBearerToken(request) {
  const header = String(request.headers.get("Authorization") || "").trim();
  if (!header.startsWith(BEARER_PREFIX)) return "";
  return normalizeToken(header.slice(BEARER_PREFIX.length));
}

/**
 * Read the internal token from the dedicated header.
 */
export function getInternalHeaderToken(request) {
  return normalizeToken(request.headers.get("X-Internal-Token"));
}

/**
 * Check whether a request is authorized with the expected internal token.
 *
 * Supported auth methods:
 * - Authorization: Bearer <token>
 * - X-Internal-Token: <token>
 */
export function isInternalAuthorized(request, internalToken) {
  const expectedToken = normalizeToken(internalToken);
  if (!expectedToken) return false;

  const bearerToken = getBearerToken(request);
  if (bearerToken && bearerToken === expectedToken) return true;

  const headerToken = getInternalHeaderToken(request);
  if (headerToken && headerToken === expectedToken) return true;

  return false;
}

/**
 * Backward-compatible alias used by the current entrypoint.
 */
export function isApiAuthorized(request, apiToken) {
  return isInternalAuthorized(request, apiToken);
}
