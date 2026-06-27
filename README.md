# cc-chat — Claude Code 远程访问中转

```
Windows/Mac 本机 (Agent) ──WSS──▶ Linux 服务器 (Relay Docker) ◀──WSS── 浏览器
```

通过 WebSocket 中继，将本地运行的 Claude Code CLI 转发到 Web 界面，支持多会话管理、文件上传、移动端访问。

## 快速开始

### 1. 生成 Token

```bash
openssl rand -hex 32
```

### 2. 部署 Relay（服务器）

```bash
mkdir cc-chat && cd cc-chat
```

下载 `compose.yaml` 和 `.env`：

```bash
curl -O https://raw.githubusercontent.com/lmx050218/cc-chat/main/compose.yaml
echo "CC_TOKEN=你的Token" > .env
```

启动：

```bash
docker compose up -d
```

镜像 `dexbug/cc-chat:v1.0` 会自动从 Docker Hub 拉取，无需本地构建。

> 如需本地构建，可 clone 仓库后执行 `docker compose up -d --build`。

### 3. 配置 Nginx 反代（可选，推荐）

```nginx
server {
    listen 443 ssl http2;
    server_name cc.你的域名.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:17389;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

无域名时可直接用 `http://服务器IP:17389` 访问。

### 4. 启动 Agent（本机）

Agent 运行在你的本地电脑上，负责启动 Claude Code CLI 并转发到 Relay。

**Windows 双击 `start.cmd`** 或手动：

```bash
cd agent
npm install
```

```powershell
# PowerShell
$env:CC_TOKEN = "你的Token"
$env:CC_RELAY = "wss://你的域名/ws"   # 无域名用 ws://服务器IP:17389/ws
node agent.js
```

```bash
# Linux / macOS
CC_TOKEN=你的Token CC_RELAY=wss://你的域名/ws node agent.js
```

Agent 会自动检测 VS Code 扩展目录中的 `claude` CLI。也可以通过 `CC_CMD` 环境变量指定路径。

### 5. 访问

浏览器打开你的域名（或 `http://服务器IP:17389`），输入 Token 即可使用。

## 功能

| 功能 | 说明 |
|------|------|
| **多会话** | 新建多个 Claude Code 窗口，侧栏切换 |
| **输入栏** | 底部文本输入框，Enter 发送，Shift+Enter 换行 |
| **文件上传** | 📎 按钮选择文件，文件名以 `@filename` 格式插入输入框 |
| **历史同步** | 进入任一会话自动加载完整聊天历史 |
| **断线重连** | Agent 指数退避重连，上线后 Web 自动恢复 |
| **状态保活** | 每 30s 检查 Agent 状态，实时显示在线/离线 |
| **移动端** | 侧栏可折叠，输入框自适应 |
| **自动应答** | Agent 自动处理 CC 启动时的信任目录、主题选择等交互提示 |

## 项目结构

```
cc-chat/
├── compose.yaml          # Docker Compose（直接拉取镜像部署）
├── Dockerfile            # 本地构建用
├── .env.example          # 环境变量模板
├── start.cmd             # Windows 本机一键启动 Agent
├── relay/                # Relay 服务端
│   ├── server.js         # WebSocket 中继 + 静态文件服务
│   ├── package.json
│   └── public/
│       └── index.html    # Web 前端
└── agent/                # Agent 客户端（本机运行）
    ├── agent.js          # 多会话 PTY 管理器
    └── package.json
```

## 环境变量

| 变量 | 位置 | 必填 | 说明 |
|------|------|------|------|
| `CC_TOKEN` | 全部 | ✅ | 预共享密钥，Relay 和 Agent 必须一致 |
| `CC_RELAY` | Agent | ✅ | Relay 的 WebSocket 地址，如 `wss://域名/ws` |
| `CC_CMD` | Agent | ❌ | Claude CLI 路径，默认自动检测 VS Code 扩展 |
| `PORT` | Relay | ❌ | 监听端口，默认 `17389` |
| `ANTHROPIC_BASE_URL` | Agent | ❌ | 自定义 API 端点 |
| `ANTHROPIC_AUTH_TOKEN` | Agent | ❌ | API 认证 Token |

## 工作原理

```
浏览器 (xterm.js)
  ↕ WebSocket
Relay 服务器 (消息中转，Docker)
  ↕ WebSocket
Agent (node-pty，本机运行)
  ↕ stdin/stdout
Claude Code CLI
```

- **Relay** 是纯消息中转，不做任何处理
- **Agent** 在本机通过 node-pty 启动 Claude Code CLI，用 xterm/headless 解析终端屏幕
- **前端** 用 xterm.js 渲染终端，通过 WebSocket 双向传输原始字节

## License

MIT
