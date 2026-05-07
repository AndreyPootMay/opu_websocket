'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const {
  roomsForEvent,
  ROOM,
  EVENT_ROUTES,
  isPrivateEvent,
  privateEventIdentityField,
} = require('./rooms');

const PORT = parseInt(process.env.PORT || '4000', 10);
const DEBUG = process.env.DEBUG_EVENTS === '1';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(cors({ origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS, credentials: false },
  // Capacitor's WebView falls back to long-polling when WS is blocked; keep
  // both transports enabled so the APK works even on flaky carrier networks.
  transports: ['websocket', 'polling'],
});

// ─── Connection lifecycle ────────────────────────────────────────────────
io.on('connection', (socket) => {
  if (DEBUG) console.log(`[ws] connect ${socket.id}`);

  // Identity is provided either via auth handshake (preferred) or via an
  // explicit "subscribe" message after connect. Both shapes are accepted.
  const auth = socket.handshake.auth || {};
  joinFromIdentity(socket, auth);

  socket.on('subscribe', (payload) => joinFromIdentity(socket, payload || {}));
  socket.on('unsubscribe', (payload) => leaveFromIdentity(socket, payload || {}));

  socket.on('disconnect', (reason) => {
    if (DEBUG) console.log(`[ws] disconnect ${socket.id} reason=${reason}`);
  });
});

function joinFromIdentity(socket, identity) {
  const joined = [];
  if (identity.deliveryman_auth_id) {
    const r = ROOM.deliveryman(identity.deliveryman_auth_id);
    socket.join(r); joined.push(r);
  }
  if (identity.customer_auth_id) {
    const r = ROOM.customer(identity.customer_auth_id);
    socket.join(r); joined.push(r);
  }
  if (identity.subsidiary_id) {
    const r = ROOM.subsidiary(identity.subsidiary_id);
    socket.join(r); joined.push(r);
  }
  if (identity.partner_auth_id) {
    const r = ROOM.partner(identity.partner_auth_id);
    socket.join(r); joined.push(r);
  }
  if (Array.isArray(identity.order_uuids)) {
    for (const uuid of identity.order_uuids) {
      const r = ROOM.order(uuid);
      socket.join(r); joined.push(r);
    }
  }
  if (Array.isArray(identity.support_ticket_ids)) {
    for (const id of identity.support_ticket_ids) {
      const r = ROOM.supportTicket(id);
      socket.join(r); joined.push(r);
    }
  }
  if (joined.length) {
    socket.emit('subscribed', { rooms: joined });
    if (DEBUG) console.log(`[ws] ${socket.id} joined`, joined);
  }
}

function leaveFromIdentity(socket, identity) {
  const left = [];
  // socket.rooms is a Set in Socket.IO v4, and we mutate it via socket.leave —
  // snapshot first so the iterator doesn't trip over the mutation.
  for (const room of [...socket.rooms]) {
    if (room === socket.id) continue;
    if (identity.all || matchesIdentity(room, identity)) {
      socket.leave(room); left.push(room);
    }
  }
  if (left.length) socket.emit('unsubscribed', { rooms: left });
}

function matchesIdentity(roomName, identity) {
  if (identity.deliveryman_auth_id && roomName === ROOM.deliveryman(identity.deliveryman_auth_id)) return true;
  if (identity.customer_auth_id && roomName === ROOM.customer(identity.customer_auth_id)) return true;
  if (identity.subsidiary_id && roomName === ROOM.subsidiary(identity.subsidiary_id)) return true;
  if (identity.partner_auth_id && roomName === ROOM.partner(identity.partner_auth_id)) return true;
  return false;
}

// ─── Health check ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, sockets: io.engine.clientsCount });
});

// ─── Webhook endpoints ───────────────────────────────────────────────────
// Catch-all under /opu/* — controllers can post to any event name without
// requiring a server-side change. Routing rules in rooms.js decide who
// hears each event; unknown events are still emitted to a global topic so
// admin dashboards can subscribe to "everything" if they want.
app.post('/opu/:event', (req, res) => {
  const event = req.params.event;
  const payload = req.body || {};

  if (DEBUG) console.log(`[webhook] /opu/${event}`, JSON.stringify(payload));

  // Private events MUST carry the identity field they claim to target.
  // Without it we can't know which room is correct, and globalizing would
  // leak personal data to every connected client.
  if (isPrivateEvent(event)) {
    const idField = privateEventIdentityField(event);
    const idValue = payload[idField];
    if (!idValue) {
      if (DEBUG) console.warn(`[webhook] rejected private event '${event}' — missing ${idField}`);
      return res.status(400).json({
        ok: false,
        error: `private event '${event}' requires '${idField}' in payload`,
      });
    }

    const targetRooms = roomsForEvent(event, payload);
    const scopedRoom = ROOM[idField === 'deliveryman_auth_id' ? 'deliveryman'
      : idField === 'customer_auth_id' ? 'customer'
      : idField === 'subsidiary_id' ? 'subsidiary'
      : 'partner'](idValue);

    // Defense-in-depth: even if the routing table somehow widens, the
    // emit list is filtered to rooms scoped to *this* recipient's identity.
    const safeRooms = targetRooms.filter((r) => r === scopedRoom);
    for (const room of safeRooms) {
      io.to(room).emit(event, payload);
    }

    return res.json({
      ok: true,
      event,
      rooms: safeRooms,
      knownEvent: !!EVENT_ROUTES[event],
      private: true,
    });
  }

  const targetRooms = roomsForEvent(event, payload);
  for (const room of targetRooms) {
    io.to(room).emit(event, payload);
  }

  // Public events are also fanned out to any client subscribed to the
  // global topic — useful for admin/observer dashboards. Private events
  // never reach this path.
  io.emit(`global:${event}`, payload);

  res.json({ ok: true, event, rooms: targetRooms, knownEvent: !!EVENT_ROUTES[event] });
});

// Convenience: list the events this server understands. Handy for ops.
app.get('/opu', (_req, res) => {
  res.json({ events: Object.keys(EVENT_ROUTES) });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`opu-websocket-server listening on :${PORT} (debug=${DEBUG ? 'on' : 'off'})`);
});
