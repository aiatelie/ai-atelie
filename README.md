<p align="center">
  <img src="./public/logo.svg" alt="AI Atelier" width="120" height="120" />
</p>

<h1 align="center">AI Atelier</h1>

<p align="center">
  <strong>An open‑source alternative to Anthropic Claude Design.</strong>
  <br />
  Design HTML/JSX/CSS artifacts together with your agent CLI.
  <br />
  <a href="https://ai.atel.ie"><strong>ai.atel.ie »</strong></a>
</p>

<p align="center">
  <a href="https://github.com/aiatelie/ai-atelie/actions"><img src="https://img.shields.io/github/actions/workflow/status/aiatelie/ai-atelie/ci.yml?branch=main&logo=github&label=CI" alt="CI" /></a>
  <a href="https://github.com/aiatelie/ai-atelie/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aiatelie/ai-atelie?label=License" alt="License" /></a>
  <a href="https://github.com/aiatelie/ai-atelie/releases"><img src="https://img.shields.io/github/v/release/aiatelie/ai-atelie?logo=semver&label=Release" alt="Release" /></a>
  <a href="https://discord.gg/aiatelie"><img src="https://img.shields.io/discord/XXXXXX?logo=discord&label=Discord" alt="Discord" /></a>
  <a href="https://x.com/aiatelie"><img src="https://img.shields.io/twitter/follow/aiatelie?style=social" alt="X / Twitter" /></a>
    </p>

![AI Atelie](docs/hero.png)

<details>
<summary>中文</summary>

<p align="center">
  <strong>Anthropic Claude Design 的开源替代品。</strong>
  <br />
  与你的智能体 CLI 一起设计 HTML/JSX/CSS 产物。
  <br />
  <a href="https://ai.atel.ie"><strong>ai.atel.ie »</strong></a>
</p>

<p align="center">
  <a href="https://github.com/aiatelie/ai-atelie/actions"><img src="https://img.shields.io/github/actions/workflow/status/aiatelie/ai-atelie/ci.yml?branch=main&logo=github&label=CI" alt="CI" /></a>
  <a href="https://github.com/aiatelie/ai-atelie/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aiatelie/ai-atelie?label=License" alt="License" /></a>
  <a href="https://github.com/aiatelie/ai-atelie/releases"><img src="https://img.shields.io/github/v/release/aiatelie/ai-atelie?logo=semver&label=Release" alt="Release" /></a>
</p>

![AI Atelie](docs/hero.png)

</details>

---

> **Read this in other languages:** [English](README.md) · [中文](README.md#中文)

---

## What Is AI Atelier?

AI Atelier is a **local-first, open‑source design atelier** where every project lives as a folder of raw HTML / JSX / CSS files. You and an agent CLI shape designs together inside a browser‑based editor.

Instead of fighting with prompt limits or opaque design tools, every part of your artifact is editable — the source code, the chat conversation, even the agent skills that helped build it.

AI Atelier was built to scratch an itch: [Claude Design](https://claude.ai/design) is incredible, but it is a closed ecosystem. You cannot iterate on a design without starting a new chat, you cannot version-control your artifacts, and you cannot bring your own agent. This project fixes all of that.

```
┌────────────────────────────────────────────────┐
│               AI Atelier                        │
│                                                  │
│  ┌────────────┐  ┌────────────────────────────┐  │
│  │   Chat      │  │     Canvas (iframe)        │  │
│  │   Sidebar   │  │   ┌────────────────────┐  │  │
│  │             │  │   │   Your Design       │  │  │
│  │  ┌───────┐  │  │   │   (HTML/JSX/CSS)    │  │  │
│  │  │ Agent │  │  │   └────────────────────┘  │  │
│  │  │ Chat  │  │  └────────────────────────────┘  │
│  │  └───────┘  │  ┌────────────────────────────┐  │
│  └────────────┘  │   Tweaks · Inspector        │  │
│                   │   Properties Panel          │  │
│                   └────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

<details>
<summary>中文</summary>

## AI Atelier 是什么？

AI Atelier 是一个**本地优先、开源的设计工作室**。每个项目都是一个包含原始 HTML / JSX / CSS 文件的文件夹。你和智能体 CLI 通过浏览器编辑器协作塑造设计。

与受限于提示长度或不透明的设计工具不同，你的产物的每个部分都可编辑——源代码、对话记录、甚至用于构建它的智能体技能。

AI Atelier 的诞生源于一个需求：[Claude Design](https://claude.ai/design) 非常出色，但它是一个封闭的生态系统。你无法在不开启新对话的情况下迭代设计，无法对产物进行版本控制，也无法使用你自己的智能体。这个项目解决了所有这些问题。

</details>

---

## Features

- **Agent‑first architecture** — bring your own CLI (Claude Code, Codex, Kimi, OpenCode, Cursor, Copilot, Gemini, Qwen, Hermes)
- **Live preview** — your artifact renders in an iframe with React + Babel‑Standalone (no build step)
- **Three edit modes**:
  - **Tweaks** — in‑design controls exposed by each component
  - **Inspector** — raw CSS property overrides
  - **Bake to source** — apply changes back to the source file via the agent
- **Skill system** — composable playbooks that teach the agent how to design
- **Local‑first** — all files on your machine. Git-friendly, no lock-in
- **MCP servers** — ask-user elicitation, starter templates, capability discovery
- **Canvas protocol** — modular DesignCanvas supporting pan, zoom, artboards, sections
- **Runtime AI** — artifacts can call `window.ai.complete()` for in-browser AI at runtime
- **Agent adapters** — Claude Code, Kimi, OpenCode all supported. Add your own

<details>
<summary>中文</summary>

## 特性

- **智能体优先架构** — 使用你自己的 CLI（Claude Code、Codex、Kimi、OpenCode、Cursor、Copilot、Gemini、Qwen、Hermes）
- **实时预览** — 你的产物在 iframe 中使用 React + Babel-Standalone 渲染（无需构建步骤）
- **三种编辑模式**：
  - **Tweaks（调整）** — 每个组件公开的设计内控件
  - **Inspector（检查器）** — 原始 CSS 属性覆盖
  - **Bake to source（烘焙到源码）** — 通过智能体将更改应用到源文件
- **技能系统** — 可组合的操作手册，教智能体如何进行设计
- **本地优先** — 所有文件都在你的机器上。Git 友好，无锁定
- **MCP 服务器** — 用户询问、入门模板、能力发现
- **画布协议** — 模块化 DesignCanvas，支持平移、缩放、画板、分区
- **运行时 AI** — 产物可调用 `window.ai.complete()` 在浏览器中运行时使用 AI
- **智能体适配器** — 支持 Claude Code、Kimi、OpenCode。可自行添加

</details>

---

## How It Works

### The Edit Loop

1. **Create or open a project** — each project is a folder under `web/projects/`
2. **Chat with the agent** — ask it to build something, modify a component, or explore ideas
3. **See changes live** — the iframe auto-updates as the agent edits files
4. **Use tweaks & inspector** — no-code adjustments for spacing, color, layout
5. **Bake to source** — lock in your changes permanently
6. **Iterate** — the agent remembers the conversation; keep refining

### Project Structure

```
web/projects/<project-name>/
  index.html            — the artifact (React + JSX rendered in an iframe)
  DESIGN.md             — automatically maintained design document
  history.jsonl         — conversation history with the agent
  config/               — per-project model, skill, and tool configuration
  skills/               — per-project skill overrides
```

### Agent Integration

The API server (`api/`) spawns the agent CLI as a subprocess and streams responses back to the editor via SSE. Each agent has its own adapter:

| Agent | Adapter | Status |
|-------|---------|--------|
| Claude Code | `api/src/agents/claude/` | Well-tested |
| Kimi | `api/src/agents/kimi/` | Implemented |
| OpenCode | `api/src/agents/opencode/` | Implemented |

<details>
<summary>中文</summary>

## 工作原理

### 编辑循环

1. **创建或打开项目** — 每个项目是 `web/projects/` 下的一个文件夹
2. **与智能体对话** — 要求它构建某些内容、修改组件或探索创意
3. **实时查看更改** — 智能体编辑文件时，iframe 自动更新
4. **使用调整和检查器** — 无需编码即可调整间距、颜色、布局
5. **烘焙到源码** — 永久锁定你的更改
6. **迭代** — 智能体会记住对话；继续优化

### 项目结构

```
web/projects/<project-name>/
  index.html            — 产物（使用 React + JSX 在 iframe 中渲染）
  DESIGN.md             — 自动维护的设计文档
  history.jsonl         — 与智能体的对话历史
  config/               — 每个项目的模型、技能和工具配置
  skills/               — 每个项目的技能覆盖
```

### 智能体集成

API 服务器（`api/`）将智能体 CLI 作为子进程启动，并通过 SSE 将响应流式传输回编辑器。每个智能体都有自己的适配器：

| 智能体 | 适配器 | 状态 |
|-------|---------|--------|
| Claude Code | `api/src/agents/claude/` | 经过充分测试 |
| Kimi | `api/src/agents/kimi/` | 已实现 |
| OpenCode | `api/src/agents/opencode/` | 已实现 |

</details>

---

## Getting Started

### Prerequisites

- **Bun** >= 1.2.x
- **An agent CLI** — at least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [Codex](https://github.com/openai/codex), [Kimi](https://kimi.moonshot.cn/), [OpenCode](https://github.com/sst/opencode), [Cursor](https://cursor.com), [Copilot](https://github.com/features/copilot), [Gemini CLI](https://google-gemini.github.io/gemini-cli/), [Qwen CLI](https://github.com/QwenLM/Qwen), [Hermes](https://hermes-agent.nousresearch.com)
- **Node.js** >= 20.x (for some agent CLIs)

### Quick Start

```bash
# Install dependencies
bun install

# Start the development server (web + API)
bun dev

# Open http://localhost:5173 in your browser
```

### Configuration

Agent CLIs are configured in `api/src/agents/<agent>/adapter.ts`. Each adapter sets:

- The CLI command to spawn
- Environment variables for the agent session
- Skill directories and MCP server references
- Model preferences and cost limits

See `api/src/agents/claude/adapter.ts` for a documented example.

<details>
<summary>中文</summary>

## 快速开始

### 前置条件

- **Bun** >= 1.2.x
- **一个智能体 CLI** — 至少其中之一：[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、[Codex](https://github.com/openai/codex)、[Kimi](https://kimi.moonshot.cn/)、[OpenCode](https://github.com/sst/opencode)、[Cursor](https://cursor.com)、[Copilot](https://github.com/features/copilot)、[Gemini CLI](https://google-gemini.github.io/gemini-cli/)、[Qwen CLI](https://github.com/QwenLM/Qwen)、[Hermes](https://hermes-agent.nousresearch.com)
- **Node.js** >= 20.x（某些智能体 CLI 需要）

### 快速启动

```bash
# 安装依赖
bun install

# 启动开发服务器（Web + API）
bun dev

# 在浏览器中打开 http://localhost:5173
```

### 配置

智能体 CLI 在 `api/src/agents/<agent>/adapter.ts` 中配置。每个适配器设置：

- 要启动的 CLI 命令
- 智能体会话的环境变量
- 技能目录和 MCP 服务器引用
- 模型偏好和成本限制

参见 `api/src/agents/claude/adapter.ts` 获取带注释的示例。

</details>

---

## Architecture

```
ai-atelie/
  api/          Bun + Hono SSE server (port 5174)
  web/          React + Vite editor application (port 5173)
  mcp/          MCP servers: ask-user, starters, capabilities
  skills/       Product skills — composable agent playbooks for end users
  .claude/      Dev-time skills for contributors working on the repo
  atelier/      Design rulebook (typography, color, accessibility, animation…)
  docs/         Documentation
  playwright-tools/  E2E testing and evidence capture tooling
```

<details>
<summary>中文</summary>

## 架构

```
ai-atelie/
  api/          Bun + Hono SSE 服务器（端口 5174）
  web/          React + Vite 编辑器应用（端口 5173）
  mcp/          MCP 服务器：ask-user、starters、capabilities
  skills/       产品技能 — 面向最终用户的可组合智能体操作手册
  .claude/      面向仓库贡献者的开发时技能
  atelier/      设计规则手册（排版、色彩、无障碍、动画…）
  docs/         文档
  playwright-tools/  E2E 测试和证据捕获工具
```

</details>

---

## Skills

The repo ships with two tiers of skills:

### Product Skills (`skills/`)

Loaded into agent sessions when a user is designing artifacts. These composable playbooks teach the agent how to build, tweak, and export designs. Includes skills for: frontend design, interactive prototypes, design systems, animated video, standalone HTML export, Canva integration, and more.

### Dev-Time Skills (`.claude/skills/`)

Used by contributors working on the repo itself. These skills automate the full contributor workflow:

- **ship-task** — understand → implement → verify → semantic commit → PR with evidence
- **cuj-guardian** — quality gate that runs and triages the Critical User Journey suite
- **verify-with-playwright** — drive a real browser, capture screenshots/video for evidence
- **pr-evidence** — inject inline evidence block into PR bodies
- **semantic-commit** — draft Conventional Commits messages tuned to the scope set
- **frontend-design** — aesthetic + convention guide for the host app chrome
- **canvas-sync** — keep DesignCanvas coherent across canonical/mirror/host wiring
- **grill-me** — code review critique skill

<details>
<summary>中文</summary>

## 技能系统

仓库配备了两层技能：

### 产品技能（`skills/`）

在用户设计产物时加载到智能体会话中。这些可组合的操作手册教智能体如何构建、调整和导出设计。包括：前端设计、交互式原型、设计系统、动画视频、独立 HTML 导出、Canva 集成等技能。

### 开发时技能（`.claude/skills/`）

由处理仓库本身的贡献者使用。这些技能自动化完整的贡献工作流程：

- **ship-task** — 理解 → 实现 → 验证 → 语义化提交 → 带证据的 PR
- **cuj-guardian** — 质量门禁，运行和分类关键用户旅程套件
- **verify-with-playwright** — 驱动真实浏览器，捕获截图/视频作为证据
- **pr-evidence** — 将内联证据块注入 PR 正文
- **semantic-commit** — 起草符合作用域集的 Conventional Commits 消息
- **frontend-design** — 主机应用界面的美学和约定指南
- **canvas-sync** — 保持 DesignCanvas 在规范/镜像/主机布线中的一致性
- **grill-me** — 代码审查技能

</details>

---

## Project Status

AI Atelier is in **early alpha** (v0.1.x). The core editing and agent-integration loops work, but expect rough edges and missing features. See the [roadmap discussions](https://github.com/aiatelie/ai-atelie/discussions) for what's coming next.

**Current focus areas:**

- **Design Intelligence phases 2–5** — authoring, library, export, marketplace
- **Editor UX** — zoom, search, keyboard shortcuts, direct manipulation, compare mode
- **Adapter health** — better error messages, model settings UI, batched questions
- **Infrastructure** — CLI, background verifier, persistent agent, Docker deployment
- **Discoverability** — prompt library, design system extractor, MCP expose

<details>
<summary>中文</summary>

## 项目状态

AI Atelier 处于**早期测试阶段**（v0.1.x）。核心编辑和智能体集成循环已可用，但可能存在粗糙的边缘和缺失的功能。参见[路线图讨论](https://github.com/aiatelie/ai-atelie/discussions)了解即将推出的内容。

**当前重点领域：**

- **Design Intelligence 第 2-5 阶段** — 创作、库、导出、市场
- **编辑器体验** — 缩放、搜索、键盘快捷方式、直接操作、对比模式
- **适配器健康** — 更好的错误消息、模型设置 UI、批量提问
- **基础设施** — CLI、后台验证器、持久化智能体、Docker 部署
- **可发现性** — 提示库、设计系统提取器、MCP 暴露

</details>

---

## Runtime AI (`window.ai.complete`)

Generated artifacts (HTML files in the sandboxed preview iframe) can make one-shot AI calls at runtime — no API key in the artifact, no SDK to import, provider-neutral:

```js
const reply = await window.ai.complete("grade this answer: ...");
// or:  await window.ai.complete({ messages: [{ role: "user", content: "..." }] })
```

**How it works:**

1. A bridge script is auto-injected into every HTML response from `/p/:id/*`
2. Defines `window.ai.complete` on the artifact side
3. The artifact `postMessage`s to the parent frame
4. The host forwards to `POST /api/artifacts/complete`
5. The API calls the appropriate agent adapter's `complete()` method

Use it for: trivia graders, AI-powered tutors, "rewrite this" buttons, in-artifact chatbots — anything that needs an LLM at runtime, not just at generation time.

<details>
<summary>中文</summary>

## 运行时 AI（`window.ai.complete`）

生成的产物（沙盒预览 iframe 中的 HTML 文件）可以在运行时进行单次 AI 调用——产物中无需 API 密钥，无需导入 SDK，提供商无关：

```js
const reply = await window.ai.complete("给这个答案打分：...");
// 或：await window.ai.complete({ messages: [{ role: "user", content: "..." }] })
```

**工作原理：**

1. 桥接脚本自动注入到来自 `/p/:id/*` 的每个 HTML 响应中
2. 在产物端定义 `window.ai.complete`
3. 产物通过 `postMessage` 发送到父框架
4. 主机转发到 `POST /api/artifacts/complete`
5. API 调用适当的智能体适配器的 `complete()` 方法

用于：问答评分器、AI 驱动的辅导工具、"重写此内容"按钮、产物内聊天机器人——任何在运行时（而非生成时）需要 LLM 的场景。

</details>

---

## Community

- **[Discord](https://discord.gg/aiatelie)** — chat with the maintainer and other users
- **[GitHub Discussions](https://github.com/aiatelie/ai-atelie/discussions)** — feature requests, Q&A, show & tell
- **[X / Twitter](https://x.com/aiatelie)** — announcements and updates

<details>
<summary>中文</summary>

## 社区

- **[Discord](https://discord.gg/aiatelie)** — 与维护者和其他用户交流
- **[GitHub Discussions](https://github.com/aiatelie/ai-atelie/discussions)** — 功能请求、问答、作品展示
- **[X / Twitter](https://x.com/aiatelie)** — 公告和更新

</details>

---

## Contributing

We welcome contributions from humans **and** from agent CLIs. The repo includes dev-time skills to guide agent contributors through the full workflow:

1. **ship-task** — the full contributor loop orchestrator
2. **verify-with-playwright** — per-task browser verification with evidence capture
3. **semantic-commit** — Conventional Commits drafting
4. **pr-evidence** — inline evidence block injection
5. **cuj-guardian** — journey suite quality gate

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete guide — including agent setup, the ship-task workflow, and the quality gate requirements.

<details>
<summary>中文</summary>

## 贡献

我们欢迎人类**和**智能体 CLI 的贡献。仓库包含开发时技能，可指导智能体贡献者完成完整的工作流程：

1. **ship-task** — 完整的贡献循环编排器
2. **verify-with-playwright** — 逐任务浏览器验证和证据捕获
3. **semantic-commit** — Conventional Commits 起草
4. **pr-evidence** — 内联证据块注入
5. **cuj-guardian** — 旅程套件质量门禁

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 获取完整指南——包括智能体设置、ship-task 工作流程和质量门禁要求。

</details>

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built with care by <a href="https://github.com/whatiskadudoing">@whatiskadudoing</a> and contributors.</sub>
</p>

<details>
<summary>中文</summary>

<p align="center">
  <sub>由 <a href="https://github.com/whatiskadudoing">@whatiskadudoing</a> 和贡献者精心构建。</sub>
</p>

</details>
