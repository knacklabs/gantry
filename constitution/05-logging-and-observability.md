# Playbook 05 - Logging & Observability

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

## 🎯 1. Purpose
This playbook defines KnackLabs’s standards for **logging, observability, metrics, tracing, and alerting**, ensuring that all logs are consistent, structured, and include the environment from which they originate.

---

## 🧱 2. Logging Principles (Core Standards)

#### ✔ 2.1 Logs must be structured JSON
All logs must be in JSON format.

#### ✔ 2.2 Logs must contain a consistent set of fields
Every log must include the following fields:
- `timestampUtc`: The UTC timestamp of the log.
- `level`: The log level (e.g., info, error, debug).
- `message`: A static, descriptive message.
- `context`: An object containing dynamic details.
- `environment`: The environment from which the log originates (e.g., `Local`, `Development`, `QA`, `UAT`, `Staging`, `Production`). [Refer](/2c577dd3e50c80a69e7dd971049ea014?pvs=25).
- `serviceName`: The name of the service emitting the log.
- `module`: The module or component name.
- `correlationId`: A unique ID to trace the request or workflow.
- `accountId` (nullable): The account/user ID if applicable.
- `requestId` (API only): The ID of the incoming request if relevant.
- `eventId` (if applicable): The ID of the event if the log is related to an event.

#### ✔ 2.3 No sensitive data
Never log sensitive information (passwords, tokens, PII).

#### ✔ 2.4 Use the shared logger, not `console.log` 

---

## 🧩 3. Message and Context Field Standards

#### ✔ Message Field (Static)
- Should be a fixed, descriptive phrase without dynamic data.
- Use neutral, present, or past tense.
- No punctuation at the end.

#### ✔ Context Field (Dynamic)
- Contains dynamic data as key-value pairs.
- Only include necessary fields, never entire objects.
- Mask PII and keep it concise.

---

## 📋 4. Must-Have Fields Description Table

| Field | Description |
| --- | --- |
| `timestampUtc` | The timestamp in UTC when the log entry was created. |
| `level` | The severity level of the log (debug, info, warn, error, fatal). |
| `message` | A static, human-readable summary of the log event. |
| `context` | An object with dynamic data related to the log. |
| `environment` | The environment from which the log originates (e.g., Local, Development, QA, UAT, Staging, Production).  |
| `serviceName` | The name of the service that generated the log. |
| `moduleName`  | The specific module or component where the log was generated. |
| `correlationId` | A unique ID used to trace a request or workflow across logs. |
| `accountId` | (Optional) The user or account ID associated with the log event. |
| `requestId` | (API only) The ID of the incoming request if the log is related to an API call. |
| `eventId` | (Optional) The ID of the event if the log is related to an event. |

---

## ⚡ 5. Log Levels and Usage

| Level | When to Use |
| --- | --- |
| **debug** | Detailed information, mostly for developers. |
| **info** | General operational logs; normal behavior. |
| **warn** | Something unexpected but not causing failures. |
| **error** | An issue that caused an operation to fail but not the system. |
| **fatal** | A severe error causing the system to |

---

## 🔍 6. API and Provider Logging Standards

#### 6.1 API Logging
Include the `environment` field in all API logs. For example, when logging incoming requests and responses, ensure the environment is part of the logged fields. This helps in filtering logs by environment in tools like Sentry.

#### 6.2 Provider Logging
Similarly, include the `environment` field in all provider logs so you can differentiate issues occurring in different environments when viewing logs in a centralized logging system.

---

## 🌐 7. Environment-Specific Logging Behavior

#### 7.1 Local Environment (`Local`)
In local development, use the console transport to output logs directly to the terminal.

#### 7.2 Dev, QA, UAT, Staging, Production
In these environments, use appropriate transports like CloudWatch, Sentry, or another centralized logging provider. The `environment` field will help you filter logs by environment within these tools.
