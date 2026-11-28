# CollabHub v3.0 — Windows PowerShell Always-On Live Fleet Prompt
# Dot-source in your $PROFILE:
#   . <path-to-collab-hub>\extensions\terminal-hud\powershell-prompt.ps1

if (-not (Test-Path Function:_CollabHubOrigPrompt)) {
  Copy-Item Function:prompt Function:_CollabHubOrigPrompt
}

function prompt {
  $hud = $null
  try {
    if (Get-Command collab-hub -ErrorAction SilentlyContinue) {
      $hud = (& collab-hub hud --format statusline --width 96 2>$null)
    }
  } catch {}
  if ($hud) { Write-Host $hud }
  return (& _CollabHubOrigPrompt)
}
