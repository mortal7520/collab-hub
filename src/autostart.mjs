/**
 * CollabHub v3.0 — Cross-Platform Always-On Resident Service Planner & Installer
 *
 * Keeps CollabHub Dashboard (`127.0.0.1:5290`), Streamable HTTP `/mcp`, Webhook Dispatcher,
 * and Resident Cockpit running reliably across Windows, macOS, and Linux without admin/root.
 * Never overwrites an existing custom Windows scheduled task unless `force: true`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APP_ROOT, DASHBOARD_PORT, WORKSPACE_ROOT } from './config.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function xmlEscape(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function assertSafeSingleLineValue(v, fieldName) {
  const s = String(v ?? '');
  if (/[\r\n\0]/.test(s)) {
    throw new Error(`Unsafe control character in ${fieldName}`);
  }
  return s;
}

function systemdEscape(v) {
  return `"${assertSafeSingleLineValue(v, 'systemd value').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function planAutostart({
  platform = process.platform,
  homedir = os.homedir(),
  nodeBin = process.execPath,
  cliEntry = path.join(PACKAGE_ROOT, 'bin', 'collab-hub.mjs'),
  appRoot = APP_ROOT,
  workspaceRoot = WORKSPACE_ROOT,
  port = DASHBOARD_PORT,
  taskName = 'CollabHubLocal',
} = {}) {
  const safeNodeBin = assertSafeSingleLineValue(nodeBin, 'nodeBin');
  const safeCliEntry = assertSafeSingleLineValue(cliEntry, 'cliEntry');
  const safeAppRoot = assertSafeSingleLineValue(appRoot, 'appRoot');
  const safeWorkspaceRoot = assertSafeSingleLineValue(workspaceRoot, 'workspaceRoot');
  const safeTaskName = assertSafeSingleLineValue(taskName, 'taskName');
  const safePort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535
    ? Number(port)
    : DASHBOARD_PORT;
  nodeBin = safeNodeBin;
  cliEntry = safeCliEntry;
  appRoot = safeAppRoot;
  workspaceRoot = safeWorkspaceRoot;
  taskName = safeTaskName;
  port = safePort;
  if (platform === 'darwin') {
    const label = 'io.github.mortal7520.collab-hub';
    const filePath = path.join(homedir, 'Library', 'LaunchAgents', `${label}.plist`);
    const logDir = path.join(appRoot, 'logs');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cliEntry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COLLAB_HUB_HOME</key>
    <string>${xmlEscape(appRoot)}</string>
    <key>COLLAB_HUB_WORKSPACE</key>
    <string>${xmlEscape(workspaceRoot)}</string>
    <key>COLLAB_HUB_PORT</key>
    <string>${xmlEscape(String(port))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
    return { platform: 'darwin', manager: 'launchd', service_id: label, file_path: filePath, log_dir: logDir, content };
  }

  if (platform === 'linux') {
    const unitName = 'collab-hub.service';
    const filePath = path.join(homedir, '.config', 'systemd', 'user', unitName);
    const content = `[Unit]
Description=CollabHub Multi-Agent Mission Control
After=network.target

[Service]
Type=simple
ExecStart=${systemdEscape(nodeBin)} ${systemdEscape(cliEntry)} start
Environment=COLLAB_HUB_HOME=${systemdEscape(appRoot)}
Environment=COLLAB_HUB_WORKSPACE=${systemdEscape(workspaceRoot)}
Environment=COLLAB_HUB_PORT=${port}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    return { platform: 'linux', manager: 'systemd-user', service_id: unitName, file_path: filePath, log_dir: path.join(appRoot, 'logs'), content };
  }

  // Windows: Scheduled Task running `node bin/collab-hub.mjs start --port <port>`
  const tr = `"${nodeBin}" "${cliEntry}" start --port ${port}`;
  return {
    platform: 'win32',
    manager: 'schtasks',
    service_id: taskName,
    file_path: null,
    command_args: ['/Create', '/TN', taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', tr],
    preview: `schtasks /Create /TN ${taskName} /SC ONLOGON /RL LIMITED /TR ${tr}`,
  };
}

export async function getAutostartStatus(opts = {}) {
  const plan = planAutostart(opts);
  if (plan.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/TN', plan.service_id, '/FO', 'LIST'], {
        encoding: 'utf8', timeout: 4000, windowsHide: true,
      });
      const running = /Status:\s*Running/i.test(stdout) || /正在运行/.test(stdout);
      return { ...plan, installed: true, active: running };
    } catch {
      return { ...plan, installed: false, active: false };
    }
  }
  const installed = Boolean(plan.file_path && fs.existsSync(plan.file_path));
  let active = false;
  if (installed && plan.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', plan.service_id], { encoding: 'utf8', timeout: 3000 });
      active = stdout.trim() === 'active';
    } catch { /* ignore */ }
  } else if (installed && plan.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['list'], { encoding: 'utf8', timeout: 3000 });
      active = stdout.includes(plan.service_id);
    } catch { /* ignore */ }
  }
  return { ...plan, installed, active };
}

export async function installAutostart({ confirmed = false, force = false, ...opts } = {}) {
  const status = await getAutostartStatus(opts);
  if (confirmed !== true) {
    return {
      mode: 'dry_run',
      applied: false,
      already_installed: status.installed,
      plan: status,
      hint: 'Pass confirmed: true (or `--confirm`) to install OS user-level autostart.',
    };
  }

  if (status.platform === 'win32') {
    if (status.installed && !force) {
      return {
        mode: 'preserved_existing',
        applied: false,
        already_installed: true,
        plan: status,
        message: `Existing Windows Scheduled Task "${status.service_id}" preserved (pass force: true to replace).`,
      };
    }
    const args = force ? [...status.command_args, '/F'] : status.command_args;
    await execFileAsync('schtasks.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return { mode: 'applied', applied: true, plan: await getAutostartStatus(opts) };
  }

  if (status.log_dir) fs.mkdirSync(status.log_dir, { recursive: true });
  fs.mkdirSync(path.dirname(status.file_path), { recursive: true });
  if (fs.existsSync(status.file_path) && !force) {
    fs.copyFileSync(status.file_path, `${status.file_path}.bak.${Date.now()}`);
  }
  fs.writeFileSync(status.file_path, status.content, 'utf8');

  const warnings = [];
  if (status.platform === 'darwin') {
    await execFileAsync('launchctl', ['unload', status.file_path], { timeout: 3000 }).catch(() => {});
    try {
      await execFileAsync('launchctl', ['load', '-w', status.file_path], { timeout: 4000 });
    } catch (err) {
      warnings.push(`launchctl load failed: ${err.message || err}`);
    }
  } else if (status.platform === 'linux') {
    try {
      await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 3000 });
      await execFileAsync('systemctl', ['--user', 'enable', '--now', status.service_id], { timeout: 4000 });
    } catch (err) {
      warnings.push(`systemctl enable failed: ${err.message || err}`);
    }
  }

  return {
    mode: 'applied',
    applied: true,
    ...(warnings.length ? { activation_warning: warnings.join('; ') } : {}),
    plan: await getAutostartStatus(opts),
  };
}

export async function removeAutostart({ confirmed = false, ...opts } = {}) {
  const status = await getAutostartStatus(opts);
  if (confirmed !== true) {
    return { mode: 'dry_run', removed: false, plan: status };
  }
  if (status.platform === 'win32') {
    await execFileAsync('schtasks.exe', ['/Delete', '/TN', status.service_id, '/F'], { timeout: 4000, windowsHide: true }).catch(() => {});
    return { mode: 'removed', removed: true, service_id: status.service_id };
  }
  if (status.platform === 'darwin' && status.file_path) {
    await execFileAsync('launchctl', ['unload', status.file_path], { timeout: 3000 }).catch(() => {});
  } else if (status.platform === 'linux') {
    await execFileAsync('systemctl', ['--user', 'disable', '--now', status.service_id], { timeout: 3000 }).catch(() => {});
  }
  if (status.file_path && fs.existsSync(status.file_path)) {
    fs.unlinkSync(status.file_path);
  }
  return { mode: 'removed', removed: true, file_path: status.file_path };
}
