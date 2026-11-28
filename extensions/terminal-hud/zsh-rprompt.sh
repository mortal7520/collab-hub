# CollabHub v3.0 — Always-On Zsh / Bash Live Usage HUD
# Add to ~/.zshrc or ~/.bashrc:
#   source /path/to/collab-hub/extensions/terminal-hud/zsh-rprompt.sh

_collabhub_hud_line() {
  if command -v collab-hub >/dev/null 2>&1; then
    collab-hub hud --format statusline --width 88 2>/dev/null
  fi
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook
  _collabhub_precmd() { RPROMPT="$(_collabhub_hud_line)"; }
  add-zsh-hook precmd _collabhub_precmd
elif [ -n "${BASH_VERSION:-}" ]; then
  PROMPT_COMMAND='_collabhub_hud_line; echo; '"${PROMPT_COMMAND:-}"
fi
