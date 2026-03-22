---
feature: cursor-provider
stage: tasks
generated_at: 2026-03-21T00:00:00Z
version: 1
---

# 任务拆分文档: Cursor Provider 集成

> **功能标识**: cursor-provider
> **总任务数**: 15
> **并行组数**: 5

## 并行分组概览

```
G1 (基础设施): T1 → T2
G2 (核心协议, 可并行): T3, T4, T5
G3 (Provider 核心, 需要 G2): T6 → T7 → T8
G4 (集成注册, 需要 G3): T9, T10, T11
G5 (前端 UI, 需要 G4): T12, T13
验收: T14 → T15
```

---

## G1: 基础设施准备

### T1: 安装依赖并初始化目录结构

**优先级**: P0
**复杂度**: simple
**并行组**: G1
**依赖**: 无
**涉及文件**:
- `package.json`
- `src/providers/cursor/` (新建目录)
- `src/providers/cursor/proto/` (新建目录)

**描述**:
安装 `@bufbuild/protobuf` npm 包，创建 cursor provider 目录结构。

**实施步骤**:
1. 在 `/Users/moxiaoxi/Desktop/AIClient-2-API` 下执行 `npm install @bufbuild/protobuf`
2. 创建目录：`src/providers/cursor/` 和 `src/providers/cursor/proto/`
3. 创建目录：`configs/cursor/`（如不存在）并确保在 `.gitignore` 中（如有需要）

**验收标准**:
- `package.json` 的 `dependencies` 中出现 `@bufbuild/protobuf`
- 目录 `src/providers/cursor/proto/` 存在
- `node_modules/@bufbuild/protobuf/` 存在

---

### T2: 移植 Protobuf Schema（agent_pb.js）

**优先级**: P0
**复杂度**: standard（审查修正：原文件使用 codegenv2 的 fileDesc/messageDesc，天然 JS 兼容，只需去除 TS 类型注解）
**并行组**: G1
**依赖**: T1
**涉及文件**:
- `src/providers/cursor/proto/agent_pb.js` (新建)

**描述**:
将 `/Users/moxiaoxi/.config/alma/plugins/cursor-auth/proto/agent_pb.ts` 转换为 ES Module JavaScript 文件。原文件使用 `@bufbuild/protobuf/codegenv2` 的 `fileDesc`/`messageDesc` API，内部是二进制编码的 proto descriptor，天然 JS 兼容。转换步骤：
1. 复制 `agent_pb.ts` → `agent_pb.js`
2. 去掉 `import type { GenEnum, GenFile, GenMessage, GenService }` 等纯类型导入
3. 去掉所有 `export type` 和 `export interface` 声明
4. 去掉 Schema 变量的类型注解（如 `: GenMessage<AgentClientMessage>`）
5. 保留所有 `fileDesc`、`messageDesc`、`enumDesc`、`serviceDesc` 运行时调用

**注意**：`agent_pb.ts` 文件很大（约 472KB），需要分段读取处理。重点移植以下 Schema（cursor-fetch.ts 实际使用的）：
- `AgentClientMessageSchema` / `AgentServerMessageSchema`
- `AgentRunRequestSchema`
- `UserMessageSchema` / `AssistantMessageSchema`
- `ConversationStateStructureSchema` / `ConversationActionSchema`
- `ConversationStepSchema` / `ConversationTurnStructureSchema`
- `AgentConversationTurnStructureSchema`
- `UserMessageActionSchema`
- `ModelDetailsSchema`
- `SelectedContextSchema` / `SelectedImageSchema` / `SelectedImage_DimensionSchema`
- `ClientHeartbeatSchema`
- `KvClientMessageSchema` / `KvServerMessageSchema`
- `ExecClientMessageSchema` / `ExecServerMessageSchema`
- `GetBlobResultSchema` / `SetBlobResultSchema`
- `McpToolDefinitionSchema` / `McpResultSchema` / `McpSuccessSchema`
- `McpTextContentSchema` / `McpToolResultContentItemSchema` / `McpErrorSchema`
- `RequestContextSchema` / `RequestContextResultSchema` / `RequestContextSuccessSchema`
- `ReadResultSchema` / `ReadRejectedSchema`
- `LsResultSchema` / `LsRejectedSchema`
- `GrepResultSchema` / `GrepErrorSchema`
- `WriteResultSchema` / `WriteRejectedSchema`
- `DeleteResultSchema` / `DeleteRejectedSchema`
- `ShellResultSchema` / `ShellRejectedSchema`
- `BackgroundShellSpawnResultSchema`
- `WriteShellStdinResultSchema` / `WriteShellStdinErrorSchema`
- `FetchResultSchema` / `FetchErrorSchema`
- `DiagnosticsResultSchema`
- `GetUsableModelsRequestSchema` / `GetUsableModelsResponseSchema`

**验收标准**:
- `src/providers/cursor/proto/agent_pb.js` 存在
- `import { AgentClientMessageSchema, AgentServerMessageSchema } from './proto/agent_pb.js'` 不报错
- `import { ValueSchema } from '@bufbuild/protobuf/wkt'` 不报错
- 使用 `create(AgentClientMessageSchema, {})` 不抛出异常
- `toBinary`/`fromBinary` 往返测试（简单消息）通过

---

## G2: 核心协议层（与 G1 并行，但依赖 T2 完成）

### T3: 实现 cursor-h2.js（HTTP/2 传输层）

**优先级**: P0
**复杂度**: standard
**并行组**: G2
**依赖**: T1
**涉及文件**:
- `src/providers/cursor/cursor-h2.js` (新建)

**描述**:
封装 Node.js `node:http2` 创建 Cursor API 的 HTTP/2 客户端，提供标准化接口。

**实施内容**:
```js
// cursor-h2.js 导出
export const CURSOR_API_URL = 'https://api2.cursor.sh';
export const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';
export const CONNECT_END_STREAM_FLAG = 0x02;

export function buildCursorH2Headers(accessToken, path) { ... }
export function frameConnectMessage(data, flags = 0) { ... }
export function parseConnectEndStream(data) { ... }
// 创建 H2 客户端和流
export function createH2Stream(accessToken, path) {
    // returns { client: Http2Session, stream: ClientHttp2Stream }
}
```

**验收标准**:
- `frameConnectMessage(data)` 返回正确的 5 字节头 + data
- `parseConnectEndStream` 解析带 error 字段的 JSON 时返回 Error 对象
- `createH2Stream` 可以创建连接到 `api2.cursor.sh` 的 H2 stream（需网络）
- `buildCursorH2Headers` 包含所有必需的 Cursor 特定头部

---

### T4: 实现 cursor-session.js（Tool Calls 会话管理）

**优先级**: P1
**复杂度**: simple
**并行组**: G2
**依赖**: T1
**涉及文件**:
- `src/providers/cursor/cursor-session.js` (新建)

**描述**:
管理 tool_calls 续话所需的 H2 session 状态，实现 session 的存取、清理和超时机制。

**实施内容**:
```js
// cursor-session.js 导出
const activeSessions = new Map();

export function deriveSessionKey(modelId, messages) {
    // SHA256(modelId + firstUserMessage[:200]).slice(0,16)
}
export function saveSession(key, session) { ... }
export function getSession(key) { ... }
export function removeSession(key) { ... }
export function cleanupSession(session) {
    // clearInterval(heartbeatTimer)
    // try { stream.close() } catch {}
    // try { client.close() } catch {}
}
export function cleanupAllSessions() { ... } // 进程退出时调用
```

Session 结构：
```js
{
    h2Client, h2Stream, heartbeatTimer,
    blobStore: Map<string, Uint8Array>,
    mcpTools: [],
    pendingExecs: []
}
```

**验收标准**:
- `deriveSessionKey` 对相同输入产生相同 key
- `saveSession` / `getSession` / `removeSession` 正确操作 Map
- `cleanupSession` 调用不因 `session.h2Stream` 已关闭而抛出异常

---

### T5: 实现 cursor-token-store.js（Token 存储与刷新）

**优先级**: P0
**复杂度**: standard
**并行组**: G2
**依赖**: T1
**涉及文件**:
- `src/providers/cursor/cursor-token-store.js` (新建)

**描述**:
Token 内存缓存 + 文件持久化 + 自动刷新（并发去重）。与 cursor-auth 的 `TokenStore` 类等价，但适配项目文件系统（读写 `configs/cursor/` 目录的 JSON 文件）。

**实施内容**:
```js
import { refreshCursorToken, getTokenExpiry } from '../../auth/cursor-oauth.js';

export class CursorTokenStore {
    constructor(credFilePath) { ... }
    async initialize() { /* 从文件读取 token */ }
    async getValidAccessToken() { /* 检查过期，自动刷新，并发去重 */ }
    async saveTokens(tokens) { /* 写文件 + 更新内存 */ }
    async clearTokens() { /* 删文件 + 清内存 */ }
    hasValidToken() { ... }
    isExpiryDateNear(nearMinutes = 5) { ... }
    async _doRefresh() { /* 调 refreshCursorToken，更新文件 */ }
}
```

Token 文件格式：`{ access_token, refresh_token, expires_at }`（expires_at 为毫秒时间戳）

**验收标准**:
- `initialize()` 从文件正确加载 token
- `getValidAccessToken()` 在 token 有效时直接返回，不调刷新
- `getValidAccessToken()` 在 token 过期时调用刷新
- 并发调用 `getValidAccessToken()` 时，`_doRefresh()` 只被调用一次（去重）
- `saveTokens()` 将 token 写入文件

---

## G3: Provider 核心实现（依赖 G2）

### T6: 实现 cursor-protobuf.js（Protobuf 编解码封装）

**优先级**: P0
**复杂度**: complex
**并行组**: G3
**依赖**: T2
**涉及文件**:
- `src/providers/cursor/cursor-protobuf.js` (新建)

**描述**:
将 cursor-auth `lib/cursor-fetch.ts` 的消息解析和构建逻辑移植为 JS 模块，提供高层 API 给 `cursor-core.js` 调用。

**实施内容**（参考 `cursor-fetch.ts` 中对应函数）：

```js
// 消息解析
export function parseMessages(messages) {
    // → { systemPrompt, userText, images, turns, toolResults }
}
export function extractContent(content) {
    // → { text, images: [{data, mimeType}] }
}

// 请求构建
export function buildCursorAgentRequest(options) {
    // { modelId, systemPrompt, userText, images, turns, tools }
    // → { requestBytes: Uint8Array, blobStore: Map<string, Uint8Array>, mcpTools }
}
export function buildMcpToolDefinitions(tools) { ... }

// 响应处理
export function processAgentServerMessage(msgBytes, blobStore, mcpTools, callbacks) {
    // callbacks: { onText, onThinking, onMcpExec, sendFrame }
    // 返回需要发回的 frames（KV/Exec 响应），或 null
}

// 心跳
export function buildHeartbeatBytes() { ... }

// 工具结果
export function buildToolResultFrames(pendingExecs, toolResults) {
    // 返回 Buffer[]（每个 pendingExec 对应一帧）
}
```

**关键边界情况**:
- `parseMessages` 中，最后一条 user 消息作为 `userText`，前面的 user/assistant 对作为 `turns`
- 图片从最后一条 user 消息的 content array 中提取（`type: image_url`，data: URL 格式）
- `role: tool` 消息收集为 `toolResults`
- KV getBlobArgs：从 blobStore 查找返回，不存在则返回空
- KV setBlobArgs：存入 blobStore
- 所有 Cursor 原生 exec（readArgs/lsArgs/shellArgs/...）返回 Rejected
- mcpArgs：转换为 `PendingExec` 并通过 `onMcpExec` 回调

**验收标准**:
- `parseMessages` 对纯文本、含历史轮次、含图片、含 tool results 四种情况均正确解析
- `buildCursorAgentRequest` 返回非空 `requestBytes`
- `buildMcpToolDefinitions` 将 OpenAI tools 格式正确转换
- `processAgentServerMessage` 对 textDelta、mcpArgs 调用正确的回调

---

### T7: 实现 cursor-core.js（Provider 主体）

**优先级**: P0
**复杂度**: complex
**并行组**: G3
**依赖**: T3, T4, T5, T6
**涉及文件**:
- `src/providers/cursor/cursor-core.js` (新建)

**描述**:
实现 `CursorApiService` 类，继承项目 `ApiServiceAdapter` 接口的方法语义（参考 `GrokApiService` 模式）。

**实施内容**：

`generateContent(model, requestBody)` — 非流式：
1. `_getValidAccessToken()`
2. `parseMessages(requestBody.messages)` 检测 toolResults
3. 如有 toolResults → `resumeWithToolResults(session, toolResults, model)` 返回完整响应
4. 否则 `buildCursorAgentRequest(...)` → `frameConnectMessage(requestBytes)`
5. `createH2Stream(accessToken, '/agent.v1.AgentService/Run')`
6. `stream.write(frame)` + 心跳定时器（5s）
7. 收集所有 textDelta → `fullText`，收集所有 mcpExecs → `pendingExecs`
8. stream end → 组装 OpenAI Chat Completion 格式返回：
   ```js
   {
     id, object: 'chat.completion', created, model,
     choices: [{ index: 0, message: { role: 'assistant', content: fullText,
       tool_calls: pendingExecs.map(e => ({...})) }, finish_reason: 'stop'/'tool_calls' }],
     usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
   }
   ```

`generateContentStream*(model, requestBody)` — 流式：
1. `_getValidAccessToken()`
2. `parseMessages` → 检测 toolResults
3. 如有 toolResults → `resumeWithToolResultsStream(session, toolResults, model)`
4. 否则构建 request → H2 stream
5. 心跳定时器（5s）
6. 逐帧处理 AgentServerMessage，yield OpenAI SSE chunks：
   - textDelta → `yield { choices: [{ delta: { content: text } }] }`
   - thinkingDelta → `yield { choices: [{ delta: { content: '<think>text</think>' } }] }`
   - mcpArgs → `yield { choices: [{ delta: { tool_calls: [...] } }] }` + 保存 session
   - stream end（无 tool_calls）→ `yield { choices: [{ delta: {}, finish_reason: 'stop' }] }`

`listModels()`:
1. 尝试 `fetchCursorUsableModels(accessToken)` via HTTP/2 GET_USABLE_MODELS
2. 失败 → 使用 `FALLBACK_CURSOR_MODELS`（从 `cursor-fetch.ts` 移植的硬编码列表）
3. 返回 OpenAI 格式 `{ object: 'list', data: [...] }`

**验收标准**:
- 非流式：返回的 JSON 包含 `choices[0].message.content`（非空文本）
- 流式：逐个 yield chunk，最后一个 chunk 有 `finish_reason`
- tool_calls 场景：非流式包含 `choices[0].message.tool_calls`，流式 chunk 包含 `delta.tool_calls`
- `listModels()` 返回 `{ object: 'list', data: [...] }`，至少有回退模型

---

### T8: 实现 CursorApiServiceAdapter（适配器包装）

**优先级**: P0
**复杂度**: simple
**并行组**: G3
**依赖**: T7
**涉及文件**:
- `src/providers/cursor/cursor-core.js` (修改，追加 Adapter 类)

**描述**:
在 `cursor-core.js` 中追加 `CursorApiServiceAdapter` 类，包装 `CursorApiService`，实现 `ApiServiceAdapter` 完整接口。

**实施内容**:
```js
export class CursorApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.cursorApiService = new CursorApiService(config);
    }
    async generateContent(model, requestBody) {
        if (!this.cursorApiService.isInitialized) {
            await this.cursorApiService.initialize();
        }
        return this.cursorApiService.generateContent(model, requestBody);
    }
    async *generateContentStream(model, requestBody) {
        if (!this.cursorApiService.isInitialized) {
            await this.cursorApiService.initialize();
        }
        yield* this.cursorApiService.generateContentStream(model, requestBody);
    }
    async listModels() { ... }
    async refreshToken() {
        // 检查 isExpiryDateNear → 调 CursorApiService.refreshToken
    }
    async forceRefreshToken() { ... }
    isExpiryDateNear() { return this.cursorApiService.isExpiryDateNear(); }
}
```

**验收标准**:
- `CursorApiServiceAdapter` 实例可通过 `getServiceAdapter(config)` 获取
- 未初始化时 `generateContent` 会先调 `initialize()`

---

## G4: 集成注册（依赖 G3）

### T9: 注册 Provider 常量与协议映射

**优先级**: P0
**复杂度**: simple
**并行组**: G4
**依赖**: T8
**涉及文件**:
- `src/utils/common.js`
- `src/utils/provider-utils.js`
- `src/providers/provider-models.js`

**描述**:
将 Cursor 注册到项目的常量系统，确保路由、转换、Pool 等逻辑正确识别。

**修改内容**:

1. `src/utils/common.js`:
   - `MODEL_PROVIDER` 中添加 `CURSOR_OAUTH: 'cursor-oauth'`
   - `getProtocolPrefix` 函数中添加特殊处理：`if (provider === 'cursor-oauth') return 'openai';`（关键：让 cursor 不触发协议转换）

2. `src/utils/provider-utils.js` — `PROVIDER_MAPPINGS` 数组末尾添加：
   ```js
   {
       dirName: 'cursor',
       patterns: ['configs/cursor/', '/cursor/'],
       providerType: 'cursor-oauth',
       credPathKey: 'CURSOR_OAUTH_CREDS_FILE_PATH',
       defaultCheckModel: 'claude-3.5-sonnet',
       displayName: 'Cursor OAuth',
       needsProjectId: false,
       urlKeys: []
   }
   ```

3. `src/providers/provider-models.js` — `PROVIDER_MODELS` 对象添加：
   ```js
   'cursor-oauth': [
       'composer-2',
       'claude-4-sonnet',
       'claude-3.5-sonnet',
       'gpt-4o',
       'cursor-small',
       'gemini-2.5-pro',
       'gpt-4o-mini',
       'o1-mini',
       'o3-mini',
   ]
   ```

**验收标准**:
- `MODEL_PROVIDER.CURSOR_OAUTH` 值为 `'cursor-oauth'`
- `getProtocolPrefix('cursor-oauth')` 返回 `'openai'`
- `PROVIDER_MAPPINGS` 包含 cursor 条目
- `getProviderModels('cursor-oauth')` 返回非空数组

---

### T10: 注册 Adapter 到工厂

**优先级**: P0
**复杂度**: simple
**并行组**: G4
**依赖**: T8, T9
**涉及文件**:
- `src/providers/adapter.js`

**描述**:
在 `adapter.js` 中引入并注册 `CursorApiServiceAdapter`。

**修改内容**:
1. 在 import 区域添加：
   ```js
   import { CursorApiService } from './cursor/cursor-core.js';
   ```
2. 在 adapter.js 末尾（或在 Grok 适配器之后）添加 `CursorApiServiceAdapter` 类（如 T8 已将其放在 cursor-core.js 中，则直接 import 该类）
3. 在注册区域添加：
   ```js
   registerAdapter(MODEL_PROVIDER.CURSOR_OAUTH, CursorApiServiceAdapter);
   ```

**验收标准**:
- `getRegisteredProviders()` 包含 `'cursor-oauth'`
- `getServiceAdapter({ MODEL_PROVIDER: 'cursor-oauth', CURSOR_OAUTH_CREDS_FILE_PATH: '...', uuid: '...' })` 返回 `CursorApiServiceAdapter` 实例

---

### T11: 实现 cursor-oauth.js（OAuth 认证流程）

**优先级**: P0
**复杂度**: standard
**并行组**: G4
**依赖**: T9
**涉及文件**:
- `src/auth/cursor-oauth.js` (新建)
- `src/auth/oauth-handlers.js` (修改)

**描述**:
实现 Cursor PKCE OAuth 完整流程，并在 `oauth-handlers.js` 中注册 HTTP 路由。

**cursor-oauth.js 实施内容**:

```js
const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl';
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll';
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';

// PKCE 参数生成
export async function generateCursorAuthParams() {
    // 96字节随机 → base64url verifier
    // SHA256(verifier) → base64url challenge
    // 随机 UUID
    // 返回 { verifier, challenge, uuid, loginUrl }
}

// 轮询（后台）
export async function pollCursorAuth(uuid, verifier, options = {}) {
    // GET https://api2.cursor.sh/auth/poll?uuid=...&verifier=...
    // 404 → 继续轮询（用户未完成）
    // 200 → 返回 { accessToken, refreshToken }
    // 其他 → 抛出错误
    // 最多 150 次，指数退避（1s → max 10s）
    // 成功后：
    //   1. 计算 expires_at（解 JWT exp - 5min）
    //   2. 保存到 configs/cursor/{timestamp}_cursor-auth-token/{...}.json
    //   3. broadcastEvent('oauth_success', { provider: 'cursor-oauth', ... })
    //   4. autoLinkProviderConfigs(CONFIG, { credPath: ... })
}

// 刷新
export async function refreshCursorToken(refreshToken) {
    // POST CURSOR_REFRESH_URL
    // Authorization: Bearer {refreshToken}
    // 返回 { access_token, refresh_token, expires_at }
}

// JWT 过期时间提取
export function getTokenExpiry(token) {
    // 解析 JWT payload 的 exp 字段
    // 返回 exp * 1000 - 5 * 60 * 1000（5分钟余量）
    // 解析失败返回 Date.now() + 3600 * 1000
}

// 统一入口
export async function handleCursorOAuth(currentConfig, options = {}) {
    // 1. generateCursorAuthParams()
    // 2. 启动后台 pollCursorAuth(uuid, verifier, options)
    // 3. 返回 { authUrl: loginUrl, authInfo: { provider, uuid, ... } }
}
```

**oauth-handlers.js 修改**:
在现有的 Kiro/Qwen 路由处理之后，添加 Cursor 的处理分支：
```js
// POST /api/oauth/cursor/start
// POST /api/oauth/cursor/logout
// GET  /api/oauth/cursor/status
```

**验收标准**:
- `generateCursorAuthParams()` 返回包含 `loginUrl`、`verifier`、`uuid` 的对象
- `refreshCursorToken` 正确调用刷新 API（mock 测试）
- `handleCursorOAuth` 返回 `authUrl`
- `oauth-handlers.js` 处理 `/api/oauth/cursor/start` 请求时返回 `{ authUrl: ... }`
- `getTokenExpiry` 从有效 JWT 中提取过期时间并减去 5 分钟

---

## G5: 前端 UI（依赖 G4）

### T12: 前端 provider-manager.js 支持 Cursor

**优先级**: P2
**复杂度**: standard
**并行组**: G5
**依赖**: T11
**涉及文件**:
- `static/app/provider-manager.js`

**描述**:
在前端 `provider-manager.js` 中添加 Cursor Provider 的支持：登录触发、状态显示、登出操作。参考现有的 Kiro/Qwen/Codex OAuth 集成模式。

**实施内容**:
1. 在 provider 类型判断逻辑中添加 `cursor-oauth` 的识别
2. 添加 Cursor OAuth 登录按钮的事件处理：
   - 调用 `/api/oauth/cursor/start`
   - 获取 `authUrl` 后打开浏览器窗口
   - 监听 SSE 事件（`oauth_success` for `cursor-oauth`）→ 刷新状态
3. 添加登出处理：调用 `/api/oauth/cursor/logout`
4. 状态显示：`/api/oauth/cursor/status` 返回的 token 信息（有效/过期时间/未登录）

**验收标准**:
- 点击 Cursor 登录按钮时，打开包含 `loginUrl` 的浏览器窗口
- 认证完成后 UI 自动刷新显示 "已连接" 状态
- 点击登出后 UI 显示 "未登录" 状态
- 已有 cursor 凭据时，UI 显示过期时间

---

### T13: 前端 section-config.html Cursor 配置面板

**优先级**: P2
**复杂度**: standard
**并行组**: G5
**依赖**: T12
**涉及文件**:
- `static/components/section-config.html`
- `static/components/section-config.css` (可能修改)

**描述**:
在配置面板中为 Cursor OAuth Provider 添加 UI 组件，与 Kiro 等其他 OAuth Provider 的展示保持一致风格。

**实施内容**:
1. 在 Provider 配置区域添加 Cursor 卡片：
   - Provider 名称：Cursor OAuth
   - 状态标签（已连接/未登录/过期）
   - 登录按钮（点击触发 OAuth 流程）
   - 登出按钮（仅在已登录时显示）
   - Token 过期时间显示
2. 添加 Cursor 账号池配置入口（参考 Kiro 的多账号列表组件）
3. 样式与现有 OAuth provider 卡片保持一致

**验收标准**:
- Cursor Provider 卡片正确显示在配置页
- 登录/登出按钮可点击并触发相应操作
- 状态信息正确反映后端状态（polling 时显示等待中，成功后显示已连接）

---

## 验收阶段

### T14: 端到端集成测试

**优先级**: P0
**复杂度**: standard
**并行组**: 验收
**依赖**: T9, T10, T11
**涉及文件**:
- `docs/dev/cursor-provider/cursor-provider-test-notes.md` (新建，测试记录)

**描述**:
使用真实 Cursor 账号（或 mock）进行端到端集成测试，覆盖所有 P0 场景。

**测试场景**:

1. **OAuth 登录流程**:
   - 调用 `handleCursorOAuth` → 获取 loginUrl
   - 模拟完成授权后 token 文件存在，格式正确

2. **非流式文本对话**（需要有效 token）:
   ```bash
   curl -X POST http://localhost:3000/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <api-key>" \
     -d '{"model": "claude-3.5-sonnet", "messages": [{"role": "user", "content": "Say hello"}], "stream": false}'
   ```
   期望：返回包含 `choices[0].message.content` 的 JSON

3. **流式文本对话**:
   同上，`"stream": true`
   期望：多个 SSE chunk，最后包含 `data: [DONE]`

4. **图片输入**:
   消息 content 包含 `type: image_url` 的 base64 图片
   期望：正常返回描述图片的响应

5. **tool_calls 两轮对话**:
   第一轮：带 tools 定义 → 期望 `finish_reason: 'tool_calls'`
   第二轮：带 `role: tool` 结果 → 期望最终文本响应

6. **模型列表**:
   ```bash
   curl http://localhost:3000/v1/models -H "Authorization: Bearer <api-key>"
   ```
   期望：包含至少一个 Cursor 模型

7. **Token 自动刷新**（mock）:
   设置 `expires_at = Date.now() - 1`（已过期）
   发送请求 → 期望自动刷新并成功响应

8. **多账号 Pool**:
   配置两个 cursor 账号（一个故意设置无效 token）
   期望：无效账号被标记 unhealthy，请求路由到有效账号

**验收标准**:
- 场景 1-3 均测试通过（或在无网络时有清晰错误提示）
- 场景 5 tool_calls 续话测试通过
- 场景 7 刷新流程通过（可通过单元测试替代）

---

### T15: Provider Pool 健康检查集成

**优先级**: P1
**复杂度**: simple
**并行组**: 验收
**依赖**: T14
**涉及文件**:
- `src/providers/provider-pool-manager.js` (确认，可能需要小改动)

**描述**:
确认 `provider-pool-manager.js` 对 `cursor-oauth` 的健康检查和轮换逻辑正常工作，不需要特殊适配（因为 Cursor 遵循标准 ApiServiceAdapter 接口）。

**检查内容**:
1. 确认 `markProviderUnhealthy('cursor-oauth', { uuid: '...' }, message)` 正常记录
2. 确认 `markProviderHealthy('cursor-oauth', { uuid: '...' })` 正常重置
3. 确认 `getProviderPoolManager()` 能创建 cursor-oauth Pool 实例
4. 确认 401/403 错误会触发 Pool 切换（通过 `shouldSwitchCredential = true`）

**注意**：如果 401 错误（token 过期）不应该立即标记 unhealthy（而是应该先刷新 token），需要在 `cursor-core.js` 的错误处理中不设置 `shouldSwitchCredential = true`，而是先尝试刷新。只有刷新后仍 401 才切换账号。

**验收标准**:
- Pool 中有两个 cursor-oauth 账号时，第一个报错后自动切换到第二个
- 被标记 unhealthy 的账号在后续请求中被跳过
- 成功请求后 `usageCount` 增加、`errorCount` 重置

---

## 任务依赖图

```
T1 (安装依赖)
 └── T2 (agent_pb.js)
      ├── T6 (cursor-protobuf.js)
      │    └── T7 (cursor-core.js) ←── T3, T4, T5
      │         └── T8 (Adapter)
      │              ├── T9 (常量注册)
      │              ├── T10 (Adapter 注册)
      │              └── T11 (OAuth) ←── T9
      │                   ├── T12 (前端 provider-manager)
      │                   │    └── T13 (配置面板)
      │                   └── T14 (端到端测试) ←── T9, T10
      │                        └── T15 (Pool 集成)
T3 (cursor-h2.js)       ──────────┘
T4 (cursor-session.js)  ──────────┘
T5 (cursor-token-store.js) ───────┘
```

## 风险项与注意事项

| 任务 | 风险 | 注意 |
|------|------|------|
| T2 | agent_pb.ts 文件 472KB，内容复杂 | 优先移植 cursor-fetch.ts 实际使用的 Schema，其余可跳过 |
| T6 | 逻辑复杂，依赖 Protobuf 正确性 | 每个方法单独测试，不要一次性集成 |
| T7 | H2 + 心跳 + session 状态交织 | 先实现非流式（更简单），流式基于相同逻辑扩展 |
| T11 | 依赖 broadcastEvent / autoLinkProviderConfigs 的调用时序 | 参考 kiro-oauth.js 完整实现，不遗漏广播和自动关联步骤 |
| T14 | 需要真实 Cursor 账号测试 | 可先用 mock server 测试协议层，再用真实账号验证 |
