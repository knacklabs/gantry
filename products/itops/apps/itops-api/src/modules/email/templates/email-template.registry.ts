import { EMAIL_TEMPLATE_KEY, type EmailTemplateKey } from "../email.types.js";
import {
  renderGoogleWorkspaceWelcomeTemplate,
  type GoogleWorkspaceWelcomeTemplateInput,
  type RenderedEmailTemplate
} from "./google-workspace-welcome.template.js";

export type EmailTemplateDataByKey = {
  [EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome]: GoogleWorkspaceWelcomeTemplateInput;
};

export class EmailTemplateRegistry {
  render(templateKey: typeof EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome, data: GoogleWorkspaceWelcomeTemplateInput): RenderedEmailTemplate;
  render<K extends EmailTemplateKey>(templateKey: K, data: EmailTemplateDataByKey[K]): RenderedEmailTemplate {
    switch (templateKey) {
      case EMAIL_TEMPLATE_KEY.googleWorkspaceWelcome:
        return renderGoogleWorkspaceWelcomeTemplate(data as GoogleWorkspaceWelcomeTemplateInput);
    }

    throw new Error(`Unsupported email template: ${String(templateKey)}`);
  }
}
