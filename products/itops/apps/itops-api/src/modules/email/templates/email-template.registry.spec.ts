import { describe, expect, it } from "vitest";

import { EMAIL_TEMPLATE_KEY } from "../email.types.js";
import { EmailTemplateRegistry } from "./email-template.registry.js";

describe("EmailTemplateRegistry", () => {
  it("renders the Google Workspace welcome template with the work email and temporary password", () => {
    const registry = new EmailTemplateRegistry();

    const rendered = registry.render(EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome, {
      employeeFullName: "Riya Sharma",
      workEmail: "riya.sharma@company.com",
      temporaryPassword: "temp-password-123"
    });

    expect(rendered.subject).toBe("Welcome to CAW - your email account is ready");
    expect(rendered.text).toContain("riya.sharma@company.com");
    expect(rendered.text).toContain("temp-password-123");
    expect(rendered.html).toContain("CAW");
    expect(rendered.html).toContain("Product-engineering for all");
    expect(rendered.html).toContain("#ffd43b");
    expect(rendered.html).toContain("temp-password-123");
  });

  it("does not include a temporary password when one is not provided", () => {
    const registry = new EmailTemplateRegistry();

    const rendered = registry.render(EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome, {
      employeeFullName: "Riya Sharma",
      workEmail: "riya.sharma@company.com"
    });

    expect(rendered.text).toContain("riya.sharma@company.com");
    expect(rendered.text).not.toContain("Temporary password:");
    expect(rendered.text).toContain("Password/setup instructions will be shared separately");
    expect(rendered.html).not.toContain("Temporary password</div>");
  });
});
