<div align="center">

# ⚡ CollabHub v3.0

**一套本地优先、全端常驻的多 Agent 统一大脑 —— 跨 Agent 实时用量监控、模型能力智能路由、14 款主流客户端 MCP 中枢、以及真正嵌进各大 Agent 内部的原生常驻插件。**

[![CI Matrix (Ubuntu + Windows · Node 22/24)](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml)
[![Interactive Live Demo](https://img.shields.io/badge/在线互动演示-GitHub_Pages-6366f1?style=flat&logo=githubpages)](https://mortal7520.github.io/collab-hub/)
[![Cockpit Preview](https://img.shields.io/badge/Cockpit_演示-SEP--1865_MCP_App-38bdf8?style=flat)](https://mortal7520.github.io/collab-hub/cockpit.html)
[![Zero Dependencies](https://img.shields.io/badge/npm_运行时依赖-0-34d399?style=flat)](./package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-34d399?style=flat&logo=nodedotjs)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat)](./LICENSE)

[**English**](./README.md) · 简体中文 · [**在线打开交互式 Workbench →**](https://mortal7520.github.io/collab-hub/) · [**直接体验 6 标签 Cockpit →**](https://mortal7520.github.io/collab-hub/cockpit.html)

<br/>

<img src="./docs/assets/social-preview.svg" alt="CollabHub v3.0 架构与旗舰功能总览" width="100%" />

</div>

---

## 为什么做 CollabHub v3.0？

当你同时使用 **Claude Code**、**Codex**、**Antigravity**、**Cursor**、**Windsurf**、**Cline**、**Ollama** 协作开发时，最痛的往往是这四件事：

1. **看不到真实消耗与实时速率**：各客户端各自为战，今日烧了多少 Tokens、当前速率 (`tok/min`)、哪个客户端最活跃全是一笔糊涂账。
2. **控制面板如果不“常驻在工作流里”，做了等于白做**：关掉网页就忘了看；真正好用的界面应该像原生插件一样，**直接嵌进你的 IDE 侧边栏与底部状态栏、Desktop 边栏与终端提示行里，跟着滚动始终可见**。
3. **配置重复与上下文灾难**：14 款工具各自维护一套 `mcpServers` JSON/TOML、技能目录和项目规则，一不小心还会泄露明文密钥；多 Agent 并发改同一份代码更是直接冲突。
4. **“用谁干什么”全靠拍脑袋**：长篇双语文档、架构设计、安全审计、Docker Linux 排障、还是本地免费小模型快速格式化——应该根据各个 Agent 和底层模型的强项自动匹配。

**CollabHub v3.0 用纯原生 Node.js (>=22.13，`0` npm 运行时依赖) 一次性解决：**

---

## 60 秒极速上手

仅需 **Node.js >= 22.13.0**（使用内置 `node:sqlite`，无任何第三方运行时依赖）：

```bash
# 推荐全局安装（确保开机自启与 IDE 扩展写入持久路径，避免 npx 临时缓存失效）
npm install -g collab-hub
# 或直接克隆源码运行：git clone https://github.com/mortal7520/collab-hub.git && cd collab-hub

# 1. 自动扫描本机 14 款主流 AI 客户端 + 写入零密钥 MCP 配置 + 安装 Claude Code 状态栏 (.bak 自动备份)
collab-hub setup --profile cockpit --confirm

# 2. 一键把零依赖“原生常驻扩展”安装进 VS Code / Cursor / Windsurf / Antigravity IDE / Kiro
collab-hub install-plugins --confirm

# 3. 自动拉起后台常驻守护进程，并弹出无边框悬浮 Cockpit 小窗
collab-hub cockpit --dock
```

更多常驻与命令行玩法：

```bash
# 零配置体验 24-bit 真彩动画终端驾驶舱（新机器可直接使用 --demo）
npx -y collab-hub tui --demo

# 配置跨平台免管理员开机自启（macOS LaunchAgent / Linux systemd --user / Windows Task Scheduler）
collab-hub autostart install --confirm

# Docker 一键部署（端口 5290 同时提供 Web 工作台与 Streamable HTTP /mcp）
docker build -t collab-hub . && docker run --rm -p 5290:5290 -v collabhub-data:/data collab-hub
```

---

## 一、真正嵌进各大 Agent 内部的“常驻可见 UI”

<img src="./docs/assets/cockpit-v3-showcase.svg" alt="CollabHub v3.0 原生 IDE 侧边栏 + SEP-1865 Cockpit + 智能路由" width="100%" />

| 常驻与贴边交互形态 | 覆盖宿主 | 嵌进聊天框旁 / 对话内能力 |
| :--- | :--- | :--- |
| **对话内嵌 HUD 条与一键贴入 Pill** (`ui://collab-hub/chat-strip.html`, `cockpit.html`) | **Antigravity（对话内/`aux_pane`/`global`）、Claude Desktop、Codex Desktop、VS Code Chat** | 调用 `collab_plan` / `collab_usage` 直接在对话消息内展示紧凑用量与推荐理由卡片，支持 **`ui/update-model-context`** 一键把当前状态作为上下文 Pill 贴进输入框，或一键展开侧栏指挥舱。 |
| **Web AI 聊天框旁 Shadow DOM 伴侣扩展** (`extensions/collab-hub-browser/`) | **claude.ai、chatgpt.com、gemini.google.com、muse.ai、DeepSeek、Grok、Perplexity** | 零依赖 Chrome/Edge MV3 扩展，用 **Shadow DOM** 把实时用量胶囊悬浮停靠在聊天框右下角，支持读取草稿智能路由（`"Route Draft"`）和一键插入上下文，绝不读取网页 Cookie。 |
| **通用 IDE 原生扩展** (`extensions/collab-hub-vscode/`) | **VS Code、Cursor、Windsurf、Antigravity IDE、Kiro** | 底部 StatusBar + 侧边栏/底栏（可拖入右侧 Auxiliary Bar 贴着 Chat 常驻）+ **`@collabhub`** 原生对话参与者（`/route`, `/usage`, `/roster`）+ **`Ctrl+Alt+C` 贴 Chat 分屏**与一键复制上下文。 |
| **终端侧边分屏 HUD 与 TUI** (`extensions/terminal-hud/`) | **Claude Code CLI (`statusLine`)、Codex CLI、Gemini CLI、OpenCode、tmux、Zsh、PowerShell、WSL** | `<30ms` SQLite `statusLine`、`tmux` 36 列/Windows Terminal 聊天框右侧实时分屏（`collab-hub cockpit --split`）及 24-bit 终端驾驶舱。 |
| **桌面置顶悬浮 Dock & PWA** (`?mode=dock`, `manifest.webmanifest`) | **macOS / Windows / Linux 桌面** | `collab-hub cockpit --dock --pin` 弹出 440px 置顶悬浮窗紧贴 Claude/Codex Desktop 窗口旁；支持桌面 PWA 固定。 |
| **全功能 Web Workbench** (`http://127.0.0.1:5290`) | **任意浏览器（及 GitHub Pages 静态演示）** | 全 9 大视图顶部常驻 Live Usage & Fleet 吸顶栏、明暗 Obsidian/Alabaster 双主题、中英文切换、`Ctrl+K` 命令面板。 |

<img src="./docs/assets/tui-v2-showcase.svg" alt="CollabHub v3.0 24-bit 终端驾驶舱与 StatusLine HUD" width="100%" />

---

## 二、全面支持市面上 14 款主流客户端 + 本地开源模型

CollabHub 原生兼容每家不同的配置结构（`mcpServers` TOML/JSON、`servers`、`mcp`、`context_servers`），提供发现、零密钥检测、统一导入与 `.bak` 安全同步：

`Antigravity` · `Claude Code` · `Claude Desktop` · `Codex` · `Cursor` · `Windsurf` · `VS Code Copilot` · `Gemini CLI` · `Cline` · `Roo Code` · `OpenCode` · `Zed` · `Continue` · `Kiro`

同时支持自动探测本机 **Ollama**、**LM Studio**、**vLLM**、**Aider**、**Qwen CLI** 以及环境变量就绪的 **OpenAI / DeepSeek / OpenRouter / SiliconFlow**（仅检查布尔存在性，**绝不读取或打印任何密钥值**）。

---

## 三、跨 Agent 实时用量统计 + 模型能力强度智能路由

### 1. 跨 Agent 实时用量与成本引擎（严格只读元数据）
- **实时接入即统计**：所有通过 stdio 或 Streamable HTTP `/mcp` 接入的客户端（Cursor、Claude Code、Codex、Antigravity、Windsurf、Cline、Kiro 等）在握手与每次调用时自动落入 `client_usage_telemetry`。
- **本地会话数值汇总**：只读解析近期本地日志中的 Token 计数、模型名与时间戳（15 秒缓存、有界读取 `<40ms`），计算今日/7 日总 Tokens、当前速率 (`tok/min`)、24 小时柱状热力以及 API 等价估算费用（Ollama 本地模型计为 `$0`）。**绝对不采集、不存储任何用户提示词或源码正文** (`privacy_note: "metadata_only_no_prompts"`)。

### 2. 模型能力画像与任务智能派单 (`src/router.mjs`)
借鉴开源路由器 [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM)（复杂度分层）与 [`BerriAI/litellm`](https://github.com/BerriAI/litellm) Router（状态/延迟/成本/冷却感知）思路，内置 10 类任务维度（`coding`, `security_audit`, `architecture`, `frontend_ui`, `copywriting`, `long_context`, `linux_ops`, `debugging`, `research`, `fast_cheap`）与 4 种路由策略（`balanced | quality | cost | speed`），并输出透明的决策理由 `routing_reasons[]`：

```bash
# 安全审计 / 底层攻防 -> 优先匹配 Codex (gpt-5-codex)
collab-hub plan --prompt "审计 SSRF 与 Webhook HMAC 签名边界" --strategy quality

# 双语旗舰文案 / 长上下文整理 -> 优先匹配 Antigravity / Claude，避开低配中继
collab-hub plan --prompt "撰写双语 README 与产品首发推广文案"

# Linux Docker / WSL 排障 -> 优先匹配 WSL DSH
collab-hub plan --prompt "Fix Docker Linux bash CI failure"

# 简单快速任务 + 成本优先 -> 自动路由给本机免费 Ollama 模型 ($0)
collab-hub plan --prompt "quick format log summary" --strategy cost
```

---

## 四、53 个 MCP 工具 · 3 档按需 Profile · Streamable HTTP `/mcp`

不再一次性向大模型塞入几十个工具浪费上下文：

| Profile 档位 | 工具数 | 适用场景 |
| :--- | :---: | :--- |
| `--profile core` | **13** | 极致省上下文：Cockpit、Roster、智能路由 Plan、派单/轮询/取消、Shared Room 租约、Handoff 交接包、Worktree 创建/验证/合并、实时用量 |
| `--profile cockpit` | **23** | **推荐默认档**：包含 `core` + 共识投票、产物库、预算护栏、安全触发器、Webhook 通知、MCP Hub/Meta-MCP 发现、Skills 同步、合并队列与自检自愈 |
| `--profile full` | **53** | 完整工程编排：全部工具 + FTS5 记忆、`ast-grep`/`repomix`/`markitdown`/`beads`/`cass` 工具箱、多阶段 DAG 流水线与动态 Agent 注册中心 |

支持标准 **stdio** 与 **Streamable HTTP**（`http://127.0.0.1:5290/mcp?profile=cockpit`，带回环 `Host` / `Origin` 防重绑定保护与 `Mcp-Session-Id` 会话管理）。

---

## 五、环境变量与开源借鉴清单

| 环境变量 | 默认值 | 用途 |
| :--- | :--- | :--- |
| `COLLAB_HUB_HOME` | `~/.collab-hub` | 运行时数据目录（SQLite、共享室、热备份、日志、`integrations.json`） |
| `COLLAB_HUB_WORKSPACE` | 当前目录 / `~/workspace` | 工作区根目录（用于发现 Git 仓库、创建 Worktree 与规则同步） |
| `COLLAB_HUB_PORT` | `5290` | 仅限 `127.0.0.1` 的控制台、SSE 与 `/mcp` 监听端口 |
| `COLLAB_HUB_MCP_PROFILE` | `full`（向导默认写 `cockpit`） | MCP 工具暴露档位（`core` \| `cockpit` \| `full`） |
| `AGENT_MAIL_URL` | `http://127.0.0.1:5291` | 可选配套的 MCP Agent Mail 服务端地址 |

> 完整开源项目借鉴与版本/许可证溯源：[`docs/UPSTREAM-REUSE.md`](./docs/UPSTREAM-REUSE.md)  
> 多平台推广文案与目录提交清单：[`docs/LAUNCH-KIT.md`](./docs/LAUNCH-KIT.md)

---

## 开源许可证

[MIT](./LICENSE)
