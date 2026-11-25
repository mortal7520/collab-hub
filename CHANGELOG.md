# Changelog

## v1.2.0 (2026-11-25)

**Watch it run: live streaming logs, live DAG execution overlay, one-click checkpoint resume, zero-dependency EN/中文 UI, and a live interactive GitHub Pages demo** — built & audited concurrently by our 4-agent team (`WSL DSH` + `Codex Desktop` + `Cloud Muse` + `AGY`).

### Highlights
- **Real-Time Streaming Logs & Process Cancel/Abort (`collab_cancel`, `GET /api/tasks/logs`, `POST /api/tasks/cancel`)**:
  - Live stdout/stderr/system log ring buffer (bounded to 200 chunks / 64 KiB per task, 100-task LRU) pushed over SSE (`task.log`) into a dark monospace **Live Output** terminal in the Task Drawer with follow-scroll and Copy.
  - Process-tree & HTTP `AbortController` cancellation (`collab_cancel` / `collab-hub cancel`), refusing unconfirmed cross-process cancellation unless `force: true` is explicitly passed after verification; bounded 2 MiB HTTP response reads and 512 KiB per-client SSE backpressure guard.
- **Live DAG Execution Overlay, Checkpoint Resume & Custom Templates (`collab_workflow_resume`, `POST /api/workflows/resume`)**:
  - Interactive SVG `Flow Canvas` binds to live workflow batches with pulsing indigo `Running` rings, emerald `Completed · 2.2s ✓` badges, red/amber error rings, and click-to-inspect task receipts.
  - Persistent `workflow_plans` SQLite table + append-only retry task IDs (`_r2`, `_r3`) resume failed/cancelled/undispatched steps while preserving original prompts, `reserve_paths`, and `auto_inject_context` settings — and strictly refusing to blindly retry `uncertain` or `stalled` tasks.
  - Save, load, and delete custom DAG templates locally, plus colorized unified Git diff rendering in the Worktree Review drawer.
- **Zero-Dependency Bilingual UI (`EN` / `中文`)**:
  - Instant `EN / 中` toggle in the topbar (`?lang=en|zh` → `localStorage` → `navigator.language`) backed by a complete 635-key bilingual dictionary with zero inline scripts and zero npm dependencies.
- **Standalone Interactive GitHub Pages Demo (`https://mortal7520.github.io/collab-hub/`)**:
  - Automatic GitHub Pages workflow (`.github/workflows/pages.yml`) with injected `<meta http-equiv="Content-Security-Policy">` and `<meta name="collabhub-static-demo" content="1">`.
  - Runs 100% client-side with zero `/api/*` requests, including **Simulate Live DAG**, live streaming log drawer, 4-column Kanban, `Ctrl+K` Command Palette, Dark/Light themes, and `EN / 中` switching.
- **34 Unified MCP Tools, CLI Subcommands & Node 24-Native CI**:
  - Added `collab_cancel` (#33) and `collab_workflow_resume` (#34) plus CLI subcommands `cancel`, `logs`, and `resume`.
  - Upgraded GitHub Actions CI to `actions/checkout@v5` and `actions/setup-node@v5` (Node 24 native, zero Node 20 deprecation warnings) across Ubuntu & Windows × Node 22 & 24.

## v1.1.0 (2026-11-25)

Major UI/UX redesign, open-source presentation upgrade, and release security hardening — dogfooded end-to-end with CollabHub's own multi-agent worktree & audit workflow.

### Highlights
- **Modular App-Shell Web Workbench (`public/index.html`, `public/styles.css`, `public/app.js`)**: Linear/Vercel-inspired 6-view sidebar, `Ctrl+K` Command Palette, Obsidian Dark / Alabaster Light themes, interactive SVG DAG `Flow Canvas`, and privacy-safe `/?demo=1` preview.
- **Security & Release Hardening**: Flat allowlist static serving, hardened CSP, single-source `APP_VERSION`, SHA-pinned `mergeWorktree` verification gate, and expanded CI matrix.

## v1.0.0 (2026-11-25)

Initial formal open-source release of **CollabHub** — a zero-dependency, local-first multi-agent orchestration workbench.
