---
feature: cursor-provider-optimization
complexity: complex
generated_by: architect-planner
generated_at: 2026-03-26T14:00:00+08:00
version: 1
---

# 任务拆分文档: Cursor Provider 全面优化

> **功能标识**: cursor-provider-optimization
> **设计文档**: cursor-provider-optimization-design.md

## 任务总览

| 组 | 任务 | 优先级 | 复杂度 | 并行 |
|----|------|--------|--------|------|
| G1 | T-01: 退化循环检测 | P0 | complex | 否 |
| G2 | T-02: 截断检测工具函数 | P0 | medium | 否（依赖 G1） |
| G2 | T-03: 非流式自动续写 | P0 | complex | 否（依赖 T-02） |
| G2 | T-04: 流式自动续写 | P0 | complex | 可与 T-03 并行 |
| G3 | T-05: 错误码精细映射 | P1 | medium | 是 |
| G3 | T-06: 会话超时优化 | P1 | simple | 是 |
| G3 | T-07: 历史消息压缩 | P1 | complex | 是 |
| G4 | T-08: 流式增量释放 | P2 | medium | 是 |
| G4 | T-09: 工具参数自动修复 | P2 | medium | 是 |
| G5 | T-10: 图片 OCR 降级 | P3 | complex | 否（依赖 G4） |

---

## G1: 退化循环防护（P0，必须先做）

### T-01: 退化循环检测（cursor-core.js 修改）

**优先级**: P0
**复杂度**: complex
**并行组**: G1（无并行）
**依赖**: 无
**预估工时**: 3-4h

**描述**:

在 `cursor-core.js` 的 `_streamFromH2` 和 `_collectFromH2` 方法中内联退化循环检测逻辑，防止模型陷入无限重复输出或工具调用死循环。

**涉及文件**:
- `src/providers/cursor/cursor-core.js` — 主要修改文件

**实施步骤**:

1. 在 `_streamFromH2` 方法的 state 对象中添加退化循环检测字段：
   ```javascript
   const degenerateState = {
       lastDelta: '',
       repeatCount: 0,
       tagBuffer: '',
       toolCallDepth: 0,
       toolCallHistory: [],
       aborted: false,
   };
   ```

2. 实现 `checkDegenerateLoop(text, state, config)` 内部函数：
   - 短 token（≤20 字符）连续重复检测（阈值：`CURSOR_MAX_REPEAT_TOKENS`，默认 8）
   - HTML token 跨 chunk 拼接后检测（`<br>`, `</s>`, `&nbsp;` 等）
   - 参考 design.md 3.2 节的完整算法

3. 实现 `checkToolCallLoop(exec, state, config)` 内部函数：
   - 工具调用深度检测（阈值：`CURSOR_MAX_TOOL_CALL_DEPTH`，默认 10）
   - 连续 3 次相同工具+参数检测

4. 在 `_streamFromH2` 的 `onText` 回调中调用 `checkDegenerateLoop`：
   ```javascript
   onText: (text, isThinking) => {
       if (!isThinking && checkDegenerateLoop(text, degenerateState, config)) {
           degenerateState.aborted = true;
           enqueue({ type: 'abort_degenerate' });
           return;
       }
       // ... 原有逻辑
   }
   ```

5. 在 `_streamFromH2` 的 `onMcpExec` 回调中调用 `checkToolCallLoop`。

6. 在 queue 消费循环中处理 `abort_degenerate` 信号：
   - 停止发送新 chunks
   - 发送带 `finish_reason: 'stop'` 的最终 chunk
   - 关闭 H2 流

7. 在 `_collectFromH2` 的 `onText` 回调中同样调用 `checkDegenerateLoop`：
   - 检测到退化循环时，直接 `resolve(buildResponse('stop'))` 返回已收集的内容

8. 从 `process.env` 或 `this.config` 读取配置值（`CURSOR_MAX_REPEAT_TOKENS`、`CURSOR_MAX_TOOL_CALL_DEPTH`）。

**验收标准**:
- WHEN 同一 delta token 连续重复 8 次以上 THEN 流自动中止，返回已有内容
- WHEN HTML token（`<br>`, `</s>`）跨 chunk 拼接后重复超过阈值 THEN 中止
- WHEN Tool Call 深度超过 10 层 THEN 中止，日志记录
- WHEN Tool Call 同一工具连续调用 3 次且参数相同 THEN 中止
- WHEN 正常输出不触发误判（短词偶发重复不中止）
- 单元测试覆盖所有场景，通过率 100%

---

## G2: 截断检测与自动续写（P0）

### T-02: 截断检测工具函数（cursor-truncation.js 新建）

**优先级**: P0
**复杂度**: medium
**并行组**: G2（在 T-01 完成后开始）
**依赖**: T-01（确保退化循环检测先就位，续写的干净基础）
**预估工时**: 2h

**描述**:

新建 `src/providers/cursor/cursor-truncation.js`，实现截断检测算法和续写去重逻辑。此文件不包含网络请求，只包含纯函数，易于单元测试。

**涉及文件**:
- `src/providers/cursor/cursor-truncation.js` — 新建

**实施步骤**:

1. 实现 `isTruncated(text, hasTools)` 函数（参考 design.md 3.1 节算法）：
   - 工具调用响应的 json action 块未闭合检测
   - 通用代码块行首 ``` 计数不配对
   - XML/HTML 标签未闭合
   - 句法不完整（逗号/冒号/开括号结尾）
   - 长响应反斜杠截断检测

2. 实现 `deduplicateContinuation(existing, continuation)` 函数（移植自 cursor2api `handler.ts`）：
   - 字符级重叠去重（最大 500 字符检测窗口）
   - 行级重叠去重（fallback）

3. 实现 `buildContinuationPrompt(fullText)` 辅助函数：
   - 生成续写提示词（包含截断点前 300 字符的锚点）

4. 实现 `closeUnclosedThinking(text)` 辅助函数：
   - 为未闭合的 `<thinking>` 标签补充 `</thinking>`

5. 导出所有公共函数，JSDoc 完整注释。

**验收标准**:
- `isTruncated()` 对代码块未闭合、XML 未闭合、逗号结尾返回 true
- `isTruncated()` 对正常句子结尾、已闭合代码块返回 false
- `deduplicateContinuation()` 正确去除前缀重叠，行级去重正确
- 单元测试覆盖率 > 90%

---

### T-03: 非流式自动续写（cursor-truncation.js + cursor-core.js 修改）

**优先级**: P0
**复杂度**: complex
**并行组**: G2
**依赖**: T-02
**预估工时**: 4h

**描述**:

在 `cursor-truncation.js` 中实现 `autoContinueFull()` 函数，在 `cursor-core.js` 的 `_collectFromH2` 方法中集成截断检测和续写逻辑。

**涉及文件**:
- `src/providers/cursor/cursor-truncation.js` — 添加 autoContinueFull
- `src/providers/cursor/cursor-core.js` — _collectFromH2 集成

**实施步骤**:

1. 在 `cursor-truncation.js` 中实现 `autoContinueFull(params)` 函数：
   - 参数：`{ fullText, model, accessToken, hasTools, maxContinue, systemPrompt, turns, mcpTools, blobStore }`
   - 循环调用 `isTruncated()` 检测
   - 通过 `buildCursorAgentRequest()` 构建续写请求（turns 中含已收集的 assistant 文本）
   - 通过 `h2RequestStream()` + promise 方式收集续写响应
   - 调用 `deduplicateContinuation()` 去重拼接
   - 达到 maxContinue 次数后停止
   - 返回最终完整文本

2. 在 `cursor-core.js` 的 `_collectFromH2` 的 Promise resolve 前：
   ```javascript
   h2Stream.on('end', async () => {
       // ... 现有清理逻辑
       let finalText = fullText;
       if (isTruncated(finalText, toolCalls.length > 0)) {
           finalText = await autoContinueFull({ ... });
       }
       resolve(buildResponse('stop', finalText));
   });
   ```

3. 需要将 `systemPrompt`、`userText`、原始 `mcpTools` 等上下文传递给 `autoContinueFull`，需要在 `_collectFromH2` 的调用处增加这些参数。

4. 续写时的 Protobuf 构建：
   - `turns` = 原始 turns + `{ userText: originalUserText, assistantText: fullText }` 最后一个
   - `userText` = continuationPrompt
   - `systemPrompt` = 原始 systemPrompt

**验收标准**:
- WHEN 非流式响应被截断 THEN 自动发起续写请求，最多 3 次（`CURSOR_MAX_AUTO_CONTINUE`）
- WHEN 续写达到上限 THEN 返回已收集的内容，不报错
- WHEN 续写内容与已有内容有重叠 THEN 去重后拼接，不出现重复段落
- 单元测试 mock H2 请求，验证续写逻辑

---

### T-04: 流式自动续写（cursor-truncation.js + cursor-core.js 修改）

**优先级**: P0
**复杂度**: complex
**并行组**: G2（可与 T-03 并行）
**依赖**: T-02
**预估工时**: 4h

**描述**:

在 `cursor-truncation.js` 中实现 `autoContinueStream()` 生成器函数，在 `cursor-core.js` 的 `_streamFromH2` 中集成，使流式客户端无感知地收到拼接后的完整流。

**涉及文件**:
- `src/providers/cursor/cursor-truncation.js` — 添加 autoContinueStream
- `src/providers/cursor/cursor-core.js` — _streamFromH2 集成

**实施步骤**:

1. 在 `cursor-truncation.js` 中实现 `autoContinueStream(params)` 异步生成器：
   - 参数同 `autoContinueFull`
   - 内部调用 `_streamFromH2`（或新的 H2 流工具）发起续写请求
   - yield 续写的 chunks（去重处理后）
   - 续写完成后 yield 带 `finish_reason: 'stop'` 的最终 chunk

2. 在 `cursor-core.js` 的 `_streamFromH2` 中：
   - 积累全部文本到 `accumulatedText`（不影响实时发送）
   - 在 `h2Stream.on('end')` 中：
     ```javascript
     h2Stream.on('end', () => {
         if (!mcpExecReceived && isTruncated(accumulatedText, ...)) {
             // 发起续写，yield 续写 chunks
             enqueue({ type: 'continue_needed', context: { ... } });
         }
         // ...
     });
     ```
   - 在 queue 消费循环中处理 `continue_needed`，调用 `autoContinueStream()`，yield 其 chunks

3. 续写期间客户端无感知：中间的续写请求对客户端透明，最终收到完整的 SSE 流。

**验收标准**:
- WHEN 流式请求被截断 THEN 客户端无感知地收到拼接后的完整流
- WHEN 截断位置在代码块中间 THEN 续写后代码块闭合完整
- WHEN 截断在 tool_calls 中间 THEN 续写后 tool_calls 完整可解析
- 流的结束 chunk（finish_reason: 'stop'）只发一次

---

## G3: 基础稳定性优化（P1，G2 完成后并行开始）

### T-05: 错误码精细映射（cursor-h2.js + cursor-core.js 修改）

**优先级**: P1
**复杂度**: medium
**并行组**: G3（可与 T-06、T-07 并行）
**依赖**: 无（独立）
**预估工时**: 1.5h

**描述**:

修改 `cursor-h2.js` 的 Connect Protocol 错误解析，添加完整的错误码到 HTTP 状态码映射表；修改 `cursor-core.js` 使用新的解析函数。

**涉及文件**:
- `src/providers/cursor/cursor-h2.js` — 新增 parseConnectErrorFrame
- `src/providers/cursor/cursor-core.js` — 使用新的错误解析函数

**实施步骤**:

1. 在 `cursor-h2.js` 中新增 `CONNECT_ERROR_HTTP_MAP` 常量（参考 design.md 3.3 节）。

2. 新增 `parseConnectErrorFrame(data)` 函数，替换现有 `parseConnectFrame`：
   - 提取 Connect error code
   - 映射为 HTTP 状态码
   - JSON 解析失败时返回 502 兜底
   - 返回 `{ error: Error, httpStatus: number } | null`

3. 修改 `cursor-core.js` 的 `_collectFromH2`：
   - 将 `reject(Object.assign(new Error(detail), { status: 400 }))` 替换为调用 `parseConnectErrorFrame()`

4. 修改 `cursor-core.js` 的 `_streamFromH2`：
   - 将 `parseConnectFrame(msgBytes)` 替换为 `parseConnectErrorFrame(msgBytes)`
   - 错误 chunk 中包含 HTTP 状态码信息

5. 保留 `parseConnectFrame` 函数并标记为 deprecated（保持向后兼容）。

**验收标准**:
- WHEN Cursor API 返回 `unauthenticated` THEN 客户端收到 HTTP 401
- WHEN Cursor API 返回 `resource_exhausted` THEN 客户端收到 HTTP 429
- WHEN Cursor API 返回 `invalid_argument` THEN 客户端收到 HTTP 400
- WHEN 错误帧 JSON 解析失败 THEN 返回 HTTP 502，不抛出解析异常
- 单元测试覆盖所有映射场景和兜底逻辑

---

### T-06: 会话超时优化（cursor-session.js 修改）

**优先级**: P1
**复杂度**: simple
**并行组**: G3
**依赖**: 无
**预估工时**: 0.5h

**描述**:

修改 `cursor-session.js` 将默认会话超时从 120s 增加到 600s，并支持通过环境变量 `CURSOR_SESSION_TIMEOUT_MS` 自定义。

**涉及文件**:
- `src/providers/cursor/cursor-session.js` — 修改超时常量

**实施步骤**:

1. 将 `SESSION_TIMEOUT_MS = 120_000` 替换为动态读取：
   ```javascript
   function getSessionTimeoutMs() {
       const envVal = process.env.CURSOR_SESSION_TIMEOUT_MS;
       if (envVal) {
           const parsed = parseInt(envVal, 10);
           if (!isNaN(parsed) && parsed > 0) return parsed;
       }
       return 600_000; // 默认 10 分钟
   }
   const SESSION_TIMEOUT_MS = getSessionTimeoutMs();
   ```

2. 更新 JSDoc 注释，说明新的默认值和配置方式。

3. 更新现有 `cursor-session.test.js` 中的超时相关测试用例（原来期望 120s，改为 600s）。

**验收标准**:
- 默认超时为 600000ms（10 分钟）
- 设置 `CURSOR_SESSION_TIMEOUT_MS=30000` 时超时为 30s
- 现有会话管理功能不受影响（saveSession/getSession/removeSession）
- 测试用例更新并通过

---

### T-07: 历史消息压缩（cursor-compression.js 新建 + cursor-core.js 集成）

**优先级**: P1
**复杂度**: complex
**并行组**: G3
**依赖**: 无（独立）
**预估工时**: 3h

**描述**:

新建 `src/providers/cursor/cursor-compression.js`，实现 OpenAI 格式消息的有损压缩；在 `cursor-core.js` 中集成，当启用时在 `parseMessages()` 前调用。

**涉及文件**:
- `src/providers/cursor/cursor-compression.js` — 新建
- `src/providers/cursor/cursor-core.js` — 集成入口

**实施步骤**:

1. 新建 `cursor-compression.js`，实现以下函数：

   a. `estimateMessageTokens(messages)` — token 估算（字符数 / 4）

   b. `compressMessage(msg, levelParams)` — 单条消息压缩：
      - `role: 'assistant'` + `tool_calls` → 摘要化工具名
      - `role: 'tool'` → 保留头尾，省略中间
      - 纯文本 → 在自然边界截断

   c. `compressMessages(messages, options)` — 主压缩函数（参考 design.md 3.5 节）：
      - 检查是否超过 `maxHistoryTokens` 阈值
      - 保留最近 `keepRecent` 条消息不压缩
      - 对其余消息调用 `compressMessage`

   d. `COMPRESSION_LEVEL_PARAMS` — 级别参数表（3 个级别）

2. 在 `cursor-core.js` 的 `generateContent()` 和 `generateContentStream()` 方法中：
   - 在 `parseMessages(requestBody.messages || [])` 之前，检查配置
   - 若 `CURSOR_COMPRESSION_ENABLED=true`，则调用 `compressMessages()`
   - 传递压缩后的 messages 给 `parseMessages()`

3. 配置读取：从 `this.config` 或 `process.env` 读取：
   - `CURSOR_COMPRESSION_ENABLED`（默认 false）
   - `CURSOR_COMPRESSION_LEVEL`（默认 2）
   - `CURSOR_COMPRESSION_KEEP_RECENT`（默认 6）
   - `CURSOR_MAX_HISTORY_TOKENS`（默认 120000）

**验收标准**:
- WHEN 消息总 token 数未超阈值 THEN 原样返回，不压缩
- WHEN 超过阈值 THEN tool_calls 消息被摘要化，保留工具名
- WHEN 超过阈值 THEN tool result 消息保留头尾，中间省略
- WHEN 超过阈值 THEN 最近 6 条消息完整保留
- WHEN `CURSOR_COMPRESSION_ENABLED=false`（默认）THEN 不执行任何压缩
- 单元测试覆盖各级别、各消息类型压缩场景

---

## G4: 体验优化（P2，G3 完成后并行开始）

### T-08: 流式增量释放（cursor-stream-guard.js 新建 + cursor-core.js 集成）

**优先级**: P2
**复杂度**: medium
**并行组**: G4（可与 T-09 并行）
**依赖**: 无（独立）
**预估工时**: 2.5h

**描述**:

新建 `src/providers/cursor/cursor-stream-guard.js`，实现预热缓冲 + 后卫缓冲的流式增量释放器；在 `cursor-core.js` 的 `_streamFromH2` 中集成（默认关闭）。

**涉及文件**:
- `src/providers/cursor/cursor-stream-guard.js` — 新建
- `src/providers/cursor/cursor-core.js` — _streamFromH2 集成

**实施步骤**:

1. 新建 `cursor-stream-guard.js`，移植 cursor2api `streaming-text.ts` 的 `createIncrementalTextStreamer` 为 JS 版本：
   - 实现 `createStreamGuard(options)` 工厂函数
   - 内部状态机：WARMUP → UNLOCKED（参考 design.md 3.6 节）
   - `push(chunk)` — 推入新内容，返回可立即发送的部分
   - `finish()` — 刷新剩余缓冲，返回最后的内容
   - `hasUnlocked()` — 是否已解锁
   - 保留 HTML 有效性检查（防止 HTML token 序列提前解锁）

2. 在 `cursor-core.js` 的 `_streamFromH2` 中：
   - 检查 `CURSOR_STREAM_GUARD_ENABLED`（默认 false）
   - 若启用，创建 `createStreamGuard()` 实例
   - 在非 thinking 文本的 `onText` 回调中通过 guard.push() 路由
   - 在 `h2Stream.on('end')` 中调用 `guard.finish()` 发送剩余内容

3. thinking 内容不经过 StreamGuard（thinking 是内部标签，无需缓冲）。

4. 配置读取：`CURSOR_STREAM_GUARD_ENABLED`、`CURSOR_WARMUP_CHARS`（默认 96）、`CURSOR_GUARD_CHARS`（默认 256）。

**验收标准**:
- WHEN `CURSOR_STREAM_GUARD_ENABLED=false`（默认）THEN 行为与原来完全相同
- WHEN 启用后预热阶段 THEN 前 96 字符不立即发送给客户端
- WHEN 预热内容包含异常前缀 THEN `isBlockedPrefix` 钩子可拦截
- WHEN 流结束 THEN `finish()` 释放所有剩余缓冲
- 后卫缓冲（guardChars=256）在实时发送阶段保留尾部不发
- 单元测试验证 WARMUP → UNLOCKED 状态转换

---

### T-09: 工具参数自动修复（cursor-tool-fixer.js 新建 + cursor-protobuf.js 集成）

**优先级**: P2
**复杂度**: medium
**并行组**: G4
**依赖**: 无（独立）
**预估工时**: 2h

**描述**:

新建 `src/providers/cursor/cursor-tool-fixer.js`，移植 cursor2api `tool-fixer.ts` 为 JS 版本；在 `cursor-protobuf.js` 的 `handleExecMessage` 中集成（默认开启）。

**涉及文件**:
- `src/providers/cursor/cursor-tool-fixer.js` — 新建
- `src/providers/cursor/cursor-protobuf.js` — handleExecMessage 集成

**实施步骤**:

1. 新建 `cursor-tool-fixer.js`，移植 cursor2api `tool-fixer.ts`：
   - 定义 `SMART_DOUBLE_QUOTES` 和 `SMART_SINGLE_QUOTES` 集合（Unicode 字符集）
   - 实现 `replaceSmartQuotes(text)` — 智能引号替换为 ASCII
   - 实现 `buildFuzzyPattern(text)` — 构建容错正则模式（内部函数）
   - 实现 `repairExactMatchToolArguments(toolName, args)` — 精确匹配修复：
     - 仅对 `str_replace`/`search_replace`/`strreplace` 工具生效
     - 读取目标文件，尝试精确匹配
     - 精确匹配失败时用模糊模式匹配
     - 唯一匹配时修复 old_string，多匹配/无匹配时原样返回（best-effort）
   - 实现 `fixToolCallArguments(toolName, args)` — 组合入口函数

2. 修改 `cursor-protobuf.js` 的 `handleExecMessage` 函数中 `mcpArgs` 分支：
   - 在 `decodeMcpArgsMap()` 返回后，检查配置 `CURSOR_TOOL_FIX_ENABLED`
   - 若启用，调用 `fixToolCallArguments(toolName, decodedArgs)`
   - **注意**：此时 args 是解码后的 JS 对象，而非 JSON 字符串

3. 配置传递：`handleExecMessage` 需要接受配置对象，或通过模块级变量读取。

4. 最终 `decodedArgs` 传给 `onMcpExec` 时转为 JSON 字符串（如现有逻辑）。

**验收标准**:
- WHEN 工具参数包含智能引号 THEN 替换为 ASCII 引号后传递给客户端
- WHEN StrReplace 的 old_string 精确匹配失败 THEN 尝试模糊匹配（空白变异、引号变异）
- WHEN 模糊匹配有唯一结果 THEN 自动修复 old_string 为精确文本
- WHEN 模糊匹配无结果或多结果 THEN 原参数原样传递（best-effort）
- WHEN 文件读取失败 THEN 不影响请求处理，原参数传递
- WHEN `CURSOR_TOOL_FIX_ENABLED=false` THEN 完全跳过修复逻辑
- 单元测试 mock 文件系统，验证所有修复场景

---

## G5: 图片降级（P3）

### T-10: 图片 OCR 降级（cursor-vision.js 新建 + cursor-core.js 集成）

**优先级**: P3
**复杂度**: complex
**并行组**: G5（G4 完成后开始）
**依赖**: 无（独立，但优先级低）
**预估工时**: 4h

**描述**:

新建 `src/providers/cursor/cursor-vision.js`，实现图片 OCR/Vision API 降级处理，适配 OpenAI 格式的 image_url 消息；在 `cursor-core.js` 中集成（默认关闭）。

**涉及文件**:
- `src/providers/cursor/cursor-vision.js` — 新建
- `src/providers/cursor/cursor-core.js` — 入口集成
- `package.json` — 添加可选依赖 tesseract.js

**实施步骤**:

1. 新建 `cursor-vision.js`，参考 cursor2api `vision.ts` 适配 OpenAI 格式：
   - 实现 `preprocessImages(messages, config)` — 主入口：
     - 找最后一条 user 消息中的图片（`image_url` content part）
     - 提取 base64 数据 / URL
     - 跳过 SVG 格式（附加文本说明）
     - 根据 `CURSOR_VISION_MODE` 分发到 OCR 或 Vision API

   - 实现 `processWithLocalOCR(images)` — 本地 OCR：
     - 动态 import `tesseract.js`（可选依赖，避免强制安装）
     - 支持 `eng+chi_sim` 双语识别
     - 调用 `worker.terminate()` 释放资源

   - 实现 `callVisionAPI(images, config)` — 外接 Vision API：
     - 发送 OpenAI vision 格式请求
     - 支持 `CURSOR_VISION_API_URL`、`CURSOR_VISION_API_KEY`、`CURSOR_VISION_MODEL`

   - 处理结果：将图片描述/OCR 文本注入为 user 消息的附加文本部分

2. 在 `cursor-core.js` 的 `generateContent()` 和 `generateContentStream()` 中，在 `parseMessages()` 之前：
   - 检查 `CURSOR_VISION_ENABLED`（默认 false）
   - 若启用，调用 `preprocessImages(messages, config)`

3. 添加 `tesseract.js` 为 package.json 的可选依赖（optionalDependencies）：
   ```json
   "optionalDependencies": {
       "tesseract.js": "^5.0.0"
   }
   ```

**验收标准**:
- WHEN `CURSOR_VISION_ENABLED=false`（默认）THEN 图片按原逻辑处理（base64 透传）
- WHEN 启用且 `CURSOR_VISION_MODE=ocr` THEN tesseract.js 提取文字，附加到消息文本
- WHEN 启用且 `CURSOR_VISION_MODE=api` THEN 调用外接 Vision API，返回图片描述
- WHEN 图片为 SVG 格式 THEN 跳过处理，附加说明文本
- WHEN tesseract.js 未安装 THEN 动态 import 失败时给出明确错误信息
- WHEN Vision API 调用失败 THEN 附加错误说明，不阻塞主请求

---

## 任务依赖图

```
T-01 (退化循环)
  └─→ T-02 (截断检测函数)
        ├─→ T-03 (非流式续写)
        └─→ T-04 (流式续写)

T-05 (错误码映射) ─┐
T-06 (会话超时)   ─┤ 并行执行
T-07 (消息压缩)   ─┘

T-08 (流式缓冲)  ─┐
T-09 (工具修复)  ─┘ 并行执行

T-10 (图片降级)    最后执行
```

---

## 测试文件清单

| 任务 | 新增测试文件 | 修改测试文件 |
|------|------------|------------|
| T-01 | `tests/unit/providers/cursor/cursor-degenerate.test.js` | `cursor-core.test.js`（添加集成测试） |
| T-02 | `tests/unit/providers/cursor/cursor-truncation.test.js` | — |
| T-03 | 在 `cursor-truncation.test.js` 中添加 | `cursor-core.test.js` |
| T-04 | 在 `cursor-truncation.test.js` 中添加 | `cursor-core.test.js` |
| T-05 | `tests/unit/providers/cursor/cursor-h2-errors.test.js` | `cursor-h2.test.js` |
| T-06 | — | `cursor-session.test.js`（更新超时值） |
| T-07 | `tests/unit/providers/cursor/cursor-compression.test.js` | — |
| T-08 | `tests/unit/providers/cursor/cursor-stream-guard.test.js` | — |
| T-09 | `tests/unit/providers/cursor/cursor-tool-fixer.test.js` | `cursor-protobuf.test.js` |
| T-10 | `tests/unit/providers/cursor/cursor-vision.test.js` | — |
