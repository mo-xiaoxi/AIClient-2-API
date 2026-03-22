---
feature: cursor-provider
stage: design
generated_at: 2026-03-21T00:00:00Z
version: 1
---

# 技术设计文档: Cursor Provider 集成

> **功能标识**: cursor-provider
> **复杂度**: complex
> **依赖**: @bufbuild/protobuf, node:http2, node:crypto

## 1. 系统架构

### 1.1 整体架构图

```
客户端 (OpenAI 兼容 API)
    │
    ▼
AIClient-2-API 统一网关
    │
    ├── 请求路由层（server.js / routes）
    │       ↓ OpenAI 格式请求
    ├── 协议转换层（CursorConverter — 不需要，见 1.2）
    │       ↓ 原始 OpenAI 格式（直接透传）
    ├── Cursor Provider 层
    │   ├── cursor-core.js        ← 主入口，实现 ApiServiceAdapter 接口
    │   ├── cursor-protobuf.js    ← Protobuf 编解码（移植自 cursor-auth）
    │   ├── cursor-h2.js          ← HTTP/2 Connect 协议传输
    │   └── cursor-session.js     ← 会话状态管理（tool_calls 续话）
    │       ↓ HTTP/2 + Connect Protocol + Protobuf
    ├── 认证层
    │   ├── cursor-oauth.js       ← PKCE OAuth 流程（新增到 src/auth/）
    │   └── cursor-token-store.js ← Token 存储与自动刷新
    │       ↓ Bearer token
    └── Cursor API (api2.cursor.sh)
            ├── POST /agent.v1.AgentService/Run
            └── POST /agent.v1.AgentService/GetUsableModels
```

### 1.2 协议设计决策：无需 CursorConverter

现有架构中，Converter 用于在不同协议格式之间转换（OpenAI ↔ Gemini ↔ Claude）。

Cursor Provider 的特殊性：
- **输入**：OpenAI Chat Completions 格式（来自客户端，已是最终格式）
- **输出**：OpenAI Chat Completions 格式（透传给客户端）
- **内部**：`cursor-core.js` 自己直接处理 OpenAI → Protobuf → OpenAI 转换

因此**不需要创建 CursorConverter**，协议转换内联在 `cursor-core.js` 中，这与 `grok-core.js` 的设计一致（Grok 也没有独立 Converter）。

`getProtocolPrefix('cursor-oauth')` 返回 `'cursor'`，与 `openai` 不同，但 `cursor-core.js` 直接消费 OpenAI 格式并输出 OpenAI 格式，所以在 `handleContentGenerationRequest` 中的转换逻辑：
```
getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)
→ 'openai' !== 'cursor' → true → 尝试 convertData(...)
```

为避免触发转换，需要在 `common.js` 中将 `cursor` 的协议前缀注册为 `openai`：

```js
// src/utils/common.js - getProtocolPrefix 特殊处理
if (provider === 'cursor-oauth') return 'openai';
```

这样 `getProtocolPrefix('cursor-oauth') === 'openai'` === `getProtocolPrefix('openai-custom')`，不触发任何转换。

### 1.3 模型 Provider 注册名

```
MODEL_PROVIDER.CURSOR_OAUTH = 'cursor-oauth'
MODEL_PROTOCOL_PREFIX.CURSOR = 'cursor'   // 仅用于日志，实际前缀对齐 openai
```

---

## 2. 组件设计

### 2.1 `src/providers/cursor/cursor-core.js`

主服务类，实现 `ApiServiceAdapter` 接口。

```js
export class CursorApiService {
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid;
        // Token 存储（包含 access_token, refresh_token, expires_at）
        this.credFilePath = config.CURSOR_OAUTH_CREDS_FILE_PATH;
        // 懒加载 token store
        this._tokenStore = null;
        this.isInitialized = false;
    }

    // 初始化：从文件加载 token
    async initialize() { ... }

    // 实现 ApiServiceAdapter.generateContent（非流式）
    async generateContent(model, requestBody) { ... }

    // 实现 ApiServiceAdapter.generateContentStream（流式）
    async *generateContentStream(model, requestBody) { ... }

    // 实现 ApiServiceAdapter.listModels
    async listModels() { ... }

    // 实现 ApiServiceAdapter.refreshToken（近期过期时刷新）
    async refreshToken() { ... }

    // 实现 ApiServiceAdapter.forceRefreshToken
    async forceRefreshToken() { ... }

    // 实现 ApiServiceAdapter.isExpiryDateNear
    isExpiryDateNear() { ... }

    // 内部：获取有效 access token（含自动刷新）
    async _getValidAccessToken() { ... }

    // 内部：解析 OpenAI 消息 → Cursor Protobuf
    _buildCursorRequest(model, requestBody) { ... }

    // 内部：执行单次 HTTP/2 RPC 调用
    async _doH2Request(requestBytes, accessToken) { ... }

    // 内部：流式执行 HTTP/2 RPC
    _doH2Stream(requestBytes, accessToken) { ... }
}
```

**generateContent 实现思路（非流式）**：

```
1. 调用 _getValidAccessToken()
2. 检测 tool results（消息中有 role='tool'）→ 走续话路径
3. 否则，解析 messages → buildCursorRequest → 编码为 Protobuf binary
4. 发起 HTTP/2 Connect 请求（frameConnectMessage 封帧）
5. 发送心跳帧（5 秒间隔）
6. 读取响应帧，解码 AgentServerMessage
7. 收集所有文本 delta（thinking + 普通文本混合拼接，与源码一致）
8. 注意：非流式模式下 tool_calls 不被支持（源码中 onMcpExec 为空函数），遇到 mcpArgs 静默跳过
9. 流结束后拼装为 OpenAI Chat Completion 格式返回
```

**generateContentStream 实现思路（流式）**：

```
1. 调用 _getValidAccessToken()
2. 检测 tool results → 走续话路径
3. 解析 messages → buildCursorRequest
4. 发起 HTTP/2 Connect 请求
5. 每收到 AgentServerMessage：
   - textDelta → yield SSE chunk { delta: { content: text } }
   - thinkingDelta → 使用 <think>/</ think> 标签包裹：
     - 首次 thinking → yield { delta: { content: '<think>' } }，设 state.thinkingActive=true
     - 后续 thinking → yield { delta: { content: text } }
     - 切回 text → yield { delta: { content: '</think>' } }，设 state.thinkingActive=false
   - mcpExec → yield SSE chunk { delta: { tool_calls: [...] } }，保存 session
6. stream end：
   - 如果 state.thinkingActive → yield { delta: { content: '</think>' } }（确保标签闭合）
   - yield finish chunk { delta: {}, finish_reason: 'stop'/'tool_calls' }
```

### 2.2 `src/providers/cursor/cursor-protobuf.js`

Protobuf 编解码，移植自 cursor-auth `lib/cursor-fetch.ts`。

**关键决策（审查后修正）**：`agent_pb.ts` 使用的是 `@bufbuild/protobuf/codegenv2` 的编译时生成 API（`fileDesc`/`messageDesc`），**这些调用天然 JS 兼容**（内部是二进制编码的 proto descriptor 字符串）。

**移植方案**：直接复制 `agent_pb.ts` → `agent_pb.js`，去除 TypeScript 类型注解：
1. 去掉 `import type { ... }` 语句
2. 去掉 `GenMessage<X>`、`GenEnum<X>` 等类型参数
3. 去掉 `export type` 和 `export interface` 声明
4. 保留所有 `fileDesc`、`messageDesc`、`enumDesc` 运行时调用和 Schema 导出
5. 额外注意：`cursor-fetch.ts` 还使用了 `ValueSchema` from `@bufbuild/protobuf/wkt`（用于 MCP tool inputSchema），需要在 `cursor-protobuf.js` 中 import

由于项目为纯 JS（`"type": "module"`），最简方案是：
1. 安装 `@bufbuild/protobuf` 到项目依赖
2. 将 cursor-auth 的 `proto/agent_pb.ts` 内的所有 Schema 导出，用 JSDoc 注释类型，以 `.js` 方式输出

具体实现：将 `agent_pb.ts` 的关键类型和 Schema 以手动方式转为 `agent_pb.js`（纯 ES Module），因为原始文件只使用 `@bufbuild/protobuf` 的 `create`、`toBinary`、`fromBinary` 等运行时函数，不依赖 TypeScript 类型系统运行。

**核心函数导出**：

```js
// cursor-protobuf.js 对外暴露的 API
export function buildCursorAgentRequest(options) {
    // { modelId, systemPrompt, userText, images, turns, tools }
    // 返回 { requestBytes: Uint8Array, blobStore: Map }
}

export function processAgentServerMessage(msgBytes, callbacks) {
    // callbacks: { onText, onThinking, onMcpExec, onKvGet, onKvSet, onExecResult }
    // 返回需要发回给 server 的帧（KV/Exec responses）
}

export function buildHeartbeatBytes() {
    // 构建: create(AgentClientMessageSchema, { message: { case: 'heartbeat', value: create(ClientHeartbeatSchema, {}) } })
    // 返回 frameConnectMessage(toBinary(...))
}

export function buildKvResponse(kvMessage, blobStore) { ... }
export function buildExecResponse(execMessage, mcpTools) { ... }
export function buildMcpToolDefinitions(tools) { ... }
export function buildToolResultMessage(pendingExecs, toolResults) { ... }

// Connect Protocol 帧编解码
export function frameConnectMessage(data, flags) { ... }
export function parseConnectFrame(buffer) { ... }
export const CONNECT_END_STREAM_FLAG = 0x02;
```

### 2.3 `src/providers/cursor/cursor-h2.js`

HTTP/2 连接管理。

```js
// 单次非流式 RPC 调用
export function h2RequestUnary(options) {
    // { url, path, headers, bodyBytes }
    // 返回 Promise<Uint8Array> 响应字节
}

// 流式 RPC 调用，返回 AsyncIterable<Buffer>
export function h2RequestStream(options) {
    // { url, path, headers, bodyBytes, onHeartbeat }
    // 返回 { stream, send(data), close() }
}

// 创建标准 Cursor HTTP/2 请求头
export function buildCursorH2Headers(accessToken, path) {
    return {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        'te': 'trailers',
        'authorization': `Bearer ${accessToken}`,
        'x-ghost-mode': 'true',
        'x-cursor-client-version': 'cli-2026.02.13-41ac335',
        'x-cursor-client-type': 'cli',
        'x-request-id': crypto.randomUUID(),
    };
}
```

### 2.4 `src/providers/cursor/cursor-session.js`

管理 tool_calls 续话 session（保持 H2 长连接直到工具结果返回）。

```js
// Session 结构
// {
//   h2Client, h2Stream, heartbeatTimer,
//   blobStore: Map<string, Uint8Array>,
//   mcpTools: McpToolDefinition[],
//   pendingExecs: Array<{ execId, execMsgId, toolCallId, toolName, decodedArgs }>
// }

const activeSessions = new Map(); // sessionKey → Session

export function deriveSessionKey(model, messages) { ... }
export function saveSession(key, session) { ... }
export function getSession(key) { ... }
export function removeSession(key) { ... }
export function cleanupSession(session) { ... }
```

### 2.5 `src/auth/cursor-oauth.js`

PKCE OAuth 流程，参考 `kiro-oauth.js` 模式（广播 `oauth_success` 事件、自动关联）。

**关键差异（Cursor vs Kiro）**：
- Cursor 使用 `cursor.com/loginDeepControl` 直接重定向（无本地 callback server），轮询模式
- Token 格式：`{ access_token, refresh_token, expires_at }`（与 cursor-auth 的 `CursorTokens` 对齐）
- 刷新端点：`POST /auth/exchange_user_api_key`（Authorization: Bearer {refresh_token}）

```js
// 公开 API
export async function handleCursorOAuth(currentConfig, options = {}) {
    // 1. 生成 PKCE { verifier, challenge, uuid, loginUrl }
    // 2. 广播 oauth_start 事件（含 loginUrl）
    // 3. 开始后台轮询
    // 4. 返回 { authUrl: loginUrl, authInfo: { ... } }
}

export async function pollCursorAuth(uuid, verifier, options = {}) {
    // 后台轮询 https://api2.cursor.sh/auth/poll?uuid=...&verifier=...
    // 成功后保存 token 文件，广播 oauth_success，自动关联 Pools
}

export async function refreshCursorToken(refreshToken) {
    // POST https://api2.cursor.sh/auth/exchange_user_api_key
    // Authorization: Bearer {refreshToken}
    // 返回 { access_token, refresh_token, expires_at }
}

export function generateCursorAuthParams() {
    // 生成 PKCE 参数，返回 { verifier, challenge, uuid, loginUrl }
}
```

**Token 文件格式**（`configs/cursor/{timestamp}_cursor-auth-token/{timestamp}_cursor-auth-token.json`）：

```json
{
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1748000000000
}
```

### 2.6 `src/providers/cursor/cursor-token-store.js`

Token 内存缓存 + 文件持久化 + 自动刷新（并发去重）。

```js
export class CursorTokenStore {
    constructor(credFilePath) {
        this.credFilePath = credFilePath;
        this._cached = null;          // { access_token, refresh_token, expires_at }
        this._refreshPromise = null;  // 并发去重
    }

    async initialize() {
        // 从 credFilePath 加载 JSON，设置 _cached
    }

    async getValidAccessToken() {
        // 1. 如有缓存且未过期 → 直接返回
        // 2. 过期 → 去重刷新 → 返回新 token
    }

    async saveTokens(tokens) { ... }
    async clearTokens() { ... }
    isExpiryDateNear(nearMinutes = 5) { ... }
    hasValidToken() { ... }

    async _doRefresh() {
        // 调用 cursor-oauth.js:refreshCursorToken
        // 保存新 token 到文件
    }
}
```

---

## 3. 数据流设计

### 3.1 非流式请求流程

```
POST /v1/chat/completions (stream=false)
    │
    ▼ handleContentGenerationRequest
    │ fromProvider='openai', toProvider='cursor-oauth'
    │ getProtocolPrefix('cursor-oauth') === 'openai' → 不转换
    ▼
CursorApiServiceAdapter.generateContent(model, requestBody)
    │
    ▼ CursorApiService.generateContent(model, requestBody)
    │
    ├── _getValidAccessToken()     // 检查/刷新 token
    ├── parseMessages(requestBody.messages)
    │   → { systemPrompt, userText, images, turns, toolResults }
    │
    ├── [if toolResults.length > 0]
    │   └── resumeWithToolResults(session, toolResults, model)
    │       └── 返回 OpenAI response (non-streaming)
    │
    └── buildCursorRequest(model, ...)
        → { requestBytes: Uint8Array, blobStore, mcpTools }
        ▼
        h2RequestUnary(headers, frameConnectMessage(requestBytes))
        ▼
        (收到响应) → 解码所有 AgentServerMessage 帧
        ▼
        拼装 OpenAI Chat Completion 格式
        → { id, object, created, model, choices: [...], usage: {...} }
```

### 3.2 流式请求流程

```
POST /v1/chat/completions (stream=true)
    │
    ▼ handleStreamRequest → CursorApiService.generateContentStream*(model, requestBody)
    │
    ├── 建立 H2 stream
    ├── 发送心跳定时器（5s）
    ├── for await (frame) from H2 stream:
    │   ├── flags == CONNECT_END_STREAM_FLAG → 解析错误/结束
    │   └── 其他 → fromBinary(AgentServerMessageSchema, frame)
    │       ├── textDelta → yield { delta: { content: text } }
    │       ├── thinkingDelta → yield { delta: { content: '<think>...</think>' } }
    │       ├── kvServerMessage → 发回 KV 响应帧（同步写入 H2）
    │       ├── execServerMessage:
    │       │   ├── requestContextArgs → 发回 context（工具列表）
    │       │   ├── mcpArgs → yield { delta: { tool_calls: [...] } }
    │       │   │              保存 session（含 H2 连接）
    │       │   │              yield { finish_reason: 'tool_calls' }
    │       │   │              return（暂停流，等待工具结果）
    │       │   └── 其他 exec → 发回 rejected 响应
    │       └── 其他 → 忽略
    ├── H2 end → yield { finish_reason: 'stop' }
    └── 清理心跳定时器
```

### 3.3 Tool Calls 续话流程

```
第一轮：模型返回 tool_calls
    ← finish_reason: 'tool_calls'
    ← delta.tool_calls: [{id, type, function: {name, arguments}}]

    Session 保存：{ h2Client, h2Stream, heartbeatTimer, pendingExecs }
    （H2 连接保持不关闭）

客户端发回 tool results（role='tool' 消息）

第二轮：generateContentStream*(model, requestBody)
    ├── parseMessages → 检测到 toolResults
    ├── getSession(sessionKey) → 复用已有 H2 连接
    ├── 向 H2 发送 mcpResult 帧（每个 pendingExec 对应一个）
    └── 继续读取响应流 → yield text/thinking deltas
        → 最终 yield finish_reason: 'stop'
```

---

## 4. 接口设计

### 4.1 `CursorApiService` 接口（完整）

| 方法 | 签名 | 说明 |
|------|------|------|
| `initialize` | `async ()` | 加载 token 文件 |
| `generateContent` | `async (model, body) → OpenAIChatCompletion` | 非流式 |
| `generateContentStream` | `async* (model, body) → AsyncIterable<chunk>` | 流式 |
| `listModels` | `async () → OpenAIModelList` | 模型列表 |
| `refreshToken` | `async ()` | 近期过期时刷新 |
| `forceRefreshToken` | `async ()` | 强制刷新 |
| `isExpiryDateNear` | `() → boolean` | 判断是否临近过期（5min 内） |
| `getUsageLimits` | `async () → {}` | 返回空（Cursor 无配额 API） |

### 4.2 OAuth API（`cursor-oauth.js`）

| 函数 | 说明 |
|------|------|
| `handleCursorOAuth(config, options)` | 发起 PKCE 登录，返回 loginUrl |
| `pollCursorAuth(uuid, verifier, opts)` | 后台轮询（内部调用） |
| `refreshCursorToken(refreshToken)` | 刷新 access token |
| `generateCursorAuthParams()` | 生成 PKCE 参数 |

### 4.3 Web UI OAuth 端点

现有 `oauth-handlers.js` 中添加 Cursor 的处理：

| HTTP 方法 | 路径 | 说明 |
|-----------|------|------|
| `POST` | `/api/oauth/cursor/start` | 发起 PKCE 登录，返回 loginUrl |
| `POST` | `/api/oauth/cursor/logout` | 登出（删除 token 文件） |
| `GET` | `/api/oauth/cursor/status` | 查询 token 状态（是否有效/过期时间）|

---

## 5. 文件存储设计

### 5.1 Token 文件路径

遵循项目现有规范（与 Kiro/Gemini/Qwen 一致）：

```
configs/cursor/{timestamp}_cursor-auth-token/
    {timestamp}_cursor-auth-token.json
```

**文件内容**：

```json
{
    "access_token": "<JWT>",
    "refresh_token": "<refresh_token>",
    "expires_at": 1748000000000
}
```

### 5.2 Provider Pool 配置

在 `provider_pools.json` 中的示例条目：

```json
{
    "cursor-oauth": [
        {
            "CURSOR_OAUTH_CREDS_FILE_PATH": "configs/cursor/1748000000000_cursor-auth-token/1748000000000_cursor-auth-token.json",
            "uuid": "xxx",
            "checkModelName": "claude-3.5-sonnet",
            "checkHealth": false,
            "isHealthy": true,
            "isDisabled": false,
            "lastUsed": null,
            "usageCount": 0,
            "errorCount": 0
        }
    ]
}
```

---

## 6. 集成点清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/utils/common.js` | 修改 | 新增 `MODEL_PROVIDER.CURSOR_OAUTH = 'cursor-oauth'`；`getProtocolPrefix` 中将 `cursor-oauth` 映射为 `openai` |
| `src/utils/provider-utils.js` | 修改 | `PROVIDER_MAPPINGS` 新增 cursor 条目 |
| `src/providers/adapter.js` | 修改 | 新增 `CursorApiServiceAdapter`，`registerAdapter(MODEL_PROVIDER.CURSOR_OAUTH, CursorApiServiceAdapter)` |
| `src/providers/provider-models.js` | 修改 | `PROVIDER_MODELS['cursor-oauth']` 硬编码回退模型列表 |
| `src/auth/cursor-oauth.js` | 新增 | PKCE OAuth 全流程 |
| `src/providers/cursor/cursor-core.js` | 新增 | 主服务实现 |
| `src/providers/cursor/cursor-protobuf.js` | 新增 | Protobuf 编解码 |
| `src/providers/cursor/cursor-h2.js` | 新增 | HTTP/2 传输 |
| `src/providers/cursor/cursor-session.js` | 新增 | Session 管理 |
| `src/providers/cursor/cursor-token-store.js` | 新增 | Token 管理 |
| `src/providers/cursor/proto/agent_pb.js` | 新增 | Proto Schema（从 cursor-auth 移植） |
| `src/auth/oauth-handlers.js` | 修改 | 新增 Cursor OAuth 路由处理 |
| `static/app/provider-manager.js` | 修改 | 新增 Cursor Provider UI 支持 |
| `static/components/section-config.html` | 修改 | Cursor 登录/登出按钮和状态显示 |
| `package.json` | 修改 | 新增 `@bufbuild/protobuf` 依赖 |

---

## 7. 安全设计

### 7.1 Token 存储安全

- Token 文件保存在项目 `configs/cursor/` 目录，不提交到 git（`.gitignore` 已包含 `configs/`）
- `access_token` 是 JWT，过期时自动刷新，不需要用户再次登录

### 7.2 Cursor 请求头安全

- 必须发送 `x-ghost-mode: true`（与 cursor-auth 保持一致，避免 Cursor 账号被检测）
- `x-cursor-client-version` 需要保持与真实 Cursor CLI 版本一致（当前：`cli-2026.02.13-41ac335`）

### 7.3 Tool Calls Session 安全

- Session key 由 `SHA256(model + firstUserMessage[:200])` 生成
- Session 超时（无新请求 120 秒）自动清理，避免 H2 连接泄漏（Claude Code tool 执行可能较慢，30 秒不够）

---

## 8. 错误处理

### 8.1 认证错误

| 场景 | 处理 |
|------|------|
| Token 文件不存在 | 抛出 401，提示用户通过 UI 登录 |
| access_token 过期 | 自动刷新，重试请求（最多 1 次） |
| refresh_token 过期 | 清除 token，抛出 401，提示重新登录 |
| 刷新失败（网络） | 重试 3 次，仍失败则清除 token |

### 8.2 协议错误

| 场景 | 处理 |
|------|------|
| Connect End Stream（flags=0x02）带 error JSON | 解析错误，作为 API 错误返回 |
| Protobuf 解码失败 | 跳过该帧，记录 warn 日志 |
| H2 stream error | 清理心跳，关闭连接，返回已收集内容 |
| H2 连接超时 | 5s 超时后取消，返回错误 |

### 8.3 模型可用性

| 场景 | 处理 |
|------|------|
| GetUsableModels 失败 | 使用硬编码回退列表 |
| 模型不可用（API 返回错误） | 标记 Provider 为 unhealthy（Pool 切换）|

---

## 9. 性能设计

### 9.1 HTTP/2 连接复用

- `tool_calls` 续话复用同一 H2 连接（session 中保存 `h2Client` + `h2Stream`）
- 非续话请求每次新建 H2 连接（cursor-auth 的原始设计，可接受）
- 心跳帧防止 H2 连接超时（5 秒间隔）

### 9.2 Token 刷新并发控制

- `CursorTokenStore._refreshPromise` 确保同一时刻只有一个刷新请求
- 并发请求等待同一个 refreshPromise 解决，避免多次刷新

### 9.3 模型列表缓存

- `listModels()` 第一次调用时缓存结果（内存缓存，进程生命周期内有效）
- Provider 启动时不主动拉取（懒加载）

---

## 10. 依赖分析

### 10.1 新增 npm 依赖

| 包 | 版本约束 | 用途 |
|----|---------|------|
| `@bufbuild/protobuf` | `^2.0.0` | Protobuf 运行时（Schema + 编解码） |

### 10.2 Node.js 内置模块

- `node:http2` — HTTP/2 客户端连接
- `node:crypto` — UUID、SHA256（PKCE + session key）

### 10.3 复用现有工具

- `src/utils/logger.js` — 日志
- `src/services/ui-manager.js:broadcastEvent` — WebSocket 事件广播
- `src/services/service-manager.js:autoLinkProviderConfigs` — 自动关联 Pool
- `src/utils/provider-utils.js:createProviderConfig` — 标准 Provider 配置
- `src/auth/oauth-handlers.js` — OAuth 路由注册（修改添加 cursor 路由）

---

## 11. 测试策略

### 11.1 单元测试范围

| 模块 | 测试重点 |
|------|---------|
| `cursor-protobuf.js` | buildCursorAgentRequest 输出格式、parseMessages 边界情况、tool_calls 序列化 |
| `cursor-token-store.js` | 过期检测（5min 内）、并发刷新去重、刷新失败清除 token |
| `cursor-h2.js` | Connect 帧解析（5字节头）、EOS flag 检测 |
| `cursor-oauth.js` | PKCE 参数生成、轮询成功/超时/网络错误 |

### 11.2 集成测试

- 完整 OAuth 登录流程（mock Cursor 轮询 API）
- 非流式请求 → OpenAI 格式验证
- 流式请求 → SSE chunk 顺序和格式
- tool_calls 两轮对话（mock Cursor API 返回 MCP exec）
- 多账号 Pool 轮换（mock 一个账号失败）

---

## 12. 实施风险与缓解

| 风险 | 可能性 | 缓解措施 |
|------|--------|---------|
| `agent_pb.ts` 依赖 TypeScript 特性难以移植为 JS | 中 | 使用 `@bufbuild/protobuf` 运行时 JS API 手写 Schema（不依赖 .ts 类型） |
| Cursor API 返回未预期的 AgentServerMessage 类型 | 中 | 防御性解码（try-catch），未知类型静默跳过 |
| `@bufbuild/protobuf` 包大小影响启动时间 | 低 | 动态 import（lazy load） |
| Cursor 修改 API 版本/client version | 低 | `CURSOR_CLIENT_VERSION` 提取为常量，方便更新 |
| H2 连接泄漏（tool_calls session 未清理） | 中 | 30 秒 session 超时 + 进程退出时全局 cleanupAll |
