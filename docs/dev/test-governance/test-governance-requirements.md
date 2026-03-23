---
feature: test-governance
complexity: complex
generated_by: clarify
generated_at: 2026-03-23T00:00:00Z
version: 1
---

# 需求文档: 测试系统性治理

> **功能标识**: test-governance
> **复杂度**: complex

## 1. 概述

### 1.1 一句话描述

系统性治理项目的单元测试、集成测试和端到端测试，将整体覆盖率从 32.76% 提升到 70%，补齐每个提供商的集成测试链路，并在 CI 中强制卡控覆盖率。

### 1.2 核心价值

- **质量保障**：通过全面的测试覆盖防止回归，提升代码变更信心
- **结构规范**：建立金字塔式测试结构（单元 > 集成 > E2E），确保每层测试职责明确
- **CI 卡控**：覆盖率不达标即阻止合并，从流程上保障测试质量持续提升

### 1.3 目标用户

项目开发者和维护者

## 2. 需求与用户故事

### 2.1 需求清单

| ID | 需求点 | 优先级 | 用户故事 |
|----|--------|--------|----------|
| R01 | 单元测试覆盖率提升至 70% | P0 | 作为开发者，我希望核心模块都有充分的单元测试，这样修改代码时不担心引入回归 |
| R02 | 低覆盖模块补充单元测试 | P0 | 作为开发者，我希望 api-potluck (5.9%)、claude (7.97%)、gemini (14.7%)、grok (15.09%)、ui-modules (14.8%) 等低覆盖模块都有对应测试 |
| R03 | 每个提供商补充集成测试 | P1 | 作为开发者，我希望每个提供商（gemini、claude、openai、grok、forward）都有从请求到响应的完整链路集成测试 |
| R04 | 集成测试覆盖流式响应 | P1 | 作为开发者，我希望集成测试能验证 SSE 流式响应的正确性 |
| R05 | E2E 测试补充关键场景 | P2 | 作为开发者，我希望 E2E 测试能覆盖多提供商切换、故障转移等关键场景 |
| R06 | CI 覆盖率阈值卡控 | P0 | 作为维护者，我希望 CI 流水线在覆盖率低于 70% 时自动失败，防止覆盖率下降 |
| R07 | Jest 覆盖率阈值配置 | P0 | 作为开发者，我希望在 jest.config.js 中配置全局覆盖率阈值 |
| R08 | 未测试模块清零 | P1 | 作为开发者，我希望消除完全没有测试的源文件（auth/index.js、iflow-oauth.js、多个 provider core 文件等） |

### 2.2 验收标准

| ID | 条件 |
|----|------|
| AC01 | WHEN 运行 `pnpm run test:coverage` THEN 语句覆盖率 ≥ 70%，分支覆盖率 ≥ 55% |
| AC02 | WHEN 运行 `pnpm run test:integration` THEN 每个提供商（gemini、claude、openai、grok、forward）至少有 1 个完整链路测试通过 |
| AC03 | WHEN 运行 `pnpm run test:integration` THEN 至少有 2 个提供商的流式响应测试通过 |
| AC04 | WHEN 运行 `pnpm run test:e2e` THEN 所有端到端场景测试通过 |
| AC05 | WHEN 提交代码到 main/dev 分支 THEN CI 流水线自动运行覆盖率检查，低于阈值则失败 |
| AC06 | WHEN 查看 jest.config.js THEN 可看到 coverageThreshold 全局配置（statements: 70, branches: 55, functions: 60, lines: 70） |
| AC07 | WHEN 列出所有 src/ 下非排除文件 THEN 每个文件至少有 1 个对应测试文件或被其他测试间接覆盖 |

## 3. 功能验收清单

| ID | 功能点 | 验收步骤 | 优先级 |
|----|--------|----------|--------|
| F01 | 低覆盖模块单元测试 — providers | 运行 `pnpm test tests/unit/providers/`，验证 claude、gemini、grok、openai 子目录均有新增测试且通过 | P0 |
| F02 | 低覆盖模块单元测试 — plugins | 运行 `pnpm test tests/unit/plugins/`，验证 api-potluck 有新增测试且通过 | P0 |
| F03 | 低覆盖模块单元测试 — ui-modules | 运行 `pnpm test tests/unit/ui-modules/`，验证新增模块测试且通过 | P1 |
| F04 | 低覆盖模块单元测试 — auth | 运行 `pnpm test tests/unit/auth/`，验证 auth/index.js、iflow-oauth 有测试 | P1 |
| F05 | 低覆盖模块单元测试 — services | 运行 `pnpm test tests/unit/services/`，验证 api-server、service-manager、ui-manager 有测试 | P1 |
| F06 | 低覆盖模块单元测试 — utils | 运行 `pnpm test tests/unit/utils/`，验证未覆盖的工具函数有测试 | P1 |
| F07 | 提供商集成测试 — gemini | 运行集成测试，验证 gemini 协议转换+响应完整链路 | P1 |
| F08 | 提供商集成测试 — claude | 运行集成测试，验证 claude 协议转换+响应完整链路 | P1 |
| F09 | 提供商集成测试 — openai | 运行集成测试，验证 openai 协议转换+响应完整链路 | P1 |
| F10 | 提供商集成测试 — grok | 运行集成测试，验证 grok 协议转换+响应完整链路 | P1 |
| F11 | 提供商集成测试 — forward | 验证现有 forward 集成测试通过（已有） | P2 |
| F12 | 流式响应集成测试 | 运行集成测试，验证至少 2 个提供商的 SSE 流式测试通过 | P1 |
| F13 | E2E 场景补充 | 运行 `pnpm run test:e2e`，验证新增场景通过 | P2 |
| F14 | Jest 覆盖率阈值 | 检查 jest.config.js 中 coverageThreshold 配置 | P0 |
| F15 | CI 覆盖率卡控 | 检查 `.github/workflows/test.yml` 中单元测试 job 包含 `--coverage` 且阈值生效 | P0 |
| F16 | 全局覆盖率达标 | 运行 `pnpm run test:coverage`，验证语句覆盖率 ≥ 70% | P0 |

## 4. 技术约束

### 4.1 技术栈

- 测试框架：Jest + babel-jest（ESM 转换）
- Mock 方式：`jest.unstable_mockModule()`（ESM 专用）
- 集成测试基础设施：`tests/helpers/` 下的 mock upstream stack
- E2E 测试：Jest HTTP 请求
- UI 测试：Playwright（不在本次范围重点）
- CI：GitHub Actions

### 4.2 集成点

- 集成测试需要利用现有 `stub-openai-upstream.js` 和 `start-mock-upstream-stack.js` 基础设施
- 新增提供商集成测试需要扩展 mock stack 以支持 gemini/claude/grok 协议
- CI 配置需在现有 `.github/workflows/test.yml` 上修改
- Jest 配置需在现有 `jest.config.js` 上添加 coverageThreshold

### 4.3 约束

- 所有测试必须不依赖外部网络和真实 API 密钥（live 测试除外）
- 测试超时设置保持 30 秒
- ESM 模块 mock 必须使用 `jest.unstable_mockModule()`，不能用 `jest.mock()`
- TLS sidecar（Go binary）相关代码需要 mock 绕过

## 5. 排除项

- Playwright UI 测试不在本次治理重点（保持现状）
- Live 测试（tests/live/）不纳入 CI 卡控
- 已排除的文件（master.js、tls-sidecar.js、scripts/、convert-old.js、cursor/proto/）继续排除
- 不做性能测试、压力测试
- 不做测试数据工厂/fixture 体系建设

## 6. 下一步

### 6.1 实施路径（金字塔策略）

**Phase 1 — 单元测试（P0）**
1. 补充 providers 低覆盖模块测试（claude-kiro、antigravity-core、grok、openai iflow/qwen/responses-core）
2. 补充 plugins/api-potluck 测试
3. 补充 auth、services、ui-modules、utils 缺失测试
4. 配置 Jest coverageThreshold
5. 验证整体覆盖率达到 70%

**Phase 2 — 集成测试（P1）**
1. 扩展 mock upstream stack，支持 gemini/claude/grok 协议响应
2. 为每个提供商编写完整链路集成测试
3. 补充流式响应集成测试
4. 验证 `pnpm run test:integration` 全部通过

**Phase 3 — E2E 测试 + CI（P0-P2）**
1. 补充 E2E 关键场景（多提供商切换、故障转移）
2. 更新 CI 配置，单元测试 job 增加 `--coverage` 和阈值检查
3. 验证 CI 流水线覆盖率卡控生效

### 6.2 执行方式

建议使用 `/devagent:dev-spec-dev test-governance --skip-requirements` 在新会话中执行，按 Phase 分阶段实施。
