# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [v1.1.0] - 2026-03-27

### ✨ Features
- feat: 从 CLIProxyAPIPlus 移植 5 个 Provider（Kilo、Kimi、Copilot、CodeBuddy、GitLab）([9738271](https://github.com/mo-xiaoxi/AIClient-2-API/commit/9738271))
- feat(cursor): 全面集成 Cursor 到 Web UI 管理界面 — 批量导入、认证选择器、i18n ([779916e](https://github.com/mo-xiaoxi/AIClient-2-API/commit/779916e))
- feat(cursor): Cursor Provider 全面优化 — 会话管理、H2 连接池、流式可靠性 ([34d9cbe](https://github.com/mo-xiaoxi/AIClient-2-API/commit/34d9cbe))
- feat(cursor): 全面优化 — 截断处理、压缩传输、Tool 修复、退避重试 ([3b96793](https://github.com/mo-xiaoxi/AIClient-2-API/commit/3b96793))
- feat(cursor): 添加图片 OCR/Vision API 降级支持 ([24ca2d7](https://github.com/mo-xiaoxi/AIClient-2-API/commit/24ca2d7))

### 🐛 Bug Fixes
- fix(cursor): 审查修复 10 项问题 — 错误处理、资源清理、可观测性 ([72fabf9](https://github.com/mo-xiaoxi/AIClient-2-API/commit/72fabf9))
- fix(cursor): 修复 CodeRabbit 审查发现的 5 项问题 ([3c81d40](https://github.com/mo-xiaoxi/AIClient-2-API/commit/3c81d40))
- fix(provider): 修复令牌刷新机制中的并发和状态问题 ([9bbde40](https://github.com/mo-xiaoxi/AIClient-2-API/commit/9bbde40))
- fix(provider): 清除刷新标记避免节点卡死并更新模型列表 ([d345ec6](https://github.com/mo-xiaoxi/AIClient-2-API/commit/d345ec6))
- fix: update TOTAL_CONTEXT_TOKENS to 1048576 ([a362243](https://github.com/mo-xiaoxi/AIClient-2-API/commit/a362243))
- fix(test): 修复 PR #9 合并后 3 个测试套件的 mock 缺失问题 ([3f1c3d3](https://github.com/mo-xiaoxi/AIClient-2-API/commit/3f1c3d3))
- fix(test): 修复 markProviderNeedRefresh 测试 ([78327ba](https://github.com/mo-xiaoxi/AIClient-2-API/commit/78327ba))
- fix(test): 修复 api-server.test.js 的 http/url 模块 mock 缺失问题 ([cfc95d7](https://github.com/mo-xiaoxi/AIClient-2-API/commit/cfc95d7))

### ✅ Tests
- test: 扩展提供商与 UI 测试覆盖并调整 Jest 与 CI ([3beb381](https://github.com/mo-xiaoxi/AIClient-2-API/commit/3beb381))
- test(cursor): 补充 Cursor 批量导入测试并修复 auth-index fs mock ([6f9b1b8](https://github.com/mo-xiaoxi/AIClient-2-API/commit/6f9b1b8))

### 📚 Documentation
- docs: 添加 Cursor Provider 全面优化需求文档 ([39a2b51](https://github.com/mo-xiaoxi/AIClient-2-API/commit/39a2b51))
- docs: 添加 PackyCode 赞助商信息到 README ([ff4fc85](https://github.com/mo-xiaoxi/AIClient-2-API/commit/ff4fc85))
- docs: 在 README 中添加赞助商联系信息 ([dd32e91](https://github.com/mo-xiaoxi/AIClient-2-API/commit/dd32e91))
- docs(test-governance): 同步测试治理设计与任务文档 ([ccae157](https://github.com/mo-xiaoxi/AIClient-2-API/commit/ccae157))

### 🔧 Chores
- chore: 将 .claude/worktrees/ 加入 .gitignore ([6ff1369](https://github.com/mo-xiaoxi/AIClient-2-API/commit/6ff1369))

**统计**: 总提交数 21 | 新功能: 5 | Bug修复: 8 | 测试: 2 | 文档: 4 | 其他: 2

[v1.1.0 完整对比](https://github.com/mo-xiaoxi/AIClient-2-API/compare/v1.0.0...v1.1.0)

## [v1.0.0] - 2026-03-24

### Features
- feat(cursor): 集成 Cursor Provider，支持 PKCE OAuth + HTTP/2 Protobuf 协议代理
- feat(cursor): 动态模型获取、模型缓存 TTL 及调试日志清理
- feat(providers): 集成 Claude Kiro OAuth 提供商，增强 Grok API 重试机制
- feat: 优化 OAuth 授权流程并更新 UI 样式
- feat: 支持 modelFallbackMapping 将标准 Anthropic 模型名路由到 Cursor 内部模型

### Bug Fixes
- fix(cursor): 修复 5 个 Bug 并重构消除重复代码
- fix(cursor): 解析 end-stream 错误帧，避免无效模型返回空内容
- fix(gemini): 修复认证初始化顺序和令牌刷新逻辑
- fix: 修复 PR 审查发现的全部问题

### Tests
- test: 测试治理 Phase 1 完成，1725 个测试全部通过（0 失败）
- test: 补全 Cursor Provider 单元测试（5 个模块 109 个用例）
- test: 大规模补充单元测试，覆盖核心管道/Converter/Provider/Auth/Plugin
- test: 增强集成测试和 E2E 测试，优化 CI 配置

### CI/Build
- ci: 重构 CI 流水线，拆分并行 job + 多版本矩阵
- build: 添加 Makefile，支持本地测试和本地 CI 流水线
- refactor(test): 整理测试文件结构，与源码目录 1:1 对应

### Docs
- docs: 整理主 README 与 CLAUDE，移除多语言 README 与 VERSION
- docs: 添加测试治理设计文档和任务书
