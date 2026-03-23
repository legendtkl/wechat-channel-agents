# WeChat Channel Agents

微信 bot 桥接服务，在同一个微信 bot 中同时支持 **Claude Code** 和 **Codex** 两个 AI agent，用户可通过命令实时切换。

<p align="center">
  <img src="docs/demo.png" width="320" alt="Demo screenshot" />
</p>

## 功能特性

- **双 Agent 支持** — 同一个微信 bot 同时接入 Claude Code（Anthropic）和 Codex（OpenAI）
- **实时切换** — 发送 `/claude` 或 `/codex` 即可切换 agent，切换时保留另一端的会话状态
- **会话持久化** — 每个用户独立维护双 agent session，重启后可恢复
- **安全防护** — 内置危险命令拦截（rm -rf、sudo 等），支持用户白名单
- **媒体支持** — 支持图片、文件、视频的上传下载（CDN 加解密）
- **长文分片** — 自动将超长回复按 4000 字符分片发送

## 快速开始

### 前置条件

- Node.js >= 22
- 微信账号（需 >= 8.0.50 版本，支持 iLink Bot）
- Claude Code 服务端（ANTHROPIC_BASE_URL）
- Codex 配置（~/.codex/config.toml）

### 安装

```bash
git clone https://github.com/anthropics/wechat-channel-agents.git
cd wechat-channel-agents
npm install
```

### 配置

1. 复制配置模板：

```bash
cp config.example.json config.json
cp .env.example .env
```

2. 编辑 `.env`，填入 Claude Code 凭证：

```bash
ANTHROPIC_BASE_URL=http://your-server:13654/
ANTHROPIC_AUTH_TOKEN=sk-xxx
```

3. 按需修改 `config.json`：

```json
{
  "defaultAgent": "claude",
  "wechat": {
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "botType": "3"
  },
  "codex": {
    "sandboxMode": "danger-full-access",
    "workingDirectory": "/path/to/your/project"
  },
  "stateDir": "~/.wechat-agents",
  "allowedUsers": [],
  "adminUsers": ["your_wechat_user_id"],
  "logLevel": "INFO"
}
```

### 启动

```bash
npm run dev
```

终端会显示二维码，用微信扫码登录。登录成功后即可在微信中与 bot 对话。

## 使用方式

| 命令 | 说明 |
|------|------|
| `/claude` | 切换到 Claude Code |
| `/codex` | 切换到 Codex |
| `/reset` | 重置当前 agent 会话 |
| `/status` | 查看当前 agent 类型和会话信息 |
| `/help` | 显示所有可用命令 |
| `/cwd <path>` | 修改工作目录 |
| `/logout` | 管理员登出 bot，清除本地凭证并停止服务 |
| 普通文本 | 发送给当前 agent 处理 |

默认使用 Claude Code。切换 agent 时，另一端的会话不会丢失，可随时切回继续。
`/logout` 仅对 `adminUsers` 中的用户生效；`adminUsers` 需要单独配置，不会从 `allowedUsers` 继承。如果未配置 `adminUsers`，该命令会被禁用。
Codex 默认以 `danger-full-access` 运行，避免某些 Linux 环境下 `bwrap` 兼容性问题；如需更严格的隔离，可在 `codex.sandboxMode` 中覆盖。

## 项目结构

```
src/
  index.ts                  # 入口
  config.ts                 # 配置加载
  types.ts                  # 类型定义

  agent/
    interface.ts            # AgentBackend 统一接口
    registry.ts             # Agent 注册工厂
    claude/backend.ts       # Claude Code 后端
    claude/hooks.ts         # 安全 hooks
    codex/backend.ts        # Codex 后端 (per-user thread)

  wechat/                   # 微信 API 层
    api.ts, login.ts, monitor.ts, send.ts, send-media.ts
    types.ts, context-token.ts, config-cache.ts, session-guard.ts

  bridge/
    dispatcher.ts           # 命令解析 + agent 路由
    formatter.ts            # 响应格式化
    chunker.ts              # 文本分片

  auth/allowlist.ts         # 用户白名单
  cdn/                      # CDN 加解密
  media/                    # 媒体下载
  storage/                  # 持久化存储
  util/                     # 日志、随机数、脱敏
```

## 架构设计

```
用户发送微信消息
  → monitor: long-poll 获取消息
  → dispatcher: 解析命令 / 路由到 agent
    → /claude, /codex: 切换 agent
    → 普通消息: agent.run() → 格式化 → 分片 → 发送
```

核心设计：**Agent 抽象层 + 策略模式**。`AgentBackend` 接口统一了 Claude 和 Codex 的调用方式，Dispatcher 根据用户当前选择路由消息。每个用户的 session 同时保存 `claudeSessionId` 和 `codexThreadId`，切换时不丢失会话。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 运行测试
npm run build       # 编译
```

## 许可

MIT

---

[English Version](README_EN.md)
