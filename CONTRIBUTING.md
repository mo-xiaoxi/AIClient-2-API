# 贡献指南

感谢你对 AIClient-2-API 项目的关注。本文件描述如何参与贡献，包括环境搭建、开发流程、代码规范、测试要求以及 PR 提交标准。

## 目录

- [开发环境搭建](#开发环境搭建)
- [开发流程](#开发流程)
- [代码规范](#代码规范)
- [提交信息格式](#提交信息格式)
- [测试要求](#测试要求)
- [新增提供商](#新增提供商)
- [PR 规范与检查清单](#pr-规范与检查清单)
- [报告 Bug](#报告-bug)
- [提交 Feature Request](#提交-feature-request)

---

## 开发环境搭建

### 前置要求

| 工具 | 最低版本 |
|------|----------|
| Node.js | 20.0.0 |
| pnpm | 8.x |
| Git | 2.x |

### 克隆与安装

```bash
# 1. Fork 仓库后克隆你的副本
git clone https://github.com/<your-username>/AIClient-2-API.git
cd AIClient-2-API

# 2. 安装依赖
pnpm install

# 3. 复制配置示例
cp configs/config.json.example configs/config.json
```

### 启动开发服务

```bash
# 开发模式（主进程 + worker，自动重启）
pnpm run start:dev

# 独立模式（无主进程，适合调试单个 worker）
pnpm run start:standalone
```

服务默认监听 `http://127.0.0.1:3000`，管理端默认密码为 `admin123`（存储于 `configs/pwd`）。

### 可选：Playwright UI 测试环境

首次运行 UI 测试前需要安装 Chromium：

```bash
pnpm run test:ui:install
```

---

## 开发流程

```
Fork → 创建分支 → 编码 → 测试 → 提交 → 推送 → 发起 PR
```

### 1. 同步上游

在开始任何工作之前，请先同步上游的最新代码：

```bash
git remote add upstream https://github.com/justlovemaki/AIClient-2-API.git
git fetch upstream
git checkout dev
git merge upstream/dev
```

### 2. 创建功能分支

从 `dev` 分支创建你的工作分支：

```bash
# 新功能
git checkout -b feat/your-feature-name

# Bug 修复
git checkout -b fix/issue-description

# 文档更新
git checkout -b docs/topic-name
```

分支命名遵循 `<type>/<kebab-case-description>` 格式，type 与 Conventional Commits 的 type 对应。

### 3. 编写代码

- 遵循本文件"代码规范"章节的约定
- 每次改动只做一件事，保持提交粒度合理
- 提交前确保单元测试通过

### 4. 本地测试

```bash
# 最低要求：单元测试全部通过
pnpm test

# 涉及集成链路时同时运行集成测试
pnpm run test:integration
```

### 5. 推送并发起 PR

```bash
git push origin feat/your-feature-name
```

在 GitHub 上向 `dev` 分支发起 Pull Request，而非直接向 `main`。

---

## 代码规范

### 模块系统

本项目使用 ES Modules，`package.json` 已设置 `"type": "module"`：

```js
// 正确：使用 import / export
import { something } from './module.js';
export function myFunction() {}

// 错误：不使用 require / module.exports
const x = require('./module'); // 禁止
```

导入路径必须带文件扩展名（`.js`），Node.js ESM 解析器不会自动补全。

### 命名约定

| 场景 | 风格 | 示例 |
|------|------|------|
| 变量、函数 | camelCase | `generateContent`, `requestBody` |
| 类名 | PascalCase | `GeminiApiService`, `BaseConverter` |
| 常量 | UPPER_SNAKE_CASE | `MODEL_PROVIDER`, `API_ACTIONS` |
| 文件名 | kebab-case | `gemini-core.js`, `claude-strategy.js` |
| 目录名 | kebab-case | `src/providers/`, `src/ui-modules/` |

### 注释语言

源码注释以**中文**为主，与项目现有风格保持一致。公开 API（导出函数、类方法）需要补充 JSDoc 注释：

```js
/**
 * 生成内容
 * @param {string} model - 模型名称
 * @param {object} requestBody - 请求体
 * @returns {Promise<object>} API 响应
 */
async generateContent(model, requestBody) {
    // 实现逻辑
}
```

### 设计模式约定

项目核心使用以下模式，贡献代码时应遵守：

- **适配器（Adapter）：** 所有提供商必须继承 `ApiServiceAdapter`，实现 `generateContent` 和 `streamGenerateContent` 方法
- **策略 + 工厂（Strategy + Factory）：** 协议转换器继承 `BaseConverter`，通过 `ConverterFactory.registerConverter()` 注册
- **注册表（Registry）：** 提供商通过 `registerAdapter()` 注册到 `src/providers/adapter.js`
- **插件（Plugin）：** 中间件扩展放在 `src/plugins/`，通过 `configs/plugins.json` 加载

### 其他约定

- 不引入 Web 框架（Express、Fastify 等），HTTP 服务使用原生 `http` 模块
- 流式响应使用 SSE（Server-Sent Events），与现有适配器保持一致
- 错误处理时记录日志，使用 `src/utils/logger.js` 的 `logger` 实例
- 配置读取通过 `src/core/config-manager.js`，不在代码中硬编码路径或凭据

---

## 提交信息格式

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

### 格式

```
<type>(<scope>): <subject>

[body]

[footer]
```

### type 类型

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码风格（不影响功能） |
| `refactor` | 重构（不新增功能、不修复 bug） |
| `test` | 新增或修改测试 |
| `chore` | 构建流程、依赖管理等杂项 |
| `perf` | 性能优化 |
| `ci` | CI/CD 配置变更 |
| `security` | 安全修复 |

### scope（可选）

使用受影响的模块名作为 scope：`providers`、`converters`、`auth`、`plugins`、`core`、`ui`、`test` 等。

### 示例

```
feat(providers): 新增 Kimi OAuth 提供商适配器

实现 KimiApiService，继承 ApiServiceAdapter，支持流式和非流式响应。
在 adapter.js 注册并补充单元测试。

Closes #123
```

```
fix(converters): 修复 GeminiConverter 流式响应末尾多余换行

在 convertStreamChunk 中去除末尾 \n\n，与 OpenAI SSE 格式对齐。
```

```
test(auth): 补充 codex-oauth 刷新令牌边界用例
```

### 破坏性变更

在 body 或 footer 中注明 `BREAKING CHANGE:`：

```
feat(providers)!: 重构 ApiServiceAdapter 接口，移除 getModels 方法

BREAKING CHANGE: getModels() 已从 ApiServiceAdapter 接口中移除，
请改用 src/providers/provider-models.js 的统一查询接口。
```

---

## 测试要求

### 测试层级

| 命令 | 目录 | 说明 | 是否需要外部服务 |
|------|------|------|----------------|
| `pnpm test` | `tests/unit/` | 单元测试 | 否 |
| `pnpm run test:integration` | `tests/integration/` | 集成测试（含本地 stub） | 否 |
| `pnpm run test:e2e` | `tests/e2e/api/` | API 端到端 | 否 |
| `pnpm run test:ui` | `tests/e2e/ui/` | Playwright 管理端 | 需服务已启动 |
| `pnpm run test:integration:live` | `tests/live/` | 对接真实上游 | 需真实凭据 |
| `pnpm run test:all` | 单元 + 集成 | 不含 live / UI | 否 |

### 贡献时的测试要求

1. **新功能**：必须附带对应单元测试，覆盖正常路径和主要错误路径
2. **Bug 修复**：必须提供能复现该 bug 的测试用例，并验证修复有效
3. **新增提供商**：单元测试覆盖 `generateContent`、`streamGenerateContent`、认证刷新及错误处理
4. **重构**：确保已有测试通过，不得降低覆盖率

### 编写单元测试的约定

测试文件放在与源文件结构对应的 `tests/unit/` 子目录下，文件名以 `.test.js` 结尾：

```
src/providers/kimi/kimi-core.js
  -> tests/unit/providers/kimi-core.test.js
```

测试使用 Jest + `@jest/globals`，以 ESM 方式导入：

```js
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { KimiApiService } from '../../../src/providers/kimi/kimi-core.js';

describe('KimiApiService', () => {
    let service;

    beforeEach(() => {
        service = new KimiApiService({ token: 'test-token' });
    });

    it('应返回流式响应', async () => {
        // 测试逻辑
    });
});
```

注意事项：
- `src/utils/tls-sidecar.js` 不参与 Babel 转换，测试中需要 mock
- Jest 全局超时为 30 秒，长时间的异步操作需要合理设置 `jest.setTimeout`
- 外部网络调用必须 mock，单元测试不允许发起真实 HTTP 请求

---

## 新增提供商

以下是添加一个新提供商（以 `example-provider` 为例）的完整步骤。

### 第一步：实现适配器

在 `src/providers/example/` 目录下创建核心文件，继承 `ApiServiceAdapter`：

```js
// src/providers/example/example-core.js
import { ApiServiceAdapter } from '../adapter.js';

export class ExampleApiService extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.config = config;
    }

    async generateContent(model, requestBody) {
        // 实现非流式请求逻辑
    }

    async streamGenerateContent(model, requestBody, onChunk, onEnd, onError) {
        // 实现 SSE 流式响应逻辑
    }
}
```

### 第二步：实现协议转换器（如需新协议）

如果新提供商使用现有协议（`openai`、`claude`、`gemini` 等），可复用已有转换器。如需新协议，在 `src/converters/strategies/` 下创建：

```js
// src/converters/strategies/ExampleConverter.js
import { BaseConverter } from '../BaseConverter.js';

export class ExampleConverter extends BaseConverter {
    constructor() {
        super('example');
    }

    convertRequest(data, targetProtocol) { /* ... */ }
    convertResponse(data, targetProtocol, model) { /* ... */ }
    convertStreamChunk(chunk, targetProtocol, model) { /* ... */ }
    convertModelList(data, targetProtocol) { /* ... */ }
}
```

### 第三步：注册到工厂和适配器注册表

在 `src/converters/register-converters.js` 中注册转换器（如新增了协议）：

```js
import { ExampleConverter } from './strategies/ExampleConverter.js';
ConverterFactory.registerConverter('example', ExampleConverter);
```

在 `src/providers/adapter.js` 中注册提供商：

```js
import { ExampleApiService } from './example/example-core.js';
registerAdapter(MODEL_PROVIDER.EXAMPLE_OAUTH, ExampleApiService);
```

### 第四步：添加常量

在 `src/utils/common.js` 的 `MODEL_PROVIDER` 和（如需）`MODEL_PROTOCOL_PREFIX` 中添加新常量：

```js
export const MODEL_PROVIDER = {
    // ...existing
    EXAMPLE_OAUTH: 'openai-example-oauth',
};
```

### 第五步：实现 OAuth（如需）

如果提供商需要 OAuth 认证，在 `src/auth/` 下创建认证模块，并在 `src/auth/index.js` 中导出。参考 `src/auth/kimi-oauth.js` 或 `src/auth/codex-oauth.js` 的实现风格。

如果需要持久化令牌，在 `src/providers/example/` 下创建 `example-token-store.js`，参考 `src/providers/kimi/kimi-token-store.js`。

### 第六步：编写测试

至少需要覆盖：

- `tests/unit/providers/example-core.test.js` — 适配器单元测试
- `tests/unit/auth/example-oauth.test.js` — OAuth 单元测试（如有）

### 第七步：更新配置示例

在 `configs/config.json.example` 中添加新提供商的配置示例，便于用户参考。

---

## PR 规范与检查清单

### 目标分支

所有 PR 应向 `dev` 分支提交，而非 `main`。`main` 分支仅接受来自 `dev` 的正式发布合并。

### PR 标题

遵循 Conventional Commits 格式，与提交信息的首行保持一致：

```
feat(providers): 新增 GitLab OAuth 提供商
fix(converters): 修复 Grok 流式响应解析异常
```

### PR 描述模板

```markdown
## 变更概述

<!-- 用 1-3 句话描述这个 PR 做了什么 -->

## 变更类型

- [ ] 新功能（feat）
- [ ] Bug 修复（fix）
- [ ] 重构（refactor）
- [ ] 文档（docs）
- [ ] 测试（test）
- [ ] 其他（chore / ci / perf）

## 测试情况

- [ ] 单元测试通过（`pnpm test`）
- [ ] 新增/修改了相关测试
- [ ] 集成测试通过（`pnpm run test:integration`，如涉及）

## 破坏性变更

- [ ] 无破坏性变更
- [ ] 有破坏性变更（在下方说明）

<!-- 如有破坏性变更，描述影响范围及迁移方式 -->

## 关联 Issue

Closes #
```

### 提交前检查清单

在请求 Review 之前，请确认以下各项：

- [ ] 代码使用 ES Modules（`import`/`export`），无 `require()`
- [ ] 导入路径包含 `.js` 扩展名
- [ ] 新增的类/函数有 JSDoc 注释，注释使用中文
- [ ] 单元测试全部通过：`pnpm test`
- [ ] 无调试代码（`console.log`、临时 mock 等）残留
- [ ] 没有提交 `configs/token-store.json`、`configs/pwd` 等包含凭据的文件
- [ ] 提交信息符合 Conventional Commits 格式
- [ ] 新增提供商已完成所有 6 个步骤（见"新增提供商"章节）

---

## 报告 Bug

在提交 Issue 前，请先搜索是否已有相同问题。

Bug Report 请包含以下信息：

1. **环境信息**
   - Node.js 版本（`node --version`）
   - 操作系统及版本
   - 项目版本（`package.json` 中的 `version` 字段）

2. **复现步骤**
   - 最小可复现的请求示例（curl 命令或代码片段）
   - 使用的提供商和模型名称

3. **实际行为**
   - 错误信息（完整日志，去除敏感凭据）
   - HTTP 响应码和响应体（如适用）

4. **预期行为**
   - 描述正常情况下应该发生什么

5. **额外上下文**
   - 是否为偶发问题？
   - 与其他提供商对比是否正常？

请在 Issue 标题中注明受影响的模块，例如：`[gemini] 流式响应提前终止`。

---

## 提交 Feature Request

Feature Request 请包含以下信息：

1. **需求背景**
   - 当前遇到了什么问题？这个功能解决什么场景？

2. **功能描述**
   - 期望的功能是什么？尽可能具体地描述行为

3. **接口设计建议（可选）**
   - 如果有想法，可以提供 API 设计草案或伪代码

4. **替代方案（可选）**
   - 你是否考虑过其他解决方式？为什么这个方案更好？

5. **新增提供商请求**
   - 如果是请求新增某个 AI 提供商，请提供：
     - 提供商官方文档或 API 参考链接
     - 该提供商的认证方式（OAuth、API Key 等）
     - 协议类型（兼容 OpenAI / Claude / Gemini 还是私有协议）

---

## 许可证

本项目使用 [GNU General Public License v3.0](LICENSE)。提交贡献即表示你同意你的代码以 GPLv3 协议发布。
