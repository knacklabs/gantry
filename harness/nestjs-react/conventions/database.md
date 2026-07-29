# Database Conventions
> Canon: <!-- canon: constitution/pnp-database-standards.md --> — this file only adds NestJS-React scaffold specifics.

Prisma + PostgreSQL rules for the modular monolith. Every migration, schema change, and query goes through these.

## Schema Design

### Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Tables | snake_case, plural | `users`, `invoice_line_items` |
| Columns | snake_case | `created_at`, `billing_address_id` |
| Indexes | `idx_{table}_{columns}` | `idx_orders_user_id` |
| Unique | `uq_{table}_{columns}` | `uq_users_email` |
| Foreign keys | `fk_{table}_{ref_table}` | `fk_orders_users` |

### Primary Keys

UUIDv7 only. Never auto-increment integers. Never UUIDv4 (random — causes B-tree page splits and poor cache locality).

UUIDv7 is timestamp-ordered, globally unique, and natively supported in PostgreSQL 18+ via `uuidv7()`. Produces sortable IDs with embedded creation timestamps.

```prisma
model User {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  // NOTE: Prisma lacks native uuidv7() support. Use a migration to set the default:
  // ALTER TABLE users ALTER COLUMN id SET DEFAULT uuidv7();
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("users")
}
```

**Migration to set UUIDv7 default (run once per table):**

```sql
-- In your migration file
ALTER TABLE users ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE projects ALTER COLUMN id SET DEFAULT uuidv7();
-- Repeat for every table
```

**Why UUIDv7 over cuid2/nanoid:**
- Native Postgres function — no application-layer generation
- Timestamp-ordered — sequential inserts, minimal B-tree page splits
- Extractable timestamp: `SELECT uuid_extract_timestamp(id) FROM users;`
- Standard RFC 9562 — portable across languages and databases

### Required Columns

Every table gets these three. No exceptions:

| Column | Type | Default |
|--------|------|---------|
| `id` | String @db.Uuid | `uuidv7()` (via migration) |
| `created_at` | DateTime | `@default(now())` |
| `updated_at` | DateTime | `@updatedAt` |

### Soft Deletes

Nullable `deleted_at` timestamp. Never a boolean `is_deleted` flag.

```prisma
model Invoice {
  id        String    @id @default(cuid())
  deletedAt DateTime? @map("deleted_at")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@index([deletedAt])
  @@map("invoices")
}
```

### Indexes

- Every foreign key column gets an index
- Add composite indexes for frequent query patterns
- Partial indexes for soft-delete filtering where supported

```prisma
model Order {
  id     String @id @default(cuid())
  userId String @map("user_id")
  status String
  user   User   @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([userId, status])
  @@map("orders")
}
```

### Enum Strategy

| Stability | Strategy | Example |
|-----------|----------|---------|
| Stable (rarely changes) | Postgres native enum | `order_status: pending, confirmed, shipped` |
| Volatile (changes often) | String + CHECK constraint | Feature flags, tag categories |

```prisma
enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELLED
}
```

For volatile sets, use a `String` column validated at the application layer.

## Migrations

### Naming

Format: `YYYYMMDD_HHMMSS_description`

```
20260315_143000_create_users_table
20260315_143500_add_email_index_to_users
20260316_090000_create_invoices_table
```

### Rules

| Rule | Detail |
|------|--------|
| One concern per migration | Don't mix table creation with data backfill |
| Always reversible | Every migration has both `up` and `down` |
| Schema ≠ data | Data migrations in separate files, prefixed `data_` |
| Squash at 20 | When a domain exceeds 20 migrations, squash into a baseline |

Data migration example:

```
20260316_100000_data_backfill_user_display_names
```

### Squashing

When migration count per domain exceeds 20:

1. Generate a baseline migration from current schema state
2. Archive old migrations in `prisma/archive/{domain}/`
3. Test that fresh `prisma migrate deploy` matches production schema

## Prisma Setup

### Multi-Schema (Modular Monolith)

One schema file per domain module. Merged at generation time.

```
prisma/
├── base.prisma          # datasource + generator config
├── modules/
│   ├── auth.prisma      # User, Session, Role
│   ├── billing.prisma   # Invoice, Payment, Subscription
│   └── inventory.prisma # Product, Warehouse, Stock
└── migrations/
```

`base.prisma` contains the datasource and generator block only:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider      = "prisma-client-js"
  previewFeatures = ["prismaSchemaFolder"]
}
```

### Client Generation

Generate per worktree. Never share a generated client across worktrees.

```bash
# In worktree boot script
npx prisma generate
npx prisma migrate deploy
```

### Repository Pattern

No raw SQL in services. All database access goes through repository classes.

```typescript
// ✅ Correct — repository handles queries
@Injectable()
export class OrderRepository {
  constructor(private prisma: PrismaService) {}

  async findActiveByUser(userId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ❌ Wrong — service talks to Prisma directly
@Injectable()
export class OrderService {
  constructor(private prisma: PrismaService) {}

  async getOrders(userId: string) {
    return this.prisma.$queryRaw`SELECT * FROM orders WHERE user_id = ${userId}`;
  }
}
```

### Soft Delete Middleware

Global Prisma middleware filters deleted records automatically:

```typescript
prisma.$use(async (params, next) => {
  if (params.action === 'findMany' || params.action === 'findFirst') {
    params.args.where = { ...params.args.where, deletedAt: null };
  }
  if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deletedAt: new Date() };
  }
  return next(params);
});
```

### Seed Scripts

Must complete in under 5 seconds. Use factories, not raw inserts.

```typescript
// prisma/seed.ts
import { UserFactory, OrderFactory } from './factories';

async function main() {
  const users = await UserFactory.createMany(5);
  await OrderFactory.createMany(10, { userId: users[0].id });
}
```

## Anti-Patterns

### No JSON Columns for Structured Data

```typescript
// ❌ Don't store structured data as JSON
model User {
  id       String @id @default(cuid())
  address  Json   // loses type safety, can't query efficiently
}

// ✅ Use proper relations
model User {
  id        String   @id @default(cuid())
  addresses Address[]
}

model Address {
  id     String @id @default(cuid())
  userId String @map("user_id")
  street String
  city   String
  user   User   @relation(fields: [userId], references: [id])
}
```

### No Nullable Booleans

```typescript
// ❌ Three states (true, false, null) = bugs
isVerified Boolean?

// ✅ Use enum or default
isVerified Boolean @default(false)

// ✅ Or use an enum for multi-state
verificationStatus VerificationStatus @default(PENDING)
```

### No Business Logic in Triggers

Keep all business logic in the application layer. Database triggers are invisible, untestable, and break the layer model.

### No Cross-Module Joins

Modules own their data. If module A needs data from module B, use events to sync a denormalized copy.

```typescript
// ❌ Billing module joins to auth module's users table
SELECT i.*, u.email FROM invoices i JOIN users u ON i.user_id = u.id;

// ✅ Billing stores its own customer_email, synced via event
@OnEvent('user.updated')
async handleUserUpdate(payload: UserUpdatedEvent) {
  await this.invoiceRepo.updateCustomerEmail(payload.userId, payload.email);
}
```

---

## Full-Text Search (PostgreSQL tsvector)

Use Postgres native FTS before reaching for Elasticsearch. For most CRUD apps it's enough, it's transactional, and it's zero extra infrastructure.

### Schema Pattern

Add a `search_vector` column with a GIN index. Use a virtual generated column (PG18 default) to keep it in sync automatically.

```sql
-- Migration
ALTER TABLE projects ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX idx_projects_search ON projects USING gin(search_vector);
```

**Weight strategy:**

| Weight | Use For | Example |
|--------|---------|---------|
| A (highest) | Title, name | `project.name` |
| B | Description, summary | `project.description` |
| C | Body content | `comment.body` |
| D (lowest) | Metadata, tags | `project.tags` |

### Prisma Integration

Prisma doesn't support tsvector natively. Use `$queryRaw` in the repository (this is the one exception to "no raw SQL"):

```typescript
// projects/projects.repository.ts
async search(query: string, limit: number = 20): Promise<ProjectSearchResult[]> {
  return this.prisma.$queryRaw<ProjectSearchResult[]>`
    SELECT id, name, description,
           ts_rank(search_vector, websearch_to_tsquery('english', ${query})) AS rank
    FROM projects
    WHERE search_vector @@ websearch_to_tsquery('english', ${query})
      AND deleted_at IS NULL
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
}
```

### Rules

| Rule | Detail |
|------|--------|
| Always use `websearch_to_tsquery` | Handles user input safely (not `plainto_tsquery`) |
| Specify language config explicitly | `'english'` — never rely on `default_text_search_config` |
| Weight your vectors | Title > description > body > metadata |
| GIN not GiST | GIN is faster for reads. GiST only if you need distance ranking with very high write throughput |
| Parallel GIN builds | PG18: `SET max_parallel_maintenance_workers = 7;` for faster index creation |
| Keep it in the repository | Raw SQL for search is acceptable — isolate it, type the return |

### When to Outgrow Postgres FTS

- You need fuzzy matching / typo tolerance (trigrams can help, but limited)
- You need faceted search with aggregations
- You need per-field boosting that changes at query time
- Document count exceeds ~10M rows with complex queries

At that point, consider Elasticsearch/OpenSearch synced via events.

---

## Vector Search (pgvector)

Use pgvector for embedding storage, similarity search, and RAG retrieval. Keeps vectors co-located with your relational data — ACID-compliant, JOINable, no separate vector DB.

### Extension Setup

```sql
-- Migration: enable pgvector (once per database)
CREATE EXTENSION IF NOT EXISTS vector;
```

### Schema Pattern

```prisma
// Prisma doesn't have a native vector type. Use Unsupported.
model Document {
  id          String   @id @db.Uuid
  content     String
  // 1536 = OpenAI text-embedding-3-small, 768 = many open-source models
  // Adjust to your embedding model's output dimension
  embedding   Unsupported("vector(1536)")?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("documents")
}
```

**Migration (create the column + index):**

```sql
ALTER TABLE documents ADD COLUMN embedding vector(1536);

-- HNSW index for approximate nearest neighbor search
CREATE INDEX idx_documents_embedding ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### Choosing Index Type

| Index | Use When | Trade-off |
|-------|----------|-----------|
| **HNSW** (default) | Most cases, <10M rows | Better recall, slower build, more memory |
| **IVFFlat** | Very large datasets (>10M), budget memory | Faster build, needs training data, lower recall |
| **None (exact)** | <100K rows | Perfect recall, no build time, brute-force scan |

**Always start with HNSW unless you have a reason not to.**

### HNSW Parameters

| Parameter | Default | Guidance |
|-----------|---------|----------|
| `m` | 16 | Higher = better recall, more memory. 16 is good for most cases. 32 for high-recall needs |
| `ef_construction` | 64 | Higher = better index quality, slower build. 128 for production, 64 for dev |
| `hnsw.ef_search` | 40 | Set per-query. 100-200 for high-recall. 40 for speed |

```sql
-- Production index with tuned parameters
CREATE INDEX idx_documents_embedding ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- At query time, tune recall vs speed
SET LOCAL hnsw.ef_search = 100;
```

### Distance Functions

| Operator | Function | Use When |
|----------|----------|----------|
| `<->` | L2 (Euclidean) | General purpose, unnormalized vectors |
| `<=>` | Cosine distance | Normalized embeddings (OpenAI, Cohere, most models) |
| `<#>` | Negative inner product | Maximum inner product search |

**Default to cosine (`<=>`) unless your embedding model docs say otherwise.**

### Filtered Vector Search (pgvector 0.8+)

Filtering + vector search is the #1 footgun. Without iterative scans, filters applied after the index scan can return fewer results than expected.

```sql
-- Enable iterative scanning (pgvector 0.8+)
SET hnsw.iterative_scan = relaxed_order;

-- Now filtered queries return the expected number of results
SELECT id, content, embedding <=> $1::vector AS distance
FROM documents
WHERE tenant_id = $2
  AND deleted_at IS NULL
ORDER BY embedding <=> $1::vector
LIMIT 20;
```

**Rules for filtered search:**
- Always enable `hnsw.iterative_scan = relaxed_order` in your session/transaction
- Create a B-tree index on filter columns (tenant_id, category, etc.)
- For high-selectivity filters (<10% of rows match), the B-tree filter index may outperform the HNSW scan — Postgres planner decides

### Prisma Integration

pgvector requires raw SQL (Prisma has no vector operators). Isolate in the repository:

```typescript
// documents/documents.repository.ts
async findSimilar(
  embedding: number[],
  limit: number = 10,
  tenantId?: string,
): Promise<DocumentWithDistance[]> {
  const vectorStr = `[${embedding.join(',')}]`;

  return this.prisma.$queryRaw<DocumentWithDistance[]>`
    SET LOCAL hnsw.iterative_scan = relaxed_order;
    SELECT id, content,
           embedding <=> ${vectorStr}::vector AS distance
    FROM documents
    WHERE deleted_at IS NULL
      ${tenantId ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty}
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
}
```

### Dimension Strategy

| Model | Dimensions | Type |
|-------|-----------|------|
| OpenAI text-embedding-3-small | 1536 | `vector(1536)` |
| OpenAI text-embedding-3-large | 3072 (or reduced via `output_dimensionality`) | `vector(N)` |
| Cohere embed-v4 | 1024 | `vector(1024)` |
| Open-source (BGE, E5, etc.) | 384-1024 | `vector(N)` |

**Use `output_dimensionality` when your model supports it** — smaller vectors = faster search, less storage, minimal recall loss. For HNSW indexes, dimensions up to 2000 are supported for `vector` type. Use `halfvec` for up to 4000 dimensions (half-precision, 2x storage savings).

```sql
-- Half-precision for large dimension models
ALTER TABLE documents ADD COLUMN embedding halfvec(3072);
CREATE INDEX ON documents USING hnsw (embedding halfvec_cosine_ops);
```

### Hybrid Search (FTS + Vector)

Combine keyword search and semantic search using Reciprocal Rank Fusion (RRF):

```sql
-- Hybrid search: combine FTS rank + vector distance
WITH keyword_results AS (
  SELECT id, ts_rank(search_vector, websearch_to_tsquery('english', $1)) AS kw_rank
  FROM documents
  WHERE search_vector @@ websearch_to_tsquery('english', $1)
  LIMIT 50
),
vector_results AS (
  SELECT id, embedding <=> $2::vector AS distance
  FROM documents
  ORDER BY embedding <=> $2::vector
  LIMIT 50
)
SELECT COALESCE(k.id, v.id) AS id,
       -- RRF: 1/(k+rank) with k=60 (standard)
       COALESCE(1.0 / (60 + ROW_NUMBER() OVER (ORDER BY k.kw_rank DESC)), 0) +
       COALESCE(1.0 / (60 + ROW_NUMBER() OVER (ORDER BY v.distance ASC)), 0) AS rrf_score
FROM keyword_results k
FULL OUTER JOIN vector_results v ON k.id = v.id
ORDER BY rrf_score DESC
LIMIT 20;
```

### Index Build Performance

Building HNSW indexes on large tables is slow. Speed it up:

```sql
-- Increase memory for index build (graph must fit in memory)
SET maintenance_work_mem = '4GB';

-- Parallel workers (PG18)
SET max_parallel_maintenance_workers = 7;

-- Build index after bulk load, not before
-- HNSW doesn't need training data (unlike IVFFlat) — safe to create on empty table
```

### Anti-Patterns (Vector)

| Anti-Pattern | Fix |
|-------------|-----|
| Storing embeddings in JSON column | Use `vector(N)` type with HNSW index |
| No index on <100K rows "for now" | Fine — exact search is fast. Add HNSW when p99 latency matters |
| Using L2 distance with normalized embeddings | Use cosine (`<=>`) — it's what the model was trained for |
| One giant vector column for everything | Separate columns/tables per embedding purpose (search vs recommendation vs classification) |
| Embedding at ingest time only | Re-embed when content changes. Stale embeddings = stale results |
| Ignoring `ef_search` tuning | Always tune per-query. 40 is too low for high-recall RAG |
| Filtered search without iterative scan | Enable `hnsw.iterative_scan = relaxed_order` (pgvector 0.8+) |
| Mixing vector + heavy relational joins | Retrieve candidate IDs from vector search first, then JOIN in a second query |
