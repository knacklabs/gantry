import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { EmailGeneratorService, generateCompanyEmail } from "./email-generator.service.js";

describe("generateCompanyEmail", () => {
  it("generates first.last email for a normal name", async () => {
    await expect(
      generateCompanyEmail({
        fullName: "Riya Sharma",
        domain: "company.com",
        isEmailTaken: async () => false
      })
    ).resolves.toBe("riya.sharma@company.com");
  });

  it("handles extra spaces and uppercase input", async () => {
    await expect(
      generateCompanyEmail({
        fullName: "  RIYA   SHARMA  ",
        domain: "Company.COM",
        isEmailTaken: async () => false
      })
    ).resolves.toBe("riya.sharma@company.com");
  });

  it("removes or normalizes unsafe characters", async () => {
    await expect(
      generateCompanyEmail({
        fullName: "  Ríya   O' Sharma-Jr.  ",
        domain: "@Company.COM",
        isEmailTaken: async () => false
      })
    ).resolves.toBe("riya.jr@company.com");
  });

  it("uses the second candidate when the base email is taken", async () => {
    const isEmailTaken = vi.fn(async (email: string) => email === "riya.sharma@company.com");

    await expect(
      generateCompanyEmail({
        fullName: "Riya Sharma",
        domain: "company.com",
        isEmailTaken
      })
    ).resolves.toBe("riya.sharma2@company.com");

    expect(isEmailTaken).toHaveBeenCalledWith("riya.sharma@company.com");
    expect(isEmailTaken).toHaveBeenCalledWith("riya.sharma2@company.com");
  });

  it("continues until an available candidate is found", async () => {
    const takenEmails = new Set(["riya.sharma@company.com", "riya.sharma2@company.com"]);

    await expect(
      generateCompanyEmail({
        fullName: "Riya Sharma",
        domain: "company.com",
        isEmailTaken: async (email) => takenEmails.has(email)
      })
    ).resolves.toBe("riya.sharma3@company.com");
  });

  it("throws for names without email-safe characters", async () => {
    await expect(
      generateCompanyEmail({
        fullName: "!! -- '",
        domain: "company.com",
        isEmailTaken: async () => false
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws for empty domains", async () => {
    await expect(
      generateCompanyEmail({
        fullName: "Riya Sharma",
        domain: "   @   ",
        isEmailTaken: async () => false
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("EmailGeneratorService", () => {
  it("delegates to generateCompanyEmail", async () => {
    const service = new EmailGeneratorService();

    await expect(
      service.generateCompanyEmail({
        fullName: "Riya Sharma",
        domain: "company.com",
        isEmailTaken: async () => false
      })
    ).resolves.toBe("riya.sharma@company.com");
  });
});
