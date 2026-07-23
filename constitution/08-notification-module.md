# Playbook 08 - Notification Module

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### 🎯 Purpose
The **Notification Module** is a standardized, reusable domain module responsible for handling all outbound notifications across the platform.
It listens to domain events via the **Service Bus** and sends notifications through multiple channels, such as:
- Email
- SMS
- WhatsApp
- Marketing Automation Platforms (e.g., CleverTap, WebEngage)
This module is designed to be **plug-and-play** and should be included in almost every project by default.

---

### Core Design Principles

#### Event-Driven & Decoupled
- The Notification Module **does not depend on any other domain module**
- It subscribes to events from the **Service Bus**
- Other domains do not directly invoke notification logic
Examples of events consumed:
- `AccountCreatedEvent`
- `AccountSuspendedEvent`
- `PasswordResetRequestedEvent`
- `OrderPlacedEvent`
This ensures:
- Zero coupling with core domains
- Easy extraction into a microservice in the future

---

#### Provider Pattern for All Integrations (Mandatory)
All external integrations **must** be implemented using the **Provider Pattern**.
This applies to:
- Email gateways
- SMS / WhatsApp gateways
- Marketing automation platforms
No direct HTTP calls to third-party services are allowed inside services or handlers.

---

### High-Level Responsibilities of the Notification Module
The Notification Module is responsible for:
- Subscribing to domain events via the Service Bus
- Mapping events to notification intents
- Selecting the appropriate notification channel(s)
- Delegating message delivery to providers
- Handling retries, failures, and logging
- Relaying events to marketing automation platforms if configured

---

### Module Structure (Recommended)

#### Folder Structure
```plain text
/modules/notification
 ├── notification.module.ts
 ├── handlers/
 │    ├── account-created.handler.ts
 │    ├── account-suspended.handler.ts
 │    └── password-reset.handler.ts
 ├── services/
 │    └── notification.service.ts
 ├── providers/
 │    ├── email/
 │    │    ├── email-provider.interface.ts
 │    │    ├── ses-email.provider.ts
 │    ├── sms/
 │    │    ├── sms-provider.interface.ts
 │    │    ├── gupshup-sms.provider.ts
 │    ├── whatsapp/
 │    │    ├── whatsapp-provider.interface.ts
 │    │    ├── gupshup-whatsapp.provider.ts
 │    └── marketing-automation/
 │         ├── marketing-automation-provider.interface.ts
 │         ├── clevertap-marketing-automation.provider.ts
 └── dto/
      └── notification-payload.dto.ts

```
(Same structure applies to FastAPI using `_service.py`, `_provider.py`, `_handler.py` suffixes.)

---

### Event Handling Model

#### Event Subscription
- Each event has a dedicated handler
- Handler responsibilities:
  - Validate event payload
  - Decide whether notification is required
  - Call `NotificationService` with a normalized intent
Handlers **must not**:
- Contain provider logic
- Call external APIs
- Contain business rules from other domains

---

#### Notification Service
The `NotificationService` is responsible for:
- Channel selection (email / SMS / WhatsApp / marketing automation)
- Template resolution
- Delegation to the correct provider via interfaces
- Fallback logic (if applicable)

---

### Provider Design Standards

#### Provider Interfaces (Mandatory)
Each notification channel must have an interface:
Examples:
- `IEmailProvider`
- `ISmsProvider`
- `IWhatsappProvider`
- `IMarketingAutomationProvider`
The Notification Service depends **only on interfaces**, never implementations.

---

#### Provider Implementations
Examples of concrete implementations:
- Email
  - `SesEmailProvider`
  - `SendgridEmailProvider`
- SMS / WhatsApp
  - `GupshupSmsProvider`
  - `GupshupWhatsappProvider`
- Marketing Automation
  - `ClevertapMarketingAutomationProvider`
  - `WebEngageMarketingAutomationProvider`
Providers must:
- Handle authentication
- Map external errors to internal error codes
- Never leak vendor-specific response formats
- Never contain business logic

---

### Marketing Automation Integration
When a project opts to use platforms like CleverTap or WebEngage:
- Notification Module forwards relevant events to the marketing automation provider
- Actual message delivery may be handled externally by the platform
- Notification Module remains the **single source of truth for event emission**
This ensures:
- Centralized control
- Easy switching between direct messaging vs automation platforms

---

### Best Practices (Mandatory)

#### Logging & Performance Timing
Every provider implementation must:
- Log the start and end of each external call
- Capture:
  - Provider name
  - Channel (email / SMS / WhatsApp)
  - Duration in milliseconds
  - Success or failure status
- Use structured logging as defined in the Logging & Observability Playbook
This allows:
- Latency tracking
- SLA monitoring
- Easier debugging of slow providers

---

#### Retry Strategy with Exponential Backoff
For transient failures (timeouts, rate limits, temporary outages):
- Implement retries using **exponential backoff**
- Example strategy:
  - Retry 1 → after 500 ms
  - Retry 2 → after 1 s
  - Retry 3 → after 2 s
- Max retry count must be configurable
Rules:
- Retries only for retryable errors
- Permanent failures must fail fast
- All retries must be logged at `warn` or `debug` level

---

### Failure Handling & Idempotency
- Notification sending must be idempotent where applicable
- Duplicate events must not result in duplicate notifications
- Event ID should be used to track processed notifications
- Failures must never crash the system

---

### Why This Module Is a Standard “Cloud Skill”
The Notification Module is standardized because:
- Almost every product needs notifications
- Event-driven design keeps domains clean
- Provider pattern keeps integrations swappable
- It scales from V1 monolith to microservices seamlessly
- Teams can reuse, extend, or disable channels per project
**Every new project should start with this module unless explicitly not required.**

---
