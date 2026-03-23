# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中协作时的说明与约定。

## 项目概览

AIClient-2-API 是一个 Node.js API 代理服务，将仅客户端可用的 AI 模型接口（如 Gemini CLI、Antigravity、Qwen Code、Kiro、Grok、Codex 等）转换为标准 OpenAI 兼容接口，并在 OpenAI、Claude、Gemini、Grok、Codex 等协议之间做转换。

- **语言：** JavaScript（ES Modules，`"type": "module"`）
- **运行时：** Node.js ≥ 20.0.0
- **包管理：** pnpm
- **无 Web 框架：** HTTP 服务使用原生 `http` 模块

## 常用命令

```bash
# 运行（主进程管理 worker、自动重启）
pnpm start                    # node src/core/master.js
pnpm run start:standalone     # node src/services/api-server.js（直连，无主进程）
pnpm run start:dev            # 开发模式

# 测试
pnpm test                     # 单元测试（tests/unit）
pnpm test tests/unit/some-file.test.js  # 单文件
pnpm run test:watch           # 监听（单元）
pnpm run test:coverage        # 覆盖率（单元）
pnpm run test:unit            # 同 pnpm test
pnpm run test:integration     # 模拟上游全栈（tests/integration）
pnpm run test:e2e             # API 端到端（tests/e2e/api）
pnpm run test:integration:live  # 对接真实服务（tests/live/api-integration.test.js）
pnpm run test:all             # 单元 + 集成（不含 live / 与 API E2E 重复路径）
pnpm run test:ui              # Playwright 管理端（先执行 pnpm run test:ui:install）

# Docker
docker run -d -p 3000:3000 -v "path:/app/configs" justlikemaki/aiclient-2-api
```

## 架构

### 入口

- `src/core/master.js` — 主进程：拉起 worker、IPC、崩溃自动重启
- `src/services/api-server.js` — Worker / 独立模式 HTTP 服务，默认端口 3000

### 请求链路

入站请求 → 插件鉴权中间件 → `request-handler.js` 路由 → `api-manager.js` → 协议转换（`converters/`）→ 提供商适配（`providers/`）→ 流式或一次性返回

### 主要目录

| 目录 | 说明 |
|------|------|
| `src/providers/` | 各提供商适配（Gemini、Claude、OpenAI、Grok、Forward 等），实现 `ApiServiceAdapter` |
| `src/converters/` | 协议转换（策略模式）— `BaseConverter` → 具体策略（如 `ClaudeConverter`、`GeminiConverter`），经 `ConverterFactory` 创建 |
| `src/auth/` | 各提供商 OAuth（Gemini、Qwen、Kiro、Codex、Antigravity、Grok 等） |
| `src/handlers/` | 中央请求分发 |
| `src/services/` | API 服务、UI 管理、API 管理、服务管理、用量统计等 |
| `src/core/` | 主进程、配置管理、插件管理 |
| `src/plugins/` | 插件（如 default-auth、ai-monitor、api-potluck） |
| `src/ui-modules/` | 管理端 Web UI 后端 API（约 13 个模块） |
| `src/utils/` | 日志、常量、代理、令牌、TLS sidecar 等 |
| `configs/` | JSON 配置（config.json、provider_pools.json、token-store.json 等） |
| `static/` | Web UI 前端静态资源 |

### 设计要点

- **策略 + 工厂：** 转换器（`ConverterFactory` → `BaseConverter` 子类）与提供商（`ProviderStrategyFactory` → `ApiServiceAdapter` 实现）
- **适配器：** 各提供商在 `ApiServiceAdapter` 后统一暴露能力
- **注册表：** 提供商在 `src/providers/adapter.js` 注册；插件由插件管理器加载
- **插件架构：** 可扩展中间件，`src/plugins/` + `configs/plugins.json`
- **账号池：** `provider-pool-manager.js` 多账号轮询、健康检查、故障转移链

### 支持的提供商（见 `src/utils/common.js`）

`gemini-cli-oauth`、`gemini-antigravity`、`claude-custom`、`claude-kiro-oauth`、`openai-custom`、`openai-qwen-oauth`、`openai-iflow`、`openai-codex-oauth`、`forward-api`、`grok-custom`

### 协议前缀（MODEL_PROTOCOL_PREFIX）

`gemini`、`openai`、`openaiResponses`、`claude`、`codex`、`forward`、`grok`

## 配置

- 主配置：`configs/config.json`（示例见 `configs/config.json.example`）
- 无数据库 — 状态均落在 `configs/` 下 JSON 文件中
- OAuth 令牌缓存：`configs/token-store.json`
- 提供商池：`configs/provider_pools.json`
- 管理端默认密码：`admin123`（存于 `configs/pwd`）

## 测试说明

- Jest + Babel 做 ESM 转换；`babel-plugin-transform-import-meta` 与 `src/utils/tls-sidecar.js` 不参与转换（保留原生 `import.meta`）
- 默认 `pnpm test`：仅 `tests/unit/`；`tests/live/` 在 Jest 中默认忽略（需真实服务）
- `pnpm run test:integration`：`forward-api` + 本地 OpenAI stub 全链路（`--runInBand`，无需外网密钥）
- `pnpm run test:e2e`：Jest API 场景（`tests/e2e/api`）
- `pnpm run test:integration:live`：`tests/live/api-integration.test.js`（需服务已启动且配置真实提供商）
- `pnpm run test:ui`：Playwright 管理端（需服务已监听，默认 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000`；首次执行 `pnpm run test:ui:install` 安装 Chromium）
- `pnpm run test:all`：单元 + 集成（排除 `tests/live` 及与 API E2E 重复的路径）
- 全局超时：30 秒（Jest）
- CLI：`--config <path>` 指定配置文件（见 `src/core/config-manager.js`）

## 新增提供商（简要步骤）

1. 在 `src/providers/<name>/` 实现 `ApiServiceAdapter`
2. 在 `src/converters/strategies/` 扩展 `BaseConverter`
3. 在 `ConverterFactory` 与提供商注册处登记
4. 如需 OAuth，在 `src/auth/` 增加处理逻辑
5. 在 `src/utils/common.js` 增加协议前缀等常量

## 其他说明

- 源码统一使用 ES Module（`import` / `export`）
- TLS sidecar（`src/utils/tls-sidecar.js`）为 Go 二进制，用于 uTLS 指纹绕过（如 Cloudflare / Grok）
- 流式响应是核心能力之一，多数适配器处理 SSE
- 源码注释以中文为主
