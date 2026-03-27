---
feature: cursor-provider-optimization
complexity: complex
generated_by: architect-planner
generated_at: 2026-03-26T14:00:00+08:00
version: 1
---

# 技术设计文档: Cursor Provider 全面优化

> **功能标识**: cursor-provider-optimization
> **对标参考**: cursor2api (~/Desktop/cursor2api)

## 1. 架构概览

### 1.1 当前架构

```
CursorApiService (cursor-core.js)
  ├── generateContent()        — 非流式入口
  ├── generateContentStream()  — 流式入口
  ├── _collectFromH2()         — 非流式 H2 消费者
  └── _streamFromH2()          — 流式 H2 消费者

cursor-protobuf.js             — Protobuf 编解码
cursor-h2.js                   — HTTP/2 传输层
cursor-session.js              — tool_calls 会话管理
cursor-token-store.js          — OAuth token 存储
```

### 1.2 优化后架构

在现有架构基础上，新增 4 个独立工具模块，并对 5 个现有文件进行精准修改：

```
CursorApiService (cursor-core.js) [修改]
  ├── generateContent()          — 集成截断检测、退化循环、工具修复
  ├── generateContentStream()    — 集成截断检测、退化循环、流式缓冲、工具修复
  ├── _collectFromH2()           — 集成退化循环检测（非流式）
  └── _streamFromH2()            — 集成退化循环检测（流式）+ StreamGuard

cursor-truncation.js             [新增] — 截断检测 + 自动续写
cursor-stream-guard.js           [新增] — 流式增量释放（预热 + 后卫缓冲）
cursor-tool-fixer.js             [新增] — 工具参数自动修复
cursor-compression.js            [新增] — 历史消息压缩

cursor-protobuf.js               [修改] — 集成消息压缩
cursor-h2.js                     [修改] — 错误码精细映射
cursor-session.js                [修改] — 会话超时优化（120s → 600s）
```

### 1.3 数据流（优化后）

```
OpenAI 请求
    │
    ▼
[cursor-compression.js]          — R5: 历史消息压缩（可选，默认关闭）
    │
    ▼
[cursor-tool-fixer.js]           — R7: 工具参数修复（默认开启）
    │
    ▼
buildCursorAgentRequest()        — Protobuf 编码
    │
    ▼
HTTP/2 请求
    │
    ▼
[流式响应处理]
    │
    ├── cursor-stream-guard.js   — R6: 流式缓冲（可选，默认关闭）
    ├── 退化循环检测              — R2: inline in cursor-core.js
    │
    ▼
[cursor-truncation.js]           — R1: 截断检测 + 自动续写
    │
    ▼
OpenAI 格式响应
```

---

## 2. 配置系统设计

所有新增配置项通过环境变量或 config.json 传入，由 `cursor-core.js` 统一读取：

```javascript
// 默认配置值（内嵌在各模块中，通过 config 参数或环境变量覆盖）
const DEFAULT_CONFIG = {
    // R1: 截断与续写
    CURSOR_MAX_AUTO_CONTINUE: 3,

    // R2: 退化循环
    CURSOR_MAX_REPEAT_TOKENS: 8,
    CURSOR_MAX_TOOL_CALL_DEPTH: 10,

    // R3: 已通过 cursor-h2.js 错误映射表实现

    // R4: 会话超时
    CURSOR_SESSION_TIMEOUT_MS: 600_000,      // 10 分钟（原 120s）

    // R5: 消息压缩
    CURSOR_COMPRESSION_ENABLED: false,        // 默认关闭
    CURSOR_COMPRESSION_LEVEL: 2,
    CURSOR_COMPRESSION_KEEP_RECENT: 6,
    CURSOR_MAX_HISTORY_TOKENS: 120_000,

    // R6: 流式缓冲
    CURSOR_STREAM_GUARD_ENABLED: false,       // 默认关闭
    CURSOR_WARMUP_CHARS: 96,
    CURSOR_GUARD_CHARS: 256,

    // R7: 工具修复
    CURSOR_TOOL_FIX_ENABLED: true,           // 默认开启

    // R8: 图片降级
    CURSOR_VISION_ENABLED: false,            // 默认关闭
    CURSOR_VISION_MODE: 'ocr',               // 'ocr' | 'api'
    CURSOR_VISION_API_URL: '',
    CURSOR_VISION_API_KEY: '',
    CURSOR_VISION_MODEL: 'gpt-4o-mini',
};
```

**读取优先级**（高 → 低）：环境变量 > config.json 中 cursor 节 > 默认值

---

## 3. 各模块详细设计

### 3.1 cursor-truncation.js（新增）— R1

**职责**：检测响应是否被截断，并通过续写请求拼接完整内容。

**核心接口**：

```javascript
/**
 * 检测文本是否截断
 * @param {string} text - 完整响应文本
 * @param {boolean} hasTools - 是否有工具定义
 * @returns {boolean}
 */
export function isTruncated(text, hasTools = false) { ... }

/**
 * 非流式自动续写
 * @param {object} params
 * @param {string} params.fullText - 已收集的完整文本
 * @param {string} params.model - 模型 ID
 * @param {string} params.accessToken - 访问令牌
 * @param {boolean} params.hasTools - 是否有工具
 * @param {number} params.maxContinue - 最大续写次数
 * @param {Map} params.blobStore - blob 存储
 * @param {Array} params.mcpTools - MCP 工具定义
 * @returns {Promise<string>} - 续写后的完整文本
 */
export async function autoContinueFull(params) { ... }

/**
 * 流式自动续写（生成器函数）
 * @param {object} params - 同上
 * @yields {object} - OpenAI SSE chunk 格式
 */
export async function* autoContinueStream(params) { ... }

/**
 * 去重拼接：移除续写开头与已有内容末尾的重叠部分
 * @param {string} existing
 * @param {string} continuation
 * @returns {string}
 */
export function deduplicateContinuation(existing, continuation) { ... }
```

**截断检测算法**（移植自 cursor2api `isTruncated()`，适配我们的消息协议）：

```javascript
export function isTruncated(text, hasTools = false) {
    if (!text || text.trim().length === 0) return false;
    const trimmed = text.trimEnd();

    // 1. 工具调用响应：JSON action 块未闭合（最精确）
    if (hasTools) {
        const actionOpens = (trimmed.match(/```json\s+action/g) || []).length;
        if (actionOpens > 0) {
            const actionBlocks = (trimmed.match(/```json\s+action[\s\S]*?```/g) || []).length;
            return actionOpens > actionBlocks;
        }
    }

    // 2. 通用代码块：行首 ``` 计数不配对
    const lineStartFences = (trimmed.match(/^```/gm) || []).length;
    if (lineStartFences % 2 !== 0) return true;

    // 3. XML/HTML 标签：开标签 > 闭标签 + 1
    const openTags = (trimmed.match(/^<[a-zA-Z]/gm) || []).length;
    const closeTags = (trimmed.match(/^<\/[a-zA-Z]/gm) || []).length;
    if (openTags > closeTags + 1) return true;

    // 4. 句法不完整：以逗号/冒号/开括号结尾
    if (/[,;:\[{(]\s*$/.test(trimmed)) return true;

    // 5. 长响应以 \n 结尾（JSON 字符串中间截断）
    if (trimmed.length > 2000 && /\\n?\s*$/.test(trimmed) && !trimmed.endsWith('```')) return true;

    return false;
}
```

**续写请求构建策略**（适配我们的 H2 + Protobuf 协议）：

我们的续写请求需要通过 `buildCursorAgentRequest()` 构建，而不是直接修改 messages 数组（cursor2api 使用简单的 REST JSON，我们使用 Protobuf）。续写请求设计：

- `systemPrompt`：空或简化版
- `userText`：续写提示词（包含截断点上下文锚点）
- `turns`：仅包含已收集的 assistant 文本（截断的响应作为 assistant turn）
- `images`：空
- `mcpTools`：原始 mcpTools（续写也需要工具定义，以便模型正确续写工具调用）

**与 cursor-core.js 的集成点**：

```javascript
// 在 _collectFromH2 的 h2Stream.on('end') 前：
// 如果检测到截断且 maxContinue > 0，则调用 autoContinueFull()

// 在 _streamFromH2 的 enqueue({ type: 'done' }) 前：
// 如果检测到截断，yield* autoContinueStream()，然后再结束
```

---

### 3.2 退化循环检测（内联到 cursor-core.js）— R2

**职责**：在 `_streamFromH2` 的 `onText` 回调中检测循环，在 `_collectFromH2` 的 `onText` 回调中检测循环。

**设计决策**：内联到 cursor-core.js 而非单独模块，因为检测逻辑与流控制紧密耦合（需要直接 `break` 退出循环）。

**检测状态**（在 `_streamFromH2` 的 state 对象中追踪）：

```javascript
const degenerateState = {
    lastDelta: '',
    repeatCount: 0,
    tagBuffer: '',          // HTML token 跨 chunk 拼接缓冲
    toolCallDepth: 0,       // tool call 嵌套深度（通过 onMcpExec 计数）
    toolCallHistory: [],    // [{toolName, argsHash}] 用于检测重复 tool call
    aborted: false,
};
```

**检测逻辑**（移植自 cursor2api `cursor-client.ts`）：

```javascript
// 在 onText 回调中：
function checkDegenerateLoop(text, state) {
    const REPEAT_THRESHOLD = config.CURSOR_MAX_REPEAT_TOKENS || 8;
    const trimmed = text.trim();

    // 1. 短 token 重复检测（≤20 字符）
    if (trimmed.length > 0 && trimmed.length <= 20) {
        if (trimmed === state.lastDelta) {
            state.repeatCount++;
            if (state.repeatCount >= REPEAT_THRESHOLD) {
                logger.warn(`[CursorApiService] Degenerate loop detected: "${trimmed}" repeated ${state.repeatCount} times`);
                return true; // abort
            }
        } else {
            state.lastDelta = trimmed;
            state.repeatCount = 1;
        }
    } else {
        state.lastDelta = '';
        state.repeatCount = 0;
    }

    // 2. HTML token 重复检测（跨 chunk 拼接）
    const HTML_TOKEN_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;
    state.tagBuffer += text;
    const tagMatches = [...state.tagBuffer.matchAll(new RegExp(HTML_TOKEN_RE.source, 'gi'))];
    if (tagMatches.length > 0) {
        const lastMatch = tagMatches[tagMatches.length - 1];
        state.tagBuffer = state.tagBuffer.slice(lastMatch.index + lastMatch[0].length);
        for (const m of tagMatches) {
            const token = m[0].toLowerCase();
            if (token === state.lastDelta) {
                state.repeatCount++;
                if (state.repeatCount >= REPEAT_THRESHOLD) {
                    logger.warn(`[CursorApiService] HTML token loop: "${token}" repeated ${state.repeatCount} times`);
                    return true;
                }
            } else {
                state.lastDelta = token;
                state.repeatCount = 1;
            }
        }
    } else if (state.tagBuffer.length > 20) {
        state.tagBuffer = '';
    }

    return false;
}

// 在 onMcpExec 回调中：
function checkToolCallLoop(exec, state) {
    const DEPTH_LIMIT = config.CURSOR_MAX_TOOL_CALL_DEPTH || 10;
    const argsHash = exec.decodedArgs.slice(0, 100); // 简单 hash

    state.toolCallDepth++;
    if (state.toolCallDepth > DEPTH_LIMIT) {
        logger.warn(`[CursorApiService] Tool call depth limit exceeded: ${state.toolCallDepth}`);
        return true;
    }

    // 检查连续 3 次相同工具+参数
    state.toolCallHistory.push({ name: exec.toolName, hash: argsHash });
    const recent = state.toolCallHistory.slice(-3);
    if (recent.length === 3 && recent.every(r => r.name === exec.toolName && r.hash === argsHash)) {
        logger.warn(`[CursorApiService] Tool call loop: "${exec.toolName}" called 3 times with same args`);
        return true;
    }

    return false;
}
```

**退出策略**：
- 流式：`enqueue({ type: 'abort_degenerate' })`，消费侧检测到此信号后停止循环并发送 finish chunk
- 非流式：直接 `resolved = true; resolve(buildResponse('stop'))`

---

### 3.3 cursor-h2.js 修改 — R3：错误码精细映射

**当前问题**：`_collectFromH2` 中，所有 Connect Protocol 错误都抛出 `status: 400`；`parseConnectFrame` 只返回 `Error` 对象，不包含 HTTP 状态码。

**修改方案**：

在 `cursor-h2.js` 中扩展 `parseConnectFrame`，提取错误码并映射为 HTTP 状态码：

```javascript
// Connect Protocol 错误码到 HTTP 状态码映射表
const CONNECT_ERROR_HTTP_MAP = {
    'unauthenticated': 401,
    'permission_denied': 403,
    'not_found': 404,
    'resource_exhausted': 429,
    'invalid_argument': 400,
    'failed_precondition': 400,
    'unimplemented': 501,
    'unavailable': 503,
    'internal': 500,
    'unknown': 502,      // 上游未知错误
    'canceled': 499,
    'deadline_exceeded': 504,
};

/**
 * 解析 Connect End Stream 帧，提取错误信息和 HTTP 状态码
 * @param {Uint8Array} data
 * @returns {{ error: Error, httpStatus: number }|null}
 */
export function parseConnectErrorFrame(data) {
    try {
        const text = new TextDecoder().decode(data);
        const p = JSON.parse(text);
        if (p?.error) {
            const code = p.error.code ?? 'unknown';
            const message = p.error.message ?? 'Unknown error';
            const detail = p.error.details?.[0]?.debug?.details?.detail || message;
            const httpStatus = CONNECT_ERROR_HTTP_MAP[code] ?? 502;
            const err = Object.assign(new Error(detail), { status: httpStatus, connectCode: code });
            return { error: err, httpStatus };
        }
        return null;
    } catch {
        // 兜底：JSON 解析失败不抛异常
        return {
            error: Object.assign(new Error('Failed to parse Cursor API error response'), { status: 502 }),
            httpStatus: 502,
        };
    }
}
```

在 `cursor-core.js` 的 `_collectFromH2` 中，将原有的错误处理替换为：

```javascript
// 旧代码
reject(Object.assign(new Error(detail), { status: 400 }));

// 新代码
const errFrame = parseConnectErrorFrame(msgBytes);
if (errFrame) {
    resolved = true;
    reject(errFrame.error);
    return;
}
```

同样在 `_streamFromH2` 的 CONNECT_END_STREAM_FLAG 处理中替换 `parseConnectFrame` 调用。

---

### 3.4 cursor-session.js 修改 — R4：会话超时优化

**当前问题**：`SESSION_TIMEOUT_MS = 120_000`（2分钟），Tool Call 处理时间超过 2 分钟时会话过期。

**修改方案**：

```javascript
// 默认超时从 120s 增加到 600s（10分钟）
const DEFAULT_SESSION_TIMEOUT_MS = 600_000;

// 支持环境变量覆盖
const SESSION_TIMEOUT_MS = (() => {
    const envVal = process.env.CURSOR_SESSION_TIMEOUT_MS;
    if (envVal) {
        const parsed = parseInt(envVal, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    // 也支持从 config 对象读取（如果 saveSession 的调用方传入 config）
    return DEFAULT_SESSION_TIMEOUT_MS;
})();
```

由于 `cursor-session.js` 是模块级初始化，环境变量在模块加载时读取，无需热更新。

**未来扩展**（暂不实现）：活跃心跳自动延期。

---

### 3.5 cursor-compression.js（新增）— R5：历史消息压缩

**职责**：对 OpenAI 格式的 messages 数组进行有损压缩，在发送给 Cursor 前减少 token 数。

**核心接口**：

```javascript
/**
 * 压缩 OpenAI messages 数组
 * @param {Array} messages - OpenAI format messages
 * @param {object} options
 * @param {number} options.level - 压缩级别 1/2/3
 * @param {number} options.keepRecent - 保留最近 N 条消息不压缩
 * @param {number} options.maxHistoryTokens - token 上限触发压缩
 * @returns {Array} 压缩后的 messages
 */
export function compressMessages(messages, options = {}) { ... }

/**
 * 估算消息数组的 token 数（字符数 / 4 的简单估算）
 * @param {Array} messages
 * @returns {number}
 */
export function estimateMessageTokens(messages) { ... }
```

**压缩级别参数表**（移植自 cursor2api）：

| 级别 | keepRecent | maxChars | briefLen |
|------|-----------|----------|---------|
| 1    | 10        | 4000     | 500     |
| 2    | 6         | 2000     | 300     |
| 3    | 4         | 1000     | 150     |

**压缩规则**：

```javascript
function compressMessage(msg, level) {
    const params = LEVEL_PARAMS[level];

    // 工具调用消息（assistant 含 tool_calls）
    if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ');
        const totalChars = JSON.stringify(msg.tool_calls).length;
        return {
            ...msg,
            content: `[Executed: ${toolNames}] (${totalChars} chars compressed)`,
            tool_calls: undefined,
        };
    }

    // 工具结果消息（role='tool'）
    if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (content.length <= params.maxChars) return msg;
        const head = content.slice(0, params.briefLen);
        const tail = content.slice(-params.briefLen);
        const omitted = content.length - params.briefLen * 2;
        return {
            ...msg,
            content: `${head}\n[...${omitted} chars omitted...]\n${tail}`,
        };
    }

    // 纯文本消息
    const content = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
            : '';
    if (content.length <= params.maxChars) return msg;

    // 在自然边界（换行）处截断
    const truncated = content.slice(0, params.maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > params.maxChars * 0.8 ? lastNewline : params.maxChars;
    return {
        ...msg,
        content: content.slice(0, cutPoint) + `\n[...truncated...]`,
    };
}

export function compressMessages(messages, options = {}) {
    const { level = 2, keepRecent = 6, maxHistoryTokens = 120_000 } = options;

    // 先检查是否超过 token 阈值
    const totalTokens = estimateMessageTokens(messages);
    if (totalTokens <= maxHistoryTokens) return messages;

    // 保留最近 N 条消息不压缩
    const recentStart = Math.max(0, messages.length - keepRecent);
    const toCompress = messages.slice(0, recentStart);
    const recent = messages.slice(recentStart);

    return [...toCompress.map(msg => compressMessage(msg, level)), ...recent];
}
```

**集成点**：在 `cursor-protobuf.js` 的 `parseMessages()` 调用前（在 `cursor-core.js` 中），当 `CURSOR_COMPRESSION_ENABLED=true` 时调用。

---

### 3.6 cursor-stream-guard.js（新增）— R6：流式增量释放

**职责**：为流式响应提供预热缓冲 + 后卫缓冲，防止拒绝前缀或异常内容直接发给客户端。

**完整移植自 cursor2api `streaming-text.ts` 的 `createIncrementalTextStreamer`，适配为 JS。**

**核心接口**：

```javascript
/**
 * 创建流式增量释放器
 * @param {object} options
 * @param {number} [options.warmupChars=96] - 预热缓冲字符数
 * @param {number} [options.guardChars=256] - 后卫缓冲字符数
 * @param {(text: string) => boolean} [options.isBlockedPrefix] - 拒绝前缀检测
 * @returns {{ push(chunk: string): string, finish(): string, hasUnlocked(): boolean }}
 */
export function createStreamGuard(options = {}) { ... }
```

**内部状态机**：

```
状态: WARMUP → UNLOCKED → DRAINING
                    └→ BLOCKED (检测到拒绝前缀)

WARMUP 阶段:
  - 缓冲前 warmupChars 字符
  - 等待自然边界（句号、换行）或缓冲满
  - 检查 isBlockedPrefix() → 若为 true 保持 BLOCKED，不发送
  - 否则 → UNLOCKED

UNLOCKED 阶段:
  - 实时发送，但保留尾部 guardChars 字符不发
  - push(chunk) 返回可以立即发出的部分

DRAINING 阶段（finish() 调用后）:
  - 释放所有剩余缓冲内容
```

**集成策略**：

StreamGuard 与退化循环检测是正交的，都在 `_streamFromH2` 的 `onText` 回调中工作：

```javascript
// 在 _streamFromH2 中，当 CURSOR_STREAM_GUARD_ENABLED=true 时：
const guard = createStreamGuard({
    warmupChars: config.CURSOR_WARMUP_CHARS || 96,
    guardChars: config.CURSOR_GUARD_CHARS || 256,
});

onText: (text, isThinking) => {
    if (!isThinking) {
        const toSend = guard.push(text);
        if (toSend) enqueue({ type: 'chunk', chunk: makeChunk({ content: toSend }) });
    } else {
        // thinking 内容不经过 guard
        enqueue({ type: 'chunk', chunk: makeChunk({ content: text }) });
    }
},

// 在 h2Stream.on('end') 中：
const remaining = guard.finish();
if (remaining) enqueue({ type: 'chunk', chunk: makeChunk({ content: remaining }) });
```

---

### 3.7 cursor-tool-fixer.js（新增）— R7：工具参数自动修复

**完整移植自 cursor2api `tool-fixer.ts`，无架构改动，直接适配为 JS。**

**核心接口**：

```javascript
/**
 * 替换智能引号为 ASCII 引号
 * @param {string} text
 * @returns {string}
 */
export function replaceSmartQuotes(text) { ... }

/**
 * 修复 str_replace/search_replace 工具的 old_string 精确匹配问题
 * 通过模糊匹配（忽略引号变异、空白变异）找到唯一匹配后替换为精确文本
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
export function repairExactMatchToolArguments(toolName, args) { ... }

/**
 * 对工具调用参数应用所有修复
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
export function fixToolCallArguments(toolName, args) { ... }
```

**集成点**：在 `cursor-protobuf.js` 的 `decodeMcpArgsMap()` 返回后，`handleExecMessage()` 的 `onMcpExec` 调用前：

```javascript
// 在 handleExecMessage 的 mcpArgs 分支中：
if (c === 'mcpArgs') {
    const a = exec.message.value;
    let decodedArgs = decodeMcpArgsMap(a.args);

    // R7: 工具参数自动修复（当 CURSOR_TOOL_FIX_ENABLED=true 时）
    if (config.CURSOR_TOOL_FIX_ENABLED !== false) {
        const toolName = a.toolName || a.name || '';
        decodedArgs = fixToolCallArguments(toolName, decodedArgs);
    }

    onMcpExec({
        execId: exec.execId,
        execMsgId: exec.id,
        toolCallId: a.toolCallId || randomUUID(),
        toolName: a.toolName || a.name,
        decodedArgs: JSON.stringify(decodedArgs),
    });
}
```

**注意**：`repairExactMatchToolArguments` 需要读取文件系统，其中 `existsSync` / `readFileSync` 在我们的 Node.js 环境中是可用的（与 cursor2api 相同）。

---

### 3.8 图片 OCR 降级 — R8（部分移植）

**设计决策**：R8 的主要复杂度在于 cursor2api 中图片处理发生在 converter 层（Anthropic API 格式），而我们的图片处理在 `parseMessages()` 中（OpenAI API 格式）。

**架构差异**：

| 维度 | cursor2api | 我们的实现 |
|------|-----------|----------|
| 图片输入格式 | Anthropic `image` content block | OpenAI `image_url` content part |
| 处理时机 | `convertToCursorRequest()` 调用前 | `parseMessages()` 中的 `extractContent()` |
| 输出方式 | 替换 content block 为文本 | 替换 images 数组元素或 userText |

**实现策略**：

新增 `cursor-vision.js`（或内嵌在 `cursor-compression.js` 中，最终决定放 `cursor-vision.js`），在 `cursor-core.js` 的 `generateContent` / `generateContentStream` 入口处，在 `parseMessages()` 之前处理：

```javascript
// cursor-vision.js
export async function preprocessImages(messages, config) {
    if (!config.CURSOR_VISION_ENABLED) return messages;

    // 找最后一条 user 消息中的图片
    // 同 cursor2api vision.ts 逻辑，但处理 OpenAI image_url 格式
    // ...
}
```

**OCR 依赖**：`tesseract.js` 为可选依赖，仅在 `CURSOR_VISION_MODE=ocr` 时动态 import：

```javascript
// 动态导入，避免在未配置 OCR 时加载 tesseract.js
const { createWorker } = await import('tesseract.js');
```

---

## 4. 关键设计决策

### 4.1 为什么不在 cursor-protobuf.js 中内联压缩？

`parseMessages()` 输出的是 Cursor 内部格式（turns/images/userText），而压缩需要在 OpenAI 格式层面进行（工具调用的 `tool_calls` 字段、`role: 'tool'` 消息）。因此压缩必须在 `parseMessages()` 之前。

### 4.2 续写请求的 Protobuf 构建问题

cursor2api 的续写使用简单 REST JSON，而我们需要用 `buildCursorAgentRequest()` 构建 Protobuf 消息。续写时的关键点：

- `turns`：把已收集的 assistant 文本作为最后一个 `assistantText` 放入 turns
- `userText`：续写提示词
- `systemPrompt`：保持原始 systemPrompt（续写时模型需要知道它的角色）
- `mcpTools`：保持原始 mcpTools（续写时可能继续产生工具调用）

这意味着 `cursor-truncation.js` 需要接受 `buildCursorAgentRequest` 函数作为参数（或直接导入），以及完整的原始请求上下文。

### 4.3 退化循环检测的位置

退化循环检测必须内联在 `_streamFromH2` 中，因为：
1. 需要在 protobuf 解码后立即检测（每个 text delta）
2. 检测到后需要立即停止 H2 流（调用 `h2Stream.close()`）
3. 状态（repeatCount 等）是单次请求级别的，随 `_streamFromH2` 的生命周期存在

### 4.4 StreamGuard 的非流式处理

`createStreamGuard` 仅用于流式响应（`_streamFromH2`）。非流式响应（`_collectFromH2`）不需要 StreamGuard，因为内容是一次性返回的，没有拒绝前缀泄漏问题。

---

## 5. 错误处理与日志

### 5.1 截断续写日志

```javascript
logger.info(`[CursorTruncation] Truncation detected, attempting continuation ${continueCount}/${maxContinue}`);
logger.info(`[CursorTruncation] Continuation ${continueCount}: added ${deduped.length} chars`);
logger.warn(`[CursorTruncation] Max continuations reached (${maxContinue}), returning partial response`);
```

### 5.2 退化循环日志

```javascript
logger.warn(`[CursorApiService] Degenerate loop: "${trimmed}" repeated ${repeatCount} times, aborting stream`);
logger.warn(`[CursorApiService] Tool call depth limit: ${depth}/${DEPTH_LIMIT}, aborting`);
logger.warn(`[CursorApiService] Tool call loop: "${toolName}" called 3 times with same args`);
```

### 5.3 消息压缩日志

```javascript
logger.debug(`[CursorCompression] Total tokens: ${totalTokens}, threshold: ${maxHistoryTokens}, compressing...`);
logger.debug(`[CursorCompression] Compressed ${compressed} messages, saved ~${savedChars} chars`);
```

---

## 6. 测试设计

### 6.1 单元测试文件结构

```
tests/unit/providers/cursor/
  ├── cursor-truncation.test.js     — R1
  ├── cursor-degenerate.test.js     — R2 (测试 cursor-core.js 中的逻辑)
  ├── cursor-h2-errors.test.js      — R3
  ├── cursor-session-timeout.test.js — R4
  ├── cursor-compression.test.js    — R5
  ├── cursor-stream-guard.test.js   — R6
  ├── cursor-tool-fixer.test.js     — R7
  └── cursor-vision.test.js         — R8
```

### 6.2 重点测试场景

**R1 截断检测**：
- 代码块未闭合 → `isTruncated()` 返回 true
- XML 标签未闭合 → true
- 逗号结尾 → true
- 正常句子结尾 → false
- `autoContinueFull()` 拼接去重

**R2 退化循环**：
- 相同 token 重复 8 次 → abort
- HTML token 跨 chunk 重复 → abort
- Tool call 深度超限 → abort
- 正常输出不误判

**R3 错误码映射**：
- unauthenticated → 401
- resource_exhausted → 429
- unknown code → 502
- JSON 解析失败兜底 → 502

**R4 会话超时**：
- 默认值 600000ms
- 环境变量覆盖

**R5 消息压缩**：
- token 未超限 → 原样返回
- tool_calls 消息压缩格式
- tool result 压缩格式（保留头尾）
- 近期消息不压缩

**R7 工具修复**：
- 智能引号替换
- StrReplace 精确匹配失败 → 模糊匹配成功
- 多匹配时不修改（best-effort）

---

## 7. 实施顺序

按 P0 → P1 → P2 → P3 优先级，各需求独立实施：

```
P0: R2（退化循环）→ R1（截断检测+续写）
P1: R3（错误码）→ R4（会话超时）→ R5（消息压缩）
P2: R6（流式缓冲）→ R7（工具修复）
P3: R8（图片降级）
```

**R2 先于 R1 的原因**：退化循环检测影响 `_streamFromH2` 的内部逻辑，R1 的续写需要在没有退化循环的干净流基础上工作。

---

## 8. 依赖变更

| 包 | 类型 | 用途 |
|----|------|------|
| `tesseract.js` | 可选（新增）| R8 本地 OCR |

其他需求均使用现有依赖（Node.js 内置模块 + 项目已有依赖）。
