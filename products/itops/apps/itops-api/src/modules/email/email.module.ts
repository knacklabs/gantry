import { Module } from "@nestjs/common";
import { loadConfig } from "@itops/config";

import { EmailController } from "./email.controller.js";
import { EmailReadService } from "./email-read.service.js";
import { EmailRepository } from "./email.repository.js";
import { EmailService } from "./email.service.js";
import type { EmailConfig, EmailProvider } from "./email.types.js";
import { EMAIL_CONFIG, EMAIL_PROVIDER_INSTANCE } from "./email.tokens.js";
import { GmailEmailProvider } from "./providers/gmail-email.provider.js";
import { EmailTemplateRegistry } from "./templates/email-template.registry.js";

@Module({
  controllers: [EmailController],
  providers: [
    EmailRepository,
    EmailReadService,
    EmailService,
    EmailTemplateRegistry,
    {
      provide: EMAIL_CONFIG,
      useFactory: (): EmailConfig => loadConfig().email
    },
    {
      provide: EMAIL_PROVIDER_INSTANCE,
      useFactory: (): EmailProvider | null => {
        const config = loadConfig().email;

        if (
          !config.itopsFrom ||
          !config.gmailClientEmail ||
          !config.gmailPrivateKey ||
          !config.gmailImpersonatedItopsEmail
        ) {
          return null;
        }

        return new GmailEmailProvider({
          clientEmail: config.gmailClientEmail,
          privateKey: config.gmailPrivateKey,
          impersonatedEmail: config.gmailImpersonatedItopsEmail
        });
      }
    }
  ],
  exports: [EmailReadService, EmailService]
})
export class EmailModule {}
