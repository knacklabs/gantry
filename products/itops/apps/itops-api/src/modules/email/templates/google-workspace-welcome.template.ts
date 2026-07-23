export type GoogleWorkspaceWelcomeTemplateInput = {
  employeeFullName: string;
  workEmail: string;
  temporaryPassword?: string;
};

export type RenderedEmailTemplate = {
  subject: string;
  text: string;
  html?: string;
};

export function renderGoogleWorkspaceWelcomeTemplate(
  input: GoogleWorkspaceWelcomeTemplateInput
): RenderedEmailTemplate {
  const passwordLines = input.temporaryPassword
    ? [
        "Temporary password:",
        input.temporaryPassword,
        "",
        "You will be asked to reset this password the first time you sign in."
      ]
    : [
        "Password/setup instructions will be shared separately, or you can use the standard first-login/reset flow."
      ];

  const subject = "Welcome to CAW - your email account is ready";
  const text = [
    `Hi ${input.employeeFullName},`,
    "",
    "Welcome to CAW. Your company email account is ready.",
    "",
    "CAW builds product-engineering teams for ambitious companies. This account is your starting point for company tools, Slack updates, and IT access.",
    "",
    `Company email: ${input.workEmail}`,
    "",
    ...passwordLines,
    "",
    "If you have trouble signing in, contact IT Ops for support."
  ].join("\n");

  return {
    subject,
    text,
    html: renderHtml({
      ...input,
      subject
    })
  };
}

function renderHtml(input: GoogleWorkspaceWelcomeTemplateInput & { subject: string }): string {
  const escapedName = escapeHtml(input.employeeFullName);
  const escapedWorkEmail = escapeHtml(input.workEmail);
  const passwordBlock = input.temporaryPassword
    ? `
      <tr>
        <td style="padding:0 0 20px 0;">
          <div style="font-size:12px;line-height:16px;color:#525252;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;">Temporary password</div>
          <div style="margin-top:8px;padding:15px 16px;border-radius:4px;background:#111111;color:#ffd43b;font-family:Consolas,Monaco,monospace;font-size:18px;line-height:24px;font-weight:700;">${escapeHtml(input.temporaryPassword)}</div>
          <div style="margin-top:9px;font-size:13px;line-height:19px;color:#525252;">You will be asked to reset this password the first time you sign in.</div>
        </td>
      </tr>`
    : `
      <tr>
        <td style="padding:0 0 20px 0;font-size:14px;line-height:21px;color:#404040;">
          Password/setup instructions will be shared separately, or you can use the standard first-login/reset flow.
        </td>
      </tr>`;

  return [
    "<!doctype html>",
    "<html>",
    '<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,Helvetica,sans-serif;color:#111111;">',
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your CAW company email account is ready.</div>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f0;padding:32px 16px;">',
    "<tr>",
    '<td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #deded4;">',
    '<tr><td style="background:#111111;padding:28px 30px 24px 30px;border-bottom:5px solid #ffd43b;">',
    '<div style="font-size:30px;line-height:32px;color:#ffd43b;font-weight:800;letter-spacing:0.04em;">CAW</div>',
    '<div style="margin-top:10px;font-size:13px;line-height:18px;color:#f5f5f0;font-weight:700;">Product-engineering for all</div>',
    "</td></tr>",
    '<tr><td style="padding:30px;">',
    '<div style="font-size:12px;line-height:16px;color:#737373;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;">IT Ops setup</div>',
    `<h1 style="margin:8px 0 12px 0;font-size:28px;line-height:35px;color:#111111;font-weight:800;">Welcome to CAW, ${escapedName}</h1>`,
    '<p style="margin:0 0 22px 0;font-size:15px;line-height:24px;color:#404040;">Your company email account is ready. Use it for CAW tools, Slack updates, and IT access as you get started.</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0">',
    '<tr><td style="padding:0 0 18px 0;">',
    '<div style="font-size:12px;line-height:16px;color:#525252;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;">Company email</div>',
    `<div style="margin-top:8px;padding:16px;border-radius:4px;background:#fff7bf;border:1px solid #ffd43b;color:#111111;font-size:18px;line-height:24px;font-weight:800;">${escapedWorkEmail}</div>`,
    "</td></tr>",
    passwordBlock,
    "</table>",
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:2px;border-top:1px solid #e7e5dc;">',
    '<tr><td style="padding:18px 0 0 0;">',
    '<div style="font-size:14px;line-height:20px;color:#111111;font-weight:700;">Getting started</div>',
    '<div style="margin-top:8px;font-size:14px;line-height:22px;color:#404040;">1. Sign in with your company email.<br>2. Reset your password if prompted.<br>3. Keep an eye on Slack for access and onboarding updates.</div>',
    "</td></tr>",
    "</table>",
    '<div style="margin-top:20px;padding:15px 16px;border-left:4px solid #ffd43b;background:#fafaf7;font-size:14px;line-height:21px;color:#404040;">If you have trouble signing in, contact IT Ops for support.</div>',
    "</td></tr>",
    "</table>",
    '<div style="max-width:620px;margin-top:14px;font-size:12px;line-height:18px;color:#737373;text-align:left;">This message was sent by CAW IT Ops.</div>',
    "</td>",
    "</tr>",
    "</table>",
    "</body>",
    "</html>"
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
