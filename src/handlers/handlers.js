import { PAGE_SIZE } from "../utils/constants.js";
import { json, jsonError, clampPage, readJsonBody } from "../utils/utils.js";
import * as dbActions from "../core/db.js";

// ─── Internal API Handlers: domains / mailboxes / emails ─────────────────────

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeNullableString(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function extractPathValue(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return "";
  return decodeURIComponent(pathname.slice(prefix.length));
}

function parseExpiry(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);

  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/**
 * [Internal] 健康检查
 */
export async function handleHealth(_url, db) {
  const stats = await dbActions.getHealthSummary(db);
  return json({
    ok: true,
    service: "mail-base",
    ...stats,
  });
}

/**
 * [Internal] 查询域名列表
 */
export async function handleDomainsGet(url, db) {
  const includeDisabled = parseBoolean(
    url.searchParams.get("include_disabled"),
    false,
  );
  const domains = await dbActions.listDomains(db, { includeDisabled });
  return json({ items: domains });
}

/**
 * [Internal] 创建域名
 */
export async function handleDomainsPost(request, db) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const body = parsed.data || {};
  const domain = normalizeDomain(body.domain);
  if (!domain) return jsonError("domain is required", 400);

  const created = await dbActions.createDomain(db, {
    domain,
    is_active:
      body.is_active === undefined ? true : parseBoolean(body.is_active, true),
    catch_all: parseBoolean(body.catch_all, false),
    metadata_json: body.metadata_json ?? body.metadata ?? null,
  });

  return json({ item: created }, 201);
}

/**
 * [Internal] 更新域名
 */
export async function handleDomainsPatch(pathname, request, db) {
  const domain = normalizeDomain(
    extractPathValue(pathname, "/internal/domains/"),
  );
  if (!domain) return jsonError("domain is required", 400);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const body = parsed.data || {};
  const updated = await dbActions.updateDomain(db, domain, {
    is_active:
      body.is_active === undefined
        ? undefined
        : parseBoolean(body.is_active, true),
    catch_all:
      body.catch_all === undefined
        ? undefined
        : parseBoolean(body.catch_all, false),
    metadata_json: body.metadata_json ?? body.metadata,
  });

  if (!updated) return jsonError("domain not found", 404);
  return json({ item: updated });
}

/**
 * [Internal] 删除域名
 */
export async function handleDomainsDelete(pathname, db) {
  const domain = normalizeDomain(
    extractPathValue(pathname, "/internal/domains/"),
  );
  if (!domain) return jsonError("domain is required", 400);

  const deleted = await dbActions.deleteDomain(db, domain);
  if (!deleted) return jsonError("domain not found", 404);

  return json({ ok: true });
}

/**
 * [Internal] 查询邮箱列表
 */
export async function handleMailboxesGet(url, db) {
  const page = clampPage(url.searchParams.get("page"));
  const pageSize = clampPage(url.searchParams.get("page_size")) || PAGE_SIZE;
  const domain = normalizeNullableString(url.searchParams.get("domain"));
  const includeExpired = parseBoolean(
    url.searchParams.get("include_expired"),
    false,
  );

  const { items, total } = await dbActions.listMailboxes(db, {
    page,
    pageSize,
    domain: domain ? domain.toLowerCase() : null,
    includeExpired,
  });

  return json({
    page,
    pageSize,
    total,
    items,
  });
}

/**
 * [Internal] 创建邮箱
 */
export async function handleMailboxesPost(request, db) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const body = parsed.data || {};
  const address = normalizeAddress(body.address);
  if (!address) return jsonError("address is required", 400);
  if (!address.includes("@"))
    return jsonError("address must be a valid email address", 400);

  const expiresAt = parseExpiry(body.expires_at);
  if (Number.isNaN(expiresAt))
    return jsonError(
      "expires_at must be a unix timestamp(ms) or valid datetime string",
      400,
    );

  const created = await dbActions.createMailbox(db, {
    address,
    expires_at: expiresAt,
    metadata_json: body.metadata_json ?? body.metadata ?? null,
  });

  if (!created)
    return jsonError(
      "mailbox domain is not active or mailbox already exists",
      400,
    );
  return json({ item: created }, 201);
}

/**
 * [Internal] 删除邮箱
 */
export async function handleMailboxesDelete(pathname, db) {
  const address = normalizeAddress(
    extractPathValue(pathname, "/internal/mailboxes/"),
  );
  if (!address) return jsonError("address is required", 400);

  const deleted = await dbActions.deleteMailbox(db, address);
  if (!deleted) return jsonError("mailbox not found", 404);

  return json({ ok: true });
}

/**
 * [Internal] 获取单个邮箱详情
 */
export async function handleMailboxGet(pathname, db) {
  const address = normalizeAddress(
    extractPathValue(pathname, "/internal/mailboxes/"),
  );
  if (!address) return jsonError("address is required", 400);

  const mailbox = await dbActions.getMailbox(db, address);
  if (!mailbox) return jsonError("mailbox not found", 404);

  return json({ item: mailbox });
}

/**
 * [Internal] 获取邮箱最新一封邮件
 */
export async function handleMailboxLatest(url, db) {
  const address = normalizeAddress(url.searchParams.get("address"));
  if (!address) return jsonError("address is required", 400);

  const item = await dbActions.getLatestEmail(db, address);
  if (!item) return jsonError("message not found", 404);

  return json({ item });
}

/**
 * [Internal] 获取某邮箱的邮件列表
 */
export async function handleMailboxEmails(pathname, url, db) {
  const rawAddress = extractPathValue(pathname, "/internal/mailboxes/");
  const address = normalizeAddress(rawAddress.replace(/\/emails$/, ""));
  if (!address) return jsonError("address is required", 400);

  const page = clampPage(url.searchParams.get("page"));
  const pageSize = clampPage(url.searchParams.get("page_size")) || PAGE_SIZE;

  const mailbox = await dbActions.getMailbox(db, address);
  if (!mailbox) return jsonError("mailbox not found", 404);

  const { items, total } = await dbActions.getMailboxEmails(db, address, {
    page,
    pageSize,
  });
  return json({
    page,
    pageSize,
    total,
    mailbox,
    items,
  });
}

/**
 * [Internal] 获取单封邮件详情
 */
export async function handleEmailGet(pathname, db) {
  const rawId = extractPathValue(pathname, "/internal/emails/");
  const emailId = Number(rawId);
  if (!Number.isFinite(emailId)) return jsonError("invalid email id", 400);

  const item = await dbActions.getEmailById(db, emailId);
  if (!item) return jsonError("message not found", 404);

  return json({ item });
}
