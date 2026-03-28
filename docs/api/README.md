# AIClient-2-API — API 概览

AIClient-2-API 将仅客户端可用的 AI 模型统一暴露为 OpenAI 兼容接口，并在 OpenAI、Claude、Gemini、Grok、Codex 等多种协议之间做双向转换。

## 支持的 API 端点

### AI 推理端点

| 方法 | 路径 | 协议 | 说明 |
|------|------|------|------|
| POST | `/v1/chat/completions` | OpenAI | 聊天补全（流式 / 非流式） |
| POST | `/v1/responses` | OpenAI Responses | 结构化响应（HTTP + WebSocket） |
| POST | `/v1/messages` | Anthropic Claude | 消息生成 |
| POST | `/v1beta/models/{model}:generateContent` | Google Gemini | 内容生成（非流式） |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Google Gemini | 内容生成（流式） |

### 模型列表端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | OpenAI 格式模型列表 |
| GET | `/v1beta/models` | Gemini 格式模型列表 |

### 系统端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/health` | 不需要 | 服务健康检查 |
| GET | `/provider_health` | 不需要 | 提供商池健康状态 |
| POST | `/v1/count_tokens` | 需要 | Token 计数 |

## 认证方式

### 推理接口

支持三种传递方式：

```
Authorization: Bearer <your-api-key>
x-goog-api-key: <your-api-key>
GET /v1/models?key=<your-api-key>
```

### 指定提供商

```
Model-Provider: gemini-cli-oauth                    # HTTP Header
POST /gemini-cli-oauth/v1/chat/completions          # URL 路径前缀
POST /auto/v1/chat/completions                      # 自动路由
```

### 管理端 API

通过 `/api/login` 登录获取 Bearer Token，后续请求携带该 Token。

## 请求 / 响应格式

### OpenAI Chat Completions（最常用）

```json
{
  "model": "gemini-2.5-pro",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2048
}
```

### 流式响应（SSE）

设置 `"stream": true`，响应格式：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

## 支持的提供商

| 提供商标识 | 协议前缀 | 说明 |
|-----------|---------|------|
| `gemini-cli-oauth` | `gemini` | Google Gemini CLI（OAuth） |
| `gemini-antigravity` | `gemini` | Gemini Antigravity |
| `claude-custom` | `claude` | Anthropic Claude（直连） |
| `claude-kiro-oauth` | `claude` | AWS Kiro（OAuth） |
| `openai-custom` | `openai` | OpenAI（直连） |
| `openai-codex-oauth` | `codex` | GitHub Copilot Codex（OAuth） |
| `cursor-oauth` | `openai` | Cursor（OAuth） |
| `grok-custom` | `grok` | xAI Grok（直连） |
| `forward-api` | `forward` | 通用 API 转发 |
| `auto` | — | 自动路由（号池模式） |

完整端点详情见 [endpoints.md](endpoints.md)。
