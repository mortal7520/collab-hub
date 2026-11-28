<div align="center">

# ⚡ CollabHub v3.0

**One Always-On Brain for Every AI Coding Agent — Live Usage HUD, Smart Model Routing, 14-Client MCP Hub & Sticky Native IDE/Desktop/CLI Plugins.**

[![CI Matrix (Ubuntu + Windows · Node 22/24)](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml)
[![Interactive Live Demo](https://img.shields.io/badge/Live_Demo-GitHub_Pages-6366f1?style=flat&logo=githubpages)](https://mortal7520.github.io/collab-hub/)
[![Cockpit Preview](https://img.shields.io/badge/Cockpit_Demo-SEP--1865_MCP_App-38bdf8?style=flat)](https://mortal7520.github.io/collab-hub/cockpit.html)
[![Zero Dependencies](https://img.shields.io/badge/npm_runtime_deps-0-34d399?style=flat)](./package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-34d399?style=flat&logo=nodedotjs)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat)](./LICENSE)

[English](./README.md) · [**简体中文**](./README.zh-CN.md) · [**Live Interactive Demo →**](https://mortal7520.github.io/collab-hub/) · [**Standalone Cockpit Demo →**](https://mortal7520.github.io/collab-hub/cockpit.html)

<br/>

<img src="./docs/assets/social-preview.svg" alt="CollabHub v3.0 — One Always-On Brain for Every AI Coding Agent" width="100%" />

</div>

---

## Why CollabHub?

If you code with **Claude Code**, **Codex**, **Antigravity**, **Cursor**, **Windsurf**, **Cline**, or **Ollama** every day, you probably hit the same four walls:

1. **You can't see what you're spending across tools in real time** — tokens, burn rate (`tok/min`), and active MCP calls are fragmented across apps.
2. **Orchestration tools disappear the moment you close a browser tab** — instead of staying *inside* your IDE sidebar, Desktop chat pane, StatusBar, and terminal prompt.
3. **Every client repeats the same mistakes** — duplicated `mcpServers` JSON/TOML configs with accidental plaintext API keys, drifting `SKILL.md` / `AGENTS.md` / `CLAUDE.md` rules, and parallel agents stomping on the same files.
4. **Weak models get flagship tasks (and vice versa)** — nothing checks whether a task needs Codex/Claude/Gemini-Pro vs a fast free local Ollama model.

**CollabHub v3.0 fixes all four in one local-first, zero-npm-dependency SQLite hub:**

- **Always-On Resident UI Inside Every Major Agent** — sticky StatusBar + Sidebar Webview extension inside **VS Code / Cursor / Windsurf / Antigravity IDE / Kiro**, sticky SEP-1865 MCP App (`position: sticky`) inside **Antigravity (`aux_pane` + `global`) / Claude Desktop / Codex Desktop**, plus sub-30ms **Claude Code `statusLine`**, **tmux**, **Zsh/PowerShell** HUD hooks, **24-bit TUI**, and an installable floating **Dock Window** (`collab-hub cockpit --dock`).
- **Real-Time Cross-Agent Usage & Cost Ledger (Metadata-Only)** — tracks every stdio and Streamable HTTP `/mcp` client in real time plus read-only token/cost counters from local CLI sessions. **Zero prompts, code, or secrets are ever extracted or stored.**
- **Model-Strength Smart Task Router** — bilingual (EN + 中文) classifier across 10 task categories (`coding`, `security_audit`, `architecture`, `frontend_ui`, `copywriting`, `long_context`, `linux_ops`, `debugging`, `research`, `fast_cheap`) and 4 strategies (`balanced`, `quality`, `cost`, `speed`) with transparent `routing_reasons[]`.
- **53 MCP Tools (`core` 13 / `cockpit` 23 / `full` 53) + Streamable HTTP `/mcp`** — plug in without blowing your LLM context window.

---

## 60-Second Quickstart

Requires **Node.js >= 22.13.0** (uses built-in `node:sqlite` — **zero** runtime `npm` dependencies).

```bash
# Install globally (stable persistent paths for autostart & IDE extensions)
npm install -g collab-hub
# Or run from a local clone before npm publish: git clone https://github.com/mortal7520/collab-hub.git && cd collab-hub

# 1. Detect all 14 local AI clients & configure zero-secret MCP + Claude Code StatusLine (.bak backup first)
collab-hub setup --profile cockpit --confirm

# 2. Install the Sticky Always-On Native Extension into VS Code / Cursor / Windsurf / Antigravity / Kiro
collab-hub install-plugins --confirm

# 3. Auto-start the local hub & pop out the Always-On Resident Floating Cockpit
collab-hub cockpit --dock
```

Or preview instantly with zero global setup via TUI demo / Docker / autostart:

```bash
# 24-bit TrueColor interactive terminal cockpit (`--demo` works on any fresh machine)
npx -y collab-hub tui --demo

# Enable zero-admin OS autostart (macOS LaunchAgent / Linux systemd --user / Windows Task Scheduler)
collab-hub autostart install --confirm

# Run via Docker (Streamable HTTP /mcp + Web Workbench on port 5290)
docker build -t collab-hub . && docker run --rm -p 5290:5290 -v collabhub-data:/data collab-hub
```

---

## 1. Always-On Resident UI Inside Every Agent

<img src="./docs/assets/cockpit-v3-showcase.svg" alt="CollabHub v3.0 Native IDE Sidebar, SEP-1865 Cockpit & Smart Router" width="100%" />

| Surface | Host Agents Supported | Always-On & Chat-Adjacent Behavior |
| :--- | :--- | :--- |
| **In-Chat MCP App Strip & Pill** (`ui://collab-hub/chat-strip.html`, `cockpit.html`) | **Antigravity (`inline` / `aux_pane` / `global`), Claude Desktop, Codex Desktop, VS Code Chat** | `collab_plan` & `collab_usage` render an interactive inline strip inside chat with 1-click **`ui/update-model-context`** (`Attach to Chat` pill) and sticky side-pane toggle. |
| **Web AI Browser Companion** (`extensions/collab-hub-browser/`) | **claude.ai, chatgpt.com, gemini.google.com, muse.ai, DeepSeek, Grok, Perplexity** | Zero-dep Chrome/Edge MV3 **Shadow DOM** pill anchored beside the chat box: live usage, `"Route Draft"`, and `"Insert Context into Chat"` (zero cookies touched). |
| **Native IDE Extension** (`extensions/collab-hub-vscode/`) | **VS Code, Cursor, Windsurf, Antigravity IDE, Kiro** | Pinned StatusBar + Activity Bar & Panel views (`retainContextWhenHidden`) + **`@collabhub`** Chat Participant (`/route`, `/usage`, `/roster`) + `Pin Beside Chat` (`Ctrl+Alt+C`) & `Copy Ctx`. |
| **Terminal Native HUD & Split** (`extensions/terminal-hud/`) | **Claude Code CLI (`statusLine`), Codex CLI, Gemini CLI, OpenCode, tmux, Zsh, PowerShell, WSL** | `<30ms` SQLite `statusLine`, 36-col tmux/Windows Terminal side split (`collab-hub cockpit --split`), and 24-bit TUI (`collab-hub tui`). |
| **Pinned Floating Dock & PWA** (`?mode=dock`, `manifest.webmanifest`) | **macOS, Windows, Linux Desktops** | Frameless always-on-top compact dock (`collab-hub cockpit --dock --pin`) sitting cleanly beside Claude/Codex Desktop + installable PWA. |
| **Web Workbench** (`http://127.0.0.1:5290`) | **Any Browser (+ GitHub Pages Demo)** | Sticky Live Usage Dock Bar across all 9 views, Light/Dark themes, EN/中文 toggle, `Ctrl+K` Command Palette. |

<img src="./docs/assets/tui-v2-showcase.svg" alt="CollabHub v3.0 24-bit Command TUI & Live Terminal StatusLine HUD" width="100%" />

---

## 2. Supported Market Clients & Ecosystem (14 Clients)

CollabHub detects, imports, probes, and safely syncs configurations (with automatic `.bak` backups and inline-secret blocking) across **14 mainstream AI clients**, handling their exact JSON/TOML schemas (`mcpServers`, `mcp_servers`, `servers`, `mcp`, `context_servers`):

`Antigravity` · `Claude Code` · `Claude Desktop` · `Codex` · `Cursor` · `Windsurf` · `VS Code Copilot` · `Gemini CLI` · `Cline` · `Roo Code` · `OpenCode` · `Zed` · `Continue` · `Kiro`

Plus auto-discovery for **Ollama**, **LM Studio**, **vLLM**, **Aider**, **Qwen CLI**, and environment-ready **OpenAI / DeepSeek / OpenRouter / SiliconFlow** gateways — **never reading or echoing raw API keys**.

---

## 3. Real-Time Cross-Agent Usage & Smart Capability Router

### Live Cross-Agent Usage (`collab_usage` / `GET /api/usage/live` / `collab-hub usage`)
- **Every MCP Call Counted**: Both stdio and Streamable HTTP `/mcp` automatically record `client_id`, `transport`, `profile`, call count, errors, and last tool in `client_usage_telemetry`.
- **Metadata-Only Local Session Aggregation**: Bounded, cached scans compute today/7-day tokens, `tok/min` burn rate, 24h hourly throughput sparklines, and API-equivalent USD cost estimates (`$0` for Ollama/local models) with a hard privacy guarantee (`privacy_note: "metadata_only_no_prompts"`).

### Capability & Model-Strength Smart Router (`collab_plan` / `POST /api/route/recommend` / `collab-hub plan`)
Inspired by [`lm-sys/RouteLLM`](https://github.com/lm-sys/RouteLLM) (complexity stratification) and [`BerriAI/litellm`](https://github.com/BerriAI/litellm) Router (cooldown/latency/cost awareness), CollabHub scores every online agent on 10 bilingual task categories (`coding`, `security_audit`, `architecture`, `frontend_ui`, `copywriting`, `long_context`, `linux_ops`, `debugging`, `research`, `fast_cheap`) and returns transparent `routing_reasons[]`:

```bash
$ collab-hub plan --prompt "Security audit of SSRF and HMAC webhook boundaries" --strategy quality
# -> Illustrative summary from JSON output: Codex (gpt-5-codex, flagship) · security_audit=96/100 · flagship_boost_for_high_complexity(+8)

$ collab-hub plan --prompt "Quick log formatting summary" --strategy cost
# -> Illustrative summary from JSON output: Ollama Qwen (local, free) · fast_cheap=99/100 · strategy=cost(free:+24)
```

---

## 4. Streamable HTTP `/mcp` & Context-Budget Profiles (53 Tools)

Don't waste 20k context tokens on tool definitions you aren't using. Pick your profile:

| Profile | Tools | Designed For |
| :--- | :---: | :--- |
| `--profile core` | **13** | Tight context budgets: Cockpit, Roster, Smart Plan, Dispatch, Poll, Cancel, Tasks, Shared Rooms, Handoff Pack, Worktrees (`create`/`verify`/`merge`), Live Usage |
| `--profile cockpit` | **23** | **Recommended default**: `core` + Consensus, Artifacts, Budgets, Triggers, Webhooks, MCP Hub, Meta-MCP Lazy Finder, Skills Sync, Merge Queue, Self-Check & Auto-Heal |
| `--profile full` | **53** | Power orchestrators: everything above + FTS5 Memory, Code Toolkit (`ast-grep`, `repomix`, `markitdown`, `beads`, `cass`), Multi-Stage DAG Workflows, Playbooks & Dynamic Agent Registry |

Connect over **stdio** (`npx collab-hub mcp --profile cockpit`) OR **Streamable HTTP** (`POST/GET/DELETE http://127.0.0.1:5290/mcp?profile=cockpit` with strict loopback `Host` & `Origin` protection).

---

## 5. Full Engineering & Safety Architecture

- **Zero-Secret All-Agent MCP Hub & Meta-MCP Lazy Router**: Blocks inline API keys (`sk-`, `ghp_`, `AIza`, UTF-16LE/BE checks) on read/write; only allows safe `${ENV_VAR}` placeholders (explicitly banning `${cmd:...}` shell injection); DNS-resolving SSRF guard blocks private/CGNAT/link-local metadata IPs.
- **Cross-Agent Skills & Rules Sync**: Syncs `SKILL.md` directories and project rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/project.mdc`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`) with Dry-Run unified diffs and `.bak` backups.
- **Worktree Isolation, Inline Diff Comments & Speculative Merge Queue**: Parallel agents work in isolated Git worktrees; pre-flight checks use side-effect-free `git merge-tree --write-tree` to detect semantic collisions before touching `main`.
- **Living Shared Rooms, Consensus, Artifact Vault & Budgets**: Path-glob leases with TTLs, per-agent `/inbox/` staging with confirmed promotion, arbitration rounds, redacted artifacts, daily token/call policies (`warn`/`downgrade`/`block`), and **SSRF-guarded HMAC-SHA256 Signed Webhooks** for Slack, Discord, Feishu, DingTalk, and Telegram.
- **Programmatic ESM SDK** (`package.json` `"exports"`):
  ```js
  import { createCollabHub, classifyTaskIntent, getLiveAgentUsage } from 'collab-hub';
  const hub = await createCollabHub({ port: 5290 });
  ```

---

## Configuration (Environment Variables)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `COLLAB_HUB_HOME` | `~/.collab-hub` | Runtime directory (`hub.db`, shared rooms, hot backups, logs, `integrations.json`) |
| `COLLAB_HUB_WORKSPACE` | Current working directory / `~/workspace` | Root workspace scanned for Git repos, worktrees & project rules |
| `COLLAB_HUB_PORT` | `5290` | Loopback dashboard, SSE & Streamable HTTP `/mcp` port (`127.0.0.1` only) |
| `COLLAB_HUB_MCP_PROFILE` | `full` (setup defaults to `cockpit`) | Default MCP tool profile (`core` \| `cockpit` \| `full`) |
| `AGENT_MAIL_URL` | `http://127.0.0.1:5291` | Optional companion MCP Agent Mail endpoint |

> Full documentation of upstream open-source inspirations & provenance: [`docs/UPSTREAM-REUSE.md`](./docs/UPSTREAM-REUSE.md).  
> Ready-to-use launch posts & directory checklist: [`docs/LAUNCH-KIT.md`](./docs/LAUNCH-KIT.md) · Machine-readable index: [`/llms.txt`](./public/llms.txt).

---

## Comparison

| Feature | Single-Client Dashboards | Cloud Router Proxies | Raw MCP Config Files | **CollabHub v3.0** |
| :--- | :---: | :---: | :---: | :---: |
| **Zero runtime npm dependencies (local-first)** | Rarely | No | N/A | **Yes (Node 22+ built-ins)** |
| **Sticky Always-On UI *inside* IDE / Desktop / CLI** | IDE-locked | Web only | No | **Yes (VS Code/Cursor/Windsurf/AGY/Kiro/Claude/Codex/TUI/Dock)** |
| **Real-time usage across 14 clients (zero prompt leak)** | 1 client | Proxy-only | No | **Yes (stdio + `/mcp` + local sessions)** |
| **Capability & model-strength task router** | No | API-only | No | **Yes (10 categories × 4 strategies + explainable reasons)** |
| **Zero-secret multi-client MCP & Skills/Rules sync** | No | No | Manual copy | **Yes (Dry-Run diff + `.bak` + secret scanner)** |
| **Speculative Git Merge Queue & Shared Rooms** | Partial | No | No | **Yes (`git merge-tree` + TTL file leases)** |

## License

[MIT](./LICENSE) — Built with zero runtime bloat for engineers orchestrating real multi-agent workflows.
