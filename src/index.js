import PostalMime from "postal-mime";

const PAGE_SIZE = 20;
const RULES_PAGE_SIZE = 12;

export default {
  async email(message, env, ctx) {
    const now = Date.now();
    const parsed = await parseIncomingEmail(message);
    const rules = await loadRules(env.DB);
    const content = parsed.text || parsed.html || "";
    const sender = parsed.from || "";
    const matches = applyRules(content, sender, rules);

    const record = {
      message_id: crypto.randomUUID(),
      from_address: parsed.from || "",
      to_address: parsed.to.join(","),
      subject: parsed.subject || "",
      extracted_json: JSON.stringify(matches),
      received_at: now
    };

    ctx.waitUntil(
      env.DB.prepare(
        "INSERT INTO emails (message_id, from_address, to_address, subject, extracted_json, received_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          record.message_id,
          record.from_address,
          record.to_address,
          record.subject,
          record.extracted_json,
          record.received_at
        )
        .run()
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
        return new Response(renderAuthHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(renderHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/hits/latest") {
      if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (url.pathname === "/api/list" && request.method === "GET") {
      const page = clampPage(url.searchParams.get("page"));
      const offset = (page - 1) * PAGE_SIZE;
      const list = await env.DB.prepare(
        "SELECT message_id, from_address, to_address, subject, extracted_json, received_at FROM emails ORDER BY received_at DESC LIMIT ? OFFSET ?"
      )
        .bind(PAGE_SIZE, offset)
        .all();

      const countResult = await env.DB.prepare("SELECT COUNT(1) as total FROM emails").all();
      const total = countResult.results[0]?.total || 0;
      return json({
        page,
        pageSize: PAGE_SIZE,
        total,
        items: list.results
      });
    }

    if (url.pathname === "/api/hits/latest" && request.method === "GET") {
      if (!isApiAuthorized(request, env.API_TOKEN)) {
        return jsonError("Unauthorized", 401);
      }
      const address = String(url.searchParams.get("address") || "").trim();
      if (!address) {
        return jsonError("address is required", 400);
      }
      const row = await env.DB.prepare(
        "SELECT message_id, from_address, to_address, extracted_json, received_at FROM emails WHERE instr(',' || to_address || ',', ',' || ? || ',') > 0 ORDER BY received_at DESC LIMIT 1"
      )
        .bind(address)
        .first();
      if (!row) {
        return jsonError("message not found", 404);
      }
      const parsed = safeParseJson(row.extracted_json);
      const resultValue = Array.isArray(parsed)
        ? (parsed[0] ?? null)
        : (parsed ?? null);
      return json({
        from_address: row.from_address,
        to_address: row.to_address,
        received_at: row.received_at,
        result: resultValue
      });
    }

    if (url.pathname === "/api/rules" && request.method === "GET") {
      const page = clampPage(url.searchParams.get("page"));
      const offset = (page - 1) * RULES_PAGE_SIZE;
      const list = await env.DB.prepare(
        "SELECT id, sender_filter, pattern, created_at FROM rules ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
        .bind(RULES_PAGE_SIZE, offset)
        .all();
      const countResult = await env.DB.prepare("SELECT COUNT(1) as total FROM rules").all();
      const total = countResult.results[0]?.total || 0;
      return json({
        page,
        pageSize: RULES_PAGE_SIZE,
        total,
        items: list.results
      });
    }

    if (url.pathname === "/api/rules" && request.method === "POST") {
      const body = await request.json();
      const pattern = String(body.pattern || "").trim();
      const senderFilter = String(body.sender_filter || "").trim();
      if (!pattern) {
        return jsonError("pattern is required", 400);
      }
      await env.DB.prepare(
        "INSERT INTO rules (sender_filter, pattern, created_at) VALUES (?, ?, ?)"
      )
        .bind(senderFilter || null, pattern, Date.now())
        .run();
      return json({ ok: true });
    }

    if (url.pathname.startsWith("/api/rules/") && request.method === "DELETE") {
      const id = Number(url.pathname.replace("/api/rules/", ""));
      if (!Number.isFinite(id)) {
        return jsonError("invalid rule id", 400);
      }
      await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response(renderAuthHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

async function parseIncomingEmail(message) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  const toList = Array.isArray(parsed.to) ? parsed.to : [];
  const recipients = toList
    .map((item) => item.address)
    .filter(Boolean);

  return {
    from: parsed.from?.address || "",
    to: recipients,
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: parsed.html || ""
  };
}

function renderAuthHtml() {
  return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Temp Mail Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-950 text-slate-100 antialiased">
    <div class="min-h-screen flex items-center justify-center">
      <div class="bg-slate-950/60 rounded-2xl shadow-sm border border-white/10 p-8 w-full max-w-md">
        <h1 class="text-xl font-semibold">请输入访问密码</h1>
        <form class="mt-6 space-y-3" onsubmit="return false;">
          <input
            id="admin-token"
            type="password"
            class="w-full px-3 py-2 rounded-md border border-white/10 bg-slate-950/40 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200/20 focus:border-slate-300/30"
            placeholder="访问密码"
            autocomplete="current-password"
          />
          <div id="admin-error" class="text-xs text-red-400 hidden">密码不正确，请重试</div>
          <button
            id="admin-submit"
            type="button"
            class="w-full px-3 py-2 rounded-md bg-white text-slate-950 text-sm shadow-sm shadow-black/30 hover:bg-slate-100"
          >进入</button>
        </form>
      </div>
    </div>
    <script>
      const input = document.getElementById("admin-token");
      const error = document.getElementById("admin-error");
      const submit = document.getElementById("admin-submit");
      if (input) {
        input.focus();
      }
       const setError = (message) => {
         if (!error) {
           return;
         }
         error.textContent = message;
         error.classList.remove("hidden");
       };
       const attempt = async () => {
         const token = input ? input.value.trim() : "";
         if (!token) {
           setError("请输入访问密码");
           return;
         }
         const res = await fetch("/api/list?page=1", {
           headers: { Authorization: "Bearer " + token }
         });
         if (res.status === 401) {
           setError("密码不正确，请重试");
           return;
         }
         if (!res.ok) {
           setError("登录失败，请重试");
           return;
         }
         document.cookie = "admin_token=" + encodeURIComponent(token) + "; Path=/; SameSite=Lax";
         window.location.href = "/";
       };
      if (submit) {
        submit.addEventListener("click", attempt);
      }
      if (input) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            attempt();
          }
        });
      }
    </script>
  </body>
</html>`;
}

async function loadRules(db) {
  const result = await db.prepare("SELECT id, sender_filter, pattern FROM rules ORDER BY created_at DESC").all();
  return result.results.map((row) => ({
    id: Number(row.id),
    sender_filter: row.sender_filter ? String(row.sender_filter) : "",
    pattern: String(row.pattern)
  }));
}

function applyRules(content, sender, rules) {
  const senderValue = String(sender || "").toLowerCase();
  const outputs = [];
  for (const rule of rules) {
    if (!senderMatches(senderValue, rule.sender_filter)) {
      continue;
    }
    try {
      const regex = new RegExp(rule.pattern, "m");
      const match = content.match(regex);
      if (match && match[0]) {
        outputs.push(match[0]);
      }
    } catch (error) {
      continue;
    }
  }
  return outputs;
}

function senderMatches(senderValue, filterValue) {
  const filter = String(filterValue || "").trim();
  if (!filter) {
    return true;
  }
  const parts = filter
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return true;
  }
  return parts.some((item) => senderRegexMatch(senderValue, item));
}

function senderRegexMatch(senderValue, pattern) {
  try {
    const regex = new RegExp(pattern, "i");
    return regex.test(senderValue);
  } catch (error) {
    return false;
  }
}

function safeParseJson(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

function isAdminAuthorized(request, adminToken) {
  if (!adminToken) {
    return false;
  }
  if (getBearerToken(request) === adminToken) {
    return true;
  }
  const cookie = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookie);
  return cookies.admin_token === adminToken;
}

function isApiAuthorized(request, apiToken) {
  if (!apiToken) {
    return false;
  }
  return getBearerToken(request) === apiToken;
}

function parseCookies(cookieHeader) {
  const output = {};
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }
    output[rawKey] = decodeURIComponent(rest.join("="));
  }
  return output;
}

function clampPage(value) {
  const page = Number(value);
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }
  return Math.floor(page);
}

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: status, data }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function jsonError(message, status) {
  return json({ error: message }, status);
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Temp Mail Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
  </head>
  <body class="bg-slate-900 text-slate-100">
    <div id="app" class="min-h-screen">
      <header class="max-w-5xl mx-auto px-4 py-4">
        <div class="rounded-xl border border-white/10 bg-slate-950/60 backdrop-blur px-4 py-3 flex items-center justify-between">
          <div>
            <h1 class="text-xl font-semibold tracking-tight">临时邮箱管理台</h1>
            <p class="text-xs text-slate-400">Cloudflare Workers · D1 · 邮件解析</p>
          </div>
          <span class="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-slate-200">实时</span>
        </div>
      </header>

      <main class="max-w-5xl mx-auto px-4 py-6">
        <div class="mb-4 flex items-center gap-2">
          <button
            class="px-3 py-1.5 rounded-md text-xs border border-white/10"
            :class="activeTab === 'emails' ? 'bg-white text-slate-950' : 'bg-transparent text-slate-300 hover:bg-white/5'"
            @click="activeTab = 'emails'"
          >邮件列表</button>
          <button
            class="px-3 py-1.5 rounded-md text-xs border border-white/10"
            :class="activeTab === 'rules' ? 'bg-white text-slate-950' : 'bg-transparent text-slate-300 hover:bg-white/5'"
            @click="activeTab = 'rules'"
          >规则管理</button>
          <button
            class="px-3 py-1.5 rounded-md text-xs border border-white/10"
            :class="activeTab === 'api' ? 'bg-white text-slate-950' : 'bg-transparent text-slate-300 hover:bg-white/5'"
            @click="activeTab = 'api'"
          >接口说明</button>
        </div>

        <div v-if="adminError" class="mb-4 text-xs text-red-400">{{ adminError }}</div>


        <section v-if="activeTab === 'emails'" class="bg-slate-950/60 rounded-xl shadow-sm border border-white/10">
          <div class="p-4 border-b border-white/10 flex items-center justify-between">
            <div>
              <h2 class="text-base font-semibold">邮件列表</h2>
              <p class="text-[11px] text-slate-400">分页展示已收到的邮件</p>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <button class="px-2.5 py-1 rounded-md border border-white/10 hover:bg-white/5" @click="prevPage" :disabled="page===1">上一页</button>
              <span class="px-2.5 py-1">第 {{ page }} 页</span>
              <button class="px-2.5 py-1 rounded-md border border-white/10 hover:bg-white/5" @click="nextPage" :disabled="page>=totalPages">下一页</button>
            </div>
          </div>
          <div class="p-4 space-y-3">
            <div class="grid grid-cols-[1.3fr,1.2fr,1.2fr,0.8fr] gap-3 text-[11px] text-slate-400 uppercase tracking-wide">
              <div>主题</div>
              <div>发件人</div>
              <div>收件人</div>
              <div class="text-right">时间</div>
            </div>
            <div v-if="items.length===0" class="min-h-[240px] flex items-center justify-center text-xs text-slate-400">暂无邮件记录</div>
            <div v-for="item in items" :key="item.message_id" class="p-3 rounded-lg border border-white/10 bg-slate-950/40 cursor-pointer" @click="toggleResult(item.message_id)">
              <div class="grid grid-cols-[1.3fr,1.2fr,1.2fr,0.8fr] gap-3 items-start">
                <div class="min-w-0">
                  <div class="text-sm font-medium truncate">{{ item.subject || '(无主题)' }}</div>
                </div>
                <div class="min-w-0 text-[11px] text-slate-400 truncate">{{ item.from_address }}</div>
                <div class="min-w-0 text-[11px] text-slate-400 truncate">{{ item.to_address }}</div>
                <div class="text-[11px] text-slate-400 text-right">{{ formatTime(item.received_at) }}</div>
                <div class="col-span-4 mt-2">
                  <div v-if="hasResult(item.extracted_json)" class="text-[11px] text-slate-400">
                    {{ expandedResults[item.message_id] ? '收起命中结果' : '命中结果' }}
                  </div>
                  <div v-else class="text-[11px] text-slate-400">未命中规则</div>
                  <div
                    v-if="expandedResults[item.message_id]"
                    class="mt-2 text-[11px] bg-slate-950/60 border border-white/10 rounded-md p-2 whitespace-pre-wrap"
                  >{{ formatResult(item.extracted_json) }}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeTab === 'rules'" class="bg-slate-950/60 rounded-xl shadow-sm border border-white/10">
          <div class="p-4 border-b border-white/10">
            <h2 class="text-base font-semibold">命中规则</h2>
            <p class="text-[11px] text-slate-400">符合发信人过滤规则的邮件，将会使用对应的邮件内容匹配规则进行解析</p>
          </div>

          <div class="p-4 grid grid-cols-1 lg:grid-cols-12 gap-3">
            <div class="lg:col-span-5">
              <div class="rounded-lg border border-white/10 bg-slate-950/40 p-3 min-h-[420px] lg:sticky lg:top-4">
                <div class="flex items-center justify-between mb-2">
                  <div class="text-[11px] text-slate-300">添加规则</div>
                  <div class="text-[11px] text-slate-400">填写后点击添加</div>
                </div>

                <div class="space-y-2.5">
                  <div class="space-y-1.5">
                    <label class="text-[11px] text-slate-300">发信人过滤规则</label>
                    <textarea v-model="newRule.sender_filter" rows="3" class="w-full px-2.5 py-2 rounded-md border border-white/10 bg-slate-950/40 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200/20 focus:border-slate-300/30" placeholder="e.g. noreply@example.com, support@demo.com"></textarea>
                  </div>

                  <div class="space-y-1.5">
                    <label class="text-[11px] text-slate-300">邮件内容匹配规则</label>
                    <textarea v-model="newRule.pattern" rows="5" class="w-full px-2.5 py-2 rounded-md border border-white/10 bg-slate-950/40 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200/20 focus:border-slate-300/30" placeholder="e.g. (\\d{6})"></textarea>
                  </div>

                  <button class="w-full px-3 py-2 rounded-md bg-white text-slate-950 text-sm shadow-sm shadow-black/30 hover:bg-slate-100" @click="addRule">添加规则</button>
                </div>
              </div>
            </div>

            <div class="lg:col-span-7">
              <div class="rounded-lg border border-white/10 min-h-[420px] flex flex-col">
                <div class="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                  <div class="text-[11px] text-slate-300">已有规则</div>
                  <div class="flex items-center gap-2 text-[11px] text-slate-400">
                    <span>共 {{ rulesTotal }} 条</span>
                    <button class="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5" @click="prevRulesPage" :disabled="rulesPage===1">上一页</button>
                    <span>第 {{ rulesPage }} 页</span>
                    <button class="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5" @click="nextRulesPage" :disabled="rulesPage>=rulesTotalPages">下一页</button>
                  </div>
                </div>

                <div class="p-3 space-y-2 flex-1 overflow-auto">
                  <div v-if="rules.length===0" class="h-full flex items-center justify-center text-xs text-slate-400">暂无规则</div>

                  <div v-for="rule in rules" :key="rule.id" class="p-2.5 rounded-md border border-white/10 bg-slate-950/40 flex items-start justify-between gap-3">
                    <div class="min-w-0 space-y-1">
                      <div class="text-[11px] text-slate-400 truncate">发信人: {{ rule.sender_filter || '任意' }}</div>
                      <div class="text-[11px] text-slate-400 break-words">规则: {{ rule.pattern }}</div>
                    </div>
                    <button class="shrink-0 text-[11px] text-red-500 hover:text-red-600" @click="deleteRule(rule.id)">删除</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeTab === 'api'" class="bg-slate-950/60 rounded-xl shadow-sm border border-white/10">
          <div class="p-4 border-b border-white/10">
            <h2 class="text-base font-semibold">接口调用说明</h2>
            <p class="text-[11px] text-slate-400">命中结果查询仅支持 API Token</p>
          </div>
          <div class="p-4 space-y-4 text-sm">
            <div class="space-y-2">
              <div class="text-[11px] text-slate-400">鉴权</div>
              <pre class="rounded-md border border-white/10 bg-slate-950/40 p-3 text-[11px] text-slate-200 whitespace-pre-wrap">Authorization: Bearer &lt;API_TOKEN&gt;</pre>
            </div>
            <div class="space-y-2">
              <div class="text-[11px] text-slate-400">按邮箱获取最新命中</div>
              <pre class="rounded-md border border-white/10 bg-slate-950/40 p-3 text-[11px] text-slate-200 whitespace-pre-wrap">GET /api/hits/latest?address=&lt;email_address&gt;
响应: { code: 200, data: { from_address, to_address, received_at, result } }</pre>
              <div class="text-[11px] text-slate-400">返回字段</div>
              <pre class="rounded-md border border-white/10 bg-slate-950/40 p-3 text-[11px] text-slate-200 whitespace-pre-wrap">code: 状态码
data.from_address: 发件人邮箱
data.to_address: 收件人邮箱
data.received_at: 收件时间戳
data.result: 命中结果值（单个值）</pre>
            </div>
          </div>
        </section>
      </main>
      <footer class="max-w-5xl mx-auto px-4 py-6 text-xs text-slate-400">
        <div class="flex items-center justify-between border-t border-white/10 pt-4">
          <span>© 2026 Temp Mail Admin</span>
          <a class="text-slate-300 hover:text-slate-100" href="https://github.com/beyoug" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </footer>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            page: 1,
            total: 0,
            items: [],
            rules: [],
            rulesPage: 1,
            rulesTotal: 0,
            newRule: { sender_filter: "", pattern: "" },
            activeTab: "emails",
            adminToken: "",
            adminError: "",
            poller: null,
            expandedResults: {}
          };
        },
        computed: {
          totalPages() {
            return Math.max(1, Math.ceil(this.total / ${PAGE_SIZE}));
          },
          rulesTotalPages() {
            return Math.max(1, Math.ceil(this.rulesTotal / ${RULES_PAGE_SIZE}));
          }
        },
        mounted() {
          this.adminToken = getCookieValue("admin_token");
          if (!this.adminToken) {
            return;
          }
          this.loadList();
          this.loadRules();
          this.startPolling();
        },
        beforeUnmount() {
          this.stopPolling();
        },
        methods: {
          startPolling() {
            this.stopPolling();
            this.poller = setInterval(() => {
              if (this.adminToken && this.activeTab === "emails") {
                this.loadList();
              }
            }, 5000);
          },
          stopPolling() {
            if (this.poller) {
              clearInterval(this.poller);
              this.poller = null;
            }
          },
          async handleAuthError(res) {
            if (res.status === 401) {
              this.clearAdminToken("密码不正确，请重试");
              return true;
            }
            return false;
          },
          clearAdminToken(message) {
            this.adminToken = "";
            this.adminError = message || "";
            document.cookie = "admin_token=; Path=/; Max-Age=0; SameSite=Lax";
            this.stopPolling();
          },
           async requestJson(url, options = {}) {
             const res = await fetch(url, { ...options, headers: { ...this.adminHeaders(), ...(options.headers || {}) } });
             if (await this.handleAuthError(res)) {
               return null;
             }
             return res.json();
           },
          async loadList() {
            const payload = await this.requestJson("/api/list?page=" + this.page);
            if (!payload) return;
            const data = payload.data || {};
            this.items = data.items || [];
            this.total = data.total || 0;
          },
          formatTime(ts) {
            return new Date(ts).toLocaleString();
          },
          async loadRules() {
            const payload = await this.requestJson("/api/rules?page=" + this.rulesPage);
            if (!payload) return;
            const data = payload.data || {};
            this.rules = data.items || [];
            this.rulesTotal = data.total || 0;
          },
          async addRule() {
            if (!this.newRule.pattern) return;
            const payload = await this.requestJson("/api/rules", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(this.newRule)
            });
            if (!payload) return;
            this.newRule = { sender_filter: "", pattern: "" };
            this.rulesPage = 1;
            await this.loadRules();
          },
          async deleteRule(id) {
            const payload = await this.requestJson("/api/rules/" + id, {
              method: "DELETE",
            });
            if (!payload) return;
            await this.loadRules();
            if (this.rules.length === 0 && this.rulesPage > 1) {
              this.rulesPage -= 1;
              await this.loadRules();
            }
          },
          adminHeaders() {
            if (!this.adminToken) {
              return {};
            }
            return { Authorization: "Bearer " + this.adminToken };
          },
          async nextRulesPage() {
            if (this.rulesPage < this.rulesTotalPages) {
              this.rulesPage += 1;
              await this.loadRules();
            }
          },
          async prevRulesPage() {
            if (this.rulesPage > 1) {
              this.rulesPage -= 1;
              await this.loadRules();
            }
          },
          async nextPage() {
            if (this.page < this.totalPages) {
              this.page += 1;
              await this.loadList();
            }
          },
          toggleResult(messageId) {
            this.expandedResults[messageId] = !this.expandedResults[messageId];
          },
          hasResult(raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                return parsed.length > 0;
              }
              return Boolean(parsed);
            } catch (error) {
              return false;
            }
          },
          formatResult(raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                return parsed.join(", ");
              }
              return String(parsed ?? "");
            } catch (error) {
              return raw || "";
            }
          },
          async prevPage() {
            if (this.page > 1) {
              this.page -= 1;
              await this.loadList();
            }
          }
        }
      }).mount("#app");

      function getCookieValue(name) {
        const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : "";
      }
    </script>
  </body>
</html>`;
}
