/**
 * CollabHub v3.0 — Cross-IDE Native Resident Plugin Installer (Zero Dependencies)
 *
 * Installs the zero-dependency `collab-hub` extension cleanly into VS Code and its
 * mainstream AI forks (Cursor, Windsurf, Antigravity IDE, Kiro), plus provides status
 * for Claude Code statusLine & terminal tmux/Zsh/PowerShell HUD integrations.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './config.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSION_DIR = path.join(PACKAGE_ROOT, 'extensions', 'collab-hub-vscode');
const SOURCE_TERMINAL_DIR = path.join(PACKAGE_ROOT, 'extensions', 'terminal-hud');
const EXTENSION_FOLDER_NAME = `mortal7520.collab-hub-${APP_VERSION}`;

export function getIdeExtensionTargets({ homedir = os.homedir() } = {}) {
  return [
    { id: 'antigravity', name: 'Antigravity IDE', extensionsDir: path.join(homedir, '.antigravity', 'extensions'), altRoot: path.join(homedir, '.gemini', 'antigravity') },
    { id: 'cursor', name: 'Cursor', extensionsDir: path.join(homedir, '.cursor', 'extensions'), altRoot: path.join(homedir, '.cursor') },
    { id: 'windsurf', name: 'Windsurf', extensionsDir: path.join(homedir, '.windsurf', 'extensions'), altRoot: path.join(homedir, '.codeium', 'windsurf') },
    { id: 'vscode', name: 'VS Code', extensionsDir: path.join(homedir, '.vscode', 'extensions'), altRoot: path.join(homedir, '.vscode') },
    { id: 'kiro', name: 'Kiro', extensionsDir: path.join(homedir, '.kiro', 'extensions'), altRoot: path.join(homedir, '.kiro') },
  ];
}

function copyDirAtomic(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirAtomic(src, dst);
    } else if (ent.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

export function planPluginInstall({
  ides = null,
  homedir = os.homedir(),
  sourceDir = SOURCE_EXTENSION_DIR,
} = {}) {
  const targets = getIdeExtensionTargets({ homedir });
  const requested = Array.isArray(ides) ? new Set(ides.map((s) => String(s).toLowerCase())) : null;

  const detectedIdes = targets.map((t) => {
    const extRootExists = fs.existsSync(t.extensionsDir);
    const altExists = t.altRoot ? fs.existsSync(t.altRoot) : false;
    const detected = extRootExists || altExists;
    const installDir = path.join(t.extensionsDir, EXTENSION_FOLDER_NAME);
    const alreadyInstalled = fs.existsSync(path.join(installDir, 'package.json'));
    const willInstall = requested ? requested.has(t.id) : detected;
    return {
      id: t.id,
      name: t.name,
      detected,
      already_installed: alreadyInstalled,
      extensions_dir: t.extensionsDir,
      install_dir: installDir,
      will_install: willInstall,
    };
  });

  return {
    ok: true,
    dry_run: true,
    version: APP_VERSION,
    extension_source: sourceDir,
    source_exists: fs.existsSync(path.join(sourceDir, 'extension.js')),
    ides: detectedIdes,
    browser_extension: path.resolve(SOURCE_EXTENSION_DIR, '..', 'collab-hub-browser'),
    terminal_hud: {
      tmux: path.join(SOURCE_TERMINAL_DIR, 'tmux.conf'),
      tmux_sidebar: path.join(SOURCE_TERMINAL_DIR, 'tmux-sidebar.sh'),
      zsh: path.join(SOURCE_TERMINAL_DIR, 'zsh-rprompt.sh'),
      powershell: path.join(SOURCE_TERMINAL_DIR, 'powershell-prompt.ps1'),
    },
    hint: 'Pass confirmed: true (or `--confirm`) to copy the zero-dependency CollabHub native resident extension into detected IDE extension folders.',
  };
}

export function installNativePlugins({
  confirmed = false,
  ides = null,
  homedir = os.homedir(),
  sourceDir = SOURCE_EXTENSION_DIR,
} = {}) {
  const plan = planPluginInstall({ ides, homedir, sourceDir });
  if (confirmed !== true) return plan;
  if (!plan.source_exists) {
    throw new Error(`Extension source directory incomplete: ${sourceDir}`);
  }

  const results = [];
  for (const ide of plan.ides) {
    if (!ide.will_install) {
      results.push({ id: ide.id, name: ide.name, skipped: true, reason: 'not_detected_or_unselected' });
      continue;
    }
    try {
      const stageDir = `${ide.install_dir}.tmp.${process.pid}`;
      let bakDir = null;
      fs.rmSync(stageDir, { recursive: true, force: true });
      copyDirAtomic(sourceDir, stageDir);
      if (fs.existsSync(ide.install_dir)) {
        bakDir = `${ide.install_dir}.bak.${Date.now()}`;
        fs.renameSync(ide.install_dir, bakDir);
      }
      try {
        fs.renameSync(stageDir, ide.install_dir);
      } catch (renameErr) {
        if (bakDir && fs.existsSync(bakDir) && !fs.existsSync(ide.install_dir)) {
          try { fs.renameSync(bakDir, ide.install_dir); } catch { /* best-effort rollback */ }
        }
        fs.rmSync(stageDir, { recursive: true, force: true });
        throw renameErr;
      }
      results.push({ id: ide.id, name: ide.name, installed: true, install_dir: ide.install_dir });
    } catch (err) {
      results.push({ id: ide.id, name: ide.name, installed: false, error: String(err.message || err) });
    }
  }

  return {
    ok: true,
    dry_run: false,
    version: APP_VERSION,
    installed_count: results.filter((r) => r.installed).length,
    results,
    browser_extension: plan.browser_extension,
    terminal_hud: plan.terminal_hud,
  };
}
