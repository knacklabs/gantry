# Playbook 03 - Modular Monolith Codebase Structure

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### **What is a Modular Monolith?**
A **Modular Monolith** is an architectural style in which the application is deployed as a **single deployable unit** (like a monolith), but is internally structured into **well-defined, independent, self-contained modules** — each representing a domain.
Each module enforces:
- clear boundaries,
- strict separation of concerns,
- no circular dependencies,
- predictable data and domain ownership.
**Good external references to learn more:**
- *"Modular Monoliths"* by Kamil Grzybek
  https://www.kamilgrzybek.com/blog/modular-monolith/
- *"Microservices vs Modular Monoliths"* by Martin Fowler
  https://martinfowler.com/articles/modular-monolith.html

---

### **How Modular Monolith Differs from Monolith and Microservices**

#### **❌ Monolith (Traditional)**
- One big codebase with no strict boundaries.
- Database tables used across modules.
- Hard to refactor or scale.
- Technical debt explodes quickly.
- When requirements grow, it's painful to break into microservices.

#### **❌ Microservices (Too Early in V1)**
- Great for scale, bad for speed in the early stage.
- Complex infra: API Gateway, service discovery, security, retries, queues, monitoring, distributed tracing.
- Cross-service communication becomes a full-time job.
- Requires bigger team maturity and DevOps overhead.
- Slows down V1 velocity and significantly increases cost.

#### **✅ Modular Monolith (The Sweet Spot)**
- Simple deployment like a monolith.
- Internal structure, like microservices.
- Clear domain boundaries.
- No over-engineering.
- High dev velocity.
- Easy to refactor into microservices later — because modules are already isolated.

---

### **Why We Recommend Modular Monolith for All V1 Projects**
1. **Fast Delivery**
  V1 = speed. Modular monolith lets the team move ultra-fast without dealing with the complexity of distributed systems.
1. **No Over-Engineering**
  Microservices are great — but only when you actually need them.
  For V1? They are unnecessary weight.
1. **Cleaner Codebase from Day 1**
  Modular boundaries prevent the spaghetti architecture that usually forms in monoliths.
1. **Future-Ready (Easy to Split Into Microservices)**
  Because each domain module already behaves like a mini-service, extracting it as a microservice later is straightforward.
1. **Lower Infra & DevOps Cost**
  One deployment, one database (but logically separated per domain), simpler pipelines.
1. **Better Team Alignment**
  New developers can understand the entire system in days—not weeks.

---

### **4. Our Modular Monolith Architecture (Recommended Standard)**
Every project follows this structure:
```plain text
/src
   /common
   /service-bus
   /modules
      /user
      /auth
      /billing
      /orders
      ...

```

#### **Modules Never Depend on Each Other**
- If Module A needs something from Module B → it uses **Service Bus** to communicate.
- If multiple modules need something → it goes into **Common Module**.

---

## **Core Component 1: Common Module**
The **Common Module** is the foundation of the modular monolith.

### **Purpose**
All cross-cutting, shared, and reusable logic that multiple domain modules rely on lives here.

### **What Goes Into Common Module**
- **Base classes**
  - `BaseController`
  - `BaseService`
  - `BaseRepository`
- **Shared middlewares** (auth checks, error handling, logging)
- **Shared validators**
- **Utility helpers**
- **Common response/request structures**
- **Database abstractions** (if applicable)
- **Common interfaces and contracts**

### **Example**
If every controller needs to enforce "check user ID exists", you don’t repeat this in every module.
You put it in:
```plain text
common/base.controller.ts

```
and all modules extend from it.

### **Why It Matters**
- Avoids duplication
- Helps enforce consistency across modules
- Accelerates new module creation
- Makes migration to microservices easier
  (the Common module becomes a shared library/package)

---

## **Core Component 2: Service Bus Module**
If the **Common Module** is the skeleton, the **Service Bus Module** is the **nervous system** of the architecture.

### **Purpose**
The **Service Bus Module** acts as the internal communication layer between modules.
In V1, this is typically **in-process** or **in-memory**, but the abstraction is built in such a way that it can later connect to external queues.

### **Key Rules**
- All domain-to-domain communication goes through it.
- Service Bus **never depends on any domain module**.
- Domain modules depend on Service Bus (not the other way around).

### **What Goes Into the Service Bus**
- Event dispatcher
- Command dispatcher
- Domain event definitions
- Event handlers
- Messaging abstractions

### **Why This Matters**
1. **Keeps Modules Independent**
  Module A never imports Module B.
  All communication happens through events/commands.
1. **Easy Upgrade Path**
  When the system grows, swap the internal bus with:
  - AWS SNS/SQS
  - Kafka
  - Azure Service Bus
  - RabbitMQ
    …without changing domain logic.
1. **When Converting to Microservices Later**
  The Service Bus becomes a **published package**.
  The new microservice imports it and participates in the same event system — just using external infra instead of in-memory dispatching.

---

## **Why This Architecture is Future-Proof**
When the product scales beyond V1:
- Each domain module is already isolated like a microservice.
- Each module can be extracted into its own repo.
- Each extracted module can:
  - Use the shared `common` package, and
  - Connect to the same `service-bus` package
- You do not refactor domain logic — only the underlying bus implementation.
This reduces microservice migration effort by **up to 80%**.

---

## **Final Summary**
We standardize on **Modular Monolith** for all V1 projects because it gives us:
- **Monolith simplicity**
- **Microservice discipline**
- **High development velocity**
- **Low operational complexity**
- **Easy pathway to microservices if and when needed**
The architecture also forces the team to follow clean DDD-like practices, encourages boundaries, and scales with the product.
- 📄 **Folder Structure Templates (NestJS + FastAPI)**
- 📄 **FastAPI Folder Structure Template**
Deck - ‣
