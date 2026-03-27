// Consistent database layer for the mail capability base.
//
// This module keeps the storage API focused on three resources:
//
// 1. domains   - allowed recipient domains
// 2. mailboxes - registered recipient addresses
// 3. emails    - received email records
//
// It intentionally does not contain product-level logic such as UI state,
// rule engines, or end-user authentication.

function now() {
  return Date.now();
}

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

function splitAddress(address) {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;

  return {
    address: normalized,
    local_part: normalized.slice(0, at),
    domain: normalized.slice(at + 1),
  };
}

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Number(value) === 1;
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMetadata(input) {
  if (input == null) return {};
  if (typeof input === "string") {
    return safeJsonParse(input, {});
  }
  if (typeof input === "object") return input;
  return {};
}

function mapDomain(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    domain: normalizeDomain(row.domain),
    is_active: fromDbBool(row.is_active),
    catch_all: fromDbBool(row.catch_all),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function mapMailbox(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    address: normalizeAddress(row.address),
    local_part: String(row.local_part || ""),
    domain: normalizeDomain(row.domain),
    is_active: fromDbBool(row.is_active),
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
    metadata: safeJsonParse(row.metadata_json, {}),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function mapEmail(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    message_id: String(row.message_id || ""),
    mailbox_address: normalizeAddress(row.mailbox_address || row.to_address),
    domain: normalizeDomain(row.domain),
    from_address: normalizeAddress(row.from_address),
    to_address: normalizeAddress(row.to_address || row.mailbox_address),
    subject: String(row.subject || ""),
    text_body: String(row.text_body || ""),
    html_body: String(row.html_body || ""),
    headers: safeJsonParse(row.headers_json, {}),
    raw_size: Number(row.raw_size || 0),
    received_at: Number(row.received_at || 0),
  };
}

async function allResults(statement) {
  const result = await statement.all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function firstResult(statement) {
  return statement.first();
}

function buildPagination(page = 1, pageSize = 20, maxPageSize = 100) {
  const safePage =
    Number.isFinite(Number(page)) && Number(page) >= 1
      ? Math.floor(Number(page))
      : 1;
  const safePageSizeRaw =
    Number.isFinite(Number(pageSize)) && Number(pageSize) >= 1
      ? Math.floor(Number(pageSize))
      : 20;
  const safePageSize = Math.min(maxPageSize, safePageSizeRaw);
  return {
    page: safePage,
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

function resolveListMailboxOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      page: 1,
      pageSize: 20,
      domain: input ? normalizeDomain(input) : null,
      includeExpired: false,
    };
  }

  return {
    page: input.page,
    pageSize: input.pageSize,
    domain: input.domain ? normalizeDomain(input.domain) : null,
    includeExpired: Boolean(input.includeExpired),
  };
}

// -----------------------------------------------------------------------------
// Domain APIs
// -----------------------------------------------------------------------------

export async function listDomains(db, options = {}) {
  const includeDisabled = Boolean(options?.includeDisabled);

  let sql = `
    SELECT id, domain, is_active, catch_all, created_at, updated_at
    FROM domains
  `;
  if (!includeDisabled) {
    sql += ` WHERE is_active = 1`;
  }
  sql += ` ORDER BY created_at DESC, id DESC`;

  const rows = await allResults(db.prepare(sql));
  return rows.map(mapDomain);
}

export async function getDomainByName(db, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  const row = await firstResult(
    db
      .prepare(
        `
      SELECT id, domain, is_active, catch_all, created_at, updated_at
      FROM domains
      WHERE domain = ?
      LIMIT 1
    `,
      )
      .bind(normalized),
  );

  return mapDomain(row);
}

export async function getActiveDomain(db, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  const row = await firstResult(
    db
      .prepare(
        `
      SELECT id, domain, is_active, catch_all, created_at, updated_at
      FROM domains
      WHERE domain = ? AND is_active = 1
      LIMIT 1
    `,
      )
      .bind(normalized),
  );

  return mapDomain(row);
}

export async function createDomain(db, input) {
  const domain = normalizeDomain(input?.domain);
  if (!domain) return null;

  const existing = await getDomainByName(db, domain);
  if (existing) return null;

  const ts = now();
  await db
    .prepare(
      `
    INSERT INTO domains (domain, is_active, catch_all, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .bind(
      domain,
      toDbBool(input?.is_active !== false),
      toDbBool(Boolean(input?.catch_all)),
      ts,
      ts,
    )
    .run();

  return getDomainByName(db, domain);
}

export async function upsertDomain(db, input) {
  const domain = normalizeDomain(input?.domain);
  if (!domain) return null;

  const existing = await getDomainByName(db, domain);
  if (existing) {
    return updateDomain(db, domain, input);
  }

  return createDomain(db, input);
}

export async function updateDomain(db, domain, patch = {}) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  const existing = await getDomainByName(db, normalized);
  if (!existing) return null;

  const nextIsActive =
    patch.is_active === undefined
      ? existing.is_active
      : Boolean(patch.is_active);
  const nextCatchAll =
    patch.catch_all === undefined
      ? existing.catch_all
      : Boolean(patch.catch_all);

  await db
    .prepare(
      `
    UPDATE domains
    SET is_active = ?, catch_all = ?, updated_at = ?
    WHERE domain = ?
  `,
    )
    .bind(toDbBool(nextIsActive), toDbBool(nextCatchAll), now(), normalized)
    .run();

  return getDomainByName(db, normalized);
}

export async function deleteDomain(db, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;

  const result = await db
    .prepare(
      `
    DELETE FROM domains
    WHERE domain = ?
  `,
    )
    .bind(normalized)
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

// -----------------------------------------------------------------------------
// Mailbox APIs
// -----------------------------------------------------------------------------

export async function listMailboxes(db, input = {}) {
  const options = resolveListMailboxOptions(input);
  const { page, pageSize, offset } = buildPagination(
    options.page,
    options.pageSize,
  );

  const conditions = [];
  const params = [];
  const countParams = [];

  if (options.domain) {
    conditions.push(`domain = ?`);
    params.push(options.domain);
    countParams.push(options.domain);
  }

  if (!options.includeExpired) {
    conditions.push(`(expires_at IS NULL OR expires_at > ?)`);
    params.push(now());
    countParams.push(params[params.length - 1]);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const [rows, countRow] = await Promise.all([
    allResults(
      db
        .prepare(
          `
        SELECT id, address, local_part, domain, is_active, expires_at, metadata_json, created_at, updated_at
        FROM mailboxes
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
        )
        .bind(...params, pageSize, offset),
    ),
    firstResult(
      db
        .prepare(
          `
        SELECT COUNT(1) AS total
        FROM mailboxes
        ${whereClause}
      `,
        )
        .bind(...countParams),
    ),
  ]);

  return {
    items: rows.map(mapMailbox),
    total: Number(countRow?.total || 0),
    page,
    pageSize,
  };
}

export async function getMailboxByAddress(db, address) {
  const parts = splitAddress(address);
  if (!parts) return null;

  const row = await firstResult(
    db
      .prepare(
        `
      SELECT id, address, local_part, domain, is_active, expires_at, metadata_json, created_at, updated_at
      FROM mailboxes
      WHERE address = ?
      LIMIT 1
    `,
      )
      .bind(parts.address),
  );

  return mapMailbox(row);
}

export async function getMailbox(db, address) {
  return getMailboxByAddress(db, address);
}

export async function createMailbox(db, input) {
  const parts = splitAddress(input?.address);
  if (!parts) return null;

  const existing = await getMailboxByAddress(db, parts.address);
  if (existing) return null;

  const activeDomain = await getActiveDomain(db, parts.domain);
  if (!activeDomain) return null;

  const ts = now();
  const expiresAt =
    input?.expires_at === undefined ||
    input?.expires_at === null ||
    input?.expires_at === ""
      ? null
      : Number(input.expires_at);

  const metadata = normalizeMetadata(
    input?.metadata ??
      input?.metadata_json ?? { source: input?.source || "manual" },
  );

  await db
    .prepare(
      `
    INSERT INTO mailboxes (
      address, local_part, domain, is_active, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      parts.address,
      parts.local_part,
      parts.domain,
      toDbBool(input?.is_active !== false),
      Number.isFinite(expiresAt) ? expiresAt : null,
      JSON.stringify(metadata),
      ts,
      ts,
    )
    .run();

  return getMailboxByAddress(db, parts.address);
}

export async function upsertMailbox(db, input) {
  const parts = splitAddress(input?.address);
  if (!parts) return null;

  const existing = await getMailboxByAddress(db, parts.address);
  if (existing) {
    return updateMailbox(db, parts.address, input);
  }

  return createMailbox(db, input);
}

export async function updateMailbox(db, address, patch = {}) {
  const parts = splitAddress(address);
  if (!parts) return null;

  const existing = await getMailboxByAddress(db, parts.address);
  if (!existing) return null;

  const nextIsActive =
    patch.is_active === undefined
      ? existing.is_active
      : Boolean(patch.is_active);

  const nextExpiresAt =
    patch.expires_at === undefined
      ? existing.expires_at
      : patch.expires_at === null || patch.expires_at === ""
        ? null
        : Number(patch.expires_at);

  const nextMetadata =
    patch.metadata === undefined && patch.metadata_json === undefined
      ? existing.metadata
      : normalizeMetadata(patch.metadata ?? patch.metadata_json);

  await db
    .prepare(
      `
    UPDATE mailboxes
    SET is_active = ?, expires_at = ?, metadata_json = ?, updated_at = ?
    WHERE address = ?
  `,
    )
    .bind(
      toDbBool(nextIsActive),
      Number.isFinite(nextExpiresAt) ? nextExpiresAt : null,
      JSON.stringify(nextMetadata),
      now(),
      parts.address,
    )
    .run();

  return getMailboxByAddress(db, parts.address);
}

export async function touchMailbox(db, address) {
  const parts = splitAddress(address);
  if (!parts) return false;

  const result = await db
    .prepare(
      `
    UPDATE mailboxes
    SET updated_at = ?
    WHERE address = ?
  `,
    )
    .bind(now(), parts.address)
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function deleteMailbox(db, address) {
  const parts = splitAddress(address);
  if (!parts) return false;

  const result = await db
    .prepare(
      `
    DELETE FROM mailboxes
    WHERE address = ?
  `,
    )
    .bind(parts.address)
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function getReceivableMailbox(db, address) {
  const parts = splitAddress(address);
  if (!parts) return null;

  const domain = await getActiveDomain(db, parts.domain);
  if (!domain) return null;

  const mailbox = await getMailboxByAddress(db, parts.address);
  const ts = now();

  if (mailbox) {
    if (!mailbox.is_active) return null;
    if (mailbox.expires_at != null && mailbox.expires_at <= ts) return null;
    return mailbox;
  }

  if (domain.catch_all) {
    return createMailbox(db, {
      address: parts.address,
      is_active: true,
      expires_at: null,
      metadata: { source: "catch_all_auto_create" },
    });
  }

  return null;
}

// -----------------------------------------------------------------------------
// Email APIs
// -----------------------------------------------------------------------------

function buildStoredMessageId(messageId, mailboxAddress) {
  const base = String(messageId || "").trim() || crypto.randomUUID();
  const mailbox = normalizeAddress(mailboxAddress);
  return `${base}::${mailbox}`;
}

export async function saveEmail(db, data) {
  const mailboxAddress = normalizeAddress(
    data?.mailbox_address || data?.to_address,
  );
  const mailboxParts = splitAddress(mailboxAddress);
  if (!mailboxParts) return null;

  const record = {
    message_id: buildStoredMessageId(data?.message_id, mailboxAddress),
    mailbox_address: mailboxParts.address,
    domain: normalizeDomain(
      data?.domain || data?.domain_name || mailboxParts.domain,
    ),
    from_address: normalizeAddress(data?.from_address || ""),
    to_address: mailboxParts.address,
    subject: String(data?.subject || ""),
    text_body: String(data?.text_body || ""),
    html_body: String(data?.html_body || ""),
    headers_json:
      typeof data?.headers_json === "string"
        ? data.headers_json
        : JSON.stringify(data?.headers || {}),
    raw_size: Number(data?.raw_size || 0),
    received_at: Number(data?.received_at || now()),
  };

  const result = await db
    .prepare(
      `
    INSERT INTO emails (
      message_id,
      mailbox_address,
      domain,
      from_address,
      to_address,
      subject,
      text_body,
      html_body,
      headers_json,
      raw_size,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      record.message_id,
      record.mailbox_address,
      record.domain,
      record.from_address,
      record.to_address,
      record.subject,
      record.text_body,
      record.html_body,
      record.headers_json,
      record.raw_size,
      record.received_at,
    )
    .run();

  const insertedId = Number(result?.meta?.last_row_id);
  return getEmailById(db, insertedId);
}

export async function getEmailById(db, id) {
  const emailId = Number(id);
  if (!Number.isFinite(emailId)) return null;

  const row = await firstResult(
    db
      .prepare(
        `
      SELECT id, message_id, mailbox_address, domain, from_address, to_address,
             subject, text_body, html_body, headers_json, raw_size, received_at
      FROM emails
      WHERE id = ?
      LIMIT 1
    `,
      )
      .bind(emailId),
  );

  return mapEmail(row);
}

export async function getLatestEmail(db, address) {
  const mailboxAddress = normalizeAddress(address);
  if (!mailboxAddress) return null;

  const row = await firstResult(
    db
      .prepare(
        `
      SELECT id, message_id, mailbox_address, domain, from_address, to_address,
             subject, text_body, html_body, headers_json, raw_size, received_at
      FROM emails
      WHERE mailbox_address = ?
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `,
      )
      .bind(mailboxAddress),
  );

  return mapEmail(row);
}

export async function getEmails(db, page = 1, pageSize = 20, domain = null) {
  const {
    offset,
    page: safePage,
    pageSize: safePageSize,
  } = buildPagination(page, pageSize);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;

  const conditions = [];
  const params = [];
  const countParams = [];

  if (normalizedDomain) {
    conditions.push(`domain = ?`);
    params.push(normalizedDomain);
    countParams.push(normalizedDomain);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const [rows, countRow] = await Promise.all([
    allResults(
      db
        .prepare(
          `
        SELECT id, message_id, mailbox_address, domain, from_address, to_address,
               subject, text_body, html_body, headers_json, raw_size, received_at
        FROM emails
        ${whereClause}
        ORDER BY received_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
        )
        .bind(...params, safePageSize, offset),
    ),
    firstResult(
      db
        .prepare(
          `
        SELECT COUNT(1) AS total
        FROM emails
        ${whereClause}
      `,
        )
        .bind(...countParams),
    ),
  ]);

  return {
    items: rows.map(mapEmail),
    total: Number(countRow?.total || 0),
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getEmailsByAddress(db, address, limit = 20, offset = 0) {
  const mailboxAddress = normalizeAddress(address);
  if (!mailboxAddress) return { items: [], total: 0 };

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows, countRow] = await Promise.all([
    allResults(
      db
        .prepare(
          `
        SELECT id, message_id, mailbox_address, domain, from_address, to_address,
               subject, text_body, html_body, headers_json, raw_size, received_at
        FROM emails
        WHERE mailbox_address = ?
        ORDER BY received_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
        )
        .bind(mailboxAddress, safeLimit, safeOffset),
    ),
    firstResult(
      db
        .prepare(
          `
        SELECT COUNT(1) AS total
        FROM emails
        WHERE mailbox_address = ?
      `,
        )
        .bind(mailboxAddress),
    ),
  ]);

  return {
    items: rows.map(mapEmail),
    total: Number(countRow?.total || 0),
  };
}

export async function getMailboxEmails(db, address, options = {}) {
  const { page, pageSize, offset } = buildPagination(
    options.page,
    options.pageSize,
  );
  return getEmailsByAddress(db, address, pageSize, offset).then((result) => ({
    ...result,
    page,
    pageSize,
  }));
}

export async function deleteEmailsByAddress(db, address) {
  const mailboxAddress = normalizeAddress(address);
  if (!mailboxAddress) return false;

  const result = await db
    .prepare(
      `
    DELETE FROM emails
    WHERE mailbox_address = ?
  `,
    )
    .bind(mailboxAddress)
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function clearExpiredEmails(db, maxHours = 48) {
  const threshold = now() - Number(maxHours || 48) * 60 * 60 * 1000;

  const result = await db
    .prepare(
      `
    DELETE FROM emails
    WHERE received_at < ?
  `,
    )
    .bind(threshold)
    .run();

  return {
    ok: true,
    threshold,
    deleted: Number(result?.meta?.changes || 0),
  };
}

export async function clearExpiredMailboxes(db) {
  const threshold = now();

  const result = await db
    .prepare(
      `
    DELETE FROM mailboxes
    WHERE expires_at IS NOT NULL AND expires_at <= ?
  `,
    )
    .bind(threshold)
    .run();

  return {
    ok: true,
    threshold,
    deleted: Number(result?.meta?.changes || 0),
  };
}

// -----------------------------------------------------------------------------
// Stats / health
// -----------------------------------------------------------------------------

export async function getServiceStats(db) {
  const [activeDomainsRow, activeMailboxesRow, totalEmailsRow] =
    await Promise.all([
      firstResult(
        db.prepare(`SELECT COUNT(1) AS total FROM domains WHERE is_active = 1`),
      ),
      firstResult(
        db.prepare(
          `SELECT COUNT(1) AS total FROM mailboxes WHERE is_active = 1`,
        ),
      ),
      firstResult(db.prepare(`SELECT COUNT(1) AS total FROM emails`)),
    ]);

  return {
    active_domains: Number(activeDomainsRow?.total || 0),
    active_mailboxes: Number(activeMailboxesRow?.total || 0),
    total_emails: Number(totalEmailsRow?.total || 0),
  };
}

export async function getHealthSummary(db) {
  return getServiceStats(db);
}
