import { Injectable } from "@nestjs/common";

export type OnboardingDetectedType = "new_joiner_alert" | "unknown";

export type ParsedOnboardingFields = {
  name: string | null;
  personalEmail: string | null;
  contactNo: string | null;
  doj: string | null;
  employmentType: "fte" | "contractor" | null;
  designation: string | null;
  laptop: string | null;
  relocation: string | null;
  slackChannels: string[];
};

export type OnboardingParseResult = {
  detectedType: OnboardingDetectedType;
  fields: ParsedOnboardingFields;
  missingFields: string[];
  parseErrors: string[];
};

type FieldKey = Exclude<keyof ParsedOnboardingFields, "slackChannels"> | "slackChannels";

const newJoinerAlertPattern = /new\s+joiner\s+alert/iu;

const fieldLabels: Array<{ key: FieldKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "personalEmail", label: "Email Id" },
  { key: "contactNo", label: "Contact No" },
  { key: "doj", label: "DOJ" },
  { key: "employmentType", label: "Contractor/FTE" },
  { key: "designation", label: "Designation" },
  { key: "laptop", label: "Laptop" },
  { key: "relocation", label: "Relocation" },
  { key: "slackChannels", label: "Slack Channels" }
];

const requiredFields: Array<keyof Pick<
  ParsedOnboardingFields,
  "name" | "personalEmail" | "doj" | "employmentType" | "designation"
>> = ["name", "personalEmail", "doj", "employmentType", "designation"];

const labelPattern = new RegExp(
  `(^|\\s)(${fieldLabels.map((field) => escapeRegExp(field.label)).join("|")})\\s*:`,
  "giu"
);

@Injectable()
export class OnboardingParserService {
  parse(rawText: string): OnboardingParseResult {
    return parseNewJoinerAlert(rawText);
  }
}

export function parseNewJoinerAlert(rawText: string): OnboardingParseResult {
  if (!newJoinerAlertPattern.test(rawText)) {
    return {
      detectedType: "unknown",
      fields: emptyFields(),
      missingFields: [],
      parseErrors: []
    };
  }

  const rawFieldValues = extractRawFieldValues(rawText);
  const fields: ParsedOnboardingFields = {
    name: normalizeTextValue(rawFieldValues.name),
    personalEmail: normalizeEmailValue(rawFieldValues.personalEmail),
    contactNo: normalizeTextValue(rawFieldValues.contactNo),
    doj: normalizeTextValue(rawFieldValues.doj),
    employmentType: normalizeEmploymentType(rawFieldValues.employmentType),
    designation: normalizeTextValue(rawFieldValues.designation),
    laptop: normalizeTextValue(rawFieldValues.laptop),
    relocation: normalizeTextValue(rawFieldValues.relocation),
    slackChannels: parseSlackChannels(rawFieldValues.slackChannels)
  };

  return {
    detectedType: "new_joiner_alert",
    fields,
    missingFields: requiredFields.filter((field) => isMissing(fields[field])),
    parseErrors: []
  };
}

function extractRawFieldValues(rawText: string): Partial<Record<FieldKey, string>> {
  const matches = [...rawText.matchAll(labelPattern)];
  const values: Partial<Record<FieldKey, string>> = {};

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const label = match[2]!;
    const key = keyForLabel(label);
    const valueStart = match.index! + match[0].length;
    const nextMatch = matches[index + 1];
    const valueEnd = nextMatch?.index ?? rawText.length;
    values[key] = rawText.slice(valueStart, valueEnd);
  }

  return values;
}

function keyForLabel(label: string): FieldKey {
  const normalizedLabel = normalizeLabel(label);
  const field = fieldLabels.find((candidate) => normalizeLabel(candidate.label) === normalizedLabel);

  if (!field) {
    throw new Error(`Unsupported onboarding field label: ${label}`);
  }

  return field.key;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeTextValue(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : null;
}

function normalizeEmailValue(value: string | undefined): string | null {
  const normalized = normalizeTextValue(value);

  if (!normalized) {
    return null;
  }

  const slackMailtoMatch = /^<mailto:([^|>]+)(?:\|[^>]+)?>$/iu.exec(normalized);
  return slackMailtoMatch?.[1]?.trim() ?? normalized;
}

function normalizeEmploymentType(value: string | undefined): ParsedOnboardingFields["employmentType"] {
  const normalized = normalizeTextValue(value)?.toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "fte") {
    return "fte";
  }

  if (normalized === "contractor" || normalized === "consultant") {
    return "contractor";
  }

  return null;
}

function parseSlackChannels(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(/[,\s]+/u)
        .map(normalizeSlackChannelValue)
        .filter(Boolean)
    )
  ];
}

function normalizeSlackChannelValue(value: string): string {
  const trimmed = value.trim();
  const slackChannelMatch = /^<#([^>|]+)(?:\|([^>]+))?>$/u.exec(trimmed);

  if (slackChannelMatch?.[2]) {
    return slackChannelMatch[2].replace(/^#+/u, "").trim();
  }

  if (slackChannelMatch?.[1]) {
    return slackChannelMatch[1].trim();
  }

  return trimmed.replace(/^#+/u, "");
}

function emptyFields(): ParsedOnboardingFields {
  return {
    name: null,
    personalEmail: null,
    contactNo: null,
    doj: null,
    employmentType: null,
    designation: null,
    laptop: null,
    relocation: null,
    slackChannels: []
  };
}

function isMissing(value: string | string[] | null): boolean {
  return Array.isArray(value) ? value.length === 0 : value === null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
