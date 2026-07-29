# PnP — Swagger / API Documentation Standards

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

---
*For NestJS + FastAPI in all Modular Monolith V1 projects*

---

## 🎯 **1. Purpose of This Playbook**
This playbook defines **how all APIs must be documented** using Swagger (OpenAPI 3.x).
Our goals:
- Make every API **self-documenting**
- Maintain **consistency across all teams and stacks**
- Provide a **single source of truth** for frontend, mobile, QA, DevOps, and LLM-based agents
- Guarantee clear **contracts**, **examples**, **schemas**, and **error formats**
- Make Swagger → future microservices friendly

---

## 🧱 **2. General Documentation Principles**
- Every endpoint must be documented.
- Every request/response must use **DTOs/Schemas**.
- Every error must be typed, with examples.
- Documentation must be updated with each PR.
- No undocumented query params, path params, or request bodies.
- Swagger must clearly show **success + error responses**.

---

## 🛠️ **3. Swagger Setup Requirements**

### **NestJS**
Use:
- `@nestjs/swagger`
- `SwaggerModule`
- `DocumentBuilder`
Swagger must be mounted under:
```plain text
/api/docs
```

### **FastAPI**
FastAPI has built-in OpenAPI generation.
Documentation URLs:
- Swagger UI → `/docs`
- ReDoc → `/redoc`

---

## 🏷️ **4. API Tags Standards**
Each domain module MUST have a dedicated tag.
Examples:
- `Users`
- `Orders`
- `Billing`
- `Authentication`
- `Inventory`
- `Payments`

#### NestJS:
```typescript
@ApiTags('Users')
```

#### FastAPI:
```python
router = APIRouter(prefix="/users", tags=["Users"])
```
**Rules:**
- Tag name must match module name (PascalCase).
- No generic tags like `Misc`, `General`, or `Other`.

---

## 📄 **5. Path & Operation Documentation**

#### Every endpoint must include:
- Summary
- Description
- Tags
- Path parameters
- Query parameters
- Request body schema
- Success response
- Error responses
- Authentication requirements

---

## ✏️ **6. Summary & Description Requirements**

#### Summary
- One sentence
- Clear, active voice
- Describes the action
**Example:**
`Create a new user account.`

#### Description
- 1–4 lines
- When to use
- Notes or edge cases
- Process flow (optional)
**Example:**
```plain text
Creates a new user account using email and password.
Email must be unique.
Triggers a UserCreatedEvent internally.
```

---

## 🔧 **7. Path & Query Parameter Documentation**

#### NestJS
```typescript
@ApiParam({ name: 'id', type: String, description: 'User ID' })
@ApiQuery({ name: 'status', required: false })
```

#### FastAPI
```python
def list_users(status: Optional[str] = Query(None, description="Filter users by status")):
```
**Rules:**
- Every path param must be documented.
- Query params must specify type + description.
- Optional vs required must be clear.

---

## 📦 **8. Request Body Documentation**

#### Must use DTOs/Schemas
NestJS:
```typescript
@ApiBody({ type: CreateUserDto })
```
FastAPI:
```python
def create_user(request: UserCreateSchema):
```
**Rules:**
- DTO/Schema must describe every field.
- Include validation decorators (Nest) or Pydantic constraints (FastAPI).
- Include example payloads.

---

## 📤 **9. Response Documentation (Mandatory)**

#### Success Response
NestJS:
```typescript
@ApiOkResponse({ type: UserResponseDto })
```
FastAPI:
```python
@router.get(..., response_model=UserResponseSchema)
```

#### Response Envelope Standard
All responses must follow:
```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```
**Never return raw objects.**

---

## ⚠️ **10. Error Documentation Standards**
Every endpoint must include **typed** error responses.
NestJS:
```typescript
@ApiBadRequestResponse({ description: 'InvalidInputError', type: ErrorResponseDto })
@ApiUnauthorizedResponse({ description: 'UnauthorizedError', type: ErrorResponseDto })
```
FastAPI:
```python
responses={
    400: {"model": ErrorResponseSchema, "description": "InvalidInputError"},
    401: {"model": ErrorResponseSchema, "description": "UnauthorizedError"},
}
```

#### Error Code Rules
- Uppercase + underscore
- Must appear in an error reference list
Examples:
- `USER_NOT_FOUND`
- `INVALID_OTP`
- `ORDER_ALREADY_CANCELLED`

---

## 🔐 **11. Authentication Documentation**
Every protected route MUST include:

#### NestJS:
```typescript
@ApiBearerAuth()
```

#### FastAPI:
```python
dependencies=[Depends(auth_guard)]
```
And Swagger must reflect:
```plain text
Authorization: Bearer <jwt>
```

---

## 📚 **12. DTO / Schema Documentation Standards**

#### Every DTO/Schema must:
- Include `@ApiProperty()` in NestJS
- Include Pydantic field descriptions in FastAPI
- Provide examples
- Define validation rules
- Match the API contract exactly
- NOT expose internal fields (passwords, metadata, DB IDs for foreign services)

---

## 🔍 **13. Example Blocks (Required)**
Every DTO/Schema must include:
- Example request
- Example response
- Example error
Example (NestJS):
```typescript
@ApiProperty({
  example: "john@example.com",
  description: "Email of the new user",
})
```
Example (FastAPI):
```python
class UserCreateSchema(BaseModel):
    email: str = Field(..., example="john@example.com")
```

---

## 🗃️ **14. Pagination Documentation**
All list endpoints must document:
- `page`
- `limit`
- `sortBy`
- `sortOrder`
- filters
Example in Swagger:
```typescript
@ApiQuery({ name: 'page', example: 1 })
@ApiQuery({ name: 'limit', example: 20 })
@ApiQuery({ name: 'sortBy', required: false })
```

---

## 🧪 **15. Developer Checklist**

#### Documentation
- [ ] Summary + description provided
- [ ] Tags assigned correctly
- [ ] Path params documented
- [ ] Query params documented
- [ ] DTO/schema used for request
- [ ] Response schema documented
- [ ] Pagination documented
- [ ] All error responses documented
- [ ] Authentication documented
