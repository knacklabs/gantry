# Boondi Intent Scenario Playbook

Status: Draft evaluator. Not injected into live prompts. No row is accepted until
it has signed-webhook evidence, payload evidence, and the actual Boondi reply.

Source inspected: `/Users/caw-d/Downloads/Boondi_Intent_Scenario_Template.xlsx`,
sheet `Template_BA`, header row 4, 59 scenario rows.

## Evidence Rules

- `Static mapped` means this playbook understands the row and expected route.
- `Live passed` requires a signed Interakt webhook run, flow logs, payload shape,
  admin/API transcript, and reviewer decision.
- If code and this playbook disagree, code/runtime evidence wins and this file
  must be corrected.
- Fresh product, order, delivery, discount, stock, invoice, and customer data
  must come from MCP/source systems, not this playbook.

## Fields

| Field | Meaning |
| --- | --- |
| `intentId` | Template_BA intent id. |
| `subflow` | Template_BA scenario/sub-flow. |
| `userIntent` | What the customer is actually trying to do. |
| `expectedDecision` | Route Boondi should choose. |
| `replyIntent` | Customer-visible reply goal. |
| `toolExpectations` | Expected source/tool behavior. |
| `handoffBrief` | Facts to pass if human/team route is needed. |
| `testIntent` | Representative webhook text for live proof. |
| `status` | Static/live verification state. |

## PRE-06 To PRE-09 Gifting Proof Set

| intentId | subflow | userIntent | expectedDecision | replyIntent | toolExpectations | handoffBrief | testIntent | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-06 | Gift rec with occasion + budget | Needs a personal gift shortlist. | Personal gifting under-25 route unless quantity says otherwise. | Ask one missing detail or suggest max 3 options, website-first. | Use Shopify search only if current product/price/stock is needed. | Occasion, budget, recipient, quantity, location/date if known. | Birthday gift for my friend under Rs 500. What should I buy? | Static mapped |
| PRE-06 | Specific occasion: roka / anniversary | Wants occasion-appropriate gifting. | Occasion-led personal route, not corporate by default. | Warm occasion acknowledgement plus one useful next step. | Use product search only for current recommendations. | Occasion, quantity, budget, location/date, customisation. | This is for a roka ceremony. Need something special. | Static mapped |
| PRE-07 | Wedding hampers | Needs event/bulk gifting. | If quantity is 25+, capture bulk brief and route to gifting team. | Acknowledge wedding, collect missing essentials, no firm quote. | Use `get_gifting_context` only when latest order/product data is needed together; otherwise no broad fanout. | Quantity, budget, locations, date, customisation, product preference. | I want 30 wedding hampers for next month in Mumbai. | Static mapped |
| PRE-07 | Baby shower / baby announcement | Needs baby occasion gifts. | Occasion route; quantity decides self-serve vs team. | Warm baby occasion tone, ask quantity/location if missing. | Product search only if shortlist needed and enough budget/context exists. | Quantity, budget, location/date, message/customisation. | Baby announcement gifting, about 40 boxes. | Static mapped |
| PRE-07 | Haldi / other personal ceremony | Small personal ceremony gifting. | Under-25 stays personal/self-serve unless customisation appears. | Warm ceremony tone, website-first, one missing detail. | No MCP unless current products or delivery/source data is needed. | Occasion, quantity, budget, location/date, customisation. | Need 11 boxes for a haldi. | Static mapped |
| PRE-08 | Corporate gifting: 25+ units, quote needed | Needs business/bulk quote. | B2B route. Capture brief and route to gifting team. | Efficient acknowledgement, no exact quote promise. | Avoid broad search. Use aggregate/search only if current product examples are requested. | Company/buyer signal, quantity, budget, cities, date, branding/GST, ask. | Corporate gifting around 100 units. Need prices. | Static mapped |
| PRE-08 | Bulk + GST invoice + logo branding | Needs enterprise/order-commercial support. | Bulk/customisation route; team confirms branding/quote. | Capture GST/branding need, route without promising feasibility. | Do not invent GST process; use source/tool or handoff if process not confirmed. | Quantity, GST need, logo/branding, budget, cities/date. | Need 80 employee gifts with GST invoice and logo branding. | Static mapped |
| PRE-09 | Custom message card | Wants gift note/message. | Self-serve gift-message path if confirmed; otherwise team confirmation. | Explain next step briefly, no custom promise. | Source confirmation needed for checkout route wording. | Message requirement, order/product, quantity, date if known. | I wanted to add a customised message to the gift box. | Static mapped |
| PRE-09 | Branded sleeve / personalised box | Wants custom packaging. | Ask quantity if missing and route feasibility to team. | Clear confirmation that team must check customisation. | No stock/price/custom feasibility without source/team. | Sleeve/box need, quantity, occasion, date/location, branding. | Can I customise a box with our logo? | Static mapped |

## Full Template_BA Coverage Map

| intentId | subflow | expectedDecision | replyIntent | toolExpectations | handoffBrief | status |
| --- | --- | --- | --- | --- | --- | --- |
| PRE-01 | Shelf life of a specific product | Product-care route. Ask product if missing. | Give shelf-life only from current product/source data. | Product/source lookup required if product-specific. | Product, quantity, travel/storage need if unresolved. | Static mapped |
| PRE-01 | Refrigeration needed? | Product-care FAQ route. | Share confirmed storage/travel guidance, keep concise. | No MCP if general confirmed FAQ; source needed for product-specific nuance. | Product and concern if source is missing. | Static mapped |
| PRE-01 | Travel / outstation suitability | Product-care/travel route. | General heat/cooling guidance, ask product for specific answer. | Source lookup for product-specific shelf life. | Product, destination, travel date/mode if needed. | Static mapped |
| PRE-02 | Pincode / city deliverability | Delivery serviceability route. | Ask pincode if missing; confirm only from current source. | Delivery/source lookup required. | Pincode, city, products, required date if unserviceable. | Static mapped |
| PRE-02 | Delivery timeline / ETA before ordering | Pre-order delivery route. | Share available options only from current source; escalate if unserviceable/uncertain. | Delivery/source lookup required when pincode/date supplied. | Pincode, required date/time, product/cart if needed. | Static mapped |
| PRE-03 | Piece count / weight / box contents | Product-detail route. | Share only confirmed size/count/weight. | Product/source lookup required. | Product/variant if unavailable. | Static mapped |
| PRE-03 | Custom packing size / alternative quantity | Product-detail/custom pack route. | Offer available sizes; do not promise unavailable custom pack. | Source lookup for current variants. | Requested size, product, quantity. | Static mapped |
| PRE-04 | Sugar-free / diabetic-friendly query | Dietary route. | Explain confirmed no-added-sugar vs sugar-free distinction. | Source lookup if asking product-specific ingredients. | Product, dietary concern. | Static mapped |
| PRE-04 | Allergen / Jain / nut-free query | Dietary/allergen route. | Share confirmed info; route clinical/severe/allergen uncertainty. | Source lookup required. | Product, allergen/dietary restriction, severity if volunteered. | Static mapped |
| PRE-04 | Ingredients/nutritional values not listed | Ingredients route. | Share confirmed ingredients or route to team. | Source lookup required. | Product, batch/order details if post-purchase. | Static mapped |
| PRE-05 | Applying a promo / discount code | Discount route. | Validate current code/offer; no invented discount. | `validate_discount_code` or current discount source required for codes. | Code/cart issue if failing. | Static mapped |
| PRE-05 | Discount missed delivery window | Discount + delivery route. | Explain only confirmed future-delivery/offer limits; route edge cases. | Discount and delivery/source lookup if specific. | Code, pincode, date, cart/product. | Static mapped |
| PRE-06 | Gift rec with occasion + budget | Personal gifting route. | Website-first, max 3 options, one missing detail. | Product search only when current shortlist needed. | Occasion, budget, recipient, quantity. | Static mapped |
| PRE-06 | Specific occasion: roka / anniversary | Occasion gifting route. | Occasion-led tone, not corporate unless bulk signal. | Product search only when needed. | Occasion, quantity, budget, location/date. | Static mapped |
| PRE-07 | Wedding hampers | Event/bulk gifting route. | Capture brief and route for quote/feasibility. | Avoid broad fanout; aggregate only if needed. | Quantity, budget, date, cities, customisation. | Static mapped |
| PRE-07 | Baby shower / baby announcement | Occasion/event gifting route. | Warm tone; route by quantity/customisation. | Product search only if current shortlist needed. | Quantity, budget, city/date, message/customisation. | Static mapped |
| PRE-07 | Haldi / other personal ceremony | Personal ceremony route. | Under-25 website-first unless customisation. | No MCP unless current facts needed. | Quantity, budget, date/location, customisation. | Static mapped |
| PRE-08 | Corporate gifting: 25+ units, quote needed | B2B/bulk route. | Capture brief, no firm quote promise. | Use compact aggregate/search only if product examples requested. | Quantity, budget, cities, timeline, company need. | Static mapped |
| PRE-08 | Bulk order + GST invoice + logo branding | B2B/customisation route. | Route GST/branding/custom feasibility to team. | Source required for GST process; otherwise handoff. | GST, branding/logo, quantity, budget, cities/date. | Static mapped |
| PRE-09 | Custom message card | Gift-message route. | Explain confirmed note/card path or route. | Source required for checkout/process detail. | Message need, order/product, quantity. | Static mapped |
| PRE-09 | Branded sleeve / personalised box | Custom packaging route. | Ask quantity if missing, route feasibility. | No feasibility promise without team/source. | Custom request, quantity, occasion, timeline. | Static mapped |
| PRE-10 | Pincode not serviceable / same-day not showing | Checkout/delivery-tech route. | Diagnose pincode/time at high level; route if blocked. | Delivery/source lookup if pincode/time present. | Pincode, desired date/time, product/cart, error. | Static mapped |
| PRE-10 | Payment failing / order not going through | Checkout/payment issue route. | Ask payment method/error once; route to human. | No payment-source write action; capture issue. | Payment method, error, cart/order attempt. | Static mapped |
| DEL-01 | Order status tracking request | Order-status route. | Share latest confirmed order stage/link if available. | Shopify/order source required. | Order id/phone context, issue, ETA ask. | Static mapped |
| DEL-01 | Tracking link shows nothing | Order-status exception route. | Check source; route if abnormal/no update. | Order source required. | Order id, tracking issue, time elapsed. | Static mapped |
| DEL-01 | Repeat follow-up not received | Escalation route. | Acknowledge delay and route priority. | Order source if available, no delivery promise. | Order id, prior delay, customer urgency. | Static mapped |
| DEL-02 | Gift order no invoice / prices visible | Order note/support route. | Explain confirmed invoice practice only; route scratch-price note. | Order source required for placed order. | Order id, no-bill/scratch-price ask. | Static mapped |
| DEL-03 | Specific delivery date request | Order modification route. | Route to human; do not promise date. | Order source if order exists. | Order id, requested date, current date. | Static mapped |
| DEL-03 | Specific time window request | Delivery request route. | Route to human; no time-window promise. | Order source if order exists. | Order id, requested time window, urgency. | Static mapped |
| DEL-04 | Add/remove item from placed order | Order modification route. | Route to human; no change promise. | Order source if order exists. | Order id, item to add/remove. | Static mapped |
| DEL-04 | Combine multiple orders | Order modification route. | Route to human; no merge promise. | Order source if orders exist. | Order ids, desired combined delivery. | Static mapped |
| DEL-05 | Accidental/change cancellation | Cancellation route. | Route to human; no cancellation promise. | Order source if order exists. | Order id, reason, urgency. | Static mapped |
| DEL-05 | Cancellation + refund request | Cancellation/refund route. | Route to human; no refund approval promise. | Order source if order exists. | Order id, refund ask, reason. | Static mapped |
| POST-01 | Product melted / texture changed | Complaint route. | Apologise, ask for picture, route. | Order/source lookup if order context needed. | Order id, product, photo request/status. | Static mapped |
| POST-01 | Stale/off taste/below expectation | Complaint route. | Apologise, ask for product and BOP/photo if needed, route. | Order/source lookup if order context needed. | Order id, product, issue, photo/BOP. | Static mapped |
| POST-02 | Item missing from order/hamper | Missing-item route. | Apologise and route; do not demand unnecessary photos. | Order source required if order unknown. | Order id, missing item, hamper/order details. | Static mapped |
| POST-02 | Gift/message card missing | Missing-card route. | Apologise and route. | Order source if order unknown. | Order id, message/card issue. | Static mapped |
| POST-03 | Packaging damaged on arrival | Damage route. | Apologise, ask picture, route. | Order source if needed. | Order id, photo, damage description. | Static mapped |
| POST-03 | Different/wrong packaging received | Wrong packaging route. | Apologise, ask picture, route. | Order source if needed. | Order id, expected vs received packaging. | Static mapped |
| POST-04 | Unexpected package identify sender | Sender-identification route. | Use order/billing source only; route privacy-sensitive cases. | Order source required. | Order/reference, recipient details from verified context. | Static mapped |
| POST-05 | GST invoice wrong number | Invoice correction route. | Route to human; no correction promise. | Order/invoice source required if available. | Order id, GST number issue, invoice received. | Static mapped |
| POST-05 | Invoice/bill needed post-delivery | Invoice request route. | Share confirmed route or human handoff. | Order/invoice source required. | Order id, invoice/GST need. | Static mapped |
| POST-06 | Marked delivered but not received | Urgent delivery complaint route. | Apologise and route without delay. | Order source if available; no delivery promise. | Order id, marked-delivered status, address issue. | Static mapped |
| CAFE-01 | Reservation requests | Cafe policy route. | Say reservations unavailable only if confirmed; share contact/source if confirmed. | Store/source lookup for outlet contact. | Outlet, date/time, party size. | Static mapped |
| CAFE-02 | Store location, hours, contact | Store-info route. | Share confirmed outlet details; aggregator route for dark store if confirmed. | Store/source lookup required. | Area/outlet, requested info. | Static mapped |
| CAFE-02 | Nearest store to area | Store-location route. | Provide nearest confirmed outlet or ordering alternative. | Store/source lookup required. | Area/locality. | Static mapped |
| CAFE-03 | Dine-in menu / soft serve flavours | Cafe menu route. | Share confirmed menu link/source; route live flavour uncertainty. | Store/menu source required. | Outlet/menu/flavour ask. | Static mapped |
| CAFE-04 | Valet availability | Store amenities route. | Share confirmed parking/valet info only. | Store/source lookup required. | Outlet/location. | Static mapped |
| CAFE-05 | Product availability instore | Store availability route. | Use source; suggest calling store for quantity confirmation if needed. | Product/store source required. | Product, outlet, pickup quantity/time. | Static mapped |
| CAFE-06 | Bill request instore | In-store invoice route. | Ask payment mode/time/outlet and route. | No live order MCP unless in-store source exists. | Outlet, time, payment mode, bill/GST need. | Static mapped |
| MISC-01 | Spam | Non-customer spam route. | No customer reply unless runtime requires closure. | No MCP. | None. | Static mapped |
| MISC-02 | Opt out marketing | Opt-out route. | Confirm unsubscribe action only if system supports it; otherwise route. | Needs opt-out capability/source before claiming action. | Phone/context, opt-out text. | Static mapped |
| MISC-02 | Repeated opt-out not honoured | Opt-out complaint route. | Acknowledge frustration, route to human. | Needs opt-out/source evidence. | Opt-out history, phone context. | Static mapped |
| MISC-03 | Franchise | Franchise policy route. | Politely decline franchise if confirmed policy; thank them. | No MCP unless policy source missing. | Partnership ask if routing. | Static mapped |
| MISC-04 | Jobs | Hiring route. | Send confirmed Hunger Inc/careers route. | Source required for link/process. | Role/location if routing. | Static mapped |
| AGG-01 | Aggregator quality issue | Aggregator complaint route. | Apologise, ask pictures/order details, route. | No Shopify direct order lookup unless aggregator source exists. | Platform, order number, invoice, photo, issue. | Static mapped |
| AGG-02 | Aggregator missing items | Aggregator missing route. | Apologise, ask aggregator order details, route. | No Shopify direct order lookup unless aggregator source exists. | Platform, order number, invoice, missing item. | Static mapped |
| AGG-03 | Aggregator product availability | Aggregator availability route. | Suggest confirmed store-switch/order-source guidance only. | Aggregator/source data if available. | Platform, product, area/store. | Static mapped |
| AGG-04 | Aggregator bill requests | Aggregator invoice route. | Redirect to platform if confirmed; route if platform refused. | No Shopify direct order lookup unless source exists. | Platform, order number, invoice refusal. | Static mapped |
