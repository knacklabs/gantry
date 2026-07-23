# API Patterns & Conventions
> Canon: <!-- canon: constitution/pnp-api-standards.md --> — this file only adds NestJS-React scaffold specifics.

## API Versioning

- **URL prefix:** All endpoints live under `/api/v1/`, `/api/v2/`, etc.
- **Breaking change = new version.** Renaming fields, removing endpoints, changing response shapes → bump major version.
- **Non-breaking changes stay in current version.** Adding optional fields, new endpoints, additive enum values.
- **Deprecation policy:** Set `Sunset` header with removal date. Minimum 3-month warning before removal.
  ```
  Sunset: Sat, 01 Nov 2025 00:00:00 GMT
  Deprecation: true
  ```

## REST Conventions

### Resource Naming
- **Plural nouns, kebab-case:** `/api/v1/invoice-items`, `/api/v1/user-profiles`
- **Nested resources max 2 levels:** `/api/v1/users/:id/invoices` ✅ — `/api/v1/users/:id/invoices/:id/line-items` ❌
- For deeper access, promote to top-level: `/api/v1/line-items?invoice_id=123`

### HTTP Verbs
| Verb | Usage | Example |
|------|-------|---------|
| `GET` | List or detail | `GET /api/v1/users`, `GET /api/v1/users/:id` |
| `POST` | Create | `POST /api/v1/users` |
| `PATCH` | Partial update | `PATCH /api/v1/users/:id` |
| `DELETE` | Soft delete | `DELETE /api/v1/users/:id` |

**PUT is avoided.** Full-replace semantics are rarely needed and error-prone.

## Response Format

### Success — Single Resource
```json
{ "data": { "id": "u_123", "name": "Alice", "email": "alice@example.com" } }
```

### Success — List
```json
{
  "data": [{ "id": "u_123", "name": "Alice" }],
  "meta": { "total": 42, "page": 1, "pageSize": 20, "hasNextPage": true }
}
```

### Error
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": { "email": ["must be a valid email"], "name": ["is required"] }
  }
}
```

### HTTP Status Codes
| Code | Meaning |
|------|---------|
| `200` | OK — successful GET/PATCH |
| `201` | Created — successful POST |
| `204` | No Content — successful DELETE |
| `400` | Validation error |
| `401` | Unauthenticated |
| `403` | Forbidden |
| `404` | Not found |
| `409` | Conflict (duplicate, state conflict) |
| `422` | Unprocessable entity |
| `429` | Rate limited |
| `500` | Server error |

## Response Interceptor

```typescript
// src/common/interceptors/response.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((result) => {
        if (result?.data && result?.meta) return result; // already formatted (paginated)
        return { data: result };
      }),
    );
  }
}
```

## Pagination

- **Cursor-based preferred** for feeds, real-time data, and any list where rows shift frequently.
- **Offset-based acceptable** for admin dashboards, reports, and stable datasets.
- **Default page size:** 20. **Max:** 100. Values outside range are clamped.

```typescript
// src/common/dto/pagination.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}

export class PaginatedResult<T> {
  data: T[];
  meta: { total: number; page: number; pageSize: number; hasNextPage: boolean };

  static create<T>(data: T[], total: number, page: number, pageSize: number): PaginatedResult<T> {
    return { data, meta: { total, page, pageSize, hasNextPage: page * pageSize < total } };
  }
}
```

## Filtering & Sorting

Query parameter conventions:
```
GET /api/v1/invoices?status=active&sort=-created_at&search=acme
GET /api/v1/invoices?amount_gte=100&amount_lte=500&sort=amount
```

| Pattern | Meaning |
|---------|---------|
| `?status=active` | Exact match filter |
| `?sort=-created_at` | Sort descending (`-` prefix) |
| `?sort=name` | Sort ascending (no prefix) |
| `?search=query` | Full-text search across searchable fields |
| `?amount_gte=100` | Greater than or equal |
| `?amount_lte=500` | Less than or equal |

## Error Handling

```typescript
// src/common/filters/http-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse() as any;

    res.status(status).json({
      error: {
        code: body.code ?? `HTTP_${status}`,
        message: body.message ?? exception.message,
        details: body.details ?? undefined,
      },
    });
  }
}
```

## OpenAPI / Swagger

### Generation
- Auto-generated from NestJS decorators — no hand-written spec files.
- **CI validates** that the generated Swagger spec matches actual TypeScript types.
- **Breaking spec changes fail CI** (detected via `openapi-diff` in pipeline).
- **orval** generates a fully typed frontend client from the spec — no manual API layer.

### Decorator Standards

```typescript
// src/modules/users/users.controller.ts
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Users')
@Controller('api/v1/users')
export class UsersController {
  @Get()
  @ApiOperation({ summary: 'List all users with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'Paginated user list', type: UserListResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  findAll(@Query() query: ListUsersDto) { /* ... */ }

  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  create(@Body() dto: CreateUserDto) { /* ... */ }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update a user' })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) { /* ... */ }
}
```

### DTO Documentation

```typescript
// src/modules/users/dto/create-user.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: 'User email address', example: 'alice@example.com' })
  email: string;

  @ApiProperty({ description: 'Display name', example: 'Alice Zhang', minLength: 2 })
  name: string;

  @ApiPropertyOptional({ description: 'Role assignment', enum: ['admin', 'member'], default: 'member' })
  role?: string;
}
```

## Documentation Requirements

| Rule | Enforced By |
|------|-------------|
| Every endpoint has `@ApiOperation` with summary | PR review + lint |
| Every DTO field has `@ApiProperty` with description | PR review + lint |
| Response types documented with `@ApiResponse` | PR review + lint |
| Each module has a `README.md` with endpoint overview | Convention |

Module README format:
```markdown
# Users Module
## Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/users | List users (paginated) |
| POST | /api/v1/users | Create user |
| GET | /api/v1/users/:id | Get user by ID |
| PATCH | /api/v1/users/:id | Update user |
| DELETE | /api/v1/users/:id | Soft-delete user |
```

## API Client Generation (orval)

orval reads the OpenAPI spec produced by NestJS Swagger and generates a fully typed frontend client — TanStack Query v5 hooks, axios calls, request/response types, and MSW handlers. Zero manual API code.

### NestJS Swagger Setup (Backend)

The backend MUST produce a clean, consistent OpenAPI spec for orval to consume.

```typescript
// apps/api/src/main.ts
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const config = new DocumentBuilder()
  .setTitle('App API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();

const document = SwaggerModule.createDocument(app, config, {
  operationIdFactory: (controllerKey, methodKey) => methodKey,
});

SwaggerModule.setup('api/docs', app, document);

// Export spec as JSON for CI consumption
import { writeFileSync } from 'fs';
writeFileSync('./openapi.json', JSON.stringify(document, null, 2));
```

**operationIdFactory:** Using `methodKey` means your controller method names become operationIds. Name them well:

| Controller Method | Generated operationId | Generated Hook |
|---|---|---|
| `getInvoices()` | `getInvoices` | `useGetInvoices` |
| `getInvoiceById()` | `getInvoiceById` | `useGetInvoiceById` |
| `createInvoice()` | `createInvoice` | `useCreateInvoice` |
| `updateInvoice()` | `updateInvoice` | `useUpdateInvoice` |
| `deleteInvoice()` | `deleteInvoice` | `useDeleteInvoice` |

**Backend requirements for clean codegen:**

| Requirement | Why |
|---|---|
| `@ApiTags('Invoices')` on every controller | orval groups output files by tag |
| `@ApiOperation({ summary: '...' })` on every endpoint | Documents the spec |
| `@ApiResponse({ status, type })` on every endpoint | Generates response types |
| Method names follow `verbResource` pattern | Clean operationIds → clean hook names |
| All DTOs use `@ApiProperty` / `@ApiPropertyOptional` | Generates request/response types |

### orval Configuration

```typescript
// orval.config.ts (project root)
import { defineConfig } from 'orval';

export default defineConfig({
  api: {
    input: {
      // Option A: Read from running dev server
      target: 'http://localhost:3000/api-json',
      // Option B: Read from committed spec file
      // target: './openapi.json',
    },
    output: {
      target: 'apps/web/src/lib/api/generated',
      client: 'react-query',
      mode: 'tags-split',        // one file per @ApiTags group
      httpClient: 'axios',
      override: {
        mutator: {
          path: 'apps/web/src/lib/api/client.ts',
          name: 'customInstance',
        },
        query: {
          useQuery: true,
          useMutation: true,
          signal: true,           // AbortController support
        },
      },
      mock: true,                 // generate MSW handlers
    },
  },
});
```

### Custom Axios Instance

```typescript
// apps/web/src/lib/api/client.ts
import Axios, { AxiosRequestConfig } from 'axios';

const axios = Axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});

// Auth token injection
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error interceptor — normalize to app error shape
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('access_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

// orval mutator signature
export const customInstance = <T>(config: AxiosRequestConfig): Promise<T> =>
  axios(config).then(({ data }) => data);
```

### Generated Output Structure

With `mode: 'tags-split'`, orval produces one file per `@ApiTags` group:

```
apps/web/src/lib/api/generated/
├── invoices.ts          # Query + mutation hooks for Invoices tag
├── users.ts             # Query + mutation hooks for Users tag
├── auth.ts              # Query + mutation hooks for Auth tag
├── invoices.msw.ts      # MSW handlers for Invoices
├── users.msw.ts         # MSW handlers for Users
├── auth.msw.ts          # MSW handlers for Auth
└── model/               # All request/response types
    ├── createInvoiceDto.ts
    ├── updateInvoiceDto.ts
    ├── invoiceResponseDto.ts
    ├── paginatedInvoiceListDto.ts
    └── index.ts
```

**What gets generated per tag file:**

```typescript
// apps/web/src/lib/api/generated/invoices.ts (generated — DO NOT EDIT)

// Query hooks (GET endpoints)
export const useGetInvoices = (params?: GetInvoicesParams, options?: ...) => useQuery(...)
export const useGetInvoiceById = (id: string, options?: ...) => useQuery(...)

// Mutation hooks (POST/PATCH/DELETE endpoints)
export const useCreateInvoice = (options?: ...) => useMutation(...)
export const useUpdateInvoice = (options?: ...) => useMutation(...)
export const useDeleteInvoice = (options?: ...) => useMutation(...)

// Query keys (for invalidation)
export const getGetInvoicesQueryKey = (params?: GetInvoicesParams) => [...]
```

### Package Scripts

```jsonc
// package.json (root)
{
  "scripts": {
    "gen:api": "orval",
    "gen:api:watch": "orval --watch",
    "gen:api:check": "orval && git diff --exit-code apps/web/src/lib/api/generated/"
  }
}
```

### Dev vs CI Workflow

**Development:**
```bash
# Terminal 1: Start API
pnpm --filter api dev

# Terminal 2: Generate client from running server
pnpm gen:api

# Or watch mode — regenerates when spec changes
pnpm gen:api:watch
```

**CI Pipeline:**
```yaml
# .github/workflows/ci.yml (relevant step)
- name: Generate API client
  run: pnpm gen:api --input ./openapi.json

- name: Check for spec drift
  run: |
    pnpm gen:api:check
    if [ $? -ne 0 ]; then
      echo "::error::Generated API client is out of date. Run 'pnpm gen:api' and commit."
      exit 1
    fi

- name: Detect breaking changes
  run: npx openapi-diff openapi.json openapi.prev.json --fail-on-incompatible
```

### Generated Files: gitignore vs Commit

| Approach | Pros | Cons |
|---|---|---|
| **`.gitignore` generated files** | No noise in PRs, always fresh | CI must generate before build, new devs need running API |
| **Commit generated files** | Explicit, visible in PRs, works offline | PRs have noisy diffs, risk of stale committed files |

**Recommended:** Commit `openapi.json`, gitignore generated client code. CI regenerates from the committed spec and fails if the spec itself is stale (checked via `openapi-diff`).

```gitignore
# .gitignore
apps/web/src/lib/api/generated/
!openapi.json
```

### Usage in Components

```tsx
// apps/web/src/features/invoices/InvoiceList.tsx
import { useGetInvoices } from '@/lib/api/generated/invoices';
import { getGetInvoicesQueryKey } from '@/lib/api/generated/invoices';
import { useQueryClient } from '@tanstack/react-query';

export function InvoiceList() {
  const { data, isLoading, error } = useGetInvoices({ page: 1, pageSize: 20 });
  // data is fully typed — InvoiceResponseDto[]
}
```

```tsx
// apps/web/src/features/invoices/CreateInvoiceForm.tsx
import { useCreateInvoice } from '@/lib/api/generated/invoices';
import { getGetInvoicesQueryKey } from '@/lib/api/generated/invoices';

export function CreateInvoiceForm() {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useCreateInvoice({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetInvoicesQueryKey() });
      },
    },
  });

  const handleSubmit = (values: CreateInvoiceDto) => mutate({ data: values });
}
```

### MSW Testing Integration

```typescript
// apps/web/src/test/setup.ts
import { setupServer } from 'msw/node';
import { getInvoicesMSW } from '@/lib/api/generated/invoices.msw';
import { getUsersMSW } from '@/lib/api/generated/users.msw';

export const server = setupServer(...getInvoicesMSW(), ...getUsersMSW());

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### Rules

| Rule | Rationale |
|---|---|
| **NEVER** write manual `fetch()` or `axios.get()` calls | Generated hooks handle typing, caching, error states |
| **NEVER** manually create API request/response types | Types come from the OpenAPI spec — single source of truth |
| **NEVER** edit files in `generated/` | They are overwritten on every `pnpm gen:api` run |
| API spec is the contract | Backend changes propagate to frontend automatically via codegen |
| Breaking spec changes MUST be caught in CI | `openapi-diff` compares current vs previous spec |
| Every controller method follows `verbResource` naming | Clean operationIds → predictable hook names |
| Every controller has `@ApiTags` | orval uses tags to split output files |
| Every endpoint has `@ApiResponse` with typed DTO | Without it, response types default to `unknown` |
