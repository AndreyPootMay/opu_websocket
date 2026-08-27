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

// Self keep-warm: en Render free tier el servicio se duerme tras ~15 min sin
// tráfico HTTP. Mientras este proceso esté vivo, golpea su propia URL pública
// cada KEEP_WARM_INTERVAL_MS para que Render lo vea activo y no lo duerma.
//
// Cuando corre en Render, RENDER_EXTERNAL_URL viene inyectada automáticamente.
// En cualquier otro host, se puede forzar con KEEP_WARM_URL.
const KEEP_WARM_URL = (
  process.env.KEEP_WARM_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
).replace(/\/$/, '');
const KEEP_WARM_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.KEEP_WARM_INTERVAL_MS || '300000', 10), // 5 min default
);

const app = express();
app.disable('x-powered-by');
app.disable('etag');                  // /ping y /health son triviales — etag no aporta y consume CPU al boot
app.set('trust proxy', true);         // detrás del LB de Render: que socket.io vea la IP real del cliente
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

// ─── Liveness / health ───────────────────────────────────────────────────
// /ping — mínimo absoluto. No parsea JSON, devuelve text/plain. Pensado
// para que monitores externos (UptimeRobot, cron-job.org, etc.) lo golpeen
// con HEAD muy frecuentemente sin gastar CPU. También lo usa el self
// keep-warm de abajo.
app.get('/ping', (_req, res) => {
  res.type('text/plain').send('pong');
});
app.head('/ping', (_req, res) => {
  res.status(200).end();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sockets: io.engine.clientsCount,
    uptime_s: Math.round(process.uptime()),
    keep_warm: KEEP_WARM_URL ? { enabled: true, target: `${KEEP_WARM_URL}/ping`, interval_ms: KEEP_WARM_INTERVAL_MS } : { enabled: false },
  });
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

    // Deliver to every room the router computed from THIS validated payload
    // (deliveryman + customer + subsidiary + order, each independently scoped
    // by its own id field inside rooms.js) — not just the required identity's
    // room. The only thing "private" gates is the fallback below: a private
    // event NEVER falls through to `io.emit('global:...')`, so a malformed
    // payload can't leak to every connected socket. A validly-populated
    // payload reaching multiple legitimately-scoped rooms is not a leak.
    const targetRooms = roomsForEvent(event, payload);
    for (const room of targetRooms) {
      io.to(room).emit(event, payload);
    }

    return res.json({
      ok: true,
      event,
      rooms: targetRooms,
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

// ─── Self keep-warm ──────────────────────────────────────────────────────
// Render free tier duerme el contenedor tras ~15 min sin tráfico HTTP. Este
// loop hace HEAD a la URL pública del propio servicio para que Render lo
// vea activo. NO sirve si el contenedor ya está dormido (no hay proceso que
// haga el ping) — para esos casos usar además un monitor externo gratuito
// como cron-job.org o UptimeRobot que apunte a /ping.
function startKeepWarm() {
  if (!KEEP_WARM_URL) {
    console.log('[keep-warm] disabled (set RENDER_EXTERNAL_URL o KEEP_WARM_URL para activarlo)');
    return;
  }
  if (typeof fetch !== 'function') {
    console.warn('[keep-warm] global fetch no disponible — se requiere Node ≥18');
    return;
  }

  const target = `${KEEP_WARM_URL}/ping`;
  const tick = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(target, { method: 'HEAD', signal: ctrl.signal });
      if (DEBUG) console.log(`[keep-warm] ${target} → ${res.status}`);
    } catch (err) {
      if (DEBUG) console.warn(`[keep-warm] ping falló: ${err && err.message}`);
    } finally {
      clearTimeout(t);
    }
  };

  // Jitter para no sincronizar con otros instancias / deploys.
  const jitter = Math.floor(Math.random() * 30_000);
  setTimeout(() => {
    tick();
    setInterval(tick, KEEP_WARM_INTERVAL_MS).unref();
  }, jitter).unref();

  console.log(
    `[keep-warm] enabled — HEAD ${target} cada ${Math.round(KEEP_WARM_INTERVAL_MS / 1000)}s ` +
    `(primer tick en ${Math.round(jitter / 1000)}s)`,
  );
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`opu-websocket-server listening on :${PORT} (debug=${DEBUG ? 'on' : 'off'})`);
  startKeepWarm();
});
