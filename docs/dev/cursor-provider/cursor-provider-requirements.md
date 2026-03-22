---
feature: cursor-provider
complexity: complex
generated_by: clarify
generated_at: 2026-03-21T00:00:00Z
version: 1
---

# 需求文档: Cursor Provider 集成

> **功能标识**: cursor-provider
> **复杂度**: complex

## 1. 概述

### 1.1 一句话描述

将 Cursor 作为新的 AI Provider 集成到 AIClient-2-API，通过 PKCE OAuth 认证和 HTTP/2 Connect + Protobuf 协议，将 Cursor 订阅内的模型（Claude、GPT、Gemini 等）暴露为标准 OpenAI 兼容 API。

### 1.2 核心价值

- 用户可通过已有的 Cursor 订阅免费使用多种高级 AI 模型
- **主要场景：为 Claude Code 提供模型代理**，通过 OpenAI 格式（`/v1/chat/completions`）和 Claude 格式（`/v1/messages`）双协议支持
- 同时兼容 Cherry-Studio、NextChat、Cline 等其他工具
- 支持多账号池轮换，提高可用性和吞吐量

### 1.3 目标用户

已有 Cursor 订阅的开发者，**主要希望将 Cursor 模型代理给 Claude Code 使用**，同时支持其他第三方 AI 工具接入。

## 2. 需求与用户故事

### 2.1 需求清单

| ID | 需求点 | 优先级 | 用户故事 |
|----|--------|--------|----------|
| R1 | Cursor OAuth 登录 | P0 | 作为用户，我希望通过 Web UI 一键触发 Cursor 浏览器登录，自动完成认证 |
| R2 | Token 自动刷新 | P0 | 作为用户，我希望系统自动刷新过期的 Cursor token，无需手动重新登录 |
| R3 | 文本对话（非流式） | P0 | 作为用户，我希望通过 OpenAI 兼容 API 发送文本对话请求到 Cursor |
| R4 | 流式对话 | P0 | 作为用户，我希望获得 SSE 流式响应，与其他 Provider 体验一致 |
| R5 | 模型动态发现 | P1 | 作为用户，我希望系统自动获取我 Cursor 账号可用的模型列表 |
| R6 | 图片输入支持 | P1 | 作为用户，我希望在对话中发送图片，支持多模态模型 |
| R7 | 工具调用（tool_calls） | P1 | 作为用户，我希望支持 function calling / tool_calls 能力 |
| R8 | 多账号池 | P1 | 作为用户，我希望配置多个 Cursor 账号，系统自动轮换和故障转移 |
| R9 | Web UI 集成 | P2 | 作为用户，我希望在管理面板中配置和监控 Cursor Provider |
| R10 | 用量追踪 | P2 | 作为用户，我希望看到 Cursor 账号的请求用量统计 |

### 2.2 验收标准

| ID | 条件 |
|----|------|
| AC1 | WHEN 用户在 Web UI 点击 Cursor 登录按钮 THEN 浏览器打开 Cursor 授权页面，完成后自动获取 token 并保存 |
| AC2 | WHEN token 即将过期（<5 分钟） THEN 系统自动使用 refresh_token 刷新，无中断 |
| AC3 | WHEN 客户端发送 `POST /v1/chat/completions`（stream=false） THEN 返回标准 OpenAI 格式的完整响应 |
| AC4 | WHEN 客户端发送 `POST /v1/chat/completions`（stream=true） THEN 返回标准 SSE 格式的流式响应 |
| AC5 | WHEN 客户端发送 `GET /v1/models` THEN 返回 Cursor 账号可用的模型列表（OpenAI 格式） |
| AC6 | WHEN 请求消息包含 base64 图片 THEN 图片正确传递到 Cursor API 并获得多模态响应 |
| AC7 | WHEN 模型返回 tool_calls THEN 正确解析 Protobuf 中的工具调用并转换为 OpenAI tool_calls 格式 |
| AC8 | WHEN 配置多个 Cursor 账号 THEN 系统按 round-robin 轮换，某账号异常时自动跳过 |

## 3. 功能验收清单

| ID | 功能点 | 验收步骤 | 优先级 |
|----|--------|----------|--------|
| F1 | OAuth 登录流程 | 1. Web UI 点击登录 → 2. 浏览器跳转 Cursor → 3. 授权完成 → 4. token 自动保存 | P0 |
| F2 | 基础文本对话 | 1. 配置 Cursor Provider → 2. 发送 chat/completions 请求 → 3. 收到正确响应 | P0 |
| F3 | 流式响应 | 1. stream=true 发送请求 → 2. 收到 SSE 事件流 → 3. 正确的 [DONE] 结束 | P0 |
| F4 | 模型列表查询 | 1. GET /v1/models → 2. 返回包含 cursor 模型的列表 | P1 |
| F5 | 图片输入 | 1. 消息中包含 base64 图片 → 2. 多模态模型正确处理图片 → 3. 返回关于图片的回复 | P1 |
| F6 | 工具调用 | 1. 请求包含 tools 定义 → 2. 模型返回 tool_calls → 3. 格式符合 OpenAI 规范 | P1 |
| F7 | 多账号池管理 | 1. 在 provider_pools.json 配置多账号 → 2. 请求自动轮换 → 3. 异常账号自动隔离 | P1 |
| F8 | Token 自动刷新 | 1. 等待 token 接近过期 → 2. 系统自动刷新 → 3. 无中断服务 | P0 |
| F9 | Web UI 配置面板 | 1. 管理面板显示 Cursor Provider → 2. 可触发登录/登出 → 3. 显示连接状态 | P2 |

## 4. 技术约束

### 4.1 技术栈

- **语言**: JavaScript (ES6+ modules)，与现有项目保持一致
- **协议**: HTTP/2 Connect + Protobuf（`@bufbuild/protobuf`）
- **认证**: PKCE OAuth 2.0（浏览器跳转 + 轮询模式）
- **API 端点**:
  - `https://api2.cursor.sh/agent.v1.AgentService/Run` — 主对话接口
  - `https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels` — 模型发现
  - `https://api2.cursor.sh/auth/poll` — OAuth 轮询
  - `https://api2.cursor.sh/auth/exchange_user_api_key` — Token 刷新

### 4.2 集成点

- **Provider 注册**: `src/providers/adapter.js` — 注册 CursorApiServiceAdapter
- **模型注册**: `src/providers/provider-models.js` — 添加 Cursor 支持的模型
- **协议转换**: `src/converters/strategies/` — 新增 CursorConverter
- **OAuth**: `src/auth/` — 新增 cursor-oauth.js
- **Provider Pool**: `src/providers/provider-pool-manager.js` — 添加 Cursor 健康检查
- **配置映射**: `src/utils/provider-utils.js` — PROVIDER_MAPPINGS
- **前端 UI**: `static/` — 配置面板、登录按钮、状态显示

### 4.3 关键约束

- Protobuf 消息定义需从 cursor-auth 的 `proto/agent_pb.ts` 移植为 JS 版本
- HTTP/2 Connect 帧格式: `[flags(1)][length(4)][message(N)]`，flags `0x02` = EOS
- 需要心跳机制（每 5 秒），保持长连接存活
- Cursor 原生工具调用需被拒绝，仅透传标准 tool_calls

## 5. 排除项

- 不实现 Cursor 原生的文件系统/Shell 工具（readArgs、shellArgs 等）
- 不实现 MCP 工具路由（这是 Alma 特有的功能）
- 不做 Cursor 的 IDE 集成功能
- 不处理 Cursor 的计费/额度限制管理

## 6. 下一步

1. 执行 `/devagent:dev:spec-dev cursor-provider --skip-requirements` 进入设计和实施阶段
2. 设计阶段产出 `cursor-provider-design.md`（架构设计）和 `cursor-provider-tasks.md`（任务拆解）
3. 按 TDD 流程实施，优先完成 P0 功能（OAuth + 基础对话 + 流式）
