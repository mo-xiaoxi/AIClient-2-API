# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AIClient-2-API is a Node.js API proxy service that converts client-only AI model APIs (Gemini CLI, Antigravity, Qwen Code, Kiro, Grok, Codex) into standard OpenAI-compatible interfaces. It handles protocol conversion between OpenAI, Claude, Gemini, Grok, and Codex formats.

- **Language:** JavaScript (ES Modules, `"type": "module"`)
- **Runtime:** Node.js ≥ 20.0.0
- **Package Manager:** pnpm
- **No framework** — uses native `http` module for the server

## Common Commands

```bash
# Run (master process with worker management and auto-restart)
pnpm start                    # node src/core/master.js
pnpm run start:standalone     # node src/services/api-server.js (direct, no master)
pnpm run start:dev            # development mode

# Test
pnpm test                     # unit tests (`tests/unit`)
pnpm test tests/unit/some-file.test.js  # single file
pnpm run test:watch           # watch (unit)
pnpm run test:coverage        # coverage (unit)
pnpm run test:unit            # same as pnpm test
pnpm run test:integration     # mock upstream stack (`tests/integration`)
pnpm run test:e2e             # API E2E (`tests/e2e/api`)
pnpm run test:integration:live # vs real server (`tests/live/api-integration.test.js`)
pnpm run test:all             # unit + integration (no live / duplicate API E2E)
pnpm run test:ui              # Playwright UI (`pnpm run test:ui:install` first)

# Docker
docker run -d -p 3000:3000 -v "path:/app/configs" justlikemaki/aiclient-2-api
```

## Architecture

### Entry Points

- `src/core/master.js` — Master process: spawns worker, handles IPC, auto-restart
- `src/services/api-server.js` — Worker/standalone HTTP server on port 3000

### Request Pipeline

Incoming request → Plugin auth middleware → `request-handler.js` routing → `api-manager.js` → Protocol conversion (`converters/`) → Provider adapter (`providers/`) → Stream/return response

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/providers/` | Provider adapters (Gemini, Claude, OpenAI, Grok, Forward) implementing `ApiServiceAdapter` interface |
| `src/converters/` | Protocol converters using Strategy pattern — `BaseConverter` → concrete strategies (`ClaudeConverter`, `GeminiConverter`, etc.), created via `ConverterFactory` |
| `src/auth/` | OAuth handlers for each provider (Gemini, Qwen, Kiro, Codex, Antigravity, Grok) |
| `src/handlers/` | Central request dispatcher |
| `src/services/` | API server, UI manager, API manager, service manager, usage tracking |
| `src/core/` | Master process, config manager, plugin manager |
| `src/plugins/` | Plugin system (default-auth, ai-monitor, api-potluck) |
| `src/ui-modules/` | Web UI backend API endpoints (~13 modules) |
| `src/utils/` | Logger, constants, proxy config, token management, TLS sidecar |
| `configs/` | JSON config files (config.json, provider_pools.json, token-store.json) |
| `static/` | Web UI frontend |

### Design Patterns

- **Strategy + Factory:** Converters (`ConverterFactory` → `BaseConverter` subclasses) and provider adapters (`ProviderStrategyFactory` → `ApiServiceAdapter` implementations)
- **Adapter:** Each provider wraps its API behind `ApiServiceAdapter` interface
- **Registry:** Providers registered in `src/providers/adapter.js`; plugins in plugin manager
- **Plugin Architecture:** Extensible middleware system — plugins in `src/plugins/` with config in `configs/plugins.json`
- **Account Pool:** `provider-pool-manager.js` manages multi-account polling, health checks, failover chains

### Supported Providers (from `src/utils/common.js`)

`gemini-cli-oauth`, `gemini-antigravity`, `claude-custom`, `claude-kiro-oauth`, `openai-custom`, `openai-qwen-oauth`, `openai-iflow`, `openai-codex-oauth`, `forward-api`, `grok-custom`

### Protocol Prefixes (MODEL_PROTOCOL_PREFIX)

`gemini`, `openai`, `openaiResponses`, `claude`, `codex`, `forward`, `grok`

## Configuration

- Main config: `configs/config.json` (see `configs/config.json.example`)
- No database — all state stored in JSON files under `configs/`
- OAuth tokens cached in `configs/token-store.json`
- Provider pools in `configs/provider_pools.json`
- Web UI default password: `admin123` (stored in `configs/pwd`)

## Testing

- Jest with Babel for ESM transformation; `babel-plugin-transform-import-meta` + `src/utils/tls-sidecar.js` excluded from transform (native `import.meta`)
- Default `pnpm test`：`tests/unit/` 仅单元测试；`tests/live/` 在 Jest 配置中默认忽略（对接真实服务）
- `pnpm run test:integration`：`forward-api` + 本地 OpenAI stub 全链路（`--runInBand`，无需外网密钥）
- `pnpm run test:e2e`：Jest API 场景（`tests/e2e/api`，单条用户路径）
- `pnpm run test:integration:live`：`tests/live/api-integration.test.js`（需已启动服务且配置真实提供商）
- `pnpm run test:ui`：Playwright 管理端（需服务已监听，默认 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000`；首次执行 `pnpm run test:ui:install` 安装 Chromium）
- `pnpm run test:all`：单元 + 集成（排除 `tests/live` 与重复 API E2E 路径）
- Test timeout: 30 seconds（Jest 全局）
- CLI：`--config <path>` 可指定配置文件（见 `src/core/config-manager.js`）

## Adding a New Provider

1. Create adapter in `src/providers/<name>/` implementing `ApiServiceAdapter`
2. Create converter strategy in `src/converters/strategies/` extending `BaseConverter`
3. Register in `ConverterFactory` and provider adapter registry
4. Add OAuth handler in `src/auth/` if needed
5. Add protocol prefix constant in `src/utils/common.js`

## Notes

- All source files use ES Module syntax (`import`/`export`)
- The TLS sidecar (`src/utils/tls-sidecar.js`) is a Go binary for uTLS fingerprint bypass (Cloudflare/Grok)
- Streaming responses are a core feature — most provider adapters handle SSE streaming
- Source code comments are primarily in Chinese (中文)
