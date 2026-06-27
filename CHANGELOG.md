# Changelog

## v1.0 (2026-06-27)

### UI 优化
- 全新 Web 界面，采用 VSCode Claude Code 插件风格
- 底部输入栏：支持 Enter 发送、Shift+Enter 换行、自动增高
- 📎 文件上传按钮，文件名以 `@filename` 格式插入输入框
- 移除多余 tab 栏，终端铺满整个主区域
- 发送按钮 ▶，支持点击发送
- xterm 终端禁用直接键盘输入，统一走输入栏，避免焦点冲突
- 深色主题配色，圆角卡片设计，移动端自适应侧栏

### 状态监控优化
- 修复 Agent 状态永远显示"等待智能体"的 bug（服务端消息顺序错误）
- 认证流程修正：先发送 `authed` 再发送 `agent_online`，确保客户端正确处理
- 新增 30s 周期性状态检查，贯穿 Web 端全生命周期
- 收到 `sessions` 响应时自动确认 Agent 在线状态
- 状态双重显示：侧栏底部 + 顶部 header pill

### 部署
- Docker 镜像 `dexbug/cc-chat:v1.0` 发布到 Docker Hub
- compose.yaml 直接拉取镜像部署，无需本地构建
- GitHub 仓库：https://github.com/lmx050218/cc-chat
