# PnP — Environment Naming Standards

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### 🎯 1. Purpose
This playbook defines a unified naming convention for environment names across all KnackLabs projects to ensure consistency and clarity.

---

### 🧱 2. Environment Naming Conventions
Each environment will have a standardized name format. This ensures that all developers, DevOps engineers, and tools reference environments consistently.

#### ✔ Local Environment
- **Name:** `Local`
- **Format:** Capital “L” followed by lowercase letters.
- **Usage:** Used for a developer’s local machine during development.

#### ✔ Development Environment
- **Name:** `Development`
- **Format:** Capital “D” followed by lowercase letters.
- **Usage:** Tied to the development branch and used for ongoing development and integration testing.

#### ✔ QA Environment
- **Name:** `QA`
- **Format:** Both “Q” and “A” are capitalized (`QA`).
- **Usage:** Used for quality assurance and testing.

#### ✔ UAT Environment
- **Name:** `UAT`
- **Format:** All uppercase letters (`UAT`).
- **Usage:** Used for User Acceptance Testing.

#### ✔ Staging Environment
- **Name:** `Staging`
- **Format:** Capital “S” followed by lowercase letters.
- **Usage:** Used as a pre-production environment to test final releases.

#### ✔ Production Environment
- **Name:** `Production`
- **Format:** Capital “P” followed by lowercase letters.
- **Usage:** The live production environment where end-users interact with the application.

---

### 📋 3. Summary
- **Local:** `Local` (L capital)
- **Development:** `Development` (D capital)
- **QA:** `QA` (all caps)
- **UAT:** `UAT` (all caps)
- **Staging:** `Staging` (S capital)
- **Production:** `Production` (P capital)
By following this convention, all projects will use the same environment names, reducing confusion and making it easier to manage deployment and configuration across different stages.
