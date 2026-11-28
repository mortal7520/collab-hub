#!/usr/bin/env bash
# CollabHub v3.0 — Tmux 36-Column Chat-Adjacent Live HUD Sidebar
# Inspired by hiroppy/tmux-agent-sidebar. Docks beside Claude Code / Codex CLI / OpenCode.
set -euo pipefail

WIDTH="${COLLAB_HUB_TMUX_WIDTH:-36}"
CMD="${COLLAB_HUB_HUD_CMD:-collab-hub hud --watch}"

if [[ -z "${TMUX:-}" ]]; then
  echo "Not inside a tmux session. Run inside tmux, or pass CLI: collab-hub hud --watch" >&2
  exit 1
fi

tmux split-window -h -l "${WIDTH}" -d "${CMD}"
echo "CollabHub live HUD docked in ${WIDTH}-col right sidebar."
