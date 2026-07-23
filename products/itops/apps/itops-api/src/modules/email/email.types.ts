export const EMAIL_PROVIDER = {
  gmail: "gmail"
} as const;

export const EMAIL_TEMPLATE_KEY = {
  googleWorkspaceWelcome: "google_workspace_welcome"
} as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEY)[keyof typeof EMAIL_TEMPLATE_KEY];

export type SendEmailInput = {
  fromEmail: string;
  toEmail: string;
  subject: string;
  text: string;
  html?: string;
};

export type SendEmailResult = {
  provider: typeof EMAIL_PROVIDER.gmail;
  providerMessageId?: string;
  accepted: boolean;
  raw?: Record<string, unknown>;
};

export type EmailProvider = {
  send(input: SendEmailInput): Promise<SendEmailResult>;
};

export type EmailSendOutcome = {
  status: "sent" | "failed" | "skipped";
  emailMessageId?: string;
  reason?: string;
};

export type EmailConfig = {
  itopsFrom?: string;
  gmailClientEmail?: string;
  gmailPrivateKey?: string;
  gmailImpersonatedItopsEmail?: string;
};
