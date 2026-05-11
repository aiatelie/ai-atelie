# Contributing to AI Atelier

Thank you for your interest in contributing to AI Atelier! We welcome contributions from humans **and** from agent CLIs (Claude Code, Codex, Kimi, OpenCode, Cursor, etc.).

This guide covers everything you need to know to contribute effectively.

<details>
<summary>中文</summary>

# 为 AI Atelier 做贡献

感谢你对 AI Atelier 的兴趣！我们欢迎人类**和**智能体 CLI（Claude Code、Codex、Kimi、OpenCode、Cursor 等）的贡献。

本指南涵盖了你有效贡献所需了解的一切。

</details>

---

## Table of Contents

- [How to Contribute](#how-to-contribute)
- [Prerequisites](#prerequisites)
- [Setting Up Agent CLI Integration](#setting-up-agent-cli-integration)
- [Setting Up Locally](#setting-up-locally)
- [Git Branching & Commit Style](#git-branching--commit-style)
- [Pull Request Workflow](#pull-request-workflow)
- [Coding Conventions](#coding-conventions)
- [Testing](#testing)
- [Dev-Time Skills](#dev-time-skills)
- [The `ship-task` Workflow](#the-ship-task-workflow)
- [Need Help?](#need-help)

<details>
<summary>中文</summary>

## 目录

- [如何贡献](#how-to-contribute)
- [前置条件](#prerequisites)
- [设置智能体 CLI 集成](#setting-up-agent-cli-integration)
- [本地设置](#setting-up-locally)
- [Git 分支与提交风格](#git-branching--commit-style)
- [Pull Request 工作流程](#pull-request-workflow)
- [编码规范](#coding-conventions)
- [测试](#testing)
- [开发时技能](#dev-time-skills)
- [ship-task 工作流程](#the-ship-task-workflow)
- [需要帮助？](#need-help)

</details>

---

## How to Contribute

1. **Find an issue** — browse [open issues](https://github.com/aiatelie/ai-atelie/issues) or open a new one
2. **Discuss** — comment on the issue to let others know you're working on it
3. **Fork & branch** — create a feature branch from `main`
4. **Implement** — follow the conventions below
5. **Test** — ensure the Critical User Journey passes
6. **Open a PR** — with a clear title and description referencing the issue

If you are an agent CLI, the [dev-time skills](#dev-time-skills) will guide you through each step automatically.

<details>
<summary>中文</summary>

## 如何贡献

1. **查找 issue** — 浏览[开放的 issue](https://github.com/aiatelie/ai-atelie/issues) 或新建一个
2. **讨论** — 在 issue 中评论，让他人知道你在处理
3. **Fork 并创建分支** — 从 `main` 创建功能分支
4. **实现** — 遵循以下规范
5. **测试** — 确保关键用户旅程通过
6. **打开 PR** — 使用清晰的标题和描述，引用相关 issue

如果你是智能体 CLI，[开发时技能](#dev-time-skills)将自动引导你完成每个步骤。

</details>

---

## Prerequisites

- **Bun** >= 1.2.x (install: `curl -fsSL https://bun.sh/install | bash`)
- **Node.js** >= 20.x (for some agent CLIs)
- **An agent CLI** — at least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Codex](https://github.com/openai/codex), [Kimi](https://kimi.moonshot.cn/), [OpenCode](https://github.com/sst/opencode), [Cursor](https://cursor.com), [Copilot](https://github.com/features/copilot), [Gemini CLI](https://google-gemini.github.io/gemini-cli/), [Qwen CLI](https://github.com/QwenLM/Qwen), [Hermes](https://hermes-agent.nousresearch.com)
- **Playwright browsers** (for E2E tests): `bunx playwright install chromium`

<details>
<summary>中文</summary>

## 前置条件

- **Bun** >= 1.2.x（安装：`curl -fsSL https://bun.sh/install | bash`）
- **Node.js** >= 20.x（某些智能体 CLI 需要）
- **一个智能体 CLI** — 至少其中之一：[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、[Codex](https://github.com/openai/codex)、[Kimi](https://kimi.moonshot.cn/)、[OpenCode](https://github.com/sst/opencode)、[Cursor](https://cursor.com)、[Copilot](https://github.com/features/copilot)、[Gemini CLI](https://google-gemini.github.io/gemini-cli/)、[Qwen CLI](https://github.com/QwenLM/Qwen)、[Hermes](https://hermes-agent.nousresearch.com)
- **Playwright 浏览器**（用于 E2E 测试）：`bunx playwright install chromium`

</details>

---

## Setting Up Agent CLI Integration

This repo is designed to work with multiple agent CLIs. The dev-time skills and project configuration are agent-agnostic.

### Claude Code

Claude Code discovers `.claude/skills/`, `AGENTS.md`, and `.mcp.json` automatically.

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Start a session
claude
```

### OpenCode

OpenCode reads `.claude/skills/`, `AGENTS.md`, and `opencode.json`.

```bash
# Install OpenCode
npm install -g opencode

# Start a session
opencode
```

### Other Agents

For Codex, Kimi, Cursor, etc., follow their respective CLI setup guides. The `AGENTS.md` file provides project orientation for any AGENTS.md-aware CLI.

<details>
<summary>中文</summary>

## 设置智能体 CLI 集成

本仓库设计为与多个智能体 CLI 配合使用。开发时技能和项目配置与智能体无关。

### Claude Code

Claude Code 自动发现 `.claude/skills/`、`AGENTS.md` 和 `.mcp.json`。

```bash
# 安装 Claude Code
npm install -g @anthropic-ai/claude-code

# 启动会话
claude
```

### OpenCode

OpenCode 读取 `.claude/skills/`、`AGENTS.md` 和 `opencode.json`。

```bash
# 安装 OpenCode
npm install -g opencode

# 启动会话
opencode
```

### 其他智能体

对于 Codex、Kimi、Cursor 等，请遵循各自的 CLI 设置指南。`AGENTS.md` 文件为任何支持 AGENTS.md 的 CLI 提供项目定位。

</details>

---

## Setting Up Locally

```bash
# Clone the repository
git clone https://github.com/aiatelie/ai-atelie.git
cd ai-atelie

# Install workspace dependencies
bun install

# Copy environment variables (if applicable)
cp .env.example .env

# Start development (web + API)
bun dev
```

The development server starts:
- Web app at `http://localhost:5173`
- API server at `http://localhost:5174`

<details>
<summary>中文</summary>

## 本地设置

```bash
# 克隆仓库
git clone https://github.com/aiatelie/ai-atelie.git
cd ai-atelie

# 安装工作空间依赖
bun install

# 复制环境变量（如适用）
cp .env.example .env

# 启动开发环境（Web + API）
bun dev
```

开发服务器启动：
- Web 应用在 `http://localhost:5173`
- API 服务器在 `http://localhost:5174`

</details>

---

## Git Branching & Commit Style

### Branch Naming

```
feat/<description>     — New features
fix/<description>      — Bug fixes
docs/<description>     — Documentation changes
refactor/<description> — Code refactoring
chore/<description>    — Maintenance tasks
```

### Commit Style

This project uses **Conventional Commits 1.0.0** with a closed scope set. The scope set is: `api | web | mcp | skills | repo | deps`.

```
<type>(<scope>): <imperative subject>

[optional body]
```

Examples:

```
feat(web): add zoom controls to canvas
fix(api): handle null model response gracefully
docs(repo): update README with new architecture diagram
chore(deps): bump playwright to 1.52.0
```

**Rules:**
- Subject is imperative, lowercase, no trailing period
- One branch per logical change — do not split a feature across multiple PRs
- One branch can have multiple semantic commits
- CHANGELOG is auto-generated by `changelogen` + `bumpp` — write commit bodies that read well in the changelog

<details>
<summary>中文</summary>

## Git 分支与提交风格

### 分支命名

```
feat/<description>     — 新功能
fix/<description>      — 错误修复
docs/<description>     — 文档更改
refactor/<description> — 代码重构
chore/<description>    — 维护任务
```

### 提交风格

本项目使用 **Conventional Commits 1.0.0**，带有封闭的作用域集。作用域集为：`api | web | mcp | skills | repo | deps`。

```
<type>(<scope>): <imperative subject>

[optional body]
```

示例：

```
feat(web): add zoom controls to canvas
fix(api): handle null model response gracefully
docs(repo): update README with new architecture diagram
chore(deps): bump playwright to 1.52.0
```

**规则：**
- 主题使用祈使句、小写、无句尾句号
- 每个逻辑更改一个分支——不要将一个功能分散到多个 PR 中
- 一个分支可以有多个语义化提交
- CHANGELOG 由 `changelogen` + `bumpp` 自动生成——编写在变更日志中易于阅读的提交正文

</details>

---

## Pull Request Workflow

1. **Create a PR** from your feature branch to `main`
2. **Title** should follow Conventional Commits format: `type(scope): description`
3. **Description** should include:
   - What the change does
   - Why it's needed (link to the issue)
   - How it was tested
   - Screenshots or screen recordings for UI changes
4. **CI** will run automatically — ensure all checks pass
5. **Review** — at least one maintainer review required
6. **Merge** — squash-merge into `main`

<details>
<summary>中文</summary>

## Pull Request 工作流程

1. **创建 PR** — 从你的功能分支到 `main`
2. **标题** — 应遵循 Conventional Commits 格式：`type(scope): description`
3. **描述** — 应包括：
   - 更改内容
   - 更改原因（链接到 issue）
   - 测试方式
   - UI 更改的截图或录屏
4. **CI** — 将自动运行，确保所有检查通过
5. **审查** — 至少需要一位维护者审查
6. **合并** — squash-merge 到 `main`

</details>

---

## Coding Conventions

### General

- **TypeScript** — strict mode. Avoid `any` unless absolutely necessary
- **React** — functional components with hooks. No class components
- **CSS** — Tailwind utility classes + a single `src/index.css` for custom styles
- **State management** — Zustand for global state, `useReducer` for complex local state
- **Comments** — default to none. Only annotate non-obvious *why* — hidden constraints, surprising invariants, workarounds for specific bugs

### Formatting & Linting

The project uses Prettier for formatting and ESLint for linting:

```bash
# Format code
bun run format

# Check for lint issues
bun run lint
```

### Atelier Rulebook

Design-related contributions should respect the `atelier/` rulebook files:

```
atelier/
  typography.md       — Font stack, sizes, line heights
  color.md            — Palette, contrast, usage
  animation.md        — Motion principles and timing
  accessibility.md    — ARIA, keyboard, color contrast
  anti-ai-slop.md     — Quality standards for AI-generated output
  form-validation.md  — Validation patterns
  state-coverage.md   — UI state requirements
  rtl-and-bidi.md     — Right-to-left and bidirectional support
```

<details>
<summary>中文</summary>

## 编码规范

### 通用

- **TypeScript** — 严格模式。除非绝对必要，否则避免使用 `any`
- **React** — 使用 hooks 的函数组件。无类组件
- **CSS** — Tailwind 工具类 + 单个 `src/index.css` 用于自定义样式
- **状态管理** — Zustand 用于全局状态，`useReducer` 用于复杂的局部状态
- **注释** — 默认为无。仅注释非显而易见的*原因*——隐藏约束、令人惊讶的不变量、特定错误的解决方法

### 格式化和检查

项目使用 Prettier 进行格式化，ESLint 进行检查：

```bash
# 格式化代码
bun run format

# 检查 lint 问题
bun run lint
```

### Atelier 规则手册

与设计相关的贡献应尊重 `atelier/` 规则手册文件：

```
atelier/
  typography.md       — 字体栈、大小、行高
  color.md            — 调色板、对比度、使用
  animation.md        — 动效原则和时序
  accessibility.md    — ARIA、键盘、色彩对比度
  anti-ai-slop.md     — AI 生成内容的质量标准
  form-validation.md  — 验证模式
  state-coverage.md   — UI 状态要求
  rtl-and-bidi.md     — 从右到左和双向支持
```

</details>

---

## Testing

### Critical User Journey (CUJ)

The load-bearing test is the CUJ suite at `web/tests/e2e/cuj.spec.ts`. Any change that plausibly affects routes, onboarding, canvas, or chat must keep it green.

```bash
# Run the full journey suite
bun run journeys
```

### E2E Tests

Additional Playwright specs live in `web/tests/e2e/`:

```bash
# Run all E2E tests (excludes journeys)
bun run test:e2e

# Run a specific test file
bunx playwright test web/tests/e2e/cuj.spec.ts
```

### Evidence Pipeline

When opening a PR, include evidence of testing:

1. Run `bun run journeys` to generate video/screenshot evidence
2. The `pr-evidence` skill will inject the evidence block into your PR body
3. Evidence is uploaded as GitHub user-attachments and displayed inline

<details>
<summary>中文</summary>

## 测试

### 关键用户旅程（CUJ）

负载测试是 `web/tests/e2e/cuj.spec.ts` 中的 CUJ 套件。任何可能影响路由、入门流程、画布或聊天的更改都必须保持其通过。

```bash
# 运行完整的旅程套件
bun run journeys
```

### E2E 测试

其他 Playwright 规范位于 `web/tests/e2e/`：

```bash
# 运行所有 E2E 测试（不包括旅程）
bun run test:e2e

# 运行特定测试文件
bunx playwright test web/tests/e2e/cuj.spec.ts
```

### 证据管道

打开 PR 时，包含测试证据：

1. 运行 `bun run journeys` 生成视频/截图证据
2. `pr-evidence` 技能将证据块注入你的 PR 正文
3. 证据作为 GitHub 用户附件上传并内联显示

</details>

---

## Dev-Time Skills

The repo includes automated skills for contributors under `.claude/skills/`. These are auto-discovered by Claude Code and OpenCode.

| Skill | Purpose |
|-------|---------|
| `ship-task` | Full contributor loop: understand → implement → verify → commit → PR |
| `verify-with-playwright` | Per-task browser verification with evidence capture |
| `semantic-commit` | Drafts Conventional Commits messages |
| `pr-evidence` | Injects inline evidence block into PR body |
| `cuj-guardian` | Runs and triages the CUJ suite on every PR change |
| `frontend-design` | Aesthetic + convention guide for host app chrome |
| `canvas-sync` | DesignCanvas parity enforcement across canonical/mirror/host |
| `grill-me` | Code review critique skill |

<details>
<summary>中文</summary>

## 开发时技能

仓库在 `.claude/skills/` 下包含供贡献者使用的自动化技能。这些技能会被 Claude Code 和 OpenCode 自动发现。

| 技能 | 用途 |
|-------|---------|
| `ship-task` | 完整贡献循环：理解 → 实现 → 验证 → 提交 → PR |
| `verify-with-playwright` | 逐任务浏览器验证和证据捕获 |
| `semantic-commit` | 起草 Conventional Commits 消息 |
| `pr-evidence` | 将内联证据块注入 PR 正文 |
| `cuj-guardian` | 在每个 PR 更改时运行和分类 CUJ 套件 |
| `frontend-design` | 主机应用界面的美学和约定指南 |
| `canvas-sync` | DesignCanvas 在规范/镜像/主机中的一致性强制 |
| `grill-me` | 代码审查技能 |

</details>

---

## The `ship-task` Workflow

The `ship-task` skill orchestrates the full contributor loop:

1. **Understand** — read the issue, quote acceptance criteria, confirm understanding
2. **Implement** — make the minimum change needed. No drive-by refactors
3. **Verify** — run `verify-with-playwright` for browser-based testing with evidence
4. **Blast-radius check** — forced-format regression report with:
   - All importers/call sites of changed code
   - Data-flow paths affected
   - Non-local effects (config, types, exports, tests)
   - Verdict: SAFE, SHALLOW, or DEEP
5. **Commit** — use `semantic-commit` to draft a proper commit message
6. **PR** — push and open a PR with the `pr-evidence` template

<details>
<summary>中文</summary>

## ship-task 工作流程

`ship-task` 技能编排完整的贡献循环：

1. **理解** — 阅读 issue，引用验收标准，确认理解
2. **实现** — 进行最小必要的更改。不进行附带重构
3. **验证** — 运行 `verify-with-playwright` 进行基于浏览器的测试和证据捕获
4. **影响范围检查** — 强制格式的回归报告，包括：
   - 更改代码的所有导入者/调用点
   - 受影响的数据流路径
   - 非局部影响（配置、类型、导出、测试）
   -  verdict：SAFE、SHALLOW 或 DEEP
5. **提交** — 使用 `semantic-commit` 起草合适的提交消息
6. **PR** — 推送并使用 `pr-evidence` 模板打开 PR

</details>

---

## Need Help?

- **Discord**: [discord.gg/aiatelie](https://discord.gg/aiatelie)
- **GitHub Discussions**: [github.com/aiatelie/ai-atelie/discussions](https://github.com/aiatelie/ai-atelie/discussions)
- **File an issue**: [github.com/aiatelie/ai-atelie/issues/new](https://github.com/aiatelie/ai-atelie/issues/new)

<details>
<summary>中文</summary>

## 需要帮助？

- **Discord**：[discord.gg/aiatelie](https://discord.gg/aiatelie)
- **GitHub Discussions**：[github.com/aiatelie/ai-atelie/discussions](https://github.com/aiatelie/ai-atelie/discussions)
- **提交 issue**：[github.com/aiatelie/ai-atelie/issues/new](https://github.com/aiatelie/ai-atelie/issues/new)

</details>
