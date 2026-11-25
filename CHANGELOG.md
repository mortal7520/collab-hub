# Changelog

## v1.0.0 (2026-11-25)

Initial formal open-source release of **CollabHub** — a zero-dependency, local-first multi-agent orchestration workbench.

### Highlights
- **Pluggable Multi-Agent Registry**: Built-in coordination slots plus dynamic registration for `generic-cli` (Gemini CLI, Aider, OpenCode, Qwen, custom scripts), `openai-http` (Ollama, LM Studio, vLLM, DeepSeek, OpenRouter — `api_key_env` only, never plaintext keys), and `desktop-native` sessions.
- **32 Unified MCP Tools**: Roster & telemetry-aware routing, `member="auto"` & pre-dispatch `auto_fallback`, DAG workflow runner, batch Markdown report export, prompt recipes, Git worktree isolation + `.worktreeinclude` auto-sync + allowlisted test verification gates, FTS5 shared memory, 8-point system doctor + `VACUUM INTO` hot backups, and optional open-source engineering toolkit wrappers (`cass`, `ast-grep`, `repomix`, `markitdown`, `beads`).
- **Interactive Web Workbench (`http://127.0.0.1:5290`)**: Dual **Table + 4-Column Kanban Board** views, live SSE push, visual multi-stage DAG builder, 4 one-click Playbooks (`code-review-squad`, `research-and-pack`, `adversarial-debate`, `multi-agent-build`), interactive toolkit workbench, visual worktree diff/verify/merge, XSS-safe rich Markdown report & memory viewer, and real token/latency/success-rate telemetry.
- **Hardened Security & Cross-Platform Portability**: Works cleanly on Windows, macOS, and Linux with zero third-party npm dependencies and full GitHub Actions CI coverage.
