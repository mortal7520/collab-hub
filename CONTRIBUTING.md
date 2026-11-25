# Contributing to CollabHub

Thank you for your interest in CollabHub!

## Core Engineering Principles

1. **Zero npm runtime dependencies**: CollabHub runs purely on modern Node.js (`>=22.13.0`) with built-in `node:sqlite`, `node:http`, `node:test`, and native ESM. Keep it lean and auditable.
2. **Defense-in-depth**: Never spawn shells (`shell: true`), never store plaintext API keys in SQLite, always validate IDs/refs/paths, and never auto-resend uncertain external deliveries.
3. **Cross-platform by default**: Keep defaults portable across Windows, macOS, and Linux (`~/.collab-hub` + `process.cwd()`), with machine-specific adapters strictly externalized to `<APP_ROOT>/data/integrations.json` or env vars.

## Development Workflow

```bash
# Run full test suite
npm test

# Start the local web workbench
npm start

# Run 8-point system doctor
npm run doctor
```

Before opening a pull request:
- Add unit & adversarial tests in `test/collab-hub.test.mjs` for every new feature or bug fix.
- Ensure `npm test` passes cleanly on both Linux and Windows (CI enforces both).
- Never commit personal paths, private Tailscale/LAN IPs, tokens, or `.collab-hub.local.json`.
