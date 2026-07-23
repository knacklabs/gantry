# PnP — Database Standards

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

---
*Applicable to all NestJS + FastAPI projects, using SQL (Postgres/MySQL/SQL Server) or NoSQL (Mongo/Document stores where applicable).*

---

## 🎯 **1. Purpose**
This playbook defines the **database naming, modeling, and structural conventions** for all V1 projects across the org.
Goals:
- Enforce consistent naming across all services & migrations
- Improve readability and maintainability
- Avoid ambiguity in datetime and duration fields
- Ensure DB schema is aligned with modular monolith design
- Make future microservice extraction easier

---

## 🧱 **2. Naming Conventions**

---

### **2.1 Table Names**
**Rules:**
- Use **PascalCase**
- Must always be **singular**
- No prefixes or suffixes
- Name should represent a **domain entity**, not an action
**Examples:**
- `User`
- `Order`
- `Invoice`
- `PaymentTransaction`
- `OtpAttempt`
❌ Avoid:
- `users`
- `order_details`
- `tblUser`
- `UserTable`
- `UserModel`

---

### **2.2 Column Names**
**Rules:**
- Use **camelCase**
- Column names must be **self-explanatory**
- No table name prefix required
  - `Order.Id` → correct
  - `Order.orderId` → ❌ redundant
**Examples:**
- `id`
- `firstName`
- `isActive`
- `createdAtUtc`
- `expiresInSeconds`
❌ Avoid:
- `OrderID`
- `UserName`
- `created_at`
- `is_active`
- `expiry_secs`

---

## ⏱️ **3. Date & Time Standards (Important)**
All datetime fields must follow:

#### **Suffix: **`**AtUtc**`
Reason:
- Explicitly communicates timezone
- Enforces consistent storage in **UTC**
- Avoids timezone bugs across microservices, queues, and async flows
**Examples:**
- `createdAtUtc`
- `updatedAtUtc`
- `archivedAtUtc`
- `lastLoginAtUtc`
❌ Avoid:
- `createdAt`
- `timestamp`
- `created_on`
- `loginTime`
> Note: All application layers must convert to local time only at the edges (UI or API response), never in the DB.

---

## ⏳ **4. Duration Standards**
When storing durations:

#### **Must include units in the suffix**
Use **full words**, not abbreviations.
**Allowed suffixes:**
- `InSeconds`
- `InMinutes`
- `InHours`
- `InDays`
**Examples:**
- `expiresInSeconds`
- `validForInMinutes`
- `tokenTtlInHours`
❌ Avoid abbreviations like:
- `expirySecs`
- `ttlMin`
- `timeoutHr`
❌ Avoid confusion-causing names like:
- `expiry`
- `duration`
- `ttl`

---

## 🔐 **5. ID Conventions**

#### **Primary Keys**
- Always named `id`
- Always `UUID` unless explicitly required otherwise
  (e.g., bulk analytics tables may use BIGINT)
**Correct:**
- `Order.id`
- `User.id`
**Incorrect:**
- `orderId`
- `user_id`
- `UserId`

#### **Foreign Keys**
- Named using `<referencedEntityName>Id`
  - Always camelCase
  - Always singular
**Examples:**
- `userId`
- `orderId`
- `transactionId`
- `addressId`
❌ Avoid:
- `user_id`
- `UserID`
- `order_id_fk`
- `usersId`

---

## 🔄 **6. Boolean Columns**
**Naming pattern:**
- Must start with `is`, `has`, or `can`
**Examples:**
- `isEnabled`
- `isVerified`
- `hasAttemptedOtp`
- `canRetry`
❌ Avoid:
- `enabled`
- `verified`
- `attemptedOtp`

---

## 🏗️ **7. Table Structure Standards**
Every domain table must include a sta~ndard set of columns that enforce **auditing**, **traceability**, and **consistent data hygiene**.

---

### **7.1 Required Columns for All Domain Tables**
Every table MUST contain:

#### **Primary Key**
- `id` (UUID)

#### **Audit Timestamps**

| Column | Purpose |
| --- | --- |
| `createdAtUtc` | When the record was created |
| `updatedAtUtc` | When the record was last modified |
| `deletedAtUtc` *(nullable)* | When the record was soft-deleted |

#### **Audit User Tracking**
These fields enforce accountability.

| Column | Type | Purpose |
| --- | --- | --- |
| `createdByAccountId` | UUID | Which account created the record |
| `modifiedByAccountId` | UUID | Which account last modified the record |
| `deletedByAccountId` *(nullable)* | UUID | Which account deleted the record |

#### **Rules for audit user fields**
- Must always reference a user/account table (typically `Account.id`).
- Soft-deleted rows must **still preserve** `deletedByAccountId`.
- For system-generated operations (automated jobs), use a dedicated system account (e.g., `SystemAccountId`).

---

### **7.2 Soft Delete Standards**
If a table supports deletion, it must implement **soft delete** using:
- `deletedAtUtc`
- `deletedByAccountId`
Hard deletes should be avoided except for:
- High-volume time-series data
- Temporary staging tables
- Logs/metrics
- System-level tech tables

---

### **7.3 When NOT to Include Audit Fields**
Audit fields are optional for:
- Pure lookup tables (e.g., `Country`, `Currency`)
- Static config tables
- Many-to-many join tables with no business meaning
- System tables like:
  - migrations
  - versioning metadata
  - queue workers
  - logs

---

## 🌳 **8. Relationship Standards**

#### **8.1 One-to-Many**
- FK on the many side
- Use `<entityName>Id`

#### **8.2 Many-to-Many**
Prefer join tables:
Join table naming:
- PascalCase
- Combine both tables in alphabetical order
- Singular form
**Example:**
Tables: `User` + `Role`
Join table: `RoleUser`
Columns:
- `userId`
- `roleId`

---

## 💾 **9. Indexing Standards**

#### **Always index:**
- Foreign keys
- Frequent query filters
- Unique constraints (email, username, phone, etc.)

#### **Index names**
Use:
`idx_<table>_<column>`
Examples:
- `idx_User_email`
- `idx_Order_userId`

---

## 🔧 **10. Enum & Status Standards**
- Never store text like “Created”, “Done”, “Running”
- Always use integer-based enums or fixed text enums
**Column suffix:**
- `Status`
**Examples:**
- `orderStatus`
- `paymentStatus`

#### **Mapping rules**
- Enum mapping must exist in application layer
- Never map enums in the DB via triggers, stored procedures, etc.

---

## 📐 **11. Data Normalization Standards**
- By default: **3rd Normal Form (3NF)**
- Denormalize **only** when a performance need is proven
- No repeated information across tables (unless denormalization is documented)

#### **Avoid:**
- Storing full user info inside multiple tables
- Storing duplicated JSON blobs without reason

---

## 📄 **12. JSON & NoSQL Columns**

#### SQL JSON Fields
Allowed for:
- Metadata
- Flexible attributes
- Rarely changing structures
Not allowed for:
- Core relational data
- Frequently queried attributes

#### Mongo / NoSQL Only
Use camelCase keys inside documents.

---

## 📝 **13. Migration Standards**

#### **Rules:**
- All schema changes must have migrations
- Never edit a migration once merged
- Use timestamp-prefixed migration names
- Write reversible migrations when possible
**Naming:**
`20250101_add_paymentStatus_to_Order`

---

## 📋 **14. Developer Checklist (Before Committing)**

#### **Naming**
- [ ] Table name is PascalCase & singular
- [ ] Columns are camelCase
- [ ] Datetime columns end with `AtUtc`
- [ ] Duration columns include units (`InSeconds`, `InHours` etc.)
- [ ] No table name prefixes in column names
- [ ] All IDs & foreign keys follow naming rules

#### **Audit Fields**
- [ ] Table includes `createdAtUtc`, `updatedAtUtc`
- [ ] Table includes `createdByAccountId`, `modifiedByAccountId`
- [ ] If soft-delete: includes `deletedAtUtc`, `deletedByAccountId`
- [ ] Audit fields reference the correct Account table
- [ ] System-level tables avoid unnecessary audit fields

#### **Integrity**
- [ ] All foreign keys indexed
- [ ] No unnecessary denormalization
- [ ] Migrations created and tested

---
