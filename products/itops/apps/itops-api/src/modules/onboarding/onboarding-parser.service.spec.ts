import { describe, expect, it } from "vitest";

import { OnboardingParserService, parseNewJoinerAlert } from "./onboarding-parser.service.js";

const fullTemplate = `
New Joiner Alert

Name: Riya Sharma
Email Id: riya.personal@example.com
Contact No: +91 9876543210
DOJ: 2026-07-01
Contractor/FTE: FTE
Designation: Backend Engineer
Laptop: MacBook Pro
Relocation: No
Slack Channels: #backend-alerts, #engineering
`;

describe("parseNewJoinerAlert", () => {
  it("parses a valid full template", () => {
    expect(parseNewJoinerAlert(fullTemplate)).toEqual({
      detectedType: "new_joiner_alert",
      fields: {
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
      missingFields: [],
      parseErrors: []
    });
  });

  it("reports missing required fields", () => {
    const result = parseNewJoinerAlert(`
New Joiner Alert
Name: Riya Sharma
Email Id:
DOJ:
Contractor/FTE:
Designation: Backend Engineer
`);

    expect(result.detectedType).toBe("new_joiner_alert");
    expect(result.missingFields).toEqual(["personalEmail", "doj", "employmentType"]);
    expect(result.parseErrors).toEqual([]);
  });

  it("parses lowercase labels", () => {
    const result = parseNewJoinerAlert(`
new joiner alert
name: Riya Sharma
email id: riya.personal@example.com
doj: 2026-07-01
contractor/fte: fte
designation: Backend Engineer
`);

    expect(result.fields).toMatchObject({
      name: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      doj: "2026-07-01",
      employmentType: "fte",
      designation: "Backend Engineer"
    });
  });

  it("allows extra spaces around labels and values", () => {
    const result = parseNewJoinerAlert(`
  New   Joiner   Alert

  Name   :    Riya   Sharma
  Email Id   :   riya.personal@example.com
  DOJ   :   01 July 2026
  Contractor/FTE   :   FTE
  Designation   :   Backend   Engineer
`);

    expect(result.fields).toMatchObject({
      name: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      doj: "01 July 2026",
      employmentType: "fte",
      designation: "Backend Engineer"
    });
    expect(result.missingFields).toEqual([]);
  });

  it("parses Slack-flattened New Joiner Alert messages", () => {
    const result = parseNewJoinerAlert(
      "@itops New Joiner Alert Name: Test Auto Onboarding Email Id: <mailto:test.auto.onboarding@example.com|test.auto.onboarding@example.com> Contact No: 9999999999 DOJ: 2026-07-15 Contractor/FTE: Contractor Designation: Backend Engineer Laptop: Not required Relocation: No Slack Channels: #engineering"
    );

    expect(result.fields).toMatchObject({
      name: "Test Auto Onboarding",
      personalEmail: "test.auto.onboarding@example.com",
      contactNo: "9999999999",
      doj: "2026-07-15",
      employmentType: "contractor",
      designation: "Backend Engineer",
      laptop: "Not required",
      relocation: "No",
      slackChannels: ["engineering"]
    });
    expect(result.missingFields).toEqual([]);
  });

  it("normalizes contractor employment type", () => {
    expect(parseNewJoinerAlert(templateWithEmploymentType("Contractor")).fields.employmentType).toBe("contractor");
  });

  it("normalizes consultant employment type to contractor", () => {
    expect(parseNewJoinerAlert(templateWithEmploymentType("Consultant")).fields.employmentType).toBe("contractor");
  });

  it("parses comma-separated Slack channels", () => {
    const result = parseNewJoinerAlert(`
New Joiner Alert
Name: Riya Sharma
Email Id: riya.personal@example.com
DOJ: 2026-07-01
Contractor/FTE: FTE
Designation: Backend Engineer
Slack Channels: #backend-alerts, #engineering, product
`);

    expect(result.fields.slackChannels).toEqual(["backend-alerts", "engineering", "product"]);
  });

  it("parses space-separated Slack channels", () => {
    const result = parseNewJoinerAlert(`
New Joiner Alert
Name: Riya Sharma
Email Id: riya.personal@example.com
DOJ: 2026-07-01
Contractor/FTE: FTE
Designation: Backend Engineer
Slack Channels: #backend-alerts #engineering product
`);

    expect(result.fields.slackChannels).toEqual(["backend-alerts", "engineering", "product"]);
  });

  it("returns unknown for messages that are not New Joiner Alerts", () => {
    expect(parseNewJoinerAlert("Please give Riya Jira access.")).toEqual({
      detectedType: "unknown",
      fields: {
        name: null,
        personalEmail: null,
        contactNo: null,
        doj: null,
        employmentType: null,
        designation: null,
        laptop: null,
        relocation: null,
        slackChannels: []
      },
      missingFields: [],
      parseErrors: []
    });
  });

  it("maps Email Id to personalEmail", () => {
    const result = parseNewJoinerAlert(fullTemplate);

    expect(result.fields.personalEmail).toBe("riya.personal@example.com");
    expect(result.fields).not.toHaveProperty("workEmail");
  });

  it("extracts personalEmail from Slack mailto markup", () => {
    const result = parseNewJoinerAlert(`
New Joiner Alert
Name: Riya Sharma
Email Id: <mailto:riya.personal@example.com|riya.personal@example.com>
DOJ: 2026-07-01
Contractor/FTE: FTE
Designation: Backend Engineer
`);

    expect(result.fields.personalEmail).toBe("riya.personal@example.com");
  });

  it("parses Slack channel mention markup", () => {
    const result = parseNewJoinerAlert(`
New Joiner Alert
Name: Riya Sharma
Email Id: riya.personal@example.com
DOJ: 2026-07-01
Contractor/FTE: FTE
Designation: Backend Engineer
Slack Channels: #engineering, <#C01CQTLGL69|interakt-backend-engg>, <#C01NO_LABEL>
`);

    expect(result.fields.slackChannels).toEqual(["engineering", "interakt-backend-engg", "C01NO_LABEL"]);
  });
});

describe("OnboardingParserService", () => {
  it("delegates to parseNewJoinerAlert", () => {
    const service = new OnboardingParserService();

    expect(service.parse(fullTemplate)).toEqual(parseNewJoinerAlert(fullTemplate));
  });
});

function templateWithEmploymentType(employmentType: string): string {
  return `
New Joiner Alert
Name: Riya Sharma
Email Id: riya.personal@example.com
DOJ: 2026-07-01
Contractor/FTE: ${employmentType}
Designation: Backend Engineer
`;
}
