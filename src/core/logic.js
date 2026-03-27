import PostalMime from "postal-mime";
import { getDomainByName, getMailboxByAddress, saveEmail } from "./db.js";

/**
 * Parse the incoming Email Routing payload into a normalized structure.
 */
async function parseIncomingEmail(message) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await new PostalMime().parse(rawBuffer);

  const toList = Array.isArray(parsed.to) ? parsed.to : [];
  const ccList = Array.isArray(parsed.cc) ? parsed.cc : [];
  const bccList = Array.isArray(parsed.bcc) ? parsed.bcc : [];

  return {
    from: normalizeAddress(parsed.from?.address || ""),
    to: dedupeAddresses(toList.map((item) => item?.address)),
    cc: dedupeAddresses(ccList.map((item) => item?.address)),
    bcc: dedupeAddresses(bccList.map((item) => item?.address)),
    subject: String(parsed.subject || "").trim(),
    text: String(parsed.text || ""),
    html: typeof parsed.html === "string" ? parsed.html : "",
    headers: normalizeHeaders(parsed.headers),
    attachments: normalizeAttachments(parsed.attachments),
  };
}

/**
 * Main inbound email flow:
 * 1. Parse MIME content
 * 2. Resolve all recipients
 * 3. Accept only recipients whose domain is active and mailbox already exists
 * 4. Persist one email record per accepted mailbox
 */
export async function processIncomingEmail(message, env, ctx) {
  const parsed = await parseIncomingEmail(message);

  const envelopeRecipients = dedupeAddresses(
    extractEnvelopeRecipients(message),
  );
  const mimeRecipients = dedupeAddresses([
    ...parsed.to,
    ...parsed.cc,
    ...parsed.bcc,
  ]);
  const recipients = dedupeAddresses([
    ...envelopeRecipients,
    ...mimeRecipients,
  ]);

  if (recipients.length === 0) {
    return {
      accepted: false,
      reason: "no_recipients",
      stored_count: 0,
      recipients: [],
    };
  }

  const acceptedRoutes = [];
  for (const recipient of recipients) {
    const route = await resolveRecipientRoute(env.DB, recipient);
    if (route) acceptedRoutes.push(route);
  }

  if (acceptedRoutes.length === 0) {
    return {
      accepted: false,
      reason: "no_precreated_mailbox",
      stored_count: 0,
      recipients: [],
    };
  }

  const rawSize = await getRawSize(message);
  const baseMessageId = resolveMessageId(message, parsed.headers);
  const receivedAt = Date.now();

  const jobs = acceptedRoutes.map(async ({ mailbox }) => {
    const mailboxAddress = normalizeAddress(mailbox.address);

    await saveEmail(env.DB, {
      message_id: baseMessageId,
      mailbox_address: mailboxAddress,
      from_address: parsed.from,
      subject: parsed.subject,
      text_body: parsed.text,
      html_body: parsed.html,
      headers: {
        ...parsed.headers,
        "x-mail-base-attachments": parsed.attachments,
      },
      raw_size: rawSize,
      received_at: receivedAt,
    });
  });

  if (ctx?.waitUntil) {
    ctx.waitUntil(Promise.all(jobs));
  } else {
    await Promise.all(jobs);
  }

  return {
    accepted: true,
    reason: "stored",
    message_id: baseMessageId,
    stored_count: acceptedRoutes.length,
    recipients: acceptedRoutes.map((item) =>
      normalizeAddress(item.mailbox.address),
    ),
  };
}

/**
 * Resolve whether a recipient address is accepted.
 *
 * Rules:
 * - domain must exist and be active
 * - mailbox must already exist and be active
 * - expired mailboxes are rejected
 * - catch-all does not auto-create mailboxes
 */
async function resolveRecipientRoute(db, address) {
  const normalizedAddress = normalizeAddress(address);
  const parts = splitAddress(normalizedAddress);
  if (!parts) return null;

  const domain = await getDomainByName(db, parts.domain);
  if (!domain || !isDomainActive(domain)) return null;

  const mailbox = await getMailboxByAddress(db, normalizedAddress);
  if (!mailbox) return null;
  if (!isMailboxActive(mailbox)) return null;
  if (isMailboxExpired(mailbox)) return null;

  return { domain, mailbox };
}

function extractEnvelopeRecipients(message) {
  const values = [];

  if (message?.to) values.push(message.to);
  if (Array.isArray(message?.recipients)) values.push(...message.recipients);
  if (Array.isArray(message?.rcptTo)) values.push(...message.rcptTo);

  return values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value.address === "string") return [value.address];
    return [];
  });
}

function normalizeHeaders(headers) {
  if (!headers) return {};

  if (headers instanceof Map) {
    return Object.fromEntries(
      Array.from(headers.entries()).map(([key, value]) => [
        String(key).toLowerCase(),
        stringifyHeaderValue(value),
      ]),
    );
  }

  if (Array.isArray(headers)) {
    const output = {};
    for (const item of headers) {
      if (!item) continue;
      const key = String(item.key || item.name || "").toLowerCase();
      if (!key) continue;
      output[key] = stringifyHeaderValue(item.value);
    }
    return output;
  }

  if (typeof headers === "object") {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        String(key).toLowerCase(),
        stringifyHeaderValue(value),
      ]),
    );
  }

  return {};
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments.map((attachment) => ({
    filename: String(attachment?.filename || ""),
    mime_type: String(attachment?.mimeType || ""),
    disposition: String(attachment?.disposition || ""),
    content_id: String(attachment?.contentId || ""),
    size: getAttachmentSize(attachment?.content),
  }));
}

function getAttachmentSize(content) {
  if (content instanceof Uint8Array) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (content instanceof ArrayBuffer) return content.byteLength;
  return 0;
}

function stringifyHeaderValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stringifyHeaderValue(item)).join(", ");
  }
  if (value == null) return "";
  return String(value);
}

function resolveMessageId(message, headers) {
  const candidates = [
    message?.headers?.get?.("message-id"),
    headers?.["message-id"],
    headers?.["message_id"],
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }

  return crypto.randomUUID();
}

async function getRawSize(message) {
  try {
    const rawBuffer = await new Response(message.raw).arrayBuffer();
    return rawBuffer.byteLength;
  } catch {
    return 0;
  }
}

function splitAddress(address) {
  const normalized = normalizeAddress(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;

  return {
    local_part: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function dedupeAddresses(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeAddress(value))
        .filter(Boolean),
    ),
  );
}

function isDomainActive(domain) {
  if (typeof domain?.is_active === "boolean") return domain.is_active;
  if (typeof domain?.is_active === "number") return domain.is_active === 1;
  return true;
}

function isMailboxActive(mailbox) {
  if (typeof mailbox?.is_active === "boolean") return mailbox.is_active;
  if (typeof mailbox?.is_active === "number") return mailbox.is_active === 1;
  return true;
}

function isMailboxExpired(mailbox) {
  if (mailbox?.expires_at == null || mailbox.expires_at === "") return false;
  const expiresAt = Number(mailbox.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now();
}
