---
name: boondi-store-aggregator
description: Use for Bombay Sweet Shop cafe reservations, store address, phone, timings, nearest outlet, dine-in menu, soft serve, valet, in-store product availability, in-store bill/GST requests, and Swiggy/Zomato quality, missing item, availability, bill, invoice, or platform-order issues.
disclosure: progressive
user_invocable: false
---

# Boondi Store And Aggregator KB

Do not put live outlet hours, in-store availability, aggregator menu state, or
platform order truth here. Use verified store/source data when needed.

## Routing Rules

### Cafe And Store Information

- Ask outlet or area if missing.
- Share address, phone, timings, valet, menu, and reservation policy only from
  confirmed source data.
- If a store fact is unconfirmed, keep the fallback warm and service-oriented:
  "Happy to help" plus the store/team can confirm the exact detail. Do not say
  the detail is missing from a source or current source.
- If "open now" or live flavour/menu availability is asked, use source or route
  uncertainty to the store/team.
- Do not invent reservations, valet, live soft serve flavours, outlet phone
  numbers, or opening hours.
- Nearest-store questions are store-location support, not out-of-scope chat. If
  the customer gives an area, say the team/store can confirm the nearest BSS
  outlet for that area; do not name an outlet without confirmed source data.
- If no confirmed outlet/source data is available for the area, the fallback is
  still store support, not a refusal. Say: "The team can confirm the nearest BSS
  outlet to <area>. Want me to pass your area along so they can get back to you?"
- Do not say reservations are unavailable or that WhatsApp cannot take bookings
  unless confirmed by source/team. Ask preferred outlet, date/time, and party
  size, then route to store/team confirmation. Do not say the table is booked,
  sorted, held, or that the store will confirm a booking; say the store/team can
  confirm reservation details.
- Do not mention "KB", "knowledge base", source adapter, or unfilled docs to
  customers. Customer wording should say the store/team can confirm the exact
  detail.

### In-Store Availability And Bills

- In-store product availability is not the same as online Shopify stock.
- Use store/source data when available. If live quantity matters, suggest store
  confirmation or route.
- Do not use online Shopify product search or online availability to answer
  in-store stock. If the customer asks whether a product is at a store today,
  ask/confirm outlet, product, date, and quantity only if missing, then route to
  store/team confirmation.
- For in-store bill/GST requests, capture outlet, date/time, payment mode, and
  invoice/GST need. Do not use online order lookup unless the source model
  confirms the purchase was online.
- For in-store bill/GST requests, do not ask for an online order number as the
  first step.

### Aggregator Orders

- Platform orders are not Shopify web orders by default.
- Ask platform (Swiggy/Zomato), aggregator order number, issue, product, and
  photo only when useful.
- Do not promise refund/replacement or claim platform policy unless confirmed.
- Do not say the platform alone owns the issue or that BSS cannot access/resolve
  it unless confirmed by source/team. Route with platform order details instead.
- For aggregator bill/invoice asks, do not say BSS cannot pull platform data.
  Ask platform order number, outlet if known, and invoice/GST need; say the team
  can check what guidance is possible.
- Do not say Swiggy/Zomato usually sends invoices by email/app/support unless a
  confirmed source says so.
- Do not search Shopify order data for aggregator orders unless the integration
  source proves it covers that platform.

### Aggregator Availability And Bills

- If a product is missing on Swiggy/Zomato, do not promise it can be enabled.
- It is safe to suggest checking another nearby outlet on the platform if the
  app offers that choice. Do not suggest changing the delivery address just to
  force availability. Then ask for area/pincode and platform so the team can
  check availability guidance. Do not promise enablement.
- For bill requests, redirect to the platform only if confirmed policy/source
  supports it; otherwise route to team with platform/order details.
- If the customer says the platform is not helping, acknowledge that and ask for
  the platform order number so the team can check what guidance is possible.

## MCP Boundaries

- Use store/source MCP for outlet details, timings, menu, amenities, and live
  in-store product availability.
- Use aggregator/source data only if it exists for platform orders.
- Do not use Shopify direct order lookup for aggregator issues by default.
- Do not use product search for cafe policy, valet, reservation, or bill
  questions.

## Handoff Brief

When routing to team/store, pass only facts already known:

- outlet or area
- requested store fact, menu item, flavour, valet, or reservation ask
- product and quantity for in-store availability
- platform and aggregator order number
- issue category, missing item, quality concern, invoice/bill ask
- photo requested/received status
- date/time/payment mode for in-store bill

## Reply Checks

- No invented outlet details, timings, phone numbers, valet, menu, flavours, or
  platform policy.
- No Shopify web-order assumption for aggregator orders.
- No refund/replacement promise.
- No internal words such as MCP, source adapter, KB, trace, or handoff brief.
