import { CORS_HEADERS } from "./utils/constants.js";
import { isInternalAuthorized } from "./core/auth.js";
import { clearExpiredEmails, clearExpiredMailboxes } from "./core/db.js";
import { processIncomingEmail } from "./core/logic.js";
import { applyCors, json, jsonError } from "./utils/utils.js";
import * as handlers from "./handlers/handlers.js";

function withCors(response) {
  return applyCors(response, CORS_HEADERS);
}

function jsonWithCors(data, status = 200) {
  return withCors(json(data, status));
}

function jsonErrorWithCors(message, status = 400) {
  return withCors(jsonError(message, status));
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS },
  });
}

function isAuthorized(request, env) {
  return isInternalAuthorized(request, env.INTERNAL_API_TOKEN);
}

function getEmailRetentionHours(env) {
  const value = Number(env.EMAIL_RETENTION_HOURS);
  return Number.isFinite(value) && value > 0 ? value : 48;
}

function isMailboxEmailsPath(pathname) {
  return /^\/internal\/mailboxes\/.+\/emails$/.test(pathname);
}

function isMailboxLatestPath(pathname) {
  return /^\/internal\/mailboxes\/.+\/emails\/latest$/.test(pathname);
}

function isMailboxItemPath(pathname) {
  return (
    /^\/internal\/mailboxes\/.+$/.test(pathname) &&
    !isMailboxEmailsPath(pathname) &&
    !isMailboxLatestPath(pathname)
  );
}

function isDomainItemPath(pathname) {
  return /^\/internal\/domains\/.+$/.test(pathname);
}

function isEmailItemPath(pathname) {
  return /^\/internal\/emails\/\d+$/.test(pathname);
}

export default {
  async email(message, env, ctx) {
    const result = await processIncomingEmail(message, env, ctx);

    if (result?.accepted && env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (error) {
        console.error("forward failed", error);
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return optionsResponse();
    }

    if (pathname === "/" && method === "GET") {
      return jsonWithCors({
        name: "mail capability base",
        status: "ok",
        routes: {
          health: "/health",
          internal_health: "/internal/health",
          domains: "/internal/domains",
          mailboxes: "/internal/mailboxes",
          mailbox_emails: "/internal/mailboxes/:address/emails",
          mailbox_latest: "/internal/mailboxes/:address/emails/latest",
          email_detail: "/internal/emails/:id",
        },
      });
    }

    if (pathname === "/health" && method === "GET") {
      return jsonWithCors({
        ok: true,
        service: "mail capability base",
      });
    }

    if (!pathname.startsWith("/internal/")) {
      return new Response("Not Found", { status: 404 });
    }

    if (!isAuthorized(request, env)) {
      return jsonErrorWithCors("Unauthorized", 401);
    }

    try {
      if (pathname === "/internal/health" && method === "GET") {
        return withCors(await handlers.handleHealth(url, env.DB));
      }

      if (pathname === "/internal/domains" && method === "GET") {
        return withCors(await handlers.handleDomainsGet(url, env.DB));
      }

      if (pathname === "/internal/domains" && method === "POST") {
        return withCors(await handlers.handleDomainsPost(request, env.DB));
      }

      if (isDomainItemPath(pathname) && method === "PATCH") {
        return withCors(
          await handlers.handleDomainsPatch(pathname, request, env.DB),
        );
      }

      if (isDomainItemPath(pathname) && method === "DELETE") {
        return withCors(await handlers.handleDomainsDelete(pathname, env.DB));
      }

      if (pathname === "/internal/mailboxes" && method === "GET") {
        return withCors(await handlers.handleMailboxesGet(url, env.DB));
      }

      if (pathname === "/internal/mailboxes" && method === "POST") {
        return withCors(await handlers.handleMailboxesPost(request, env.DB));
      }

      if (isMailboxLatestPath(pathname) && method === "GET") {
        const basePath = pathname.replace(/\/emails\/latest$/, "");
        const latestUrl = new URL(request.url);
        const address = decodeURIComponent(
          basePath.replace("/internal/mailboxes/", ""),
        );
        latestUrl.searchParams.set("address", address);
        return withCors(await handlers.handleMailboxLatest(latestUrl, env.DB));
      }

      if (isMailboxEmailsPath(pathname) && method === "GET") {
        return withCors(
          await handlers.handleMailboxEmails(pathname, url, env.DB),
        );
      }

      if (isMailboxItemPath(pathname) && method === "GET") {
        return withCors(await handlers.handleMailboxGet(pathname, env.DB));
      }

      if (isMailboxItemPath(pathname) && method === "DELETE") {
        return withCors(await handlers.handleMailboxesDelete(pathname, env.DB));
      }

      if (isEmailItemPath(pathname) && method === "GET") {
        return withCors(await handlers.handleEmailGet(pathname, env.DB));
      }

      if (pathname === "/api/emails/latest" && method === "GET") {
        return withCors(await handlers.handleMailboxLatest(url, env.DB));
      }

      return jsonErrorWithCors("Not Found", 404);
    } catch (error) {
      console.error("request handling failed", error);
      return jsonErrorWithCors("Internal Server Error", 500);
    }
  },

  async scheduled(_event, env, ctx) {
    const retentionHours = getEmailRetentionHours(env);

    ctx.waitUntil(
      Promise.all([
        clearExpiredMailboxes(env.DB),
        clearExpiredEmails(env.DB, retentionHours),
      ])
        .then(() => {
          console.log(
            `[Cron] cleanup completed: expired mailboxes removed, emails older than ${retentionHours}h deleted`,
          );
        })
        .catch((error) => {
          console.error("[Cron] cleanup failed", error);
        }),
    );
  },
};
