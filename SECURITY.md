# Security Policy

## Security Architecture

CollabHub is designed from first principles as a **local-first, defense-in-depth** multi-agent coordinator:

1. **Loopback-Only Web Workbench (`127.0.0.1`)**:
   - Strict `Host` header allowlist rejecting DNS rebinding with HTTP `421`.
   - All state-changing `POST` routes require same-origin `Origin`/`Sec-Fetch-Site`, `Content-Type: application/json`, and `X-CollabHub-CSRF: 1` (rejecting cross-site requests with HTTP `403`).
   - Bounded `64KB` JSON request body cap (`413`), CSP, and `X-Frame-Options: DENY`.
2. **Zero Plaintext Secrets in SQLite**:
   - `openai-http` agents forbid plaintext `api_key` storage and accept only `api_key_env` (environment variable name).
   - `discoverLocalAgents` checks boolean presence of provider env vars without ever reading or returning secret values.
3. **Strict Path Jails & Zero Shell Execution**:
   - All project directories, `.worktreeinclude` entries, and document paths are canonicalized with `fs.realpathSync` and jailed inside configured roots.
   - All subprocesses (`git`, `generic-cli`, `ast-grep`, `repomix`, `markitdown`, `beads`, `cass`, `verifyWorktree`) execute with `shell: false`, strict regex/allowlist validation, and `--` option terminators.
4. **Worktree Review & Verification Integrity**:
   - `mergeWorktree` requires explicit `confirmed: true`, verifies the main repository is clean on the exact `base_ref`, binds `reviewed_head_sha` to prevent post-review tampering, and acquires an exclusive file lock.
5. **No Blind Resends / Zero Identity Forgery**:
   - Dispatch intent is persisted before external calls; uncertain deliveries are surfaced for inspection rather than auto-resent; terminal states (`completed`/`failed`/`rerouted`) cannot be regressed by slow concurrent polls.

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories on this repository rather than opening a public issue with exploit payloads.
