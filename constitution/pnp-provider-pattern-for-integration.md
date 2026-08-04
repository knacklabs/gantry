# PnP — Provider Pattern for Integration

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### 🎯 **1. Purpose**
The Provider Pattern standardizes **how we integrate with external services** (SMS, Email, Payment Gateways, Maps, KYC, Credit Bureau, Analytics, etc.).
It ensures that:
- All external IO is isolated
- Domain logic stays clean
- Switching vendors later becomes easy
- Testing becomes simpler
- Microservice extraction becomes hassle-free
This is a **mandatory pattern** for all integrations.

---

### 🧩 **2. What is a Provider?**
A **Provider** is a class dedicated to interfacing with **one external system**.
It is responsible for:
- External API calls
- Authentication & headers
- Error mapping
- Retries & timeouts
- Request/response transformation
- Logging & metrics
Providers must be **thin**, **focused**, and **single-responsibility**.

---

### 🧱 **3. When to Use a Provider**
Use a Provider when you need to call:
- SMS gateways (Twilio, MSG91)
- Email systems (SendGrid, SES)
- Payment gateways (Razorpay, Stripe)
- KYC services (Digilocker, Perfios)
- Geocoding / Maps APIs
- External CRM / ERP
- Any HTTP, gRPC, or SDK-based external API
If the code interacts with **the outside world**, it belongs in a Provider.

---

### ❌ When NOT to Use a Provider
Do **not** use a provider for:
- Data formatting → use a Helper
- Pure calculations → use a Helper
- Simple wrappers around internal modules
- Business logic → belongs in the Service layer
Providers = Side Effects
Helpers = Pure Computation

---

### 🧱 **4. Provider Naming & File Structure**

#### File Naming
- NestJS: `payment.provider.ts`, `sms.provider.ts`
- FastAPI: `payment_provider.py`, `sms_provider.py`

#### Class Naming
- `PaymentProvider`
- `SmsProvider`
- `EmailProvider`

#### Interface Naming
- `IPaymentProvider`
- `SmsProviderInterface`
Using interfaces keeps the system mockable and swappable.

---

### 🔧 **5. Provider Responsibilities**
Every Provider must handle:

#### ✔ External API Call
- HTTP/gRPC calls
- Authentication
- Header injection
- Request shaping

#### ✔ Response Parsing
- Convert vendor response into internal DTO
- Mask or sanitize sensitive data

#### ✔ Error Mapping
- Map vendor errors into **application errors**
- Avoid leaking external error formats to the domain

#### ✔ Retries & Timeouts
- For retryable operations
- Sensible defaults based on provider type

#### ✔ Logging
- Log request + response metadata
- Never log sensitive info (PAN, OTP, passwords, tokens)

#### ✔ Idempotency (where applicable)
- Payments
- Notifications
- KYC verification

---

### 🧪 **6. Testing Providers**
Providers must support:
- Unit tests using mocks
- Fake provider implementations for local/dev
- Integration tests (optional for V1)
Services should always consume providers through **interfaces** so providers are easily mockable.

---

### 🔄 **7. Provider Pattern in Modular Monolith**
Providers help keep modularity intact:
- Domain services consume providers through interfaces
- Providers never import domain code
- Providers live under their own folder (e.g., `/common/providers` or `/modules/<domain>/providers`)
- Easy to swap implementations when extracting into microservices

---

### 🧩 **8. Provider Anti-Patterns (Avoid at All Costs)**
- Making providers hold business logic
- Writing direct HTTP calls in controllers/services
- Mixing multiple third-party systems into one provider
- Returning vendor-shaped objects (must convert to internal shape)
- Hardcoding URLs, tokens inside provider
- Large God-providers with 2,000+ lines
**Rule:**
Every provider must be replaceable without touching domain code.

---

### 📝 **9. Developer Checklist**
- [ ] Provider name uses correct suffix
- [ ] Provider implements an interface
- [ ] No business logic inside provider
- [ ] Provider returns internal DTO format
- [ ] All external errors mapped to internal error codes
- [ ] Provider uses retries/timeouts correctly
- [ ] Provider does NOT leak vendor concepts into service or domain
- [ ] Sensitive data not logged
- [ ] Provider is mockable in tests
