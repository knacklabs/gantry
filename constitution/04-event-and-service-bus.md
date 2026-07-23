# Playbook 04 - Event & Service Bus

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

---
*Authoritative guidelines for event naming, publishing, consumption, idempotency, retries, and microservice readiness.*

---

## 🎯 **1. Purpose of This Playbook**
This playbook defines the **standards, naming conventions, rules, and patterns** for events in all V1 projects.
Goals:
- Enforce clean **inter-module communication** in modular monoliths
- Guarantee future compatibility when extracting microservices
- Standardize **event naming**, **payloads**, **versioning**, and **contract evolution**
- Ensure events are **idempotent**, **safe**, and **traceable**
- Avoid circular dependencies and tight coupling between domains

---

## 🧱 **2. What is the Service Bus?**
In our architecture, the **Service Bus** is the internal communication layer used for module-to-module interactions.
It provides:
- **Event publishing** (`publishEvent`)
- **Event subscription/handlers** (`onEvent`)
- **Command dispatching** (optional)
- **In-process messaging** during V1
- Future ability to plug in:
  - SNS/SQS
  - Kafka
  - RabbitMQ
  - Redis Streams
  - EventBridge
The important rule:
> Domain modules NEVER import each other.
All communication happens exclusively through the Service Bus.

---

## 🏗️ **3. Event Naming Standards**

#### **3.1 Structure**
Use **PascalCase** with the suffix:
```plain text
<Domain><Action><Event>
```
Examples:
- `UserCreatedEvent`
- `OrderCancelledEvent`
- `PaymentFailedEvent`
- `OtpGeneratedEvent`
- `InventoryAdjustedEvent`

#### **3.2 Domain MUST be included**
This avoids collisions when multiple domains have similar event names.
❌ Avoid:
- `CreatedEvent`
- `UpdatedEvent`

---

## 📦 **4. Event File Naming (Mandatory)**

#### NestJS (TS)
```plain text
user-created.event.ts
order-cancelled.event.ts
```

#### FastAPI (Python)
```plain text
user_created_event.py
order_cancelled_event.py
```
Each file must export:
- Event name
- Event payload interface/schema
- Event metadata schema
- Event version

---

## 🧬 **5. Event Versioning**
Every event MUST include a version:
```plain text
v1
v2
v3
...
```

#### File-level example (TS):
```typescript
export const UserCreatedEvent_v1 = {
  version: 'v1',
  ...
}
```

#### Why version events?
- To evolve schemas without breaking consumers
- Allows new consumers to subscribe to new versions
- Old consumers continue working without changes
- Supports smooth migrations when extracting microservices

---

## 📑 **6. Event Payload Standards**

#### **6.1 Required Payload Structure**
All events must include:
```plain text
id: UUID (event id)
version: string
timestampUtc: ISO string
initiatedByAccountId: UUID | null
data: {...}
```

#### Example:
```json
{
  "id": "uuid",
  "version": "v1",
  "timestampUtc": "2025-01-01T10:00:00Z",
  "initiatedByAccountId": "account-123",
  "data": {
    "userId": "abc123",
    "email": "john@example.com"
  }
}
```

#### **Required Elements**
- `id` → unique id for the event itself
- `version` → ensures backward compatibility
- `timestampUtc` → always UTC
- `initiatedByAccountId` → who triggered the event
- `data` → domain-specific payload

---

## 🔁 **7. Publishing Standards**

#### **7.1 When to Publish Events**
Publish events when:
- A domain entity is **created**, **updated**, **deleted**, **activated**, **approved**, or **completed**
- A business process **transitions state**
- An action in one module triggers behavior in another

#### **7.2 When NOT to Publish**
Avoid publishing events for:
- Internal helper operations
- Pure calculations
- UI actions
- Non-state-changing read operations

---

## 🛎️ **8. Event Handler Standards**

#### **8.1 Handler Naming**
Suffix must be `handler`.
Examples:
- `user-created.handler.ts`
- `order-cancelled.handler.ts`
Python:
- `user_created_handler.py`

#### **8.2 Handler Responsibilities**
Handlers **may**:
- Call services
- Update database records
- Trigger notifications
- Publish new events
- Log business actions
Handlers **may NOT**:
- Perform HTTP operations
- Depend on other modules
- Contain business rules that belong in services
- Call providers directly
- Perform circular event loops

---

## 🧠 **9. Idempotency Standards**
Every handler must be **idempotent**.

#### Must implement:
- Event ID check → Has this event been processed before?
- Idempotency key store (table: `EventLog` or `ProcessedEvents`)
- Skip logic if already processed

#### Why?
- When we move to external queues (SQS, Kafka, etc.), duplicate messages happen.
- Idempotency avoids accidental double execution (eg. double charging a customer).

---

## 🔁 **10. Retry & Failure Handling**

#### For in-process (modular monolith):
- Catch all handler-level errors
- Log errors with metadata
- Never crash the system
- Optionally retry with backoff

#### For future microservices:
- Dead-letter queues (DLQ) will be required
- Retry policies configured per event type
- Poison event identification

---

## 🧵 **11. Event Ordering Standards**
Not all events need ordering — but some do.

#### **If ordering is required:**
- Include `sequenceNumber` in payload
- Make consumer enforce ascending sequence
- Avoid parallel handlers for that event type

---

## 🛡️ **12. Security Standards**
Never include sensitive data in event payloads.
Prohibited:
- Passwords
- OTPs
- Raw tokens
- PAN, Aadhaar, PII unless encrypted
- Any authentication/authorization secrets
Allowed:
- IDs
- Non-sensitive fields
- Hashed tokens
- Partial data (masked)

---

## 🔍 **13. Logging Standards**
Every event publication must log:
- Event name
- Event id
- Producer module
- TimestampUtc
Every event handler must log:
- Event name
- Event id
- Handler module
- Success/failure
- Duration

---

## 🌐 **14. Cross-Module Communication Rules**

#### Allowed:
- Publish events
- Handle events

#### Not allowed:
- Direct imports of module services
- Direct DB access for other modules
- Tight coupling or bidirectional event flows

---

## 🔩 **15. Internal Service Bus API (Recommended Structure)**

#### **In NestJS (TS)**
```typescript
serviceBus.publishEvent(UserCreatedEvent_v1)

serviceBus.onEvent('UserCreatedEvent_v1', handlerFunction)
```

#### **In FastAPI (Python)**
```python
service_bus.publish_event(UserCreatedEvent_v1)

@service_bus.on_event("UserCreatedEvent_v1")
def handle_user_created(event):
    ...
```

---

## 🧪 **16. Testing Standards**

#### Every event handler MUST have:
- Unit tests
- Idempotency tests
- Failure scenario tests
- Race condition tests (if applicable)

#### Every published event MUST be:
- Validated against schema
- Version-confirmed
- Logged

---

## 📝 **17. Developer Checklist**
- [ ] Event name follows correct format
- [ ] Event suffix = `Event`
- [ ] Event file suffix = `.event.ts`/`.py`
- [ ] Event version included
- [ ] Event payload uses required structure
- [ ] Payload contains UTC timestamps
- [ ] InitiatedByAccountId included
- [ ] No sensitive data present
- [ ] Handler is idempotent
- [ ] Handler logs success/failure
- [ ] No cross-module imports

---
