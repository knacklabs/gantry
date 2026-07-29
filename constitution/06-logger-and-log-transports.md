# Playbook 06 - Logger and Log Transports

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

## 🎯 Purpose
This playbook explains the difference between a **logger** and **logger transports**, and provides guidance on which transports to use in different environments.

---

### 🧱 What is a Logger vs. a Logger Transport?

#### ✔ Logger
A **logger** is the main component or interface you use to create logs. It provides methods like `logger.info()`, `logger.error()`, and so on, which you call throughout your code.

#### ✔ Logger Transports
A **logger transport** is a destination where your logs are sent. Think of it as the "output channel" for the logger. The logger itself is like the controller, and the transport is the delivery method.
**Common Examples of Transports:**
- **Console Transport:** Outputs logs directly to the console (stdout). Useful for local development and debugging.
- **File Transport:** Writes logs to a file on disk.
- **CloudWatch Transport:** Sends logs to AWS CloudWatch for centralized monitoring.
- **Sentry Transport:** Sends logs and errors to Sentry for error tracking.
- **Other Transports:** Datadog, Logstash, or any third-party log management tool.

---

### 🔧 Which Transports to Use in Each Environment

#### ✔ Local Environment (`env = Local`)
In your local development environment, you primarily want logs to appear in your terminal for easy debugging. Therefore, configure the logger to use only the **console transport** in this environment. This way, you continue using the logger in code, and it will output logs to your terminal without you having to use `console.log` directly.

#### ✔ Development, QA, and Production Environments (`env = Development/QA/Production`)
In non-local environments, console output is not useful and can clutter the logs. Instead, you should configure the logger to use transports that send logs to centralized logging services like CloudWatch, Sentry, or another log management system. This ensures that logs are aggregated and accessible for monitoring and debugging across the team.

---

### 📋 Summary
- Use the **console transport** in local environments for immediate feedback.
- Use **cloud or third-party transports** (such as CloudWatch or Sentry) across development, QA, and production environments for centralized log management.

---
