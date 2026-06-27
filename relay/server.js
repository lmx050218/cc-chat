const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

// ── 配置 ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 17389;
const TOKEN = process.env.CC_TOKEN;
if (!TOKEN) {
  console.error('❌ 请设置 CC_TOKEN');
  process.exit(1);
}

// ── HTTP / Express ────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

function roomId(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exclude = null) {
  if (room.agent && room.agent !== exclude) send(room.agent, obj);
  for (const c of room.clients) {
    if (c !== exclude) send(c, obj);
  }
}

const rooms = new Map();

wss.on('connection', (ws) => {
  let room = null;
  let role = null;
  let authed = false;
  let pingTimer = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'auth') {
      if (msg.token !== TOKEN) {
        send(ws, { type: 'error', message: 'Token 无效' });
        ws.close(4001);
        return;
      }
      role = msg.role;
      if (role !== 'agent' && role !== 'client') {
        send(ws, { type: 'error', message: 'role 必须是 agent 或 client' });
        ws.close(4002);
        return;
      }

      const rid = roomId(msg.token);
      if (!rooms.has(rid)) rooms.set(rid, { agent: null, clients: new Set() });
      room = rooms.get(rid);

      if (role === 'agent') {
        if (room.agent) {
          // 踢掉旧 agent，让新的接管
          try { room.agent.close(4000, 'new agent'); } catch {}
        }
        room.agent = ws;
        // 通知所有 client：agent 上线
        for (const c of room.clients) send(c, { type: 'agent_online' });
      } else {
        room.clients.add(ws);
      }

      // 先发 authed，确保 client 端 authed 标志就绪
      authed = true;
      send(ws, { type: 'authed', room: rid, role });
      // 再发 agent_online，client 收到后可正常发 get_sessions
      if (room.agent) send(ws, { type: 'agent_online' });

      // 心跳
      pingTimer = setInterval(() => send(ws, { type: 'ping' }), 25000);
      return;
    }

    if (!authed || !room) return;
    if (msg.type === 'pong') return;

    // ── 消息路由 ──────────────────────────────────
    // sessionId 携带在每条消息中，用于多会话路由
    if (role === 'agent') {
      // agent → 所有 clients (广播)
      for (const c of room.clients) send(c, msg);
    } else {
      // client → agent (转发)
      if (room.agent) send(room.agent, msg);
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    if (!room || !role) return;

    if (role === 'agent') {
      room.agent = null;
      for (const c of room.clients) send(c, { type: 'agent_offline' });
    } else {
      room.clients.delete(ws);
    }

    if (!room.agent && room.clients.size === 0) {
      rooms.delete(roomId(TOKEN));
    }
  });

  ws.on('error', () => {});
});

// ── 健康检查 ─────────────────────────────────────────
app.get('/health', (_req, res) => {
  const rid = roomId(TOKEN);
  const room = rooms.get(rid);
  res.json({ ok: true, agent: !!room?.agent, clients: room?.clients.size ?? 0 });
});

// ── 启动 ─────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔗 relay 启动 → http://0.0.0.0:${PORT}`);
});
