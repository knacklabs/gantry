import { Injectable } from "@nestjs/common";

import type { ParsedOnboardingFields } from "./onboarding-parser.service.js";
import { OnboardingValidationRepository } from "./onboarding-validation.repository.js";

export type NormalizedOnboardingFields = {
  name: string;
  personalEmail: string;
  contactNo?: string;
  doj: string;
  employmentType: "fte" | "contractor";
  designation: string;
  laptop?: string;
  relocation?: string;
  slackChannels: string[];
};

export type OnboardingValidationResult = {
  valid: boolean;
  normalized: NormalizedOnboardingFields | null;
  validationErrors: string[];
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

@Injectable()
export class OnboardingValidationService {
  constructor(private readonly onboardingValidationRepository: OnboardingValidationRepository) {}

  async validate(fields: ParsedOnboardingFields): Promise<OnboardingValidationResult> {
    const normalizedName = normalizeWhitespace(fields.name);
    const normalizedPersonalEmail = normalizeWhitespace(fields.personalEmail)?.toLowerCase() ?? null;
    const normalizedDoj = normalizeDate(fields.doj);
    const normalizedEmploymentType = fields.employmentType;
    const normalizedDesignation = normalizeWhitespace(fields.designation);
    const validationErrors: string[] = [];

    if (!normalizedName) {
      validationErrors.push("name is required");
    }

    if (!normalizedPersonalEmail) {
      validationErrors.push("personalEmail is required");
    } else if (!emailPattern.test(normalizedPersonalEmail)) {
      validationErrors.push("personalEmail must be a valid email");
    }

    if (!normalizeWhitespace(fields.doj)) {
      validationErrors.push("doj is required");
    } else if (!normalizedDoj) {
      validationErrors.push("doj must be a valid date");
    }

    if (!normalizedEmploymentType) {
      validationErrors.push("employmentType is required");
    }

    if (!normalizedDesignation) {
      validationErrors.push("designation is required");
    }

    if (normalizedEmploymentType === "fte" && normalizedDesignation) {
      const designationExists = await this.onboardingValidationRepository.activeFteDesignationExists(
        normalizedDesignation
      );

      if (!designationExists) {
        validationErrors.push("designation is not approved for fte onboarding");
      }
    }

    if (normalizedPersonalEmail && emailPattern.test(normalizedPersonalEmail)) {
      const [personalEmailExists, workEmailExists] = await Promise.all([
        this.onboardingValidationRepository.employeePersonalEmailExists(normalizedPersonalEmail),
        this.onboardingValidationRepository.employeeWorkEmailExists(normalizedPersonalEmail)
      ]);

      if (personalEmailExists) {
        validationErrors.push("employee with personalEmail already exists");
      }

      if (workEmailExists) {
        validationErrors.push("employee with workEmail matching personalEmail already exists");
      }
    }

    if (validationErrors.length > 0 || !normalizedName || !normalizedPersonalEmail || !normalizedDoj || !normalizedEmploymentType || !normalizedDesignation) {
      return {
        valid: false,
        normalized: null,
        validationErrors
      };
    }

    return {
      valid: true,
      normalized: {
        name: normalizedName,
        personalEmail: normalizedPersonalEmail,
        ...(normalizeWhitespace(fields.contactNo) ? { contactNo: normalizeWhitespace(fields.contactNo)! } : {}),
        doj: normalizedDoj,
        employmentType: normalizedEmploymentType,
        designation: normalizedDesignation,
        ...(normalizeWhitespace(fields.laptop) ? { laptop: normalizeWhitespace(fields.laptop)! } : {}),
        ...(normalizeWhitespace(fields.relocation) ? { relocation: normalizeWhitespace(fields.relocation)! } : {}),
        slackChannels: normalizeSlackChannels(fields.slackChannels)
      },
      validationErrors: []
    };
  }
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : null;
}

function normalizeDate(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return null;
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);

  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const canonicalDate = date.toISOString().slice(0, 10);

    return canonicalDate === normalized ? canonicalDate : null;
  }

  const timestamp = Date.parse(normalized);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function normalizeSlackChannels(slackChannels: string[]): string[] {
  return [
    ...new Set(
      slackChannels
        .flatMap((channel) => channel.split(/[,\s]+/u))
        .map((channel) => channel.trim().replace(/^#+/u, ""))
        .filter(Boolean)
    )
  ];
}

function formatDateParts(year: number, month: number, day: number): string {
  return [year, month, day].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
}
