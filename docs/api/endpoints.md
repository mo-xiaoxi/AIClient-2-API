# AIClient-2-API — 端点详情

## AI 推理端点

### POST /v1/chat/completions

OpenAI 兼容的聊天补全接口。

**请求头**

| 名称 | 必填 | 说明 |
|------|------|------|
| `Authorization` | 是 | `Bearer <api-key>` |
| `Content-Type` | 是 | `application/json` |
| `Model-Provider` | 否 | 指定目标提供商 |

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `messages` | array | 是 | 对话消息数组 |
| `stream` | boolean | 否 | 是否流式，默认 `false` |
| `temperature` | number | 否 | 采样温度，0.0-2.0 |
| `max_tokens` | integer | 否 | 最大输出 Token 数 |
| `top_p` | number | 否 | nucleus sampling |
| `stop` | string/array | 否 | 停止序列 |

**示例**

```bash
# 非流式
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "Hello"}]}'

# 流式
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'

# 指定提供商（URL 路径前缀）
curl -X POST http://localhost:3000/gemini-cli-oauth/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "Hello"}]}'
```

---

### POST /v1/messages

Anthropic Messages API 兼容接口。

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello!"}]}'
```

---

### POST /v1/responses

OpenAI Responses API 兼容接口（含 WebSocket 支持）。

---

### POST /v1beta/models/{model}:generateContent

Google Gemini 原生格式。

```bash
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: 123456" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"role": "user", "parts": [{"text": "Hello"}]}]}'
```

---

## 模型列表端点

### GET /v1/models

```bash
curl http://localhost:3000/v1/models -H "Authorization: Bearer 123456"
```

### GET /v1beta/models

```bash
curl "http://localhost:3000/v1beta/models?key=123456"
```

---

## 系统端点

### GET /health

```bash
curl http://localhost:3000/health
```

### GET /provider_health

```bash
curl "http://localhost:3000/provider_health?provider=gemini-cli-oauth&unhealthRatioThreshold=0.05"
```

### POST /v1/count_tokens

```bash
curl -X POST http://localhost:3000/v1/count_tokens \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "Hello"}]}'
```

---

## 管理端 API

所有管理端 API 需通过 `/api/login` 登录后携带 Bearer Token 访问。

### 认证

```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"password": "admin123"}'
```

### 配置管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 获取当前配置 |
| POST | `/api/config` | 更新配置 |
| POST | `/api/reload-config` | 热重载配置 |
| POST | `/api/admin-password` | 修改管理员密码 |

### 提供商管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 所有提供商概览 |
| GET | `/api/providers/supported` | 已注册类型列表 |
| GET | `/api/providers/{type}` | 指定类型详情 |
| POST | `/api/providers` | 新增提供商 |
| PUT | `/api/providers/{type}/{uuid}` | 更新提供商 |
| DELETE | `/api/providers/{type}/{uuid}` | 删除提供商 |
| POST | `/api/providers/{type}/{uuid}/disable` | 禁用 |
| POST | `/api/providers/{type}/{uuid}/enable` | 启用 |
| POST | `/api/providers/{type}/health-check` | 触发健康检查 |
| POST | `/api/providers/{type}/reset-health` | 重置健康状态 |

### OAuth 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/providers/{type}/generate-auth-url` | 生成 OAuth 授权 URL |
| POST | `/api/oauth/manual-callback` | 手动 OAuth 回调 |
| POST | `/api/upload-oauth-credentials` | 上传 OAuth 凭据 |
| POST | `/api/gemini/batch-import-tokens` | 批量导入 Gemini Token（SSE） |
| POST | `/api/kiro/batch-import-tokens` | 批量导入 Kiro Token（SSE） |
| POST | `/api/codex/batch-import-tokens` | 批量导入 Codex Token（SSE） |
| POST | `/api/cursor/batch-import-tokens` | 批量导入 Cursor Token（SSE） |

### 用量统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/usage` | 所有提供商用量 |
| GET | `/api/usage/{type}` | 指定提供商用量 |

### 系统管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system` | 系统信息 |
| POST | `/api/restart-service` | 重启 Worker |
| GET | `/api/system/download-log` | 下载日志 |
| GET | `/api/check-update` | 检查新版本 |
| POST | `/api/update` | 执行更新 |

### 实时事件（SSE）

```bash
curl http://localhost:3000/api/events -H "Accept: text/event-stream"
```

## 错误格式

```json
{
  "error": {
    "message": "错误描述",
    "code": "ERROR_CODE"
  }
}
```

| 状态码 | 含义 |
|--------|------|
| 400 | 请求参数错误 / 提供商不可用 |
| 401 | API Key 无效或缺失 |
| 404 | 路由不存在 |
| 500 | 服务器内部错误 |
