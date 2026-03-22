---
feature: cursor-provider
stage: review
reviewed_at: 2026-03-21
reviewer: spec-plan-reviewer (opus)
verdict: 需修改
---

# 审查报告: Cursor Provider 集成

> **整体评估**: **可实施（已修正）** — 2 个 P0 问题已在设计文档中修正，1 个 P0 为误报

---

## 1. 需求文档审查

**评分**: 7/10 — 基本完整，有遗漏

### P1-R1: 缺少 thinking/extended thinking 的需求描述

**问题**: Cursor 模型（如 claude-4-sonnet, composer-2）支持 reasoning/thinking 输出。cursor-auth 的 `cursor-fetch.ts` 中有 `thinkingDelta` 的处理逻辑，但需求文档没有提到 thinking 输出如何暴露给下游。

**建议**: 在需求 R3/R4 中补充：thinking 内容是否作为 `content` 的一部分输出（用 `<think>` 标签包裹），还是通过其他方式传递？对于 Claude Code 下游，thinking 输出是否有价值？

### P2-R1: 模型名称映射未提及

**问题**: Cursor 内部的模型名（如 `claude-4-sonnet`）与上游平台（NewAPI）使用的名称可能不一致。需求未涉及是否需要模型名映射。

**建议**: 考虑是否需要 `cursor:claude-4-sonnet` → `claude-sonnet-4-20250514` 的映射，或直接透传。

---

## 2. 设计文档审查

**评分**: 8/10 — 架构合理，关键问题需修正

### P0-D1: Protobuf Schema 移植方案有误

**问题**: 设计文档建议"去掉 TypeScript 类型注解即可转为 JS"，但实际 `agent_pb.ts` 使用的是 `@bufbuild/protobuf/codegenv2` 的 **编译时生成 API**：

```typescript
import { fileDesc, messageDesc, enumDesc } from "@bufbuild/protobuf/codegenv2";
const file_agent = fileDesc("CgVhZ2VudC...");  // 二进制编码的 proto descriptor
export const AgentClientMessageSchema = messageDesc(file_agent, 42);
```

这些 `fileDesc`/`messageDesc` 调用使用的是编码后的二进制 proto descriptor 字符串，**不是运行时 JS 对象**。它们天然就是 JS 兼容的（只需要 `@bufbuild/protobuf` 运行时），移植不需要"去掉类型注解"那么简单，也不需要手写 Schema。

**正确方案**:
1. 直接复制 `agent_pb.ts` 并重命名为 `agent_pb.js`
2. 去掉 TypeScript 的类型导入（`import type`）和类型注解（`: GenMessage<X>`）
3. 保留所有 `fileDesc`、`messageDesc`、`enumDesc` 调用和 Schema 导出
4. 去掉 `export type` 和 `export interface` 声明
5. 额外需要安装 `@bufbuild/protobuf` 的 `wkt`（Well-Known Types）子包，因为 `cursor-fetch.ts` 使用了 `ValueSchema` from `@bufbuild/protobuf/wkt`

**影响**: T2（移植 proto）的复杂度从 complex 降为 standard，工作量大幅减少。

### P0-D2: 非流式模式下 tool_calls 不被支持

**问题**: 设计文档描述了 `generateContent`（非流式）中的 tool_calls 处理。但审查 cursor-auth 源码发现，**`handleNonStreaming` 中 `onMcpExec` 回调是空函数 `() => {}`**（cursor-fetch.ts:705）。

这意味着 **Cursor 原始实现在非流式模式下静默忽略 tool_calls**。设计文档描述的非流式 tool_calls 支持是一个**不存在的功能**。

**建议**:
- 方案 A（推荐）：非流式模式下不支持 tool_calls，在 `generateContent` 中遇到 mcpArgs 时返回错误或仅返回文本部分
- 方案 B：自行实现非流式 tool_calls（收集所有 mcpArgs 后组装），但这会增加复杂度且未经原始实现验证

### ~~P0-D3: `getProtocolPrefix` 映射~~ → **已验证：设计正确，此为误报**

经完整追踪 `getProtocolPrefix` 调用链确认，`cursor-oauth → openai` 映射是正确的：
- `/v1/chat/completions`：`'openai' === 'openai'` → 不转换 → 直接到 cursor-core ✅
- `/v1/messages`：`'claude' !== 'openai'` → `ClaudeConverter.toOpenAIRequest()` → 转为 OpenAI → cursor-core ✅
- 响应回转：`OpenAIConverter.toClaudeStreamChunk()` → 转回 Claude 格式 ✅

`getProtocolPrefix` 定义在 `common.js:85-96`，使用 `-` 前缀提取规则。需添加特殊处理使 `cursor-oauth` 返回 `openai`（而非默认的 `cursor`）。

### P1-D1: 缺少 `@bufbuild/protobuf/wkt` 依赖说明

**问题**: cursor-fetch.ts 使用了 `ValueSchema` from `@bufbuild/protobuf/wkt`（用于 MCP tool 的 inputSchema 编解码）。设计文档的依赖分析只提到 `@bufbuild/protobuf`，未提到 `wkt` 子路径。

**建议**: `@bufbuild/protobuf` 包本身包含 `wkt` 子路径导出，不需要额外安装。但需要在 T6（cursor-protobuf.js）中明确 import `ValueSchema`。

### P1-D2: Session 超时设计 30 秒可能不够

**问题**: 设计设定 session 超时 30 秒。但在 Claude Code 场景中，tool_calls 的执行可能涉及文件操作、代码分析等，**执行时间可能超过 30 秒**。

**建议**: 将默认超时调整为 **120 秒**，或设为可配置参数。cursor-auth 原始实现没有硬编码超时，而是通过心跳保持连接。

### P1-D3: 心跳机制设计细节不足

**问题**: 设计提到"每 5 秒发送心跳"，但未说明心跳帧的内容。审查源码发现，cursor-auth 使用 `ClientHeartbeat` protobuf 消息（非空帧），包含 `AgentClientMessageSchema` 的 `heartbeat` case。

**建议**: 在 T6（cursor-protobuf.js）中明确 `buildHeartbeatBytes()` 的实现：
```js
create(AgentClientMessageSchema, { message: { case: 'heartbeat', value: create(ClientHeartbeatSchema, {}) } })
```

### P2-D1: 模型列表端点设计可优化

**问题**: 设计中 `listModels()` 在每次调用 `GET /v1/models` 时都可能发起 HTTP/2 请求到 Cursor API。对于 NewAPI 频繁拉取模型列表的场景，可能产生不必要的请求。

**建议**: 添加 TTL 缓存（如 5 分钟），避免频繁远程查询。

---

## 3. 任务文档审查

**评分**: 8/10 — 拆分合理，依赖关系准确

### P1-T1: T2 复杂度评估偏高

**问题**: 基于 P0-D1 的发现，T2（移植 Protobuf Schema）实际上是"复制+去除类型注解"的工作，不需要"手写 Schema"。应从 complex 降为 standard。

### P1-T2: 缺少 `@bufbuild/protobuf/wkt` 的验证任务

**问题**: T2 验收标准中没有验证 `ValueSchema` 的 import。如果 `wkt` 子路径导出有问题，会在 T6 才暴露。

**建议**: 在 T2 验收标准中加入：`import { ValueSchema } from '@bufbuild/protobuf/wkt'` 不报错。

### P2-T1: T14（端到端测试）的 tool_calls 场景需要真实 Cursor 账号

**问题**: tool_calls 测试（T14 场景 5）需要 Cursor API 返回 mcpArgs，这很难 mock。建议明确标注哪些测试需要真实账号。

---

## 4. 关键问题汇总

| 级别 | 编号 | 问题 | 影响 | 建议 |
|------|------|------|------|------|
| **P0** | D1 | Proto 移植方案描述有误 | T2 实施方向错误 | **已修正**：改为直接复制+去类型注解 |
| **P0** | D2 | 非流式 tool_calls 在源码中不支持 | T7 实施虚假功能 | **已修正**：非流式模式下跳过 tool_calls |
| ~~P0~~ | ~~D3~~ | ~~getProtocolPrefix 映射需验证~~ | ~~误报~~ | **已验证**：`cursor-oauth → openai` 映射正确 |
| **P1** | R1 | 缺少 thinking 输出需求 | 功能不完整 | 补充 thinking 处理策略 |
| **P1** | D1 | 缺少 wkt 依赖说明 | 编译错误 | 文档补充 |
| **P1** | D2 | Session 超时 30s 太短 | Claude Code tool 执行超时 | 调整为 120s |
| **P1** | D3 | 心跳帧内容未明确 | 实施时猜测 | 补充 heartbeat message 构建 |
| **P2** | R1 | 模型名映射未提及 | 下游命名不一致 | 确认映射策略 |
| **P2** | D1 | 模型列表缺少 TTL 缓存 | 频繁远程请求 | 添加 5 分钟缓存 |

---

## 5. 整体评估

### 优点
1. **架构方向正确**：不引入 CursorConverter、协议前缀映射为 openai 的决策合理
2. **模块拆分清晰**：6 个新模块职责分明，耦合度低
3. **充分参考源码**：设计文档大量引用 cursor-auth 的实现细节
4. **集成点识别完整**：14 个文件修改点基本无遗漏

### 已修正的问题
1. ✅ P0-D1: Proto 移植方案已修正为"直接复制+去类型注解"
2. ✅ P0-D2: 非流式 tool_calls 已标注为不支持
3. ✅ P0-D3: 验证为误报，设计正确
4. ✅ P1-R1: thinking 输出策略已补充（`<think>` 标签包裹）
5. ✅ P1-D2: Session 超时从 30s 调整为 120s
6. ✅ P1-D3: 心跳帧内容已明确（ClientHeartbeatSchema）
7. ✅ T2 复杂度从 complex 降为 standard

### 建议行动
**可以进入实施阶段。**
