# CollabHub · 零依赖本地多 Agent 协作与自治工程工作台

[![CI](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/mortal7520/collab-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[English README](./README.md) · [安全架构](./SECURITY.md) · [贡献指南](./CONTRIBUTING.md) · [更新日志](./CHANGELOG.md)

**CollabHub** 是一个**零第三方 npm 运行依赖（纯 Node.js + 原生 `node:sqlite` FTS5）**、面向真实日常开发的本地优先多 Agent 编排工作台。

它支持把 **本地 CLI Agent**（Gemini CLI / Aider / OpenCode / Qwen）、**本地或云端 OpenAI 兼容模型**（Ollama / LM Studio / vLLM / DeepSeek / OpenRouter）以及 **桌面原生客户端**（Claude / Codex / Cursor / Antigravity）统一纳入同一套可审计账本、**32 个 MCP 工具**、**账本+看板双视图驾驶舱**与**隔离 Git Worktree 测试验收闭环**。

---

## 核心特性

1. **无限扩展任意 Agent + 一键自动发现**
   - 内置 3 种即插即用驱动：`openai-http`（**禁止存明文 `api_key`**，仅读环境变量 `api_key_env`，遇 429 自动按通道冷却）、`generic-cli`（强制无 Shell 直启 `shell: false`）、`desktop-native`。
   - `collab-hub discover` / 驾驶舱一键扫描本机运行中的 Ollama / LM Studio / vLLM 模型、已安装的外部 CLI 与云端 API Key 环境变量布尔就绪态（绝不读取或暴露密钥值）。
2. **账本 + 4 列看板双视图驾驶舱 (`http://127.0.0.1:5290`)**
   - 实时 **SSE 事件推送** + 30 秒只读自动巡检，任务状态变化即刻同步；支持 **📋 账本列表** 与 **🗂️ 4 列看板（排队 → 执行中 → 需关注 → 已结束）** 一键切换。
   - 内置 **🔀 可视化多阶段 DAG 编排器**、**4 套实战 Playbook**（`code-review-squad`、`research-and-pack`、`adversarial-debate`、`multi-agent-build`）、**6 套可复用 Prompt 配方**、**富文本 Markdown 报告预览**、**实时审计事件流** 与 **8 项系统体检 + `VACUUM INTO` 热备份**。
3. **Git Worktree 并发隔离 + `.worktreeinclude` 自动同步 + 闭环测试门控**
   - 创建隔离分支时自动安全同步 `.worktreeinclude` 中声明的本地配置文件（如 `.env.local`），严格拦截路径穿越与符号链接逃逸。
   - 合并前支持一键执行白名单测试验收（`collab_worktree_verify`：`auto` / `node-test` / `npm-test` / `pytest` / `cargo-test` / `go-test`，无 Shell 注入），并强制校验 `reviewed_head_sha` 未被篡改及 `confirmed: true`。
4. **遥测感知智能路由（`member="auto"` & `auto_fallback`）**
   - 自动统计各 Agent 历史成功率、平均耗时与 Token 消耗；支持派发前自动降级路由，同时严守“已发出的不确定任务绝不重复发送”原则。
5. **32 个统一 MCP 工具 + 可选开源工程工具链**
   - 一次接入 Claude / Codex / Cursor / Antigravity；可选挂载 `mcp_agent_mail_rust`、`cass`、`ast-grep`、`repomix`、`markitdown`、`beads` 组成完整工程工具箱。

---

## 30 秒快速上手

环境要求：Node.js `>= 22.13.0` 与 `git`（Windows / macOS / Linux 通用，无需 `npm install`）。

```bash
git clone https://github.com/mortal7520/collab-hub.git
cd collab-hub

# 运行零依赖完整测试套件（24 项单元 + 对抗安全测试）
npm test

# 启动交互式 Web 工作台 (http://127.0.0.1:5290)
npm start
```

### 常用 CLI 命令

```bash
# 系统 8 项体检 + 热备份 hub.db
node bin/collab-hub.mjs doctor --backup

# 自动发现本机 Ollama / LM Studio / CLI / 环境变量
node bin/collab-hub.mjs discover

# 查看各 Agent 成功率、平均耗时与 Token 遥测
node bin/collab-hub.mjs metrics

# 导出批次 Markdown 汇总报告
node bin/collab-hub.mjs export-batch <batch_id>

# 启动 32 工具 MCP stdio 服务
node bin/collab-hub.mjs mcp
```

---

## 配置与跨平台迁移

默认运行目录为 `~/.collab-hub`，工作区为 `process.cwd()`。可通过环境变量或在仓库根目录放置被 `.gitignore` 忽略的 `.collab-hub.local.json` 自定义（可选高级原生桥接参数放在 `<APP_ROOT>/data/integrations.json`，绝不进入 Git 仓库）：

- `COLLAB_HUB_APP_ROOT`：数据、Worktree、备份与日志目录
- `COLLAB_HUB_WORKSPACE_ROOT`：允许操作的工作区根目录
- `COLLAB_HUB_PORT`：驾驶舱监听端口（默认 `5290`，严格绑定 `127.0.0.1`）

---

## 开源协议

[MIT](./LICENSE) © 2026 Mortal
