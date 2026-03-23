# 设计文档: 测试系统性治理

> **功能标识**: test-governance
> **基于需求**: test-governance-requirements.md
> **撰写时间**: 2026-03-23

---

## 1. 当前状态（截至 2026-03-23）

### 1.1 已完成工作（在 `test-governance` worktree 中）

本次治理已在 `.claude/worktrees/test-governance` 分支上完成了大量基础工作：

| 模块 | 状态 | 说明 |
|------|------|------|
| Jest 配置 (worktree) | ✅ 完成 | 移除了 worktree 路径排除规则 |
| providers/claude | ✅ 完成 | claude-core (98%) + claude-kiro (36%) |
| providers/gemini | ⚠️ 部分 | gemini-core 有新测试文件，覆盖率待验证 |
| providers/grok | ⚠️ 部分 | grok-core 有新测试文件，覆盖率待验证 |
| providers/openai | ⚠️ 部分 | codex-core/openai-core 有新测试文件 |
| converters/strategies | ⚠️ 部分 | 多个新的 extended/deep 测试文件已创建 |
| plugins/api-potluck | ⚠️ 部分 | 4 个新测试文件（routes 有超时问题） |
| services | ⚠️ 部分 | api-server/ui-manager/service-manager 有新测试，部分有 bug |
| ui-modules | ⚠️ 部分 | 新增多个模块测试（config-scanner/oauth-api 等） |
| auth | ⚠️ 部分 | iflow-oauth + auth-index 测试已创建 |
| utils | ⚠️ 部分 | grok-assets-proxy + provider-strategies + provider-strategy 已创建 |

**当前测试结果**（worktree 中）:
- 单元测试: **1718 通过 / 15 失败 / 2 套件失败**
- 基线（治理前主分支）: **1256 通过 / 0 失败 / 61 套件**
- 净增加: **+462 个通过测试**

### 1.2 仍存在的问题

#### 问题 1: api-server.test.js — 5 个测试失败（超时约 120s）

失败用例：
- `startServer() › uses default argv and configPath when options not provided`
- `startServer() › sets up cron interval when CRON_REFRESH_TOKEN is true`
- `gracefulShutdown() › closes server in test mode without calling process.exit`
- `gracefulShutdown() › calls TLS sidecar stop during shutdown`
- `gracefulShutdown() › handles TLS sidecar stop error gracefully`

**根因**: `api-server.js` 测试中有实际的异步操作（HTTP 服务器）未被正确 mock，导致 Jest 等待句柄。

#### 问题 2: api-potluck-routes.test.js — 10 个测试失败（超时约 303s）

**根因**: 路由测试中某些请求/响应对象 mock 不完整，或有未关闭的 Promise。

#### 问题 3: ui-manager.test.js — 已修复语法错误（`async () =>` 缺失）

#### 问题 4: auth-index.test.js — 已修复（proxy-utils mock 缺少 `getGoogleAuthProxyConfig`）

#### 问题 5: provider-strategy.test.js — 已修复（断言逻辑错误）

### 1.3 当前覆盖率（实测数据，2026-03-23）

| 模块 | 治理前 | **当前实测** | 变化 | 目标 |
|------|--------|------------|------|------|
| plugins/api-potluck | 5.9% | **85.68%** | +79.8pp | ✅ 达标 |
| services | 21.34% | **65.63%** | +44.3pp | 需再提升 |
| ui-modules | 19.32% | **42.93%** | +23.6pp | 需再提升 |
| providers/claude | 7.5% | **42.62%** | +35.1pp | 需再提升 |
| auth | 35.77% | **41.75%** | +5.98pp | 需再提升 |
| converters/strategies | 36.77% | **36.77%** | 0 | 需提升 |
| providers/forward | 30% | **30%** | 0 | 需提升 |
| providers/gemini | 13.52% | **13.52%** | 0 | 需提升 |
| providers/grok | 15.09% | **15.09%** | 0 | 需提升 |
| providers/openai | 20.68% | **20.68%** | 0 | 需提升 |
| **整体** | **29.7%** | **41.01%** | **+11.3pp** | 目标 70% |

**说明**：gemini/grok/openai/converters 新建的测试文件因 agent 触及限额，测试文件可能为空壳或存在 bug（测试失败不计入覆盖率）。需按任务书 T04-T07 逐一修复和补充。

**距目标 70% 仍有差距**，需要继续补充测试。

---

## 2. 技术架构

### 2.1 测试工具链

```
pnpm test                # NODE_OPTIONS=--experimental-vm-modules jest tests/unit
pnpm run test:coverage   # + --coverage
pnpm run test:integration # jest --runInBand tests/integration --forceExit
pnpm run test:e2e        # jest --runInBand tests/e2e/api --forceExit
```

### 2.2 Mock 规范（ESM 必须遵守）

```js
// ✅ 正确方式 - jest.unstable_mockModule + beforeAll + dynamic import
beforeAll(async () => {
    mockFn = jest.fn();
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    const mod = await import('../../../src/target.js');
    targetFn = mod.targetFn;
});

// ❌ 错误方式
jest.mock(...)          // CJS 语法，不适用于 ESM
import target from ...  // 顶层 import 不能用于被 mock 的模块
```

### 2.3 常见 mock 模板

```js
// logger
await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// fs (用于 import { promises as fs } from 'fs')
await jest.unstable_mockModule('fs', () => ({
    __esModule: true,
    promises: { readFile: jest.fn(), writeFile: jest.fn(), mkdir: jest.fn() },
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn(),
}));

// CONFIG
await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
    __esModule: true,
    CONFIG: { API_KEY: 'test', PROXY_URL: null },
}));

// proxy-utils (完整版)
await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    __esModule: true,
    getProxyConfigForProvider: jest.fn().mockReturnValue(null),
    getGoogleAuthProxyConfig: jest.fn().mockReturnValue(null),
    configureAxiosProxy: jest.fn(),
}));

// ui-manager
await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
    __esModule: true,
    broadcastEvent: jest.fn(),
}));

// service-manager
await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    __esModule: true,
    autoLinkProviderConfigs: jest.fn().mockResolvedValue(undefined),
}));
```

### 2.4 HTTP 服务器 Mock 模板

```js
// 适用于 createServer / listen / close 模式
const mockServer = {
    listen: jest.fn((port, host, cb) => { if (cb) cb(); else if (typeof host === 'function') host(); }),
    close: jest.fn((cb) => { if (cb) cb(); }),
    on: jest.fn(),
    emit: jest.fn(),
    listening: true,
};
await jest.unstable_mockModule('http', () => ({
    __esModule: true,
    default: { createServer: jest.fn().mockReturnValue(mockServer) },
}));
```

---

## 3. 仍需完成的工作

### 3.1 修复已有测试的 Bug（必须先完成）

#### Fix 1: `tests/unit/services/api-server.test.js`

问题：超时 120s，5 个测试失败。

诊断方向：
1. 读取 `src/services/api-server.js` 了解启动流程
2. 确保 `http.createServer` 被正确 mock（listen 回调立即触发）
3. 确保 `tls-sidecar` 被 mock（该模块被 transformIgnorePatterns 排除）
4. 确保 cron/interval 被 mock 防止 open handles
5. 修复 `gracefulShutdown` 相关测试

关键 mock：
```js
// tls-sidecar 必须 mock（被 babel 排除）
await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    __esModule: true,
    default: { start: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) },
}));
```

#### Fix 2: `tests/unit/plugins/api-potluck-routes.test.js`

问题：超时 303s，10 个测试失败。

诊断方向：
1. 路由处理函数的 req/res mock 需要完整模拟流对象（包括 pipe、destroy）
2. 检查是否有 Promise 未 resolve 导致测试挂起
3. 为每个路由处理函数补充 `res._end()` 或 `res.end()` 调用

### 3.2 提升覆盖率到 70%（各模块具体目标）

覆盖率缺口最大的模块（需要重点补充）：

#### providers/gemini（当前 ~40%，目标 70%）
- `gemini-core.js`：覆盖 SSE 流解析、内容块转换、思考模式
- `antigravity-core.js`：如果存在，覆盖其核心路径

#### providers/grok（当前 ~40%，目标 70%）
- `grok-core.js`：覆盖请求构建（261-676 行未覆盖），流式响应解析

#### providers/openai（当前 ~45%，目标 70%）
- `codex-core.js`：覆盖 token 刷新、流式响应（428-762 行）
- `iflow-core.js`：创建测试文件（如存在）
- `qwen-core.js`：创建测试文件（如存在）

#### converters/strategies（当前 ~50%，目标 70%）
- `ClaudeConverter.js`：覆盖 857-992 行（系统提示处理）、1025-1074 行（工具调用）
- `GeminiConverter.js`：覆盖 688-853 行（流式块解析）
- `GrokConverter.js`：覆盖 811-1142 行（大段未覆盖）
- `OpenAIConverter.js`：覆盖 1176-1490 行

#### services（当前 ~35%，目标 60%）
- `api-server.js`：修复现有测试 + 补充 startServer 成功路径
- `service-manager.js`：覆盖服务注册、初始化流程
- `ui-manager.js`：修复 path mock 问题（已修复语法错误），覆盖路由注册

#### ui-modules（当前 ~35%，目标 55%）
- `provider-api.js`（13%）：大量 API 端点未覆盖（175-1098 行）
- `event-broadcast.js`（33%）：SSE 客户端管理、广播逻辑
- `system-monitor.js`：系统监控端点
- `oauth-api.js`：OAuth 流程端点

### 3.3 Jest 覆盖率阈值配置（Phase 1 完成后执行）

在 `jest.config.js` 中添加：
```js
coverageThreshold: {
    global: {
        statements: 70,
        branches: 55,
        functions: 60,
        lines: 70,
    },
},
```

### 3.4 CI 卡控配置

在 `.github/workflows/test.yml` 的 Unit Tests job 中：
```yaml
- name: Run unit tests with coverage
  run: pnpm run test:coverage
  # jest.config.js 中的 coverageThreshold 会自动使 CI 失败
```

### 3.5 集成测试补充（Phase 2）

当前集成测试仅覆盖 `forward-api`。需要扩展 mock upstream stack 支持各提供商：

**gemini 集成测试**：
- Mock 端点返回 Gemini 格式响应（JSON 和 SSE）
- 测试 `gemini-cli-oauth` 和 `gemini-antigravity` 两种提供商
- 覆盖 `toGeminiRequest` → `fromGeminiResponse` 完整链路

**claude 集成测试**：
- Mock Claude API 响应（非流式和 SSE 流式）
- 测试 `claude-custom` 提供商
- 覆盖工具调用响应

**openai 集成测试**：
- Mock OpenAI API 响应
- 测试 `openai-custom` 和 `openai-iflow` 两种提供商

**grok 集成测试**：
- Mock Grok API 响应
- 测试 `grok-custom` 提供商

### 3.6 E2E 测试补充（Phase 3）

补充以下场景：
- 多提供商模型列表（`/v1/models` 返回来自多个提供商的模型）
- 账户池故障转移（第一个账户失败后自动切换）
- 插件链路（api-potluck 启用时的请求路由）

---

## 4. 已创建文件清单（worktree 中）

```
tests/unit/auth/
  auth-index.test.js          ← 新建（导出验证）
  iflow-oauth.test.js         ← 新建（handleIFlowOAuth / refreshIFlowTokens）

tests/unit/utils/
  grok-assets-proxy.test.js   ← 新建（handleGrokAssetsProxy）
  provider-strategies.test.js ← 新建（ProviderStrategyFactory）
  provider-strategy.test.js   ← 新建（ProviderStrategy 抽象基类）

tests/unit/providers/
  claude-kiro.test.js         ← 新建（79 个测试，claude-kiro.js 从 ~0% 到 36%）
  claude-core.test.js         ← 修改（补充重试逻辑测试，98%）
  gemini-core.test.js         ← 新建（待验证）
  grok-core.test.js           ← 新建（待验证）
  openai-core.test.js         ← 修改/新建（待验证）
  codex-core.test.js          ← 新建（待验证）

tests/unit/services/
  api-server.test.js          ← 新建（有 5 个失败需修复）
  service-manager.test.js     ← 新建
  ui-manager.test.js          ← 新建（语法错误已修复）
  api-manager.test.js         ← 新建

tests/unit/plugins/
  api-potluck-index.test.js   ← 新建
  api-potluck-key-manager.test.js ← 新建
  api-potluck-middleware.test.js  ← 新建
  api-potluck-routes.test.js  ← 新建（10 个失败需修复）

tests/unit/ui-modules/
  config-scanner.test.js      ← 新建
  oauth-api.test.js           ← 新建
  system-monitor.test.js      ← 新建
  upload-config-api.test.js   ← 新建
  usage-cache.test.js         ← 新建
  plugin-api.test.js          ← 新建
  system-api.test.js          ← 新建

tests/unit/converters/
  openai-converter-extended.test.js ← 新建（补充测试）
```

---

## 5. 工作目录说明

所有工作在 `test-governance` branch 的 worktree 中进行：
```bash
# worktree 路径
/Users/moxiaoxi/Desktop/AIClient-2-API/.claude/worktrees/test-governance/

# 切换到 worktree
cd /Users/moxiaoxi/Desktop/AIClient-2-API/.claude/worktrees/test-governance

# 运行测试（必须带 NODE_OPTIONS）
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --forceExit

# 运行覆盖率
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --coverage --forceExit
```
