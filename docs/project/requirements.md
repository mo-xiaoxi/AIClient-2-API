# AIClient-2-API — 项目需求概述

本文档从现有代码实现逆向整理，描述系统的功能需求、非功能需求及技术约束。

## 1. 功能需求

### 1.1 多协议接入

- **FR-01** 提供 OpenAI Chat Completions 兼容端点（`/v1/chat/completions`）
- **FR-02** 提供 Anthropic Messages 兼容端点（`/v1/messages`）
- **FR-03** 提供 Google Gemini 原生端点（`/v1beta/models/{model}:generateContent`）
- **FR-04** 提供 OpenAI Responses API 端点（`/v1/responses`），含 WebSocket 支持

### 1.2 多提供商支持

- **FR-05** 支持 16+ 种 AI 提供商（Gemini、Claude、OpenAI、Grok、Cursor、Copilot、Kiro、Qwen、Codex、CodeBuddy、Kimi、GitLab、Kilo 等）
- **FR-06** 通过 HTTP Header 或 URL 路径前缀动态切换提供商

### 1.3 协议双向转换

- **FR-07** OpenAI → Gemini 请求转换（角色映射、消息合并、缺失字段修复）
- **FR-08** OpenAI → Claude 请求转换（系统提示提取、消息结构转换）
- **FR-09** 响应反向转换为客户端期望格式
- **FR-10** 转换逻辑通过策略模式实现（`ConverterFactory` + `BaseConverter`）

### 1.4 流式响应

- **FR-11** 所有推理端点支持 SSE 流式响应
- **FR-12** 流式期间禁用请求超时
- **FR-13** Codex 提供商支持 WebSocket 双向流

### 1.5 号池与多账号管理

- **FR-14** 同一提供商多账号轮询调度
- **FR-15** 健康检查 + 自动故障转移
- **FR-16** `auto` 模式自动路由到匹配提供商
- **FR-17** 管理端支持手动健康检查和批量操作

### 1.6 OAuth 令牌管理

- **FR-18** 支持 Base64、文件路径、自动发现三种凭据加载方式
- **FR-19** 自动刷新过期令牌（默认 15 分钟检查）
- **FR-20** 管理端上传 OAuth 凭据
- **FR-21** 批量导入 Token（SSE 进度反馈，上限 1000 条/批次）

### 1.7 服务认证与插件

- **FR-25** 三种 API Key 传递方式
- **FR-26** 管理端独立密码认证
- **FR-28** 可扩展插件架构（auth + 中间件）

### 1.8 管理端

- **FR-30** 内置 Web 管理界面
- **FR-34** 命令行参数 + 配置文件双模式
- **FR-35** 热重载配置

## 2. 非功能需求

### 2.1 性能

- **NFR-01** 最大 1000 路并发连接
- **NFR-02** Keep-Alive 超时 65 秒
- **NFR-03** 流式请求无超时限制

### 2.2 可靠性

- **NFR-05** 网络错误自动捕获，不退出进程
- **NFR-06** 优雅关闭（SIGTERM/SIGINT），最长等待 10 秒
- **NFR-07** Worker 崩溃后 Master 自动重启
- **NFR-08** 请求失败自动重试（最多 3 次，指数退避）

### 2.3 安全

- **NFR-09** 管理端 API Token 验证
- **NFR-10** 批量导入接口数量上限（1000 条）
- **NFR-12** TLS Sidecar 绕过指纹检测

### 2.4 可观测性

- **NFR-13** 请求级 ID + 日志上下文隔离
- **NFR-15** `/health` 和 `/provider_health` 监控端点
- **NFR-16** 日志下载和清空功能

### 2.5 可扩展性

- **NFR-17** 新增提供商无需修改核心路由
- **NFR-18** 新增协议转换无需修改现有代码
- **NFR-19** 认证和请求处理通过插件扩展

## 3. 技术约束

| 约束项 | 约束内容 |
|--------|---------|
| 运行时 | Node.js >= 20.0.0（ES Module 原生支持） |
| 语言 | JavaScript（ES Modules），注释以中文为主 |
| 包管理 | pnpm |
| HTTP 框架 | 原生 `node:http`，无 Web 框架 |
| 测试框架 | Jest + Babel（ESM 转换） |
| 容器化 | Docker，配置目录 Volume 挂载 |
| 持久化 | 无数据库，`configs/*.json` 文件存储 |
| TLS 绕过 | Go 编译的 TLS Sidecar（uTLS） |
| 并发模型 | Master-Worker 进程架构 |
| 最大连接数 | 1000 |
