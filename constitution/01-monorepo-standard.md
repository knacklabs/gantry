# Playbook 01 - Monorepo Standard

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

## Purpose
At KnackLabs, we prefer to use a **monorepo** structure wherever possible. This means housing the backend, web clients, and mobile apps in a single repository. This approach offers:
- Unified dependency management
- Consistent versioning across all parts of the application
- Easier code sharing and collaboration between teams

---

### When to Use a Monorepo
- **Predominantly JavaScript/TypeScript Projects**:
  If your stack is mainly JS/TS—for example, NestJS for the backend, React.js for the web frontend, and React Native for the mobile apps—then we recommend using an **Nx Workspace**. Nx is a powerful monorepo management tool that makes it easy to manage multiple apps and libraries in one repo.
- **Mixed Language Repos**:
  Even if you have a Python backend (e.g., FastAPI) and JS frontends, you can still use Nx for a unified structure. Just note there may be some limitations, such as needing to configure Python tooling manually and handling Python virtual environments separately. But overall, it still helps keep everything in one place.

---

### Shared Libraries
- **Shared Code**:
  Place common libraries (like shared TypeScript types, DTOs, or utility functions) in a `/shared` or `/libs` folder. This allows both the backend and frontend to consume the same definitions and stay in sync.
- **UI Libraries**:
  If you have common UI components shared across web and mobile, place them in the shared library folder as well. This ensures a single source of truth for design elements.

---

### Folder Structure and Environment Setup
- **Root Folder**:
  At the root of the monorepo, include a `/deployment` folder. Inside it, create a subfolder for each environment (e.g., `/deployment/development`, `/deployment/production`).
- **Deployment Pipelines and IaC**:
  Each environment folder holds the CI/CD pipelines (e.g., GitHub Actions, GitLab CI) and infrastructure-as-code files (Terraform) for provisioning. Follow the **environment naming conventions** from the Environment Naming Standards playbook (Local, Development, QA, UAT, Staging, Production).

---

### Limitations for Python Projects in Nx
- **Tooling Integration**:
  Nx is primarily optimized for JavaScript/TypeScript. When including a FastAPI (Python) project, you will need to manually manage Python virtual environments and dependencies.
- **Limited Plugin Support**:
  You may not find as many ready-made Nx plugins for Python tooling, so some scripting and custom configuration will be required.
Despite these limitations, a monorepo with Nx still provides a cohesive structure and easier cross-team collaboration.

---

### Summary
Using a monorepo approach with tools like Nx helps standardize the development workflow, makes it easier to share code, and simplifies deployment. All environment configurations and deployment pipelines live in a dedicated folder, ensuring a clear and maintainable structure.

---
Feel free to copy this into Notion, and let me know if you’d like any more details added!
