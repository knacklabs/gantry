# Security Conventions

## HTTP Security (Helmet)

Helmet is enabled globally in `main.ts` with strict Content Security Policy.

```typescript
// main.ts
import helmet from 'helmet';

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", process.env.API_URL],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    noSniff: true,
  }),
);

app.enableCors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['https://app.example.com'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
  maxAge: 3600,
});
// NEVER use origin: '*' in production
```

**Rules:**
- HSTS with `includeSubDomains` and `preload` — always on in production.
- `X-Frame-Options: DENY` via `frameguard` — no embedding allowed.
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing.
- CORS origins are an explicit allowlist from `CORS_ORIGINS` env var.

## Rate Limiting

Use `@nestjs/throttler` for all rate limiting. Global default: **100 requests per minute**.

```typescript
// app.module.ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60000, limit: 100 }],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

```typescript
// Per-endpoint overrides
@Throttle({ default: { ttl: 60000, limit: 10 } })  // Auth: 10 req/min
@Post('auth/login')
login() {}

@Throttle({ default: { ttl: 60000, limit: 200 } })  // Public API: higher limit
@Get('public/feed')
getFeed() {}

@SkipThrottle()  // Health checks only
@Get('health')
health() {}
```

**Rules:**
- Every response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.
- Auth endpoints (`/auth/*`): **10 req/min** — no exceptions.
- Public APIs: configurable per-endpoint, document the limit in the controller.
- Never disable rate limiting globally.

## Input Validation

Global `ValidationPipe` with `whitelist: true` to strip unknown properties.

```typescript
// main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

```typescript
// Example DTO with strict constraints
import { IsString, MaxLength, IsInt, Min, Max, ArrayMaxSize, IsEmail } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @MaxLength(72)  // bcrypt max input length
  password: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags: string[];

  @IsInt()
  @Min(0)
  @Max(150)
  age: number;
}
```

**File uploads:** Use `FileInterceptor` with limits:
- Max size: 5 MB default (configurable per endpoint).
- Allowed MIME types: explicit whitelist (`image/png`, `image/jpeg`, `application/pdf`).
- Validate MIME from file magic bytes, not just the `Content-Type` header.

**Hard bans:**
- No `eval()` or `new Function()` anywhere in the codebase.
- No string-concatenated SQL — use parameterized queries or ORM exclusively.
- No template literal injection in HTML responses.

## Authentication & Authorization

| Parameter | Value |
|-----------|-------|
| Access token expiry | 15 minutes |
| Refresh token expiry | 7 days |
| Refresh token rotation | One-time use; revoke on reuse (detect token theft) |
| Password hashing | bcrypt, cost factor 12 |
| API keys | SHA-256 hashed in DB, never stored plaintext |

**Rules:**
- RBAC enforced via `@Roles()` decorator + `RolesGuard` — never inline role checks in handlers.
- Refresh tokens are single-use. If a refresh token is presented twice, revoke the entire family.
- JWTs contain only `sub`, `roles`, and `iat`/`exp` — no PII in tokens.
- API keys are shown to the user once at creation, stored as `sha256(key)` in the database.

## Secrets Management

- **All secrets** come from environment variables. No hardcoded secrets, ever.
- `.env` files are **never committed**. `.gitignore` includes `.env*`.
- `.env.example` exists with dummy/placeholder values for onboarding.
- Secrets must **never appear in logs** — sanitize logger output.
- In CI/CD, use the platform's secret store (GitHub Actions secrets, Vault, etc.).

## Dependencies

- `pnpm-lock.yaml` is committed and required for reproducible builds.
- `npm audit` runs in CI — **pipeline fails on high or critical vulnerabilities**.
- Renovate or Dependabot is enabled for automated dependency PRs.
- Review dependency PRs within 1 week; don't let them pile up.

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Do This Instead |
|---|---|
| `origin: '*'` in CORS config | Explicit origin allowlist from env var |
| `eval()` or `new Function()` | Static logic; use a safe parser if needed |
| SQL via string concatenation | Parameterized queries or TypeORM/Prisma |
| Secrets in code or `.env` committed | Environment variables + `.env.example` with dummies |
| `@SkipThrottle()` on auth routes | Stricter limits (`10 req/min`) on auth routes |
| JWT with 24h+ expiry | 15min access + 7d refresh with rotation |
| Plaintext API keys in DB | Store `sha256(key)`; show key once at creation |
| `forbidNonWhitelisted: false` | Always `whitelist: true` + `forbidNonWhitelisted: true` |
| No max length on string inputs | `@MaxLength()` on every string field |
| MIME type check via header only | Validate magic bytes with `file-type` package |
| Inline role checks in handlers | `@Roles()` decorator + `RolesGuard` |
| `console.log(password)` / logging secrets | Sanitize all log output; never log credentials |
