import { BadRequestException, Injectable } from "@nestjs/common";

export type GenerateCompanyEmailInput = {
  fullName: string;
  domain: string;
  isEmailTaken: (email: string) => Promise<boolean>;
};

@Injectable()
export class EmailGeneratorService {
  async generateCompanyEmail(input: GenerateCompanyEmailInput): Promise<string> {
    return generateCompanyEmail(input);
  }
}

export async function generateCompanyEmail(input: GenerateCompanyEmailInput): Promise<string> {
  const domain = normalizeDomain(input.domain);
  const { firstName, lastName } = normalizeFullName(input.fullName);

  let suffix = 1;

  while (true) {
    const suffixText = suffix === 1 ? "" : String(suffix);
    const email = `${firstName}.${lastName}${suffixText}@${domain}`;

    if (!(await input.isEmailTaken(email))) {
      return email;
    }

    suffix += 1;
  }
}

function normalizeDomain(domain: string): string {
  const normalizedDomain = domain.trim().toLowerCase().replace(/^@/u, "");

  if (!normalizedDomain) {
    throw new BadRequestException("Company email domain is required.");
  }

  return normalizedDomain;
}

function normalizeFullName(fullName: string): { firstName: string; lastName: string } {
  const nameParts = fullName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .replace(/-/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (nameParts.length === 0) {
    throw new BadRequestException("Full name must contain at least one email-safe character.");
  }

  const firstName = nameParts[0];
  const lastName = nameParts.at(-1) ?? firstName;

  return {
    firstName,
    lastName
  };
}
