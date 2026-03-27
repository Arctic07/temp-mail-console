export const PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const DEFAULT_EMAIL_RETENTION_HOURS = 48;
export const DEFAULT_MAILBOX_TTL_SECONDS = 1800;

export const MAX_EMAIL_BODY_CHARS = 100000;
export const MAX_HTML_BODY_CHARS = 200000;
export const MAX_HEADERS_JSON_CHARS = 50000;

export const MAX_DOMAIN_LENGTH = 255;
export const MAX_LOCAL_PART_LENGTH = 64;
export const MAX_ADDRESS_LENGTH = 320;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-Internal-Token",
};

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};
