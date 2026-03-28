# 开发指南

本文档面向需要在本地开发、调试或扩展 AIClient-2-API 的开发者。

## 项目结构

```
AIClient-2-API/
├── src/
│   ├── core/               # 主进程与配置管理
│   │   ├── master.js       # 进程管理：拉起 worker、IPC、崩溃自动重启
│   │   └── config-manager.js  # 配置加载、合并、校验
│   ├── services/           # 核心服务
│   │   ├── api-server.js   # HTTP 服务（原生 http 模块，端口 3000）
│   │   ├── api-manager.js  # 请求分发与提供商路由
│   │   ├── service-manager.js  # 适配器生命周期管理
│   │   └── ui-manager.js   # 管理端 API 路由
│   ├── handlers/           # 请求处理
│   │   └── request-handler.js  # 中央请求分发
│   ├── providers/          # 各 AI 提供商适配
│   │   ├── adapter.js      # 适配器注册与工厂（ApiServiceAdapter）
│   │   ├── provider-models.js  # 各提供商支持的模型列表
│   │   ├── provider-pool-manager.js  # 多账号轮询、健康检查
│   │   ├── gemini/         # Gemini 系列适配器
│   │   ├── claude/         # Claude 系列适配器
│   │   ├── openai/         # OpenAI 系列适配器
│   │   ├── grok/           # Grok 适配器
│   │   ├── cursor/         # Cursor 适配器
│   │   └── forward/        # 透传适配器
│   ├── converters/         # 协议转换（策略模式）
│   │   ├── base-converter.js   # BaseConverter 基类
│   │   ├── converter-factory.js  # ConverterFactory 工厂
│   │   └── strategies/     # 各协议转换策略
│   ├── auth/               # OAuth 认证处理
│   ├── plugins/            # 插件系统
│   │   ├── default-auth/   # 默认鉴权插件
│   │   ├── ai-monitor/     # 监控插件
│   │   └── api-potluck/    # API 聚合插件
│   ├── ui-modules/         # 管理端 Web UI 后端接口（约 13 个模块）
│   └── utils/              # 工具函数
│       ├── common.js       # 常量定义（MODEL_PROVIDER、协议前缀等）
│       ├── logger.js       # 日志工具
│       ├── proxy-utils.js  # 代理工具
│       └── tls-sidecar.js  # Go uTLS sidecar 接口
├── configs/                # 运行时配置（JSON 文件，不纳入 Git）
│   ├── config.json         # 主配置
│   ├── provider_pools.json # 多账号池配置
│   └── token-store.json    # OAuth 令牌缓存
├── tests/
│   ├── unit/               # 单元测试
│   ├── integration/        # 集成测试（Mock 上游）
│   ├── e2e/api/            # API 端到端测试
│   ├── live/               # 真实服务测试（不纳入 CI）
│   └── helpers/            # 测试基础设施（stub 服务器）
├── static/                 # Web UI 前端静态资源
├── tls-sidecar/            # Go TLS sidecar 源码
├── Dockerfile
├── Makefile
└── package.json
```

## 启动开发模式

开发模式与生产模式的区别是传入 `--dev` 标志，启用更详细的错误输出：

```bash
pnpm run start:dev
```

如果只想启动单进程（不通过 master.js 管理 worker），适合调试时快速重启：

```bash
pnpm run start:standalone
```

## 请求链路

理解请求如何流经系统有助于调试和扩展：

```
入站请求
  → 插件中间件（default-auth 鉴权）
  → request-handler.js（路由判断）
  → api-manager.js（提供商选择）
  → ConverterFactory（协议转换：入站格式 → 提供商格式）
  → ApiServiceAdapter（调用对应提供商）
  → 流式 SSE 或一次性响应
```

## 模块说明

### 提供商（`src/providers/`）

每个提供商目录通常包含：

- `*-core.js`：实际发起 HTTP 请求的 Service 类，实现 `generateContent()` 和 `generateContentStream()`
- `*-strategy.js`：适配器策略，将 `ApiServiceAdapter` 接口委托给 core

新增提供商的详细步骤见 `docs/PROVIDER_ADAPTER_GUIDE.md`。

### 转换器（`src/converters/`）

使用策略模式。`ConverterFactory` 根据协议前缀（`gemini`、`openai`、`claude`、`codex`、`grok`、`forward`）选择具体转换策略。

### 插件（`src/plugins/`）

插件是可插拔中间件，在请求到达处理器前执行。插件列表在 `configs/plugins.json` 中配置，由 `src/core/plugin-manager.js` 加载。

### 多账号池（`provider-pool-manager.js`）

支持为同一提供商配置多个账号，自动轮询、健康检查和故障转移。账号池配置在 `configs/provider_pools.json` 中定义。

## 调试技巧

**查看详细日志**

将 `LOG_LEVEL` 设置为 `debug`：

```json
{ "LOG_LEVEL": "debug" }
```

**记录请求内容**

启用 prompt 日志：

```json
{ "PROMPT_LOG_MODE": "console" }
```

或输出到文件：

```json
{ "PROMPT_LOG_MODE": "file", "PROMPT_LOG_BASE_NAME": "prompt_log" }
```

**代理调试**

通过本地代理（如 Charles、Proxyman）抓包：

```json
{
  "PROXY_URL": "http://127.0.0.1:8888",
  "PROXY_ENABLED_PROVIDERS": ["gemini-cli-oauth"]
}
```

## 添加新功能

### 添加新提供商

1. 在 `src/utils/common.js` 的 `MODEL_PROVIDER` 对象中添加常量
2. 在 `src/providers/<name>/` 创建核心 Service 实现
3. 在 `src/providers/adapter.js` 注册适配器
4. 在 `src/providers/provider-models.js` 添加模型列表
5. 如需 OAuth，在 `src/auth/` 实现认证逻辑
6. 在前端 UI 文件（`static/app/`）中添加配置界面支持

### 添加新的协议转换器

1. 在 `src/converters/strategies/` 创建继承 `BaseConverter` 的新策略类
2. 在 `src/converters/converter-factory.js` 中注册新策略
3. 在 `src/utils/common.js` 的 `MODEL_PROTOCOL_PREFIX` 中添加对应前缀

### 添加新插件

1. 在 `src/plugins/<name>/` 创建插件目录
2. 实现标准插件接口（参考 `src/plugins/default-auth/`）
3. 在 `configs/plugins.json` 中注册插件

## 代码规范

- 所有源码使用 ES Module（`import`/`export`），不使用 CommonJS
- 源码注释以中文为主
- 异步操作使用 `async/await`
- 提供商 Core 代码必须抛出含 `status` 字段的标准错误，以触发号池的自动故障转移
- ESM 环境下 Mock 使用 `jest.unstable_mockModule()`，不能使用 `jest.mock()`

## TLS Sidecar

`src/utils/tls-sidecar.js` 是一个接口文件，调用 Go 编译的二进制 `tls-sidecar/`，用于绕过 Cloudflare 等服务的 TLS 指纹检测（如 Grok）。

在 Docker 镜像中 Go 二进制已自动编译。本地开发时如不需要此功能，保持 `TLS_SIDECAR_ENABLED: false` 即可。
