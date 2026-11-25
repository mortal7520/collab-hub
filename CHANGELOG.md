# Changelog

## v1.1.0 (2026-11-25)

Major UI/UX redesign, open-source presentation upgrade, and release security hardening — dogfooded end-to-end with CollabHub's own multi-agent worktree & audit workflow.

### Highlights
- **Modular App-Shell Web Workbench (`public/index.html`, `public/styles.css`, `public/app.js`)**:
  - Linear/Vercel-inspired 6-view sidebar navigation (`Overview`, `Tasks & Kanban`, `DAG & Playbooks`, `Worktrees`, `Toolkit & Memory`, `Ops & Doctor`).
  - Global **`Ctrl+K` / `Cmd+K` Command Palette**, **Obsidian Dark / Alabaster Light** theme switcher, live **Toast** notifications, and responsive layouts from 1440px down to 390px.
  - **Interactive SVG DAG `Flow Canvas`**: Live Bezier dependency graph with automatic cycle detection, role color dots, click-to-jump step focus, and responsive `viewBox` fitting.
  - **Privacy-Safe Demo Mode (`/?demo=1`)**: Pure in-memory fixture with zero database or disk reads (verified with canary DB isolation tests) for instant previews and safe screenshots.
- **Security & Release Hardening**:
  - Strict flat allowlist static serving for `/assets/*` (`GET` & `HEAD`, no body on `HEAD`), hardened `Content-Security-Policy` (`base-uri 'none'; object-src 'none'; frame-ancestors 'none'`).
  - Single-source-of-truth `APP_VERSION` read from `package.json` across CLI, MCP server, dashboard, and executors.
  - Hardened `mergeWorktree` verification gate: blocks merges when verification failed or when `requireVerified: true` is set without a passing verification matching the current worktree `HEAD` SHA.
  - Added `"files"` manifest in `package.json` and expanded GitHub Actions CI to **Ubuntu & Windows × Node 22 & 24**.
- **Open-Source Presentation & Community Templates**:
  - Custom SVG hero banner (`docs/assets/banner.svg`), real `?demo=1` screenshots (`workbench-overview.png`, `workbench-kanban.png`, `workbench-dag.png`), bilingual outcome-driven `README.md` + `README.zh-CN.md`, honest competitor comparison, and GitHub Issue / PR templates.

## v1.0.0 (2026-11-25)

Initial formal open-source release of **CollabHub** — a zero-dependency, local-first multi-agent orchestration workbench.

### Highlights
- **Pluggable Multi-Agent Registry**: Built-in coordination slots plus dynamic registration for `generic-cli` (Gemini CLI, Aider, OpenCode, Qwen, custom scripts), `openai-http` (Ollama, LM Studio, vLLM, DeepSeek, OpenRouter — `api_key_env` only, never plaintext keys), and `desktop-native` sessions.
- **32 Unified MCP Tools**: Roster & telemetry-aware routing, `member="auto"` & pre-dispatch `auto_fallback`, DAG workflow runner, batch Markdown report export, prompt recipes, Git worktree isolation + `.worktreeinclude` auto-sync + allowlisted test verification gates, FTS5 shared memory, 8-point system doctor + `VACUUM INTO` hot backups, and optional open-source engineering toolkit wrappers (`cass`, `ast-grep`, `repomix`, `markitdown`, `beads`).
- **Interactive Web Workbench (`http://127.0.0.1:5290`)**: Dual **Table + 4-Column Kanban Board** views, live SSE push, visual multi-stage DAG builder, 4 one-click Playbooks (`code-review-squad`, `research-and-pack`, `adversarial-debate`, `multi-agent-build`), interactive toolkit workbench, visual worktree diff/verify/merge, XSS-safe rich Markdown report & memory viewer, and real token/latency/success-rate telemetry.
- **Hardened Security & Cross-Platform Portability**: Works cleanly on Windows, macOS, and Linux with zero third-party npm dependencies and full GitHub Actions CI coverage.
