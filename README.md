# Mail 底座

一个基于 **Cloudflare Workers + Email Routing + D1** 的轻量邮件能力底座。

它的职责不是提供完整的临时邮箱产品，而是专注于这几件事：

- 接收入站邮件
- 管理可接收域名与邮箱地址
- 存储邮件基础元数据与正文
- 对外提供内部 API，供你的 **Python 业务层** 调用
- 定时清理过期邮箱与历史邮件

你可以把它理解为：

> **邮件接收与存储平台**
>
> 而不是：
>
> **最终面向用户的 temp mail 成品**

---

## 适用场景

这个项目适合你在以下场景中使用：

- 你希望用 **Cloudflare Email Routing** 来接收邮件
- 你希望底层只做“邮件能力”
- 你的业务逻辑、用户系统、风控、管理后台都打算放到 **Python** 中
- 你需要一个简单、稳定、低运维成本的邮件接收底座
- 你希望用内部 API 的方式把邮件能力接入自己的系统

---

## 当前定位

本项目默认只保留以下职责：

### 保留
- 入站邮件解析
- 可接收域名管理
- 可接收邮箱地址管理
- 邮件持久化
- 基础查询接口
- 定时清理

### 不保留
- 最终用户控制台
- 正则提取规则
- 发件人白名单产品逻辑
- 面向最终用户的 API Key 体系
- 业务侧邮箱创建规则
- 业务侧权限系统

这些能力应该由你的 Python 服务实现。

---

## 核心规则

### 1. 只有已创建邮箱才能接收邮件
这是当前最重要的规则：

- **域名已启用，不代表该域名下任意地址都能接收**
- **必须先通过内部 API 创建邮箱地址**
- **只有已存在、未过期、仍有效的邮箱地址，才会接收邮件**

例如：

- `abc123@example.com` 已创建 → 可以接收
- `xyz999@example.com` 未创建 → 不接收
- `demo@example.com` 已过期并被清理 → 不接收

### 2. 即使配置了 catch-all，也不会自动创建邮箱
就算你在 Cloudflare Email Routing 中配置了 catch-all 路由：

- Worker 仍然只会接收**已经在底座中创建过**的邮箱
- 未创建地址不会自动入库
- 未创建地址不会自动补建

### 3. 过期邮箱不会继续接收
如果一个邮箱已经：

- 到达 `expires_at`
- 被定时清理删除
- 被手动删除
- 被手动禁用

那么之后发往这个地址的邮件将不会再被接收。

---

## 推荐架构

推荐把本项目作为底座层，Python 作为业务层：

```text
外部发件人
   ↓
Cloudflare Email Routing
   ↓
Mail 底座（Cloudflare Worker）
   ├─ D1：域名、邮箱、邮件数据
   ├─ 可选：邮件转发
   └─ 内部 API
        ↓
Python 业务服务
   ├─ 用户系统
   ├─ 邮箱分配规则
   ├─ TTL 策略
   ├─ 风控
   ├─ 收件箱接口
   └─ 管理后台
```

---

## 与 Python 的职责边界

建议这样划分：

### Mail 底座负责
- 接收邮件
- 保存邮件
- 校验域名 / 邮箱是否允许接收
- 暴露内部查询接口
- 清理过期数据

### Python 业务层负责
- 创建用户
- 给用户分配邮箱
- 设置邮箱 TTL
- 域名审核
- 计费 / 配额 / 权限
- 风控与限流
- 面向前端的业务 API
- 邮件展示页面

---

## 数据存储

当前使用：

- **Cloudflare Workers**
- **Cloudflare Email Routing**
- **Cloudflare D1**

也就是说，本项目数据库是：

> **Cloudflare D1（SQLite）**

---

## 数据模型

### `domains`
用于记录可接收域名。

字段说明：

- `id`
- `domain`
- `is_active`
- `catch_all`
- `created_at`
- `updated_at`

### `mailboxes`
用于记录已注册邮箱地址。

字段说明：

- `id`
- `address`
- `local_part`
- `domain`
- `is_active`
- `expires_at`
- `metadata_json`
- `created_at`
- `updated_at`

### `emails`
用于记录邮件基础内容。

字段说明：

- `id`
- `message_id`
- `mailbox_address`
- `domain`
- `from_address`
- `to_address`
- `subject`
- `text_body`
- `html_body`
- `headers_json`
- `raw_size`
- `received_at`

---

## 快速开始

## 1. 安装依赖

```bash
npm install
```

## 2. 创建 D1 数据库

```bash
npx wrangler d1 create mail-base-db
```

将输出的 `database_id` 填入 `wrangler.toml`。

---

## 3. 配置 `wrangler.toml`

示例：

```toml
name = "mail-base"
main = "src/index.js"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB"
database_name = "mail-base-db"
database_id = "your-d1-database-id"

[triggers]
crons = ["0 * * * *"]
```

---

## 4. 配置运行时变量

推荐使用 `.dev.vars` 做本地开发配置。

你可以从 `.dev.vars.example` 复制一份：

```bash
cp .dev.vars.example .dev.vars
```

一个推荐的示例：

```bash
# 内部 API 鉴权令牌
# Python 业务层调用底座时使用
INTERNAL_API_TOKEN=dev-internal-api-token

# 可选：开启后，Worker 会将已成功接收的原始邮件继续转发到该邮箱
# 该邮箱需要先在 Cloudflare Email Routing 的 Destination addresses 中验证
FORWARD_TO=

# 可选：邮件保留时间，单位小时
# 超过这个时长的邮件会在定时任务中被清理
EMAIL_RETENTION_HOURS=48

# 可选：默认邮箱 TTL（秒）
# 当前底座不会自动创建邮箱，也不会自动套用该值；
# 这个值更适合给上层 Python 业务层当默认值参考
DEFAULT_MAILBOX_TTL_SECONDS=1800
```

### 变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `INTERNAL_API_TOKEN` | 是 | 内部 API 鉴权令牌，供 Python 服务调用 |
| `FORWARD_TO` | 否 | 邮件成功接收后，是否额外转发一份原始邮件 |
| `EMAIL_RETENTION_HOURS` | 否 | 邮件保留时长，超过后会被定时清理 |
| `DEFAULT_MAILBOX_TTL_SECONDS` | 否 | 给上层业务参考的默认邮箱 TTL 值 |

> 建议在线上环境中使用平台提供的 Secret / Variable 管理能力，不要把真实凭据直接写进仓库。

---

## 5. 执行数据库迁移

本地：

```bash
npm run db:migrate:local
```

远程：

```bash
npm run db:migrate:remote
```

---

## 6. 本地开发

```bash
npm run dev
```

默认访问地址：

```text
http://localhost:8787
```

---

## 7. 部署

```bash
npm run deploy
```

---

## 8. 配置 Cloudflare Email Routing

在 Cloudflare 控制台中：

- 打开 **Email**
- 进入 **Email Routing**
- 配置你的域名邮件路由
- 将目标设置为 **Send to a Worker**
- 选择当前 Worker

你可以按需选择：

- 具体地址路由
- catch-all 路由

> 即使配置了 catch-all，底座也只会接收**已经预先创建**的邮箱地址。

---

## 推荐接入方式

推荐采用：

### 唯一模式：预注册地址

由 Python 业务层先调用底座 API 注册一个邮箱地址，例如：

- `abc123@example.com`
- `order-001@example.com`

然后底座只接收这些已注册邮箱的来信。

**未预先创建的地址不会被接收，也不会自动生效。**

---

## 认证方式

内部 API 统一使用以下任意一种方式鉴权：

### 方式一：Bearer Token

```http
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### 方式二：自定义请求头

```http
X-Internal-Token: <INTERNAL_API_TOKEN>
```

---

## 响应格式

### 成功响应格式

```json
{
  "code": 200,
  "data": {
    "...": "..."
  }
}
```

### 错误响应格式

```json
{
  "code": 400,
  "message": "error message"
}
```

---

## API 文档

下面所有示例都假设：

- 服务地址：`http://localhost:8787`
- 内部 Token：`dev-internal-api-token`

你可以先设置 shell 变量：

```bash
BASE="http://localhost:8787"
TOKEN="dev-internal-api-token"
```

---

# 1. 公共接口

## 1.1 服务说明

### 请求

```http
GET /
```

### `curl`

```bash
curl "$BASE/"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "name": "mail capability base",
    "status": "ok",
    "routes": {
      "health": "/health",
      "internal_health": "/internal/health",
      "domains": "/internal/domains",
      "mailboxes": "/internal/mailboxes",
      "mailbox_emails": "/internal/mailboxes/:address/emails",
      "mailbox_latest": "/internal/mailboxes/:address/emails/latest",
      "email_detail": "/internal/emails/:id"
    }
  }
}
```

---

## 1.2 公开健康检查

### 请求

```http
GET /health
```

### `curl`

```bash
curl "$BASE/health"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "ok": true,
    "service": "mail capability base"
  }
}
```

---

# 2. 内部健康检查

## 2.1 查询内部状态

### 请求

```http
GET /internal/health
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl "$BASE/internal/health" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "ok": true,
    "service": "mail-base",
    "active_domains": 2,
    "active_mailboxes": 18,
    "total_emails": 356
  }
}
```

### 未授权响应示例

```json
{
  "code": 401,
  "message": "Unauthorized"
}
```

---

# 3. 域名管理

## 3.1 创建域名

### 请求

```http
POST /internal/domains
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
```

### 请求体示例

```json
{
  "domain": "example.com",
  "is_active": true,
  "catch_all": false
}
```

### `curl`

```bash
curl -X POST "$BASE/internal/domains" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "example.com",
    "is_active": true,
    "catch_all": false
  }'
```

### 成功响应示例

```json
{
  "code": 201,
  "data": {
    "item": {
      "id": 1,
      "domain": "example.com",
      "is_active": true,
      "catch_all": false,
      "created_at": 1735000000000,
      "updated_at": 1735000000000
    }
  }
}
```

### 参数错误响应示例

```json
{
  "code": 400,
  "message": "domain is required"
}
```

---

## 3.2 获取域名列表

### 请求

```http
GET /internal/domains
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### 可选查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `include_disabled` | `boolean` | 是否包含已禁用域名，默认 `false` |

### `curl`

```bash
curl "$BASE/internal/domains?include_disabled=true" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "items": [
      {
        "id": 1,
        "domain": "example.com",
        "is_active": true,
        "catch_all": false,
        "created_at": 1735000000000,
        "updated_at": 1735000000000
      },
      {
        "id": 2,
        "domain": "mail-demo.com",
        "is_active": false,
        "catch_all": false,
        "created_at": 1735000100000,
        "updated_at": 1735000200000
      }
    ]
  }
}
```

---

## 3.3 更新域名

### 请求

```http
PATCH /internal/domains/:domain
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
```

### 请求体示例

```json
{
  "is_active": false,
  "catch_all": false
}
```

### `curl`

```bash
curl -X PATCH "$BASE/internal/domains/example.com" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "is_active": false,
    "catch_all": false
  }'
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "item": {
      "id": 1,
      "domain": "example.com",
      "is_active": false,
      "catch_all": false,
      "created_at": 1735000000000,
      "updated_at": 1735000300000
    }
  }
}
```

### 不存在响应示例

```json
{
  "code": 404,
  "message": "domain not found"
}
```

---

## 3.4 删除域名

### 请求

```http
DELETE /internal/domains/:domain
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl -X DELETE "$BASE/internal/domains/example.com" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "ok": true
  }
}
```

### 不存在响应示例

```json
{
  "code": 404,
  "message": "domain not found"
}
```

---

# 4. 邮箱管理

## 4.1 创建邮箱

### 请求

```http
POST /internal/mailboxes
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
```

### 请求体说明

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `address` | 是 | `string` | 完整邮箱地址 |
| `expires_at` | 否 | `number \| string \| null` | 过期时间，支持毫秒时间戳或日期字符串 |
| `metadata` | 否 | `object` | 业务自定义元数据 |
| `metadata_json` | 否 | `object \| string` | 与 `metadata` 二选一 |

### 请求体示例

```json
{
  "address": "demo@example.com",
  "expires_at": 1735689600000,
  "metadata": {
    "source": "python-service",
    "user_id": 1001
  }
}
```

### `curl`

```bash
curl -X POST "$BASE/internal/mailboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "demo@example.com",
    "expires_at": 1735689600000,
    "metadata": {
      "source": "python-service",
      "user_id": 1001
    }
  }'
```

### 成功响应示例

```json
{
  "code": 201,
  "data": {
    "item": {
      "id": 1,
      "address": "demo@example.com",
      "local_part": "demo",
      "domain": "example.com",
      "is_active": true,
      "expires_at": 1735689600000,
      "metadata": {
        "source": "python-service",
        "user_id": 1001
      },
      "created_at": 1735001000000,
      "updated_at": 1735001000000
    }
  }
}
```

### 域名不存在或邮箱已存在响应示例

```json
{
  "code": 400,
  "message": "mailbox domain is not active or mailbox already exists"
}
```

### 地址错误响应示例

```json
{
  "code": 400,
  "message": "address must be a valid email address"
}
```

### 过期时间格式错误响应示例

```json
{
  "code": 400,
  "message": "expires_at must be a unix timestamp(ms) or valid datetime string"
}
```

---

## 4.2 获取邮箱列表

### 请求

```http
GET /internal/mailboxes
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### 可选查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | `number` | 页码，默认 `1` |
| `page_size` | `number` | 每页数量，默认 `20` |
| `domain` | `string` | 按域名过滤 |
| `include_expired` | `boolean` | 是否包含过期邮箱，默认 `false` |

### `curl`

```bash
curl "$BASE/internal/mailboxes?page=1&page_size=20&domain=example.com" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "page": 1,
    "pageSize": 20,
    "total": 2,
    "items": [
      {
        "id": 1,
        "address": "demo@example.com",
        "local_part": "demo",
        "domain": "example.com",
        "is_active": true,
        "expires_at": 1735689600000,
        "metadata": {
          "source": "python-service",
          "user_id": 1001
        },
        "created_at": 1735001000000,
        "updated_at": 1735001000000
      },
      {
        "id": 2,
        "address": "verify@example.com",
        "local_part": "verify",
        "domain": "example.com",
        "is_active": true,
        "expires_at": null,
        "metadata": {
          "source": "python-service"
        },
        "created_at": 1735001100000,
        "updated_at": 1735001100000
      }
    ]
  }
}
```

---

## 4.3 获取单个邮箱

### 请求

```http
GET /internal/mailboxes/:address
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl "$BASE/internal/mailboxes/demo@example.com" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "item": {
      "id": 1,
      "address": "demo@example.com",
      "local_part": "demo",
      "domain": "example.com",
      "is_active": true,
      "expires_at": 1735689600000,
      "metadata": {
        "source": "python-service",
        "user_id": 1001
      },
      "created_at": 1735001000000,
      "updated_at": 1735001000000
    }
  }
}
```

### 不存在响应示例

```json
{
  "code": 404,
  "message": "mailbox not found"
}
```

---

## 4.4 删除邮箱

### 请求

```http
DELETE /internal/mailboxes/:address
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl -X DELETE "$BASE/internal/mailboxes/demo@example.com" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "ok": true
  }
}
```

### 不存在响应示例

```json
{
  "code": 404,
  "message": "mailbox not found"
}
```

---

# 5. 邮件查询

## 5.1 获取某邮箱邮件列表

### 请求

```http
GET /internal/mailboxes/:address/emails
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### 可选查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | `number` | 页码，默认 `1` |
| `page_size` | `number` | 每页数量，默认 `20` |

### `curl`

```bash
curl "$BASE/internal/mailboxes/demo@example.com/emails?page=1&page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "page": 1,
    "pageSize": 20,
    "total": 2,
    "mailbox": {
      "id": 1,
      "address": "demo@example.com",
      "local_part": "demo",
      "domain": "example.com",
      "is_active": true,
      "expires_at": 1735689600000,
      "metadata": {
        "source": "python-service",
        "user_id": 1001
      },
      "created_at": 1735001000000,
      "updated_at": 1735001000000
    },
    "items": [
      {
        "id": 11,
        "message_id": "<message-001@example.net>::demo@example.com",
        "mailbox_address": "demo@example.com",
        "domain": "example.com",
        "from_address": "noreply@example.net",
        "to_address": "demo@example.com",
        "subject": "Your verification code",
        "text_body": "Your code is 123456",
        "html_body": "<p>Your code is <b>123456</b></p>",
        "headers": {
          "message-id": "<message-001@example.net>",
          "from": "noreply@example.net",
          "to": "demo@example.com"
        },
        "raw_size": 2048,
        "received_at": 1735002000000
      },
      {
        "id": 10,
        "message_id": "<message-000@example.net>::demo@example.com",
        "mailbox_address": "demo@example.com",
        "domain": "example.com",
        "from_address": "alert@example.net",
        "to_address": "demo@example.com",
        "subject": "Welcome",
        "text_body": "welcome",
        "html_body": "",
        "headers": {
          "message-id": "<message-000@example.net>"
        },
        "raw_size": 1024,
        "received_at": 1735001900000
      }
    ]
  }
}
```

### 邮箱不存在响应示例

```json
{
  "code": 404,
  "message": "mailbox not found"
}
```

---

## 5.2 获取某邮箱最新邮件

### 请求

```http
GET /internal/mailboxes/:address/emails/latest
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl "$BASE/internal/mailboxes/demo@example.com/emails/latest" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "item": {
      "id": 11,
      "message_id": "<message-001@example.net>::demo@example.com",
      "mailbox_address": "demo@example.com",
      "domain": "example.com",
      "from_address": "noreply@example.net",
      "to_address": "demo@example.com",
      "subject": "Your verification code",
      "text_body": "Your code is 123456",
      "html_body": "<p>Your code is <b>123456</b></p>",
      "headers": {
        "message-id": "<message-001@example.net>",
        "from": "noreply@example.net",
        "to": "demo@example.com"
      },
      "raw_size": 2048,
      "received_at": 1735002000000
    }
  }
}
```

### 没有邮件响应示例

```json
{
  "code": 404,
  "message": "message not found"
}
```

---

## 5.3 获取单封邮件详情

### 请求

```http
GET /internal/emails/:id
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl "$BASE/internal/emails/11" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "item": {
      "id": 11,
      "message_id": "<message-001@example.net>::demo@example.com",
      "mailbox_address": "demo@example.com",
      "domain": "example.com",
      "from_address": "noreply@example.net",
      "to_address": "demo@example.com",
      "subject": "Your verification code",
      "text_body": "Your code is 123456",
      "html_body": "<p>Your code is <b>123456</b></p>",
      "headers": {
        "message-id": "<message-001@example.net>",
        "from": "noreply@example.net",
        "to": "demo@example.com",
        "x-mail-base-attachments": []
      },
      "raw_size": 2048,
      "received_at": 1735002000000
    }
  }
}
```

### 不存在响应示例

```json
{
  "code": 404,
  "message": "message not found"
}
```

---

## 5.4 兼容接口：按地址获取最新邮件

这是一个兼容接口，便于旧调用方式继续使用。

### 请求

```http
GET /api/emails/latest?address=<email>
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### `curl`

```bash
curl "$BASE/api/emails/latest?address=demo@example.com" \
  -H "Authorization: Bearer $TOKEN"
```

### 成功响应示例

```json
{
  "code": 200,
  "data": {
    "item": {
      "id": 11,
      "message_id": "<message-001@example.net>::demo@example.com",
      "mailbox_address": "demo@example.com",
      "domain": "example.com",
      "from_address": "noreply@example.net",
      "to_address": "demo@example.com",
      "subject": "Your verification code",
      "text_body": "Your code is 123456",
      "html_body": "<p>Your code is <b>123456</b></p>",
      "headers": {
        "message-id": "<message-001@example.net>",
        "from": "noreply@example.net",
        "to": "demo@example.com"
      },
      "raw_size": 2048,
      "received_at": 1735002000000
    }
  }
}
```

---

# 6. 典型接入流程

## 步骤 1：创建域名

```bash
curl -X POST "$BASE/internal/domains" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "example.com",
    "is_active": true,
    "catch_all": false
  }'
```

## 步骤 2：创建邮箱

```bash
curl -X POST "$BASE/internal/mailboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "demo@example.com",
    "expires_at": 1735689600000,
    "metadata": {
      "source": "python-service"
    }
  }'
```

## 步骤 3：外部向该邮箱发邮件

发件人发送到：

```text
demo@example.com
```

## 步骤 4：查询最新邮件

```bash
curl "$BASE/internal/mailboxes/demo@example.com/emails/latest" \
  -H "Authorization: Bearer $TOKEN"
```

---

# 7. Python 对接建议

推荐你的 Python 服务这样接入：

### 1. 创建业务邮箱
Python 根据业务逻辑生成地址，例如：

- 用户注册时生成临时邮箱
- 某任务生成一次性邮箱
- 某订单绑定专用邮箱

然后调用底座 API 注册：

```text
POST /internal/mailboxes
```

### 2. 使用该邮箱接收邮件
用户或外部系统往该地址发信。

注意：**只有已经通过底座 API 创建过的邮箱地址才会被接收。**

### 3. 轮询或同步查询
Python 定时调用：

```text
GET /internal/mailboxes/:address/emails/latest
```

或者：

```text
GET /internal/mailboxes/:address/emails
```

### 4. 在 Python 中执行业务逻辑
例如：

- 提取验证码
- 同步到你的主业务数据库
- 告知前端新邮件到达
- 做状态流转

---

## 清理策略建议

建议底座默认执行两类清理：

### 1. 邮箱清理
删除已过期的邮箱地址。

### 2. 邮件清理
删除超出保留时长的邮件。

### 推荐策略
- 一次性验证码邮箱：保留 30 分钟到 24 小时
- 邮件正文：保留 24 到 72 小时
- 长期业务邮箱：由 Python 业务层控制是否续期

---

## 本地测试

你可以使用示例邮件文件测试 Worker 的邮件处理能力。

### 先创建测试域名

```bash
curl -X POST "$BASE/internal/domains" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "example.com",
    "is_active": true,
    "catch_all": false
  }'
```

### 再创建测试邮箱

```bash
curl -X POST "$BASE/internal/mailboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "demo@example.com",
    "metadata": {
      "source": "local-test"
    }
  }'
```

### 发送测试邮件

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=sender@example.com&to=demo@example.com" \
  --data-binary @./test/sample.eml
```

### 查询最新邮件

```bash
curl "$BASE/internal/mailboxes/demo@example.com/emails/latest" \
  -H "Authorization: Bearer $TOKEN"
```

如果你已经预先注册了 `demo@example.com`，则邮件应被底座正常接收并入库。

---

## 目录结构

```text
maildizuo/
├── migrations/           # D1 数据库迁移
├── src/
│   ├── core/             # 核心能力：认证、数据库、邮件处理
│   ├── handlers/         # 内部 API 路由处理
│   ├── utils/            # 工具函数与常量
│   └── index.js          # Worker 入口
├── test/                 # 测试样例邮件
├── .dev.vars.example     # 本地开发变量示例
├── package.json
├── README.md
└── wrangler.toml
```

---

## 后续扩展建议

如果你后续需要更强的能力，可以继续往底座增加：

- webhook 事件通知
- 邮件原始 MIME 下载
- 附件索引与下载
- 域名自动校验
- 邮件接收审计日志
- 死信 / 异常邮件队列
- 更细粒度的内部服务鉴权

但仍然建议把下面这些能力留在 Python：

- 业务提取规则
- 账号系统
- 面向前端的产品 API
- 收件箱 UI
- 用户权限与配额
- 风控策略

---

## 许可证

MIT