# Playbook 07 - Exception Handling

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### 🎯 Purpose
Standardize how exceptions are caught, logged, traced, classified, and returned across KnackLabs projects.
This ensures:
- Predictable, consistent error handling
- Full observability (logs + metrics + traces)
- No swallowed 500s
- Clean error responses to consumers
- Safety from leaking internal/PII data
Applies to **API Backend**, **workers**, **cron jobs**, **event handlers**, and **providers**.

---

### 🧱 Core Principles

#### Centralized Global Exception Handling
All unexpected exceptions must bubble up to a **global exception handler**, which:
- Logs the exception (structured JSON)
- Emits error metrics
- Generates a stable error response
- Masks internal details from clients

#### Never Swallow 500s
If an unexpected internal error occurs → **do not handle silently**.
Allow it to reach the global exception handler, where logging and error formatting happen.

#### Localized Logging Allowed (When Intentional)
It’s acceptable to log *additional* context inside services/providers **if**:
- It adds useful meaning
- No sensitive data is logged
- It supplements (not replaces) the global exception log

#### Validation != Error
Payload validation failures are **normal** and should:
- Be logged as `debug` (or `info` if auditing is required)
- Return a `400 Bad Request` with field error details
- Never be treated as 500 errors

#### Provider/Infra Error Mapping
External errors must be mapped into **internal application error codes**, not leaked raw.

---

### 🧵 Global Exception Handler Responsibilities
A global handler **MUST**:
- Catch all uncaught exceptions
- Log a structured error record including:
  - `errorId`, `correlationId`, `environment`, `serviceName`, `module` . Refer to the [Logging Playbook](/2c577dd3e50c808487e3e3ca897b98a1?pvs=25). 
  - Sanitized stack trace (unless dev environment)
- Return a standardized API error payload
- Ensure no sensitive values leak to clients
A global handler **MUST NOT**:
- Perform complex recovery logic
- Hide or downplay unexpected server errors
- Leak raw stack traces to clients (except in the Local environment)

---

### 🧩 When Local Logging Is Acceptable
Local logging is OK when:

#### ✔ Provider-Specific Context
Before mapping provider errors to internal codes.
> Example: Logging "SMS provider rate-limited" with { provider: "MSG91", attempt: 2 }.

#### ✔ Business Rule Handling
If a service intentionally blocks an action (e.g., credit limit exceeded).

#### ✔ Retry Logic
Retries logged at `debug` for diagnostic purposes.

#### ✔ Graceful Degradation
Returning cached or fallback results.
> Example:
`"Using backup cache due to upstream timeout"` (warn)
These **do not replace** global handler logs.

---

### ❌ Do Not Swallow 500s

#### Rule
Unexpected internal errors **must not** be caught and ignored.

#### Incorrect Example (Swallowed 500)
```typescript
try {
  processPayment();
} catch (e) {
  return { success: true }; // 👎 hides the failure
}

```

#### Correct Example
Let it bubble so the global handler logs it.
Or—if you *intentionally* degrade gracefully:
```typescript
catch (e) {
  Logger.warn({
    message: "Using fallback due to payment provider timeout",
    context: { provider: "Razorpay" }
  });
  return cachedResponse;
}

```
This scenario must be **explicitly justified**.

---

### 🪪 Validation Failure Handling
Validation failures are common and should not pollute error logs.

#### Logging standard:
- `debug` log level (unless a regulated domain requires audit)
- Include field errors only
- No full request body

#### Response:
- `400 Bad Request`
- Structured field error list

---

### 📦 Standard API Error Response Payload
> KnackLabs-wide standard — consistent across NestJS, FastAPI, workers, etc.
```json
{
  "success": false,
  "error": {
    "errorId": "uuid-v4",
    "code": "USER_NOT_FOUND",
    "type": "DomainError",
    "message": "User does not exist",
    "userMessage": "We could not find the user. Please check the user ID.",
    "details": {
      "fieldErrors": [
        { "field": "email", "reason": "invalid_format" }
      ]
    },
    "statusCode": 404,
    "correlationId": "corr-123",
    "requestId": "req-123",
    "environment": "Production",
    "timestampUtc": "2025-12-08T12:34:56Z"
  },
  "data": null}

```

#### Required behavior:
- `errorId` must be logged and returned to the client
- `message` must be static (no dynamic interpolation)
- `details` must contain *no sensitive fields*

---

### 🧬 NestJS Example — Global Exception Filter
```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : 500;

    const errorId = uuid();
    const correlationId = req.correlationId;

    Logger.error({
      message: status >= 500 ? "Unhandled server error" : "HTTP exception",
      context: { status, errorId, path: req.path, method: req.method },
      correlationId,
      environment: process.env.ENVIRONMENT,
      serviceName: process.env.SERVICE_NAME
    });

    const payload = {
      success: false,
      error: {
        errorId,
        code: mapExceptionToCode(exception),
        type: mapExceptionType(exception),
        message: mapExceptionMessage(exception),
        userMessage: mapExceptionUserMessage(exception),
        details: sanitizeDetails(exception),
        statusCode: status,
        correlationId,
        requestId: req.headers["x-request-id"] || null,
        environment: process.env.ENVIRONMENT,
        timestampUtc: new Date().toISOString()
      },
      data: null
    };

    res.status(status).json(payload);
  }
}

```

---

### 🐍 FastAPI Example — Global Exception Handler
```python
async def global_exception_handler(request: Request, exc: Exception):
    status = getattr(exc, "status_code", 500)
    error_id = generate_uuid()
    correlation_id = request.headers.get("x-correlation-id")

    logger.error({
        "message": "Unhandled exception" if status >= 500 else "Handled exception",
        "context": {"status": status, "errorId": error_id, "path": request.url.path},
        "correlationId": correlation_id,
        "environment": settings.ENVIRONMENT,
    })

    payload = {
        "success": False,
        "error": {
            "errorId": error_id,
            "code": map_code(exc),
            "type": map_type(exc),
            "message": map_message(exc),
            "statusCode": status,
            "correlationId": correlation_id,
            "requestId": request.headers.get("x-request-id"),
            "environment": settings.ENVIRONMENT,
            "timestampUtc": now_iso()
        },
        "data": None
    }

    return JSONResponse(status_code=status, content=payload)

```

---

### 📌 Best Practices (With Allowed Flouting)

#### ✔ Best Practice 1: All exceptions bubble to the global handler
**Allowed flout:** Skip logging for success-path noise (e.g., extremely high-volume INFO logs).
You may *sample* logs for performance reasons.

---

#### ✔ Best Practice 2: Don’t swallow 500s
**Allowed flout:** Graceful degradation with fallback cache.
Must be logged locally and with a `fallback_used` metric.

---

#### ✔ Best Practice 3: Validation failures logged at debug
**Allowed flout:** In regulated domains (finance, insurance), log validation errors at `info` for audit.
