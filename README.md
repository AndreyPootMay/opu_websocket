# opu-websocket-server

Tiny Node.js relay that sits between the Yii2 backend and the realtime
clients (the `deliveryman_opu` driver app, the customer app, back-office
dashboards). Yii2 controllers already POST event payloads to
`{WEBSOCKET_URL}/opu/<event-name>` — this service receives those POSTs and
re-emits them over Socket.IO to the right rooms.

## Architecture

```
 ┌──────────────────┐   POST /opu/<event>      ┌──────────────────────┐
 │  Yii2 backend    │ ───────────────────────▶ │ opu-websocket-server │
 │ (api/apipartners│                          │  (this project)      │
 │  /admin/web)     │                          └──────────┬───────────┘
 └──────────────────┘                                     │ Socket.IO emit
                                                          ▼
                                ┌─────────────────────────────────────────┐
                                │ deliveryman_opu APK / customer / admin  │
                                │ subscribed to deliveryman:<id>, etc.    │
                                └─────────────────────────────────────────┘
```

Routing rules live in `src/rooms.js` — every event the Yii2 controllers
fire is mapped to one or more rooms keyed by `deliveryman_auth_id`,
`customer_auth_id`, `subsidiary_id`, the order UUID, or a support ticket
id. Clients pick which rooms to join when they connect.

## Run locally

```bash
cd websocket-server
cp .env.example .env
npm install
npm run dev   # node --watch
```

The server binds `0.0.0.0:4000` by default.

Quick smoke-test:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/opu                        # list known events
curl -X POST http://localhost:4000/opu/order-assigned-to-deliveryman \
  -H 'Content-Type: application/json' \
  -d '{"deliveryman_auth_id":42,"buy_order_id":1,"buy_order_uuid":"abc"}'
```

## Wire it to Yii2

In `.env` of the Yii2 root, point `WEBSOCKET_URL` at this server:

```
WEBSOCKET_URL="http://localhost:4000"
# Or in prod:
# WEBSOCKET_URL="https://socket.opu.mx"
```

The controllers already do
`$websocketClient->post("{$websocketUrl}/opu/<event>", ['json' => $payload])`.

## Wire it to deliveryman_opu

`deliveryman_opu/lib/socket.js` reads `NEXT_PUBLIC_WS_URL`. Set it in
`deliveryman_opu/.env` and `deliveryman_opu/.env.production`:

```
NEXT_PUBLIC_WS_URL=http://localhost:4000
# prod:
# NEXT_PUBLIC_WS_URL=https://socket.opu.mx
```

The Capacitor APK reads the same variable at build time, so `cap:build`
must be re-run whenever the URL changes.

## Deploy

It's a stateless single-process server; Render / Fly / Railway / a single
PM2 worker behind nginx all work. If you put it behind nginx, allow the
WebSocket upgrade:

```nginx
location / {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade    $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host       $host;
  proxy_set_header X-Real-IP  $remote_addr;
  proxy_read_timeout 3600s;
}
```

A `Dockerfile` is included for container deploys.

## Adding a new event

1. The Yii2 controller POSTs to `{$websocketUrl}/opu/my-new-event` with
   the payload it already constructs.
2. Add an entry to `EVENT_ROUTES` in `src/rooms.js` mapping that name to
   the rooms the payload should reach.
3. Subscribe to it in the relevant client (`deliveryman_opu/lib/socket.js`
   or wherever).

If you skip step 2, the relay still emits the event globally as
`global:my-new-event`, so admin dashboards see it — but identity-scoped
clients won't.
