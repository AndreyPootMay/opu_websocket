'use strict';

// Room naming. Every connected client joins one or more of these rooms based
// on the identity it presents at handshake. Yii2 webhook payloads carry the
// same identifiers, so we can look up the right room from the payload alone.
const ROOM = {
  deliveryman: (id) => `deliveryman:${id}`,
  customer:    (id) => `customer:${id}`,
  subsidiary:  (id) => `subsidiary:${id}`,
  partner:     (id) => `partner:${id}`,
  order:       (uuidOrId) => `order:${uuidOrId}`,
  supportTicket: (id) => `support:${id}`,
};

// Map of webhook event name → function that returns the list of rooms the
// payload should be broadcast to. Anything unmapped falls through to the
// generic "broadcast to everyone subscribed to this event name" path.
//
// Keep this exhaustive against the controllers in api/modules/v1/controllers.
// When you add a new $websocketClient->post(...) call site, add the route
// here so the relay knows who should hear it.
const EVENT_ROUTES = {
  // ─── Deliveryman-bound events (the driver app cares about these) ────────
  'order-assigned-to-deliveryman': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
  ],
  'order-reassigned-to-deliveryman': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
  ],
  'new-order': (p) => [
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-in-preparation': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-ready-for-pickup': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-cancelled-by-customer': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-cancelled-by-store': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-cancelled-by-deliveryman': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'cash-payment-confirmed': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],

  // ─── Customer-bound events (mirrored to the order room for back-office) ─
  'order-assignment-accepted': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-assignment-declined': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-accepted-by-deliveryman': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-rejected-by-deliveryman': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'deliveryman-arrived-at-store': (p) => [
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-picked-up': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-picked-up-by-deliveryman': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-on-the-way': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'deliveryman-arrived-at-customer': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'deliveryman-arrival-at-customer': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-delivered': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'order-delivered-to-customer': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'delivery-failed': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'delivery-issue-reported': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'new-delivery-issue': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'new-delivery-contact-log': (p) => [
    p.subsidiary_id && ROOM.subsidiary(p.subsidiary_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'tip-created': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'tip-received': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.buy_order_uuid && ROOM.order(p.buy_order_uuid),
  ],
  'new-customer-support-ticket': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.support_ticket_id && ROOM.supportTicket(p.support_ticket_id),
  ],
  'new-deliveryman-support-ticket': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.support_ticket_id && ROOM.supportTicket(p.support_ticket_id),
  ],
  'new-support-ticket-message': (p) => [
    p.customer_auth_id && ROOM.customer(p.customer_auth_id),
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
    p.support_ticket_id && ROOM.supportTicket(p.support_ticket_id),
  ],

  // Driver flipped their availability toggle. Routed to the driver's own
  // room (for cross-device confirmation) and the per-driver room is the
  // only listener — admin dashboards that want a global "who's online"
  // view should listen for the event name directly via the broadcast path.
  'deliveryman-status-changed': (p) => [
    p.deliveryman_auth_id && ROOM.deliveryman(p.deliveryman_auth_id),
  ],
};

function roomsForEvent(eventName, payload) {
  const router = EVENT_ROUTES[eventName];
  if (!router) return [];
  return router(payload || {}).filter(Boolean);
}

// Events whose payload contains private order/customer data and which must
// only ever land in their identity-scoped room. Never globalized, and the
// relay refuses to emit them at all if the required identity field is
// missing — that prevents a malformed Yii2 webhook from flooding every
// connected driver with a stranger's assignment.
const PRIVATE_EVENTS = {
  'order-assigned-to-deliveryman': 'deliveryman_auth_id',
  'order-reassigned-to-deliveryman': 'deliveryman_auth_id',
  'order-cancelled-by-customer': 'deliveryman_auth_id',
  'order-cancelled-by-store': 'deliveryman_auth_id',
  'order-ready-for-pickup': 'deliveryman_auth_id',
  'order-in-preparation': 'deliveryman_auth_id',
  'cash-payment-confirmed': 'deliveryman_auth_id',
};

function isPrivateEvent(eventName) {
  return Object.prototype.hasOwnProperty.call(PRIVATE_EVENTS, eventName);
}

function privateEventIdentityField(eventName) {
  return PRIVATE_EVENTS[eventName] || null;
}

module.exports = {
  ROOM,
  EVENT_ROUTES,
  roomsForEvent,
  PRIVATE_EVENTS,
  isPrivateEvent,
  privateEventIdentityField,
};
