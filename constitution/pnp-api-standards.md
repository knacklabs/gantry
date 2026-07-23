# PnP — API Standards

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

---
*Applicable to all NestJS, FastAPI, and modular monolith V1 projects.*

---

## 🎯 **1. Purpose of This Playbook**
These API standards ensure that **all V1 projects**:
- Are predictable
- Are consistent across teams/stacks
- Use clean REST conventions
- Maintain strict module boundaries
- Are easy for other teams and external developers to consume
- Can be scaled and versioned easily
- Produce high-quality, well-documented APIs

---

## 🧱 **2. General Principles**
- APIs must be **simple**, **predictable**, and **consistent**.
- Naming conventions and HTTP semantics should be uniform.
- No business logic inside controllers — controllers orchestrate only.
- All requests and responses must use **DTOs/Schemas**, never raw JSON.
- Errors must follow a **consistent, typed structure**.
- Pagination & filtering must follow standard patterns.
- APIs should be explicitly **versioned**.

---

## 🏷️ **3. Naming Conventions**

### **3.1 Resource Naming**
- Use **lowercase, kebab-case** for URLs.
- Use **nouns**, not verbs.
- Use **plural nouns** for collections.
**Examples:**
```plain text
/api/v1/users
/api/v1/orders
/api/v1/payment-transactions
```
❌ Avoid:
```plain text
/getUsers
/createOrder
/processPayment
```

---

### **3.2 Action-Based Endpoints (Allowed Only for Non-CRUD Operations)**
Format:
```plain text
POST /api/v1/users/{id}/reset-password
POST /api/v1/orders/{id}/cancel
POST /api/v1/payments/{id}/refund
```
Action verbs should be:
- imperative
- lowercase
- attached **after the resource**, not as the resource

---

## 🌱 **4. HTTP Method Standards**

| Method | Usage |
| --- | --- |
| **GET** | Fetch resource(s) |
| **POST** | Create resource / trigger action |
| **PUT** | Replace full resource |
| **PATCH** | Update partial resource |
| **DELETE** | Soft-delete or disable resource |

#### Rules:
- Never use GET for write operations.
- Never use PUT/PATCH for actions (use POST).
- DELETE should soft-delete unless explicitly required.

---

## 🔄 **5. Versioning Standards**

#### Always version your APIs.
**Format:**
```plain text
/api/v1/<resource>
```
Rules:
- Never remove versions without migration announcement.
- Never introduce breaking changes in existing versions.
- Significant changes → increment major version.

---

## 📤 **6. Request Standards**

#### **6.1 All requests must use DTOs/Schemas**
NestJS → `*.dto.ts`
FastAPI → `*_schemas.py`

#### **6.2 Required fields**
- Validation must be defined at the DTO/schema level.
- All validation messages must be explicit.

#### **6.3 Request Structure**
Use:
- Path params
- Query params
- Body payloads
Never mix them incorrectly.
Example:
```plain text
GET /api/v1/orders?status=pending&limit=20
POST /api/v1/orders            ← body contains order details
POST /api/v1/orders/{id}/pay   ← path parameter + body
```

---

## 📥 **7. Response Standards**

#### **7.1 Response Envelope**
Every endpoint must return the structure:
```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```
For failures:
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User does not exist",
    "details": {}
  }
}
```

#### Why?
- Clients always parse predictable fields
- Error payload is typed
- Extensible for logging, analytics, SDKs

---

## ⚠️ **8. Error Standards**

#### **8.1 Error Shape**
```json
{
  "success": false,
  "error": {
    "code": "string_enum",
    "message": "Human readable text",
    "details": { ... }
  }
}
```

#### **8.2 Error Code Rules**
- ALL CAPS
- Underscore-separated
- Must represent developer-friendly classification
Examples:
- `INVALID_CREDENTIALS`
- `USER_ALREADY_EXISTS`
- `ORDER_NOT_FOUND`
- `PERMISSION_DENIED`

#### **8.3 Never expose**
- Internal stack traces
- Library error messages
- SQL errors
- Sensitive data

---

## 📚 **9. Pagination Standards**
All list endpoints must support:

#### **Query Params**
- `page` (default 1)
- `limit` (default 20, max 100)

#### **Pagination Envelope**
```plain text
{
  "success": true,
  "data": {
    "items": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 120,
      "totalPages": 6
    }
  },
  "error": null
}
```

---

## 🔍 **10. Filtering, Searching, Sorting**

#### **Filter Example**
```plain text
GET /api/v1/orders?status=pending&customerId=abc123
```

#### **Search Example**
```plain text
GET /api/v1/users?search=john
```

#### **Sort Example**
```plain text
GET /api/v1/orders?sortBy=createdAtUtc&sortOrder=desc
```
Sorting values:
- `asc`
- `desc`
Never use:
`ASCENDING`, `1`, `-1`, `reverse`

---

## 🔐 **11. Authentication & Authorization**

#### **Auth Method**
- Use JWT or session tokens
- Include `AccountId` in JWT payload
- Reject all unauthenticated requests except public endpoints

#### **Header**
```plain text
Authorization: Bearer <token>
```

#### **Authorization**
- Controller must enforce permissions
- Services should not rely on controller-level auth
- Avoid passing raw JWT content beyond controller

---

## 🛡️ **12. Security Standards**
ALL APIs must enforce:
- HTTPS only
- Input validation
- Output escaping
- Avoid over-fetching (limit returned fields)
- Rate limiting (if required)
- No sensitive data in logs
- CSRF protection for browser clients
- CORS configured explicitly
- No leaking internal IDs in multiple-tenant systems

---

## 🚦 **15. Idempotency Standards**
Required for:
- Payment APIs
- Retryable actions
- Webhooks
- Multi-step processes

#### Use header:
```plain text
Idempotency-Key: <UUID>
```
Persist idempotency keys to avoid replay.

---

## 📝 **17. API Documentation Standards**
Every project must include:
- Swagger (NestJS)
- ReDoc/Swagger (FastAPI)
- Example requests/responses
- Error codes list
- Headers documentation
- Pagination rules

---

## 📋 **18. Developer Checklist**

#### **Controllers**
- [ ] Controller contains no business logic
- [ ] DTOs used for all input/output
- [ ] Naming follows standards
- [ ] Pagination included for list endpoints

#### **Endpoints**
- [ ] CRUD endpoints follow correct HTTP verbs
- [ ] Actions use POST with verbs at the end
- [ ] Versioning applied (`/api/v1`)
- [ ] Resource paths are noun-based

#### **Responses**
- [ ] All responses follow envelope standard
- [ ] Error structure correct
- [ ] No sensitive data leaked

---
