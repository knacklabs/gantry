import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedOnboardingFields } from "./onboarding-parser.service.js";
import type { OnboardingValidationRepository } from "./onboarding-validation.repository.js";
import { OnboardingValidationService } from "./onboarding-validation.service.js";

type OnboardingValidationRepositoryMock = {
  activeFteDesignationExists: ReturnType<typeof vi.fn>;
  employeePersonalEmailExists: ReturnType<typeof vi.fn>;
  employeeWorkEmailExists: ReturnType<typeof vi.fn>;
};

describe("OnboardingValidationService", () => {
  let repository: OnboardingValidationRepositoryMock;
  let service: OnboardingValidationService;

  beforeEach(() => {
    repository = {
      activeFteDesignationExists: vi.fn(async () => true),
      employeePersonalEmailExists: vi.fn(async () => false),
      employeeWorkEmailExists: vi.fn(async () => false)
    };
    service = new OnboardingValidationService(repository as unknown as OnboardingValidationRepository);
  });

  it("validates an FTE with an approved designation", async () => {
    await expect(service.validate(makeFields())).resolves.toEqual({
      valid: true,
      normalized: {
        name: "Riya Sharma",
        personalEmail: "riya.personal@example.com",
        contactNo: "+91 9876543210",
        doj: "2026-07-01",
        employmentType: "fte",
        designation: "Backend Engineer",
        laptop: "MacBook Pro",
        relocation: "No",
        slackChannels: ["backend-alerts", "engineering"]
      },
      validationErrors: []
    });

    expect(repository.activeFteDesignationExists).toHaveBeenCalledWith("Backend Engineer");
    expect(repository.employeePersonalEmailExists).toHaveBeenCalledWith("riya.personal@example.com");
    expect(repository.employeeWorkEmailExists).toHaveBeenCalledWith("riya.personal@example.com");
  });

  it("fails an FTE with an invalid designation", async () => {
    repository.activeFteDesignationExists.mockResolvedValue(false);

    await expect(service.validate(makeFields({ designation: "Unapproved Engineer" }))).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: ["designation is not approved for fte onboarding"]
    });
  });

  it("allows a contractor with a custom designation", async () => {
    await expect(
      service.validate(makeFields({ employmentType: "contractor", designation: "Security Consultant" }))
    ).resolves.toMatchObject({
      valid: true,
      normalized: {
        employmentType: "contractor",
        designation: "Security Consultant"
      },
      validationErrors: []
    });

    expect(repository.activeFteDesignationExists).not.toHaveBeenCalled();
  });

  it("fails invalid email", async () => {
    await expect(service.validate(makeFields({ personalEmail: "not-an-email" }))).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: ["personalEmail must be a valid email"]
    });

    expect(repository.employeePersonalEmailExists).not.toHaveBeenCalled();
    expect(repository.employeeWorkEmailExists).not.toHaveBeenCalled();
  });

  it("fails invalid date", async () => {
    await expect(service.validate(makeFields({ doj: "2026-02-30" }))).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: ["doj must be a valid date"]
    });
  });

  it("fails duplicate personal email", async () => {
    repository.employeePersonalEmailExists.mockResolvedValue(true);

    await expect(service.validate(makeFields())).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: ["employee with personalEmail already exists"]
    });
  });

  it("fails duplicate work email matching personal email", async () => {
    repository.employeeWorkEmailExists.mockResolvedValue(true);

    await expect(service.validate(makeFields())).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: ["employee with workEmail matching personalEmail already exists"]
    });
  });

  it("allows duplicate names when the personal email is different", async () => {
    await expect(service.validate(makeFields({ name: "Test User", personalEmail: "new.user@example.com" }))).resolves.toMatchObject({
      valid: true,
      normalized: {
        name: "Test User",
        personalEmail: "new.user@example.com"
      },
      validationErrors: []
    });

    expect(repository.employeePersonalEmailExists).toHaveBeenCalledWith("new.user@example.com");
  });

  it("normalizes email, name, date, and Slack channels", async () => {
    await expect(
      service.validate(
        makeFields({
          name: "  RIYA   SHARMA  ",
          personalEmail: " RIYA.Personal@Example.COM ",
          doj: "01 July 2026",
          contactNo: null,
          laptop: null,
          relocation: null,
          slackChannels: ["#backend-alerts", "engineering", "backend-alerts", "#product,design"]
        })
      )
    ).resolves.toEqual({
      valid: true,
      normalized: {
        name: "RIYA SHARMA",
        personalEmail: "riya.personal@example.com",
        doj: "2026-07-01",
        employmentType: "fte",
        designation: "Backend Engineer",
        slackChannels: ["backend-alerts", "engineering", "product", "design"]
      },
      validationErrors: []
    });
  });

  it("reports missing required fields", async () => {
    await expect(
      service.validate(
        makeFields({
          name: null,
          personalEmail: null,
          doj: null,
          employmentType: null,
          designation: null
        })
      )
    ).resolves.toEqual({
      valid: false,
      normalized: null,
      validationErrors: [
        "name is required",
        "personalEmail is required",
        "doj is required",
        "employmentType is required",
        "designation is required"
      ]
    });

    expect(repository.activeFteDesignationExists).not.toHaveBeenCalled();
  });
});

function makeFields(overrides: Partial<ParsedOnboardingFields> = {}): ParsedOnboardingFields {
  return {
    name: "Riya Sharma",
    personalEmail: "riya.personal@example.com",
    contactNo: "+91 9876543210",
    doj: "2026-07-01",
    employmentType: "fte",
    designation: "Backend Engineer",
    laptop: "MacBook Pro",
    relocation: "No",
    slackChannels: ["backend-alerts", "engineering"],
    ...overrides
  };
}
