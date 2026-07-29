# Design Patterns
> Canon: <!-- canon: constitution/03-modular-monolith-structure.md --> — this file only adds NestJS-React scaffold specifics.

How to write code within the architecture boundaries. Enforced by linters, structural tests, and code review.

## Modular Monolith (Non-Negotiable)

Every project starts as a modular monolith. Not a monolith you'll "refactor later." Not microservices you'll "consolidate later." A properly bounded monolith where each domain module can be extracted to a service with zero business logic changes.

Rules:
- Each NestJS module = one bounded context (domain)
- Modules communicate ONLY via the event bus or shared interfaces — never direct imports
- Each module has its own Prisma schema file (multi-schema setup)
- Module boundaries are enforced by `check-boundaries.ts` linter
- Cross-module database joins are forbidden — use events to sync denormalized data
- Each module owns its own migrations

Directory structure per module:
```
apps/api/src/billing/
  billing.module.ts          # Module definition, imports, exports
  billing.controller.ts      # HTTP layer — one controller per resource
  billing.service.ts         # Business logic
  billing.repository.ts      # Data access (Prisma)
  billing.events.ts          # Event definitions (classes)
  billing.listeners.ts       # Event handlers for OTHER modules' events
  dto/
    create-invoice.dto.ts    # Input validation
    invoice-response.dto.ts  # Output serialization
  interfaces/
    billing.interfaces.ts    # Contracts this module exposes
  errors/
    billing.errors.ts        # Domain-specific errors
```

What a module may export:
- Interfaces (contracts)
- Event classes (for other modules to listen)
- DTOs (for API contract)

What a module must NOT export:
- Services (internal implementation)
- Repositories (data access is private)
- Prisma models (internal schema)

## Provider Pattern (Third-Party Isolation)

Every external service sits behind an interface. The agent codes against the interface, never the SDK.

```typescript
// interfaces/file-storage.interface.ts
export interface FileStorage {
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number): Promise<string>;
}

// providers/s3-file-storage.ts (production)
@Injectable()
export class S3FileStorage implements FileStorage { ... }

// providers/local-file-storage.ts (dev/test)
@Injectable()
export class LocalFileStorage implements FileStorage { ... }
```

Registration via NestJS dynamic modules:
```typescript
// file-storage.module.ts
@Module({})
export class FileStorageModule {
  static register(provider: 's3' | 'local'): DynamicModule {
    return {
      module: FileStorageModule,
      providers: [{
        provide: FILE_STORAGE,
        useClass: provider === 's3' ? S3FileStorage : LocalFileStorage,
      }],
      exports: [FILE_STORAGE],
    };
  }
}
```

Required providers (every project needs these interfaces from day one):
- `FileStorage` — S3 / local filesystem
- `AuthProvider` — OIDC provider / mock auth (specific provider per BRIEF.md)
- `EmailSender` — SES / SendGrid / console logger
- `CacheProvider` — Redis / in-memory Map
- `EventBus` — see Event System below

## Event System (Cross-Module Communication)

**Local (dev/test): in-memory via NestJS EventEmitter2**
**Production: swappable to SNS+SQS, Kafka, or any provider**

### Interface

```typescript
// common/events/event-bus.interface.ts
export interface EventBus {
  emit<T extends DomainEvent>(event: T): Promise<void>;
  emitAsync<T extends DomainEvent>(event: T): Promise<void>;
}

export abstract class DomainEvent {
  readonly occurredAt: Date = new Date();
  readonly eventId: string = randomUUID();
  abstract readonly eventName: string;
}
```

### In-Memory Implementation (Default)

```typescript
// common/events/in-memory-event-bus.ts
@Injectable()
export class InMemoryEventBus implements EventBus {
  constructor(private readonly emitter: EventEmitter2) {}

  async emit<T extends DomainEvent>(event: T): Promise<void> {
    this.emitter.emit(event.eventName, event);
  }

  async emitAsync<T extends DomainEvent>(event: T): Promise<void> {
    await this.emitter.emitAsync(event.eventName, event);
  }
}
```

### Production Implementations (Swap via Config)

```typescript
// SNS+SQS (AWS-native, good for most projects)
@Injectable()
export class SnsEventBus implements EventBus { ... }

// Kafka (high-throughput, event sourcing)
@Injectable()
export class KafkaEventBus implements EventBus { ... }

// NATS/Redis Streams (lightweight, self-hosted)
@Injectable()
export class NatsEventBus implements EventBus { ... }
```

### Event Definitions

```typescript
// billing/billing.events.ts
export class InvoiceCreatedEvent extends DomainEvent {
  readonly eventName = 'billing.invoice.created';
  constructor(
    public readonly invoiceId: string,
    public readonly userId: string,
    public readonly amount: number,
  ) { super(); }
}
```

### Event Listeners

```typescript
// notifications/notification.listeners.ts
@Injectable()
export class NotificationListeners {
  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent('billing.invoice.created')
  async handleInvoiceCreated(event: InvoiceCreatedEvent): Promise<void> {
    await this.notificationService.sendInvoiceEmail(event.userId, event.invoiceId);
  }
}
```

### Event Rules
- Event names: `<domain>.<entity>.<action>` — e.g., `billing.invoice.created`
- Events are immutable value objects (readonly properties)
- Events carry IDs, not full objects (listener fetches what it needs)
- Listeners must be idempotent (production buses may deliver twice)
- Failed listeners don't block the emitting service
- Event schema changes are versioned: `billing.invoice.created.v2`

## Single Responsibility

One file, one reason to change:
- One service = one domain concept (`InvoiceService`, not `BillingHelpers`)
- One controller = one REST resource (`/invoices`, not `/billing/*`)
- One repository = one aggregate root
- If injecting more than 3 services into another service → you're mixing concerns, split

## Configuration as a Typed Boundary

No `process.env` access outside the config module. Ever.

```typescript
// config/database.config.ts
export const databaseConfig = registerAs('database', () => ({
  url: requireEnv('DATABASE_URL'),
  poolSize: parseInt(requireEnv('DB_POOL_SIZE', '10')),
  ssl: process.env.NODE_ENV === 'production',
}));

// Type-safe access everywhere else
constructor(
  @Inject(databaseConfig.KEY)
  private readonly dbConfig: ConfigType<typeof databaseConfig>,
) {}
```

Rules:
- All env vars validated at boot (fail fast, not at 3 AM)
- Default values only for non-critical settings
- Secrets never have defaults
- Config types are exported, env var names are not

## Repository Pattern (Prisma Isolation)

Services never touch Prisma directly.

```typescript
// billing/billing.repository.ts
@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findInvoiceById(id: string): Promise<Invoice | null> {
    const record = await this.prisma.invoice.findUnique({ where: { id } });
    return record ? this.toDomain(record) : null;
  }

  private toDomain(record: PrismaInvoice): Invoice {
    return { id: record.id, amount: record.amount, ... };
  }
}
```

Why:
- Services test against repository interface, not Prisma mock
- Database migration (Prisma → Drizzle → Kysely) doesn't touch services
- Domain types stay clean of database concerns

## DTO Mapping (Three Shapes Per Entity)

```
Input (CreateInvoiceDto) → Domain (Invoice) → Output (InvoiceResponseDto)
```

- Input DTOs: class-validator decorators, used in controllers
- Domain models: plain objects, used in services
- Response DTOs: serialization shape, returned to clients
- Never pass one layer's shape to another — map explicitly
- Use a `toResponse()` static method on response DTOs

## Error Escalation

Each layer throws its own error type:

| Layer | Throws | Example |
|-------|--------|---------|
| Repository | Domain errors | `RecordNotFoundError`, `DuplicateKeyError` |
| Service | NestJS exceptions | `NotFoundException`, `ConflictException` |
| Controller | Nothing | Global filter handles everything |

```typescript
// Repository
const record = await this.prisma.user.findUnique({ where: { id } });
if (!record) throw new RecordNotFoundError('User', id);

// Service
try {
  return await this.userRepo.findById(id);
} catch (error) {
  if (error instanceof RecordNotFoundError) {
    throw new NotFoundException(`User ${id} not found`);
  }
  throw error;
}
```

Error messages must be agent-readable remediation instructions:
> "User abc-123 not found. Verify the ID exists via GET /api/v1/users or check if it was soft-deleted."

## Guard Composition (Cross-Cutting Concerns)

Decorative, not imperative. Stack guards and interceptors, never inline auth/logging/feature checks:

```typescript
@Controller('invoices')
@UseGuards(JwtAuthGuard)
@UseInterceptors(LoggingInterceptor)
export class InvoiceController {

  @Post()
  @UseGuards(FeatureFlagGuard('billing-v2'))
  @UseGuards(RolesGuard(Role.ADMIN))
  async create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: AuthUser) { ... }
}
```

## What We Intentionally Skip

- **CQRS** — adds complexity agents struggle with, overkill for most projects
- **Hexagonal architecture** — our layer model covers this simpler
- **Generic repository base classes** — they always leak abstraction
- **Abstract factory patterns** — NestJS DI handles this natively
- **Service mesh** — modular monolith means no network between domains
