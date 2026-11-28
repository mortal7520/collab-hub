# CollabHub v3.0 — Launch Kit & Star-Growth Playbook

High-signal, honest, developer-first launch drafts written directly for technical audiences, paired with directory submission checklists. Every claim below maps 1:1 to verified `v3.0.0` features (zero npm runtime deps, 53 MCP tools across 3 profiles, Streamable HTTP `/mcp`, 14 market clients, Sticky IDE/Desktop/Terminal resident plugins, metadata-only live usage, and model-strength smart routing).

---

## 1. GitHub Repository & Release Positioning

- **Tagline / Description**:
  > `One Always-On Brain for Every AI Coding Agent — Live cross-agent usage HUD, capability-aware smart router, 14-client zero-secret MCP Hub, git worktree merge queue, 53 MCP tools (core/cockpit/full) & sticky native plugins inside VS Code/Cursor/Windsurf/Antigravity/Claude/Codex.`
- **Topics**:
  `mcp`, `mcp-server`, `mcp-apps`, `multi-agent`, `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `antigravity`, `git-worktree`, `terminal-ui`, `ai-agents`, `local-first`, `nodejs`
- **Social Preview Image**: Export `docs/assets/social-preview.svg` (1280×640 PNG) into GitHub Repository Settings → Social Preview.

---

## 2. Show HN (Hacker News)

**Title**:
`Show HN: CollabHub v3.0 – Zero-dep Mission Control, live usage HUD, and sticky native plugins across 14 AI coding agents`

**Body**:
> Hey HN — I run Claude Code, Codex, Cursor, and local Ollama models side by side across repositories, and hit two daily frustrations:
>
> 1. **Fragmented usage & blind routing**: Each client hides its own token spend, and simple tasks still burn flagship tokens while complex audits or copy get sent to weaker/cheaper endpoints.
> 2. **Dashboards nobody keeps open**: Web UIs get buried behind browser tabs unless telemetry actually lives *inside* your IDE, desktop app, or terminal prompt.
>
> So I built **CollabHub** (`https://github.com/mortal7520/collab-hub`), a local-first, MIT-licensed orchestrator written in plain Node.js (>=22.13, built-in `node:sqlite`, **0 runtime npm dependencies**):
>
> - **Sticky Native Host Presence**: A tiny zero-dep VS Code/Fork extension (`extensions/collab-hub-vscode/`) puts a live StatusBar counter + sticky Sidebar Webview directly inside **VS Code, Cursor, Windsurf, Antigravity IDE, and Kiro** (`npx collab-hub install-plugins --confirm`). On Desktop, a **SEP-1865 MCP App** (`ui://collab-hub/cockpit.html`) sticks its live usage header inside Antigravity / Claude Desktop / Codex Desktop. In the terminal, a `<30ms` SQLite-only `statusLine` + `tmux`/Zsh/PowerShell hooks + 24-bit TUI stay visible on every command.
> - **Metadata-Only Cross-Agent Live Usage**: Counts live stdio + Streamable HTTP `/mcp` traffic across 14 clients plus bounded token-counter scans of recent local sessions (never extracts prompts, code, or secrets).
> - **Capability & Model-Strength Smart Router**: Scores 10 task categories (`security_audit`, `coding`, `architecture`, `copywriting`, `linux_ops`, `fast_cheap`, etc.) across `balanced | quality | cost | speed` strategies with explainable `routing_reasons[]`.
> - **Engineering Safety Guardrails**: Zero-secret MCP Hub & Skills/Rules sync (`.bak` backups + UTF-16/inline secret scanner), speculative `git merge-tree` conflict detection across worktrees, and SSRF-guarded HMAC-SHA256 webhooks (Slack/Discord/Feishu/DingTalk/Telegram).
> - **53 MCP Tools without Context Bloat**: Choose `--profile core` (13 tools), `--profile cockpit` (23), or `--profile full` (53), over stdio or Streamable HTTP `/mcp`.
>
> Live interactive browser preview (zero install): `https://mortal7520.github.io/collab-hub/`  
> Local quickstart: `npx collab-hub setup --confirm && npx collab-hub cockpit --dock`
>
> Would love feedback on client config edge cases (especially OpenCode / Zed / Roo Code) and your multi-agent routing heuristics!

---

## 3. Reddit (`r/ClaudeAI`, `r/mcp`, `r/LocalLLaMA`)

### `r/ClaudeAI` / `r/mcp`
**Title**: `I built a 0-dependency, always-on multi-agent cockpit + live usage HUD that runs natively inside Claude Desktop/Code, Cursor, Windsurf, Codex & VS Code`
- Lead with **Cockpit + StatusLine + Sticky IDE Sidebar** screenshots (`docs/assets/cockpit-v3-showcase.svg`, `docs/assets/tui-v2-showcase.svg`).
- Emphasize `--profile core` (13 tools) vs `cockpit` (23) so Claude Code/Desktop users don't bloat their context window.
- Link to live GitHub Pages demo (`https://mortal7520.github.io/collab-hub/`).

### `r/LocalLLaMA`
**Title**: `Route trivial coding/log tasks to local Ollama ($0) and security audits/architecture to flagship models automatically — 0 npm deps, local SQLite`
- Highlight `collab-hub discover` (auto-detects Ollama/LM Studio/vLLM on `127.0.0.1` without storing secrets) + `collab-hub plan --strategy cost`.

---

## 4. X / Twitter Thread (5 Posts)

1. **Hook**: Running Claude Code + Codex + Cursor + Ollama side by side usually means 4 scattered configs, no unified token meter, and web dashboards you forget to open. Meet **CollabHub v3.0** — local-first, 0 npm deps, MIT. 🧵👇 (Attach `docs/assets/social-preview.svg`)
2. **Always-On Inside Every Agent**: One `npx collab-hub install-plugins --confirm` drops a sticky live StatusBar + Sidebar directly inside VS Code, Cursor, Windsurf, Antigravity & Kiro — plus SEP-1865 MCP App in Claude/Codex Desktop and `<30ms` terminal `statusLine` + 24-bit TUI. (Attach `docs/assets/cockpit-v3-showcase.svg`)
3. **Real-Time Usage (No Prompt Leaks)**: Watch live `tok/min`, today's tokens, API-equivalent cost (`$0` for Ollama), and MCP calls across 14 clients in one sticky bar — strictly metadata-only.
4. **Smart Model-Strength Routing**: Why send a quick lint summary to Opus or a security audit to a small fast model? CollabHub's deterministic router picks the right model per task (`balanced | quality | cost | speed`) with transparent reasons.
5. **Try Without Installing**: Interactive GitHub Pages demo (`https://mortal7520.github.io/collab-hub/`) or 1-command onboarding (`npx collab-hub setup --confirm`). Star if useful ⭐ `https://github.com/mortal7520/collab-hub`

---

## 5. 中文技术社区首发（V2EX / 掘金 / 少数派 / 微信公众号）

**标题建议**：
`开源了一个零依赖的多 Agent“全端常驻”驾驶舱：14 款客户端实时用量监控 + 模型强弱智能派单 + 嵌进 IDE/桌面的原生插件`

**核心结构**：
1. **痛点共鸣**：同时开 Claude Code、Codex、Cursor、Windsurf、Antigravity、Ollama 写代码，最缺的不是又一个网页，而是一个**直接常驻在 IDE 侧边栏/底栏、Desktop 驾驶舱、终端提示行里、随滚动始终可见**的实时用量与防冲突编排大脑。
2. **4 个硬核亮点（配 `cockpit-v3-showcase.svg` 与 `tui-v2-showcase.svg`）**：
   - **真·宿主原生常驻**：一套零依赖 VS Code 家族扩展覆盖 VS Code / Cursor / Windsurf / Antigravity / Kiro；桌面端 SEP-1865 驾驶舱顶部吸顶随滚；终端提供 `<30ms` Claude Code `statusLine` + tmux/Zsh/PowerShell + 24-bit TUI；桌面端还支持 `collab-hub cockpit --dock` 独立悬浮小窗。
   - **跨 Agent 实时用量（只读元数据，绝不碰提示词）**：统一统计所有 stdio 与 Streamable HTTP `/mcp` 接入客户端，汇总今日 Tokens、燃烧速率与估算费用。
   - **按模型能力与强项派单**：借鉴 RouteLLM / LiteLLM 思路，自动把安全审计交给 Codex、双语文案/长上下文交给 AGY/Claude、Linux/Docker 交给 WSL DSH、低复杂度快速总结在省钱策略下交给免费本地 Ollama。
   - **安全与工程闭环**：14 款客户端 MCP 零密钥检测与 `.bak` 同步、Skills/Rules 跨端同步、`git merge-tree` 投机式合并队列、协作室文件租约与飞书/钉钉/Slack Webhook。
3. **在线零安装体验**：GitHub Pages 交互式演示 `https://mortal7520.github.io/collab-hub/`，本地一条命令 `npx collab-hub setup --confirm` 上手，欢迎试用与 Star！

---

## 6. MCP Directory & Ecosystem Submission Checklist

- [ ] **GitHub Repo Settings**: Upload `docs/assets/social-preview.svg` PNG export as Social Preview image; verify About description, website URL (`https://mortal7520.github.io/collab-hub/`), Topics, and Discussions enabled.
- [ ] **Official MCP Registry**: Publish `server.json` (`io.github.mortal7520/collab-hub` v3.0.0) via `mcp-publisher`.
- [ ] **Smithery**: Submit repo with `smithery.yaml` (`core | cockpit | full` profile selector).
- [ ] **PulseMCP / Glama / mcp.so / awesome-mcp-servers**: Submit PR / listing pointing to `https://github.com/mortal7520/collab-hub` and `server.json`.
- [ ] **npm Publish (`collab-hub@3.0.0`)**: Run `npm publish --dry-run` first to confirm clean tarball (`bin/`, `extensions/`, `public/`, `src/`, `server.json`, `README*.md`, `LICENSE`), then publish when ready for global `npx collab-hub`.
