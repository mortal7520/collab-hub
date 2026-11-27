# Upstream Open-Source Reuse & Provenance

CollabHub adheres to a strict **zero-npm-runtime-dependency** core (`node >= 22.13.0` built-ins only) while standing on the shoulders of verified, maintained open-source projects. Every reused design or ported core algorithm is recorded below with its exact upstream repository, commit SHA / version, license, and local adaptation rationale.

## Host-Native Animated Cockpit & TUI Adaptations (`v2.0.0`)

| CollabHub Module | Upstream Project | Exact Commit / Tag | License | What Was Adapted & Why |
| :--- | :--- | :--- | :--- | :--- |
| [`src/mcp-app-ui.mjs`](../src/mcp-app-ui.mjs), [`src/mcp-server.mjs`](../src/mcp-server.mjs) | **[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps)** | `87bcdc8cb626` (SEP-1865 `2026-01-26`) | MIT | Implemented zero-dependency SEP-1865 MCP Apps server (`resources/list`, `resources/read`, `text/html;profile=mcp-app`, `_meta.ui.resourceUri`, `com.google.antigravity/ui` `aux_pane`/`global` entrypoints) and inline iframe JSON-RPC 2.0 `postMessage` bridge (`ui/initialize`, `ui/notifications/tool-result`, `ui/notifications/host-context-changed`, `ui/notifications/size-changed`, `tools/call`, `ui/message`) working natively in Antigravity, Claude Desktop, and Codex Desktop. |
| [`src/tui.mjs`](../src/tui.mjs) | **[asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck)** | `fec4fcbc55f1` | MIT | Adapted the multi-agent terminal command center layout (agent constellation/status lanes, keyboard-driven tab navigation, live log preview, MCP & worktree inspection) into a zero-dependency Node.js 24-bit TrueColor animated TUI with `NO_COLOR`/`TERM=dumb` graceful degradation. |
| [`src/hud.mjs`](../src/hud.mjs) | **[sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline)** | `0c94df755665` | MIT | Adapted the sub-100ms Claude Code `statusLine` JSON-stdin + compact colored telemetry bar pattern for live fleet/MCP/Merge-Queue/health monitoring inside Claude Code CLI, Codex CLI, and WSL DSH terminals. |

## Core Multi-Agent Source Adaptations (`v1.5.0`)

| CollabHub Module | Upstream Project | Exact Commit / Tag | License | What Was Adapted & Why |
| :--- | :--- | :--- | :--- | :--- |
| [`src/mcp-hub.mjs`](../src/mcp-hub.mjs) | **[ravitemer/mcp-hub](https://github.com/ravitemer/mcp-hub)** | `v4.2.1` (`9c7670a4c341ed3cf738a6242c0fde1cea40bccf`) | MIT | Adapted centralized multi-client MCP server management and safe `${ENV_VAR}` / `${userHome}` / `${workspaceFolder}` placeholder resolution from `src/utils/env-resolver.js`. Hardened locally by explicitly forbidding `${cmd:...}` shell command interpolation, adding inline-secret detection (`secret_inline`), DNS-resolved SSRF protection, and Dry-Run + `.bak` confirmed config sync. |
| [`src/mcp-hub.mjs`](../src/mcp-hub.mjs) | **[warpdev/mcp-hub-mcp](https://github.com/warpdev/mcp-hub-mcp)** | `060838ad7034bd366873b04b7aa50ce676132ae8` | MIT | Adapted the Meta-MCP lazy tool router pattern (`find-tools` / `call-tool` from `src/index.ts` and `src/server-manager.ts`) into zero-dep `findMcpTools` + `callMcpServerTool` and MCP tools `collab_mcp_find_tools` / `collab_mcp_call_tool` so multi-agent sessions discover and call external MCP tools on demand without flooding context windows. |
| [`src/mcp-hub.mjs`](../src/mcp-hub.mjs) | **[samanhappy/mcphub](https://github.com/samanhappy/mcphub)** | `f2c0d9937f8481be954b158d9f2adba041bd6d50` | Apache-2.0 | Adopted logical server grouping (`group_name`) and unified gateway snapshot summaries for multi-client MCP registries. |
| [`src/skills-hub.mjs`](../src/skills-hub.mjs) | **[lbb00/ai-rules-sync](https://github.com/lbb00/ai-rules-sync)** | `ddc7704653ac24dd003e6c3bf9e9f944b0580274` | Unlicense | Adapted the multi-client Skills (`SKILL.md`) and Rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/*.mdc`, `.windsurfrules`) adapter map from `src/adapters/` into a zero-dep ESM scanner + dialect-aware sync engine with Dry-Run diff preview and automatic `.bak` backups. |
| [`src/skills-hub.mjs`](../src/skills-hub.mjs) | **[fALECX/shareskills](https://github.com/fALECX/shareskills)** | `4b68eb88b1172a0fa1d87cbf7b92a4f437c1a33b` | ISC | Adapted central skill directory inventory and backup-exclusion filtering (`.backup_` / `.bak.`) from `src/sync.ts`. |
| [`src/skills-hub.mjs`](../src/skills-hub.mjs) | **[viteinfinite/sync-skills](https://github.com/viteinfinite/sync-skills)** | `88e22f83eb161557039c4a2aa8d66a39e1d60581` | MIT | Adopted cross-client `.claude` ↔ `.codex` / `.gemini` skill drift comparison model. |
| [`src/merge-queue.mjs`](../src/merge-queue.mjs) | **[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)** | `37bee50ff4cab5f44da77a3b263ecda6e2fec378` | Apache-2.0 | Adapted the worktree-bound inline diff review comment workflow (attaching file/line comments to isolated Git worktree diffs and dispatching open comments back to the owning agent for targeted rework), paired with a side-effect-free speculative `git merge-tree --write-tree` serialized Agent Merge Queue. |

## Optional Prebuilt Engineering Toolkit Sidecars (`src/toolkit.mjs`)

These standalone open-source tools are invoked safely via allowlisted paths and strict workspace directory jails (never bundled into CollabHub's npm dependencies):

- **[Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)** (`v0.3.41`, MIT with OpenAI/Anthropic Rider) — Local Agent Mail & advisory file reservations.
- **[Dicklesworthstone/coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search)** (`cass v0.11.0`, MIT) — Read-only cross-agent session history indexing & search.
- **[ast-grep/ast-grep](https://github.com/ast-grep/ast-grep)** (`0.51.3`, MIT) — Structural AST code search.
- **[steveyegge/beads](https://github.com/steveyegge/beads)** (`bd v1.3.4`, MIT) — Dependency-aware issue tracker.
- **[yamadashy/repomix](https://github.com/yamadashy/repomix)** (`1.19.0`, MIT) — Repository context packing.
- **[microsoft/markitdown](https://github.com/microsoft/markitdown)** (`0.1.9`, MIT) — Document-to-Markdown conversion.
