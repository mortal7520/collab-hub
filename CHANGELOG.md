# Changelog

## v1.4.0 (2026-11-25)

**Self-Improving & Self-Healing Multi-Agent Engine: runtime self-diagnosis, safe dry-run/apply auto-heal, learned incident guardrails, per-channel Bayesian telemetry, opt-in closed-loop auto-repair DAG, and 37 unified MCP tools** — built & adversarially audited concurrently by `Codex Desktop` + `WSL DSH` + `Cloud Muse` + `AGY`.

### Highlights
- **Runtime Self-Diagnosis & Safe Auto-Heal Engine (`src/self-improve.mjs`, `collab_self_check`, `collab_self_heal`, `/api/system/self-check`, `/api/system/self-heal`)**:
  - Computes a decomposable `0–100` operational Health Score across 8 runtime detectors: dead-owner orphans, stuck/needs_input tasks, expired cooldowns, missing-on-disk worktrees, repeating failure clusters, degraded agent circuit breakers, WAL/retention size, and stale desktop presence.
  - Strict boolean `apply` guard (`dry_run` default is 100% read-only with zero DB writes); `apply: true` executes ONLY verified zero-risk operational heals: conservative orphan recovery (`uncertain`), atomic conditional cooldown cleanup, non-terminal-task-safe missing worktree reconciliation, bounded 500-row retention pruning preserving open-task audit trails, non-blocking `PRAGMA wal_checkpoint(PASSIVE)`, and automatic deduplicated `incident_lessons` extraction.
  - Every `apply` run is persisted in an append-only `self_improve_runs` audit trail (`SCHEMA_VERSION = 140` inside `BEGIN IMMEDIATE`).
- **Learned Runtime Guardrails (`incident_lessons`, `collab_lessons`, `/api/lessons*`)**:
  - Automatically extracts and deduplicates operational lessons from repeating failure clusters and successful auto-repairs, injecting up to 3 relevant active guardrails (strictly capped at `<= 700 chars` total prefix, redacted of secrets & prompt-injection delimiters, opt-out via `inject_guardrails: false` across HTTP/MCP/DAG).
  - Full operator control in the UI & CLI (`collab-hub lessons list|save|toggle`) to inspect hit counts, pause/resume rules, or add custom guardrails.
- **Per-Channel Bayesian Reliability & Soft Circuit Breaker (`src/telemetry.mjs`, `src/prober.mjs`)**:
  - Isolates reliability scoring strictly by `(member, channel)` so `claude-cli` 429s never penalize `claude` `desktop-native` sessions and cold-start channels start neutral (`0`).
  - Fixes stalled-task denominator distortion (`effective_attempts = completed + failed + stalled`) with 7-day exponential recency decay, excluding operator `cancelled`, `needs_input`, and `429` from permanent reliability penalties while surfacing an `open`/`half_open`/`closed` circuit breaker.
- **Opt-In Closed-Loop Auto-Repair DAG (`src/workflows.mjs`) & Windows+WSL Worktree Self-Heal (`src/worktree.mjs`)**:
  - Opt-in `auto_repair: { enabled: true, max_repairs: 1..2 }` (included in `plan_sha256`, hard batch cap `4` enforced against persisted SQLite rows, strictly blocked on `uncertain`/`stalled`/`needs_input`/`cancelled`/429, halts immediately on duplicate failure fingerprint, passes allowlisted structured metadata only — zero raw stderr/secret leakage!).
  - Self-healing `healWslWorktreeConfig()` in `src/worktree.mjs` automatically clears rogue WSL `worktree = /mnt/...` entries in Windows `.git/config` so mixed Windows + WSL agent teams never hit `fatal: Invalid path '/mnt'`.
- **Self-Improve & Auto-Heal Workbench UI (`public/app.js`, `public/styles.css`, `public/index.html`)**:
  - Animated `132px` SVG Health Score ring, Overview KPI health pill (0 DOM mutations on unchanged 15s polls), Live Findings list (`Auto-Healable` vs `Operator Review`), interactive Learned Guardrails library with toggle & inline add form, Recent Self-Heal audit timeline, 104 new EN/中文 keys (`752/752` parity), and full zero-network interactive Demo (`84 → 98` simulated heal).
- **37 Unified MCP Tools & CLI Subcommands**: Added `collab_self_check` (#35), `collab_self_heal` (#36), and `collab_lessons` (#37), plus CLI `self-check`, `self-heal [--apply]`, and `lessons`.

## v1.3.0 (2026-11-25)

**Deep Systems & Architecture Hardening: cross-process SQLite control plane, lossless SSE replay, confirmed cancellation, transactional migrations, credential-to-host binding, and 0-mutation dirty-gated UI** — audited & hardened concurrently by `Codex Desktop` + `WSL DSH` + `AGY`.

### Highlights
- **Cross-Process Durable Control Plane & 6x Faster SQLite (`src/db.mjs`, `src/executors.mjs`, `src/dashboard.mjs`)**:
  - Migrated `task_logs` to SQLite WAL (`PRAGMA synchronous = NORMAL`, `temp_store = MEMORY`, `cache_size = -16000`, composite indexes) — per-test DB latency dropped ~6x while logs now survive restarts and stream across MCP/CLI/Dashboard processes.
  - Serialized schema migrations inside `BEGIN IMMEDIATE` with `PRAGMA user_version = 130`, including atomic FTS5 rebuild over pre-existing `memory_notes` rows (eliminating upgrade-time FTS5 corruption) and bounded retention pruning (`pruneRetentionTables`).
  - Lossless SSE reconnect catch-up (`Last-Event-ID`: `e<ev>-l<log>`, `ev-<N>`, `log-<N>`) with synchronous tip snapshot and paginated chunk replay so reconnects never drop events or logs.
- **Confirmed Cancellation, Atomic Dispatch Ownership & Crash Safety (`src/executors.mjs`, `src/workflows.mjs`, `src/worktree.mjs`, `bin/collab-hub.mjs`)**:
  - Atomic `dispatch_token` ownership verification right before external bridge calls (aborts send and releases Mail reservations if the task was terminated while awaiting leases).
  - Strict stop confirmation: POSIX process-group cleanup (`-pid`), OS-confirmed exit detection (`childClosed`), cross-process SQLite cancel-signal watcher (`cancel_requested_at`), DSH `still_busy: true` / `ok: false` refusal, and conservative `uncertain` recovery in `sweepOrphanTasks` so `collab_workflow_resume` never blindly retries an uncertain run.
  - True non-blocking `POST /api/tasks/dispatch` (`async: true` → `HTTP 202`) across all drivers including DSH/Muse/Claude, unified `bin/collab-hub.mjs start` orphan sweeping & graceful `server.shutdown()` drain.
  - Immutable `workflow_plans` digest covering canonical `project_dir` + steps (with automatic legacy digest backfill); SHA-pinned `git merge --no-ff` + atomic `renameSync` stale-lock handoff & token-verified release + Git root jail verification.
- **Security & Resource Hardening (`src/registry.mjs`, `src/prober.mjs`, `src/toolkit.mjs`, `src/memory.mjs`, `src/discovery.mjs`)**:
  - `openai-http` enforces `https://` for non-loopback hosts, restricts `api_key_env` to `*_API_KEY` / `*_KEY` / `*_TOKEN`, binds built-in provider credentials (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, etc.) to their official HTTPS hosts, and re-validates on both probe and dispatch.
  - Minimal allowlisted `childEnv` & accurate timeout→`offline` mapping in `probeCustomAgent`, bounded concurrency (`4`) custom probes, bounded `packRepoRepomix` file reads, `beads create --` argument guard, 64-char SQL `LIKE` cap, and collision-safe `slugId` hashing.
- **Frontend Performance & Cross-Process Cancel UX (`public/app.js`, `public/styles.css`, `public/index.html`)**:
  - Content-signature dirty-gated `renderAll()` cuts unchanged overview poll mutations from `80 / 60 KB` → **`0 / 0 B`**; active-view-only task rendering, debounced filter, and 30s SSE fallback polling.
  - Transition-only DAG simulation cuts 5s SVG DOM churn & layout/script time by **−80%**; compositor-friendly `opacity` pulse animation; exact retry-aware (`_r2`, `_r3`) DAG node matching; zero-wipe deduped live log console (cap 200 + truncation banner + Follow toggle, 0 redundant `/api/tasks/logs` fetches); two-step `Force Cancel` flow for `cancel_requested` cross-process runs.

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
