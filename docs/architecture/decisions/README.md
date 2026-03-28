# 架构决策记录（Architecture Decision Records）

本目录记录 AIClient-2-API 项目中的重要架构决策。每条记录说明决策的背景、方案选择与理由，帮助后续维护者理解系统现状。

---

## ADR 格式说明

每个 ADR 文件建议包含以下章节：

```markdown
# ADR-NNN: 标题

## 状态
提议 / 已接受 / 已废弃 / 已替代

## 背景
描述需要做出决策的问题或情境。

## 决策
描述所做的决策。

## 理由
解释为什么选择该方案，以及考虑过但未采用的替代方案。

## 影响
描述该决策带来的后果，包括正面和负面影响。
```

---

## 已知决策列表

### ADR-001：使用原生 `node:http` 而非 Web 框架

**状态：** 已接受

**背景：** 服务需要处理长连接 SSE 流式响应、WebSocket 连接（Codex）、大量并发请求，且需要对超时配置有精细控制（如完全禁用 `requestTimeout`）。

**决策：** 使用 Node.js 原生 `http` 模块构建 HTTP 服务，不引入 Express、Fastify 等框架。

**理由：** 流式响应场景下框架的中间件抽象带来不必要的复杂性；原生模块可以直接配置 `requestTimeout: 0`、`keepAliveTimeout` 等底层参数；减少依赖数量，降低供应链攻击面。

**影响：** 路由需手动实现（见 `request-handler.js`、`api-manager.js`）；静态文件服务需自行处理。

---

### ADR-002：主从进程架构（Master-Worker）

**状态：** 已接受

**背景：** Node.js 单进程崩溃后无法自我恢复；需要支持运行时热重启而不丢失管理能力。

**决策：** 引入独立的 Master 进程（`src/core/master.js`），通过 `child_process.fork` 管理 Worker 进程。Master 监听独立的管理端口（默认 `:3100`），Worker 监听业务端口（默认 `:3000`）。

**理由：** Master 进程极简（无业务逻辑），崩溃概率极低；Worker 崩溃后 Master 可指数退避自动重启；管理端口与业务端口分离，运维操作不影响业务流量。

**影响：** 部署时存在两个监听端口；使用 `pnpm run start:standalone` 可绕过 Master 直接启动 Worker，用于开发或容器场景。

---

### ADR-003：策略模式实现协议转换

**状态：** 已接受

**背景：** 系统需要支持 OpenAI、Gemini、Claude、Grok、Codex 等多种协议，各协议的请求/响应格式差异显著，且未来会持续增加新协议。

**决策：** 采用策略模式（Strategy Pattern）实现协议转换层。`BaseConverter` 定义统一接口，具体转换器（`GeminiConverter`、`ClaudeConverter` 等）实现各协议的转换逻辑。`ConverterFactory` 以工厂 + 单例模式管理转换器实例，支持运行时动态注册。

**理由：** 新增协议只需添加一个转换器类并在 `register-converters.js` 注册，无需修改核心路由逻辑；转换器单例缓存避免频繁实例化开销。

**影响：** 转换器类之间完全解耦；协议前缀（`gemini`、`openai`、`claude` 等）是连接提供商与转换器的关键纽带，需通过 `getProtocolPrefix()` 函数维护好映射关系。

---

### ADR-004：适配器模式统一提供商接口

**状态：** 已接受

**背景：** 各 AI 提供商的 SDK、认证方式、请求格式、流式实现差异极大（有些使用 OAuth，有些使用 API Key；有些返回 SSE，有些返回 WebSocket）。

**决策：** 所有提供商适配器实现统一的 `ApiServiceAdapter` 抽象基类，暴露 `generateContent`、`generateContentStream`、`listModels`、`refreshToken`、`forceRefreshToken`、`isExpiryDateNear` 六个标准接口。适配器通过 `adapterRegistry`（Map）注册，由 `getServiceAdapter(config)` 工厂函数统一创建和缓存。

**理由：** 上层业务代码（转换层、路由层）与具体提供商实现完全解耦；新增提供商只需实现适配器并调用 `registerAdapter()`，无需修改任何上层代码。

**影响：** 适配器单例以 `provider + uuid` 为键缓存，多账号场景下每个账号对应独立实例；需要谨慎处理适配器初始化失败的懒重试逻辑（当前通过 `isInitialized` 标志实现）。

---

### ADR-005：无数据库——以 JSON 文件存储配置和状态

**状态：** 已接受

**背景：** 项目定位为轻量级本地代理，需要易于部署（单命令启动，无外部依赖）和易于 Docker 化（挂载 `configs/` 目录即可持久化）。

**决策：** 所有状态（配置、OAuth Token 缓存、账号池信息、管理员密码）均以 JSON 文件形式存储在 `configs/` 目录下，无数据库依赖。

**关键文件：**

| 文件 | 用途 |
|------|------|
| `configs/config.json` | 主配置 |
| `configs/token-store.json` | OAuth Token 缓存 |
| `configs/provider_pools.json` | 账号池配置 |
| `configs/plugins.json` | 插件启用配置 |
| `configs/pwd` | 管理员密码 |

**理由：** 零外部依赖，`docker run -v` 挂载即完成持久化；配置文件可直接用文本编辑器查看和修改，对个人用户友好。

**影响：** 不适合高并发写入场景（并发 Token 刷新可能有文件竞争）；规模扩大后需考虑迁移至 Redis 或 SQLite。

---

### ADR-006：插件系统实现可扩展中间件

**状态：** 已接受

**背景：** 认证、监控、流量控制等横切关注点不应硬编码在核心路由逻辑中，需要可扩展的机制支持用户自定义扩展。

**决策：** 引入基于 `src/plugins/` 目录的插件系统，由 `PluginManager` 在启动时自动发现并加载插件。插件分为 `auth` 类型（参与认证决策）和普通中间件类型，执行顺序明确分离（认证先于中间件）。

**理由：** 认证与业务逻辑分离，便于替换认证方式；第三方功能（如 `api-potluck`）可以作为插件独立维护和发布。

**影响：** 插件执行顺序需严格保证（认证 → 中间件 → 业务处理）；插件中的错误处理需防止影响主请求流程。

---

### ADR-007：TLS Sidecar 绕过指纹检测

**状态：** 已接受

**背景：** 部分上游服务（如 Grok、Cloudflare 保护的端点）对 TLS ClientHello 指纹进行检测，Node.js 原生 TLS 实现的指纹特征明显，会被识别并拦截。

**决策：** 引入独立的 Go 语言 TLS Sidecar 二进制（`src/utils/tls-sidecar.js` 管理其生命周期），使用 `uTLS` 库模拟浏览器 TLS 指纹。需要绕过指纹的请求通过本地代理路由至 Sidecar，再由 Sidecar 发出。

**理由：** Go + uTLS 是目前最成熟的 TLS 指纹模拟方案；以独立进程形式运行，与主 Node.js 进程生命周期解耦，Sidecar 崩溃不影响不需要绕过指纹的提供商正常使用。

**影响：** 部署时需要包含对应平台的 Go 二进制；Sidecar 未成功启动时自动降级为 Node.js 原生 TLS；Docker 镜像中已内置该二进制。

---

### ADR-008：请求级 ID 与日志上下文隔离

**状态：** 已接受

**背景：** 高并发场景下多个请求的日志交叉输出，难以追踪单个请求的完整处理链路。

**决策：** 每个请求生成唯一 ID（`clientIP:UUID8`），通过 `logger.runWithContext` 将 ID 绑定到 AsyncLocalStorage 上下文，确保该请求在所有异步调用栈中的日志均携带相同 ID。请求结束后调用 `logger.clearRequestContext` 清理上下文。

**理由：** AsyncLocalStorage 是 Node.js 原生 API，无性能开销；`clientIP` 前缀便于按来源过滤日志；8 字符 UUID 在高并发下碰撞概率极低且日志可读性好。

**影响：** 所有业务代码通过 `logger` 模块输出日志（不直接调用 `console.log`），确保上下文能正确传播。
