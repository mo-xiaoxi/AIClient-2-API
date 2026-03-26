---
feature: cursor-provider-optimization
complexity: complex
generated_by: clarify
generated_at: 2026-03-26T12:00:00+08:00
version: 1
---

# 需求文档: Cursor Provider 全面优化

> **功能标识**: cursor-provider-optimization
> **复杂度**: complex
> **来源**: 对标 cursor2api (~/Desktop/cursor2api) 项目，借鉴其工程实践优化我们的 Cursor Provider

## 1. 概述

### 1.1 一句话描述

对标 cursor2api 项目的成熟工程实践，为 AIClient-2-API 的 Cursor Provider 补齐截断检测、退化循环防护、历史消息压缩等 8 项核心能力，使其达到与 Gemini/Claude Provider 同等的稳定性和体验水平。

### 1.2 核心价值

当前 Cursor Provider 核心功能（HTTP/2 + Protobuf + OAuth + Tool Calls）已完整实现，但缺少生产级的防护机制和体验优化。cursor2api 虽走不同技术路线（免费文档接口 vs 正式 Agent 协议），但其在流式处理、截断恢复、上下文管理等方面积累了大量实战经验，值得借鉴。

### 1.3 目标用户

- 通过 AIClient-2-API 使用 Cursor 模型的 Claude Code / OpenAI 兼容客户端用户
- 长对话、重度 Tool Calls 场景的开发者

## 2. 需求与用户故事

### 2.1 需求清单

| ID | 需求点 | 优先级 | 用户故事 |
|----|--------|--------|---------|
| R1 | 截断检测与自动续写 | P0 | 作为用户，当模型因 max_tokens 截断响应时，系统应自动检测并续写，让我收到完整内容 |
| R2 | 退化循环检测 | P0 | 作为用户，当模型陷入重复输出（如反复输出 `</s>`）或 Tool Call 死循环时，系统应自动中止并返回已有内容 |
| R3 | 错误码精细映射 | P1 | 作为用户，当 Cursor API 返回错误时，我应收到准确的 HTTP 状态码（401/429/500），而非统一的 400 |
| R4 | 会话超时优化 | P1 | 作为用户，当 Tool Call 处理需要较长时间时，会话不应在 120 秒后自动过期导致续话失败 |
| R5 | 历史消息压缩 | P1 | 作为用户，在长对话中系统应自动压缩早期消息以节省上下文窗口，保留近期消息完整 |
| R6 | 流式增量释放 | P2 | 作为用户，流式响应应有预热缓冲机制，避免异常内容（错误前缀、身份泄漏）直接发送给客户端 |
| R7 | 工具参数自动修复 | P2 | 作为用户，当模型生成的工具参数有轻微格式问题（智能引号、空白变异）时，系统应自动修复 |
| R8 | 图片 OCR 降级 | P3 | 作为用户，当 Cursor 不支持直接处理图片时，系统应通过本地 OCR 或外接 Vision API 降级处理 |

### 2.2 验收标准

#### R1: 截断检测与自动续写

- WHEN 模型响应在代码块中间截断（``` 不配对）THEN 系统检测到截断并自动发起续写请求
- WHEN 模型响应在 JSON/XML 标签中间截断 THEN 系统检测到截断并自动续写
- WHEN 续写达到最大次数（默认 3 次）THEN 停止续写，返回已收集的内容
- WHEN 非流式请求被截断 THEN 同样触发自动续写
- WHEN 流式请求被截断 THEN 客户端无感知地收到拼接后的完整流

#### R2: 退化循环检测

- WHEN 同一 delta token 连续重复 8 次以上 THEN 自动中止流，返回已有内容
- WHEN HTML 类 token（`<br>`, `</s>`, `&nbsp;`）跨 chunk 拼接后检测到重复 THEN 中止
- WHEN Tool Call 同一工具被连续调用 3 次且参数相同 THEN 中止循环，返回错误提示
- WHEN Tool Call 深度超过 10 层 THEN 中止，返回错误提示

#### R3: 错误码精细映射

- WHEN Cursor API 返回 `unauthenticated` 错误 THEN 映射为 HTTP 401
- WHEN Cursor API 返回 `resource_exhausted` 错误 THEN 映射为 HTTP 429
- WHEN Cursor API 返回 `invalid_argument` 错误 THEN 映射为 HTTP 400
- WHEN Cursor API 返回未知错误 THEN 映射为 HTTP 502（上游错误）
- WHEN 错误帧 JSON 结构变化 THEN 有兜底解析逻辑，不会抛出解析异常

#### R4: 会话超时优化

- WHEN 保存会话时 THEN 默认超时从 120s 增加到 600s（10 分钟）
- WHEN 通过配置 `CURSOR_SESSION_TIMEOUT_MS` 环境变量 THEN 可自定义超时时长
- WHEN 会话即将过期但有活跃心跳 THEN 自动延长超时

#### R5: 历史消息压缩

- WHEN 消息总 token 数超过阈值（默认 120k tokens）THEN 自动压缩早期消息
- WHEN 压缩工具调用消息 THEN 保留工具名称摘要，删除详细参数
- WHEN 压缩工具结果消息 THEN 保留头尾内容，中间部分省略
- WHEN 压缩纯文本消息 THEN 在自然边界（换行）处截断
- WHEN 最近 N 条消息（默认 6 条）THEN 保留完整，不压缩
- WHEN 压缩功能通过配置关闭 THEN 不执行任何压缩

#### R6: 流式增量释放

- WHEN 流式响应开始 THEN 缓冲前 96 字符（预热阶段）
- WHEN 预热内容包含错误/拒绝前缀 THEN 不释放缓冲，标记异常
- WHEN 预热检查通过 THEN 解锁并开始逐块发送
- WHEN 正常发送阶段 THEN 保留尾部 256 字符作为后卫缓冲
- WHEN 流结束 THEN 一次性释放剩余缓冲内容

#### R7: 工具参数自动修复

- WHEN 工具参数包含智能引号（`""''`）THEN 替换为 ASCII 引号
- WHEN StrReplace 工具的 `old_string` 精确匹配失败 THEN 尝试模糊匹配（忽略空白变异）
- WHEN 模糊匹配有唯一结果 THEN 自动替换为精确文本
- WHEN 模糊匹配有多个结果或无结果 THEN 返回原参数（best-effort）

#### R8: 图片 OCR 降级

- WHEN 消息包含图片且 Cursor 不支持直接处理 THEN 通过配置的降级方式处理
- WHEN 配置为 `ocr` 模式 THEN 使用 tesseract.js 本地 OCR 提取文本
- WHEN 配置为 `api` 模式 THEN 调用外部 Vision API（OpenAI 等）描述图片
- WHEN 遇到 SVG 格式图片 THEN 跳过 OCR 处理（避免崩溃）
- WHEN 降级功能通过配置关闭 THEN 图片按原逻辑处理（base64 透传）

## 3. 功能验收清单

| ID | 功能点 | 验收步骤 | 优先级 |
|----|--------|---------|--------|
| F1 | 截断检测 - 代码块 | 发送请求生成长代码 → 验证 ``` 配对完整 | P0 |
| F2 | 截断检测 - JSON/XML | 发送请求生成 JSON → 验证括号/标签闭合 | P0 |
| F3 | 截断自动续写 - 流式 | stream=true 长输出 → 验证客户端收到完整内容无中断 | P0 |
| F4 | 截断自动续写 - 非流式 | stream=false 长输出 → 验证返回完整内容 | P0 |
| F5 | 退化循环 - token 重复 | 触发重复输出场景 → 验证自动中止 | P0 |
| F6 | 退化循环 - Tool Call | 触发循环 tool_calls → 验证深度限制生效 | P0 |
| F7 | 错误码映射 - 401 | 使用过期 token → 验证返回 401 | P1 |
| F8 | 错误码映射 - 429 | 触发限流 → 验证返回 429 | P1 |
| F9 | 错误码映射 - 兜底 | 构造未知错误 → 验证返回 502 | P1 |
| F10 | 会话超时 - 默认值 | 验证默认超时 600s | P1 |
| F11 | 会话超时 - 可配置 | 设置环境变量 → 验证超时值生效 | P1 |
| F12 | 消息压缩 - 工具调用 | 发送含大量 tool_calls 历史 → 验证早期调用被摘要化 | P1 |
| F13 | 消息压缩 - 纯文本 | 发送超长对话 → 验证早期消息被截断 | P1 |
| F14 | 消息压缩 - 保留近期 | 发送超长对话 → 验证最近 6 条消息完整保留 | P1 |
| F15 | 流式缓冲 - 预热 | 流式响应 → 验证前 96 字符有缓冲 | P2 |
| F16 | 流式缓冲 - 后卫 | 流式响应 → 验证尾部 256 字符在结束时释放 | P2 |
| F17 | 工具修复 - 智能引号 | 发送含智能引号的 tool_call → 验证替换为 ASCII | P2 |
| F18 | 工具修复 - 模糊匹配 | StrReplace 精确匹配失败 → 验证模糊匹配成功 | P2 |
| F19 | 图片 OCR - 本地 | 发送图片消息 → 验证 OCR 提取文本 | P3 |
| F20 | 图片 OCR - 外接 API | 配置 Vision API → 验证图片描述返回 | P3 |

## 4. 技术约束

### 4.1 技术栈

- **语言**: JavaScript (ES Modules)
- **运行时**: Node.js >= 20.0.0
- **现有模块**: 修改 `src/providers/cursor/` 下已有文件，新增工具类
- **依赖**: 尽量使用现有依赖，OCR 降级需新增 `tesseract.js`（可选，P3）
- **测试**: Jest，遵循现有 `tests/unit/providers/cursor/` 结构

### 4.2 集成点

| 集成点 | 说明 |
|--------|------|
| `cursor-core.js` | 截断检测、退化循环检测、流式缓冲的主要修改点 |
| `cursor-protobuf.js` | 消息压缩逻辑（在 `parseMessages` 或 `buildCursorAgentRequest` 中） |
| `cursor-session.js` | 会话超时优化 |
| `cursor-h2.js` | 错误码映射（Connect Protocol 错误帧解析） |
| 新文件 `cursor-stream-guard.js` | 流式增量释放（预热+缓冲+后卫） |
| 新文件 `cursor-tool-fixer.js` | 工具参数自动修复 |
| 新文件 `cursor-truncation.js` | 截断检测与自动续写逻辑 |
| 新文件 `cursor-compression.js` | 历史消息压缩 |
| `common.js` 或配置 | 新增配置项（压缩级别、超时时长、开关等） |

### 4.3 配置项设计（参考 cursor2api）

```javascript
// 环境变量或 config.json 配置
{
  // 截断与续写
  "CURSOR_MAX_AUTO_CONTINUE": 3,          // 最大自动续写次数

  // 退化循环
  "CURSOR_MAX_REPEAT_TOKENS": 8,          // token 重复阈值
  "CURSOR_MAX_TOOL_CALL_DEPTH": 10,       // tool call 深度上限

  // 会话超时
  "CURSOR_SESSION_TIMEOUT_MS": 600000,    // 10 分钟

  // 消息压缩
  "CURSOR_COMPRESSION_ENABLED": false,    // 默认关闭
  "CURSOR_COMPRESSION_LEVEL": 2,          // 1=轻度, 2=中等, 3=激进
  "CURSOR_COMPRESSION_KEEP_RECENT": 6,    // 保留最近消息数
  "CURSOR_MAX_HISTORY_TOKENS": 120000,    // 历史 token 上限

  // 流式缓冲
  "CURSOR_STREAM_GUARD_ENABLED": false,   // 默认关闭
  "CURSOR_WARMUP_CHARS": 96,             // 预热缓冲字符数
  "CURSOR_GUARD_CHARS": 256,             // 后卫缓冲字符数

  // 工具修复
  "CURSOR_TOOL_FIX_ENABLED": true,       // 默认开启

  // 图片降级
  "CURSOR_VISION_ENABLED": false,         // 默认关闭
  "CURSOR_VISION_MODE": "ocr",           // ocr | api
  "CURSOR_VISION_API_URL": "",            // 外接 Vision API 地址
  "CURSOR_VISION_API_KEY": "",            // 外接 Vision API 密钥
  "CURSOR_VISION_MODEL": "gpt-4o-mini"   // Vision 模型
}
```

### 4.4 cursor2api 关键参考文件

| 我们的需求 | cursor2api 参考文件 | 核心函数/逻辑 |
|-----------|-------------------|-------------|
| R1 截断检测 | `src/handler.ts` | `isTruncated()`, `shouldAutoContinueTruncatedToolResponse()` |
| R1 自动续写 | `src/handler.ts` | `autoContinueCursorToolResponseStream()` |
| R2 退化循环 | `src/cursor-client.ts` | 重复 delta 检测（8次阈值） |
| R5 消息压缩 | `src/converter.ts` | `compressMessages()`, `estimateInputTokens()` |
| R6 流式释放 | `src/streaming-text.ts` | `StreamingTextManager`（预热+缓冲+后卫） |
| R7 工具修复 | `src/tool-fixer.ts` | `fixToolCallArguments()`, `repairExactMatchToolArguments()` |
| R8 图片降级 | `src/vision.ts` | `preprocessImages()`, `processWithLocalOCR()`, `callVisionAPI()` |

## 5. 排除项

- **拒绝检测与重试**: cursor2api 的 50+ 拒绝模式正则和认知重构提示词注入是针对免费文档接口的对抗策略，我们使用正式 Agent 协议不需要
- **身份探针拦截**: 同上，正式协议不存在身份伪装问题
- **提示词清洗/身份清洗**: 同上
- **日志系统 Web UI**: 我们已有管理端 UI，不需要移植 cursor2api 的日志查看器
- **CursorConverter 类**: 当前 Cursor 直接映射 OpenAI 协议，暂不需要单独的 Converter
- **Connect Protocol 压缩**: HTTP/2 层面压缩优先级低，暂不考虑

## 6. 设计参考

### 6.1 截断检测算法（参考 cursor2api `isTruncated()`）

```
检测优先级（从高到低）：
1. JSON Action 块未闭合 — 计数 ```json action 开启/闭合标记
2. 通用代码块 — 行首 ``` 计数不配对
3. XML/HTML 标签 — 开标签 > 闭标签 + 1
4. 句法完整性 — 以逗号/冒号/开括号结尾
5. 短响应豁免 — < 500 chars 以小写字母结尾不判断截断
```

### 6.2 消息压缩策略（参考 cursor2api `compressMessages()`）

```
级别参数映射：
| 级别 | keep_recent | max_chars | brief_len |
|------|------------|-----------|-----------|
| 1    | 10         | 4000      | 500       |
| 2    | 6          | 2000      | 300       |
| 3    | 4          | 1000      | 150       |

压缩规则：
- 工具调用消息 → "[Executed: tool1, tool2] (N chars compressed)"
- 工具结果消息 → "Head...\n[middle N chars omitted]\nTail"
- 纯文本消息 → 在自然边界截断
- 近期消息 → 完整保留
```

### 6.3 流式增量释放（参考 cursor2api `StreamingTextManager`）

```
预热阶段（96 字符）→ 检查拒绝前缀 → 锁定/解锁
  ├─ 若异常 → 保留缓冲，标记
  └─ 否则解锁，开始逐块发送

输出阶段
  ├─ 每次保留尾部 256 字符不发送（后卫缓冲）
  └─ 超过缓冲时触发发送

完成阶段
  └─ finish() 时剩余文本一次性释放
```

## 7. 下一步

1. 使用 `/devagent:dev-spec-dev cursor-provider-optimization --skip-requirements` 进入设计和实施阶段
2. 按 P0 → P1 → P2 → P3 优先级分批实施
3. 每个需求点独立编写单元测试
