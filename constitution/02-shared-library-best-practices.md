# Playbook 02 - Shared Library Best Practices for Monorepo

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### Purpose
In our monorepo setup at KnackLabs, the **shared library** (often in `/shared` or `/libs`) is where we place reusable code that multiple parts of the application (backend and clients, or multiple clients) need to share. This ensures consistency, reduces code duplication, and makes it easy to maintain shared logic.

---

### Types of Shared Code

#### Code Shared Between Backend and Clients (Mobile/Web)
This includes any logic or definitions that both the backend and the clients need. Examples:
- **Validation Logic**: Common validators, such as email validators, phone number validators, or other input checks. For example, if you have a 10-digit phone number validator used on the backend, place it in the shared library so the frontend can use the exact same validation.
- **DTOs and Types**: Shared TypeScript interfaces or data transfer objects (DTOs) that the backend and frontend both rely on. This ensures that both ends agree on the shape of the data.

#### Code Shared Among Clients (Mobile and Web)
This includes logic that is used by both web and mobile clients but not necessarily by the backend. Examples:
- **Common Loggers**: A shared logger class that both React.js and React Native apps can use. For example, a Sentry-based logger that takes app name, version number, and environment as parameters, and initializes Sentry accordingly. This way, you only write the logging setup once.
- **HTTP Clients and Middleware**: A common HTTP client wrapper that both web and mobile clients use to make API calls. This wrapper can handle things like setting auth tokens, adding correlation IDs, and dealing with any cross-cutting concerns.
- **Error Codes and Messages**: A shared set of custom error codes and user-friendly error messages. By placing these in the shared library, both the backend and frontend can stay in sync on what errors mean and how they should be displayed to users.

---

### Best Practices for Shared Code
- **Always Place Common Validators in Shared**: Whenever you create a validator (like email, phone number, or any form validation), put it in the shared library. This ensures both backend and frontend teams can reuse it consistently.
- **Generate API Clients in Shared for Frontend Use**: Every time a backend developer creates a new API, they should also create a TypeScript client for that API in the shared library. This client can then be easily imported by the frontend developers, making integration much smoother.
- **Shared Validation on Frontend**: For any form fields on the client side, use the same validators from the shared library. This way, the frontend validation matches the backend rules exactly.
- **Error Code Consistency**: Define a shared set of error codes and their corresponding user-friendly messages in the shared library. This ensures that when the backend returns an error code, the frontend knows exactly how to display the correct message to the user.

---

### Example: Logger and HTTP Client

#### Shared Logger Class
Create a common logger class in the shared library that both web and mobile clients use. For example, a Sentry-based logger that takes parameters like app name, version, and environment. Each platform (web or mobile) passes its specific configuration when initializing the logger.

#### Shared HTTP Client
Create a shared HTTP client class that handles API calls. It should allow setting an auth token, automatically add correlation IDs, and wrap the underlying HTTP library.
