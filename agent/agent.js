const os = require('os');
const fs = require('fs');
const path = require('path');

// 从项目根目录读取 .env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pty = require('node-pty');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { Terminal: XtermHeadless } = require('@xterm/headless');

// ── 配置 ────────────────────────────────────────────────
const TOKEN = process.env.CC_TOKEN;
const RELAY = process.env.CC_RELAY || 'wss://your-server.com/ws';

if (!TOKEN) {
  console.error('❌ 请设置 CC_TOKEN');
  process.exit(1);
}

// ── 自动寻找 Claude Code CLI ──────────────────────────
function findClaudeBinary() {
  // 用户显式指定优先
  if (process.env.CC_CMD) return process.env.CC_CMD;

  // 扫描 VS Code 扩展目录找最新版 claude.exe
  const extDir = path.join(process.env.USERPROFILE, '.vscode', 'extensions');
  if (fs.existsSync(extDir)) {
    const candidates = [];
    for (const name of fs.readdirSync(extDir)) {
      const m = name.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)-win32-x64$/);
      if (m) {
        const bin = path.join(extDir, name, 'resources', 'native-binary', 'claude.exe');
        if (fs.existsSync(bin)) candidates.push({ ver: m[1], bin });
      }
    }
    candidates.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
    if (candidates.length > 0) {
      console.log(`🔍 自动检测: ${candidates[0].bin} (v${candidates[0].ver})`);
      return candidates[0].bin;
    }
  }

  // 回退到 PATH 中找
  return 'claude';
}

const CC_CMD = findClaudeBinary();

// ── 全局状态 ────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 30000;
let shuttingDown = false;

const sessions = new Map();   // sessionId → { id, name, pty, history: [], createdAt }

// ── 创建会话 ──────────────────────────────────────────
// opts: { name, theme?, permissionMode?, model?, effort? }
function createSession(opts) {
  const name = opts?.name || '未命名';
  const id = uuidv4();
  const createdAt = Date.now();

  console.log(`🐚 新建会话: ${name} (${id.slice(0, 8)})`);

  const isWin = os.platform() === 'win32';

  // ── 构建 CLI 参数，跳过对应交互提示 ──────────────
  const cliArgs = [];
  if (opts.model) cliArgs.push('--model', opts.model);
  if (opts.effort) cliArgs.push('--effort', opts.effort);
  if (opts.permissionMode) cliArgs.push('--permission-mode', opts.permissionMode);
  cliArgs.push('--name', name);

  const fullCmd = [CC_CMD, ...cliArgs];
  const spawnCmd = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
  const spawnArgs = isWin ? ['/c', ...fullCmd] : ['-c', fullCmd.join(' ')];

  console.log(`🚀 启动参数: ${cliArgs.join(' ')}`);

  const term = pty.spawn(spawnCmd, spawnArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.env.HOME || process.env.USERPROFILE || process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    },
  });

  const session = { id, name, opts, term, history: [], createdAt, alive: true };

  // ── 用 xterm/headless 解析终端屏幕文本 ──────────────
  // 直接用正则去 ANSI 会导致文本丢失空格（CC 用 cursor positioning 绘制 UI）
  // xterm.js 可正确解析终端缓冲区，获得带空格的屏幕文本
  const COLS = 120;
  const ROWS = 40;
  const xterm = new XtermHeadless({ cols: COLS, rows: ROWS, allowProposedApi: true });
  let booted = false;
  let currentPrompt = null;  // 跟踪当前提示类型，防止同一提示被重复应答

  function getScreenText() {
    const lines = [];
    const buffer = xterm.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  term.onData((data) => {
    session.history.push({ time: Date.now(), data, dir: 'out' });
    if (session.history.length > 10000) session.history.shift();

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'data', sessionId: id, data }));
    }

    if (booted) return;

    // 将数据写入 xterm.js 解析终端屏幕
    xterm.write(data);
    const screen = getScreenText();

    // ── 状态机：检测并自动应答启动交互提示 ──────────
    // 用 currentPrompt 跟踪当前提示，每个提示只应答一次

    // 1) 信任目录（cc-chat 用户主动远程连接，默认信任）
    if (screen.includes('Quick safety check') && screen.includes('Yes, I trust this folder')) {
      if (currentPrompt !== 'trust') {
        currentPrompt = 'trust';
        term.write('\r\n');
        console.log('📋 自动应答: 信任目录 → Enter');
      }
      return;
    }

    // 2) bypass 模式警告（仅当 --permission-mode bypassPermissions 时出现）
    if (screen.includes('Bypass Permissions mode') && screen.includes('Yes, I accept')) {
      if (currentPrompt !== 'bypass') {
        currentPrompt = 'bypass';
        term.write('2\r\n');
        console.log('📋 自动应答: Bypass Permissions → 2+Enter');
      }
      return;
    }

    // 3) 主题/颜色选择（未通过 CLI 传递时可能出现）
    if (screen.includes('color theme') || screen.includes('Choose your')) {
      if (currentPrompt !== 'theme') {
        currentPrompt = 'theme';
        const choice = matchChoice(screen, opts.theme, 'dark');
        if (choice) {
          term.write(choice + '\r\n');
          console.log(`📋 自动应答: 主题选择 → ${choice}`);
        }
      }
      return;
    }

    // 4) Consumer Terms / Privacy Policy（首次使用时出现，必须接受才能使用）
    if (screen.includes('Consumer Terms') || screen.includes('Privacy Policy')) {
      if (currentPrompt !== 'terms') {
        currentPrompt = 'terms';
        term.write('y\r\n');
        console.log('📋 自动应答: Consumer Terms → y');
      }
      return;
    }

    // 5) auto-updates（不自动更新，避免打断使用）
    if (screen.includes('auto-update') || screen.includes('enable update') || screen.includes('automatic update')) {
      if (currentPrompt !== 'updates') {
        currentPrompt = 'updates';
        term.write('n\r\n');
        console.log('📋 自动应答: auto-updates → n');
      }
      return;
    }

    // 6) 启动完成标志
    if (screen.includes('Claude Code v') && screen.includes('Tips for getting started')) {
      booted = true;
      console.log('✅ CC 启动完成');
    }
  });

  term.onExit(({ exitCode }) => {
    session.alive = false;
    xterm.dispose();
    session.history.push({
      time: Date.now(),
      data: `\r\n[进程退出，exitCode=${exitCode}]\r\n`,
      dir: 'out',
    });
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'session_died', sessionId: id }));
    }
  });

  sessions.set(id, session);
  return session;
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.term) { s.term.kill(); s.alive = false; }
  sessions.delete(id);
  console.log(`💀 会话关闭: ${s.name}`);
  return true;
}

function sendMsg(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ── WebSocket ───────────────────────────────────────────
function connect() {
  if (shuttingDown) return;
  console.log(`🔗 连接 ${RELAY} …`);
  ws = new WebSocket(RELAY);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'agent' }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'authed':
        console.log(`✅ 房间 ${msg.room}`);
        reconnectDelay = 5000;
        if (sessions.size === 0) createSession({ name: '主窗口' });
        sendSessionList();
        break;

      case 'get_sessions':
        sendSessionList();
        break;

      case 'create_session': {
        const opts = {
          name: msg.name || `会话 ${sessions.size + 1}`,
          theme: msg.theme,
          permissionMode: msg.permissionMode,
          model: msg.model,
          effort: msg.effort,
        };
        const s = createSession(opts);
        sendMsg({ type: 'session_created', session: sessionInfo(s) });
        sendSessionList();
        break;
      }

      case 'kill_session':
        if (killSession(msg.sessionId)) {
          sendMsg({ type: 'session_killed', sessionId: msg.sessionId });
          sendSessionList();
        }
        break;

      case 'data': {
        const s = sessions.get(msg.sessionId);
        if (s && s.alive && s.term) {
          s.history.push({ time: Date.now(), data: msg.data, dir: 'in' });
          s.term.write(msg.data);
        }
        break;
      }

      case 'resize': {
        const s = sessions.get(msg.sessionId);
        if (s && s.alive && s.term) {
          s.term.resize(msg.cols, msg.rows);
        }
        break;
      }

      case 'get_history': {
        const s = sessions.get(msg.sessionId);
        if (s) sendMsg({ type: 'history', sessionId: msg.sessionId, history: s.history });
        break;
      }

      case 'ping':
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'error':
        console.error('❌ 服务端:', msg.message);
        break;
    }
  });

  ws.on('close', () => {
    if (shuttingDown) return;
    console.log(`⏳ ${(reconnectDelay / 1000).toFixed(1)}s 后重连…`);
    ws = null;
    reconnectTimer = setTimeout(() => {
      connect();
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
  });

  ws.on('error', () => {});
}

// ── 辅助 ────────────────────────────────────────────────
function sessionInfo(s) {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    alive: s.alive,
    historyLength: s.history.length,
  };
}

// 从 CC 的交互式选择列表中匹配用户的选择
// text: 终端输出文本, prefer: 用户偏好 ('dark'|'light'|undefined), fallback: 默认
function matchChoice(text, prefer, fallback) {
  const target = (prefer || fallback).toLowerCase();

  // 1) 尝试匹配数字编号: "1. Dark ··· 2. Light" → 找 "1" 或 "2"
  const numbered = [...text.matchAll(/(\d+)[.)\s]+([^\d\n]+)/g)];
  for (const m of numbered) {
    const label = m[2].toLowerCase();
    if (label.includes(target) || label.includes(target.slice(0, 2))) {
      return m[1];
    }
  }

  // 2) 尝试匹配括号内的字母键: "(d)ark" "(l)ight" → 返回 "d" 或 "l"
  const lettered = [...text.matchAll(/\((\w)\)\s*(\w+)/gi)];
  for (const m of lettered) {
    const label = (m[2] || '').toLowerCase();
    if (label.includes(target) || label.startsWith(target.slice(0, 1))) {
      return m[1];
    }
  }

  // 3) 回退：直接发送选项关键词
  const maps = {
    dark:  ['1', 'd', 'dark'],
    light: ['2', 'l', 'light'],
  };
  const entries = maps[target];
  if (entries) {
    for (const key of entries) {
      if (text.includes(key)) return key;
    }
  }

  return null;
}

function sendSessionList() {
  const list = [];
  for (const s of sessions.values()) list.push(sessionInfo(s));
  sendMsg({ type: 'sessions', sessions: list });
}

// ── 优雅退出 ────────────────────────────────────────────
function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  console.log('\n👋 退出…');
  for (const [id, s] of sessions) killSession(id);
  if (ws) ws.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

connect();
