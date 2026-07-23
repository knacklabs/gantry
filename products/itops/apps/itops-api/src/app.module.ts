import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { AccessRequestsModule } from "./modules/access-requests/access-requests.module.js";
import { AccessTasksModule } from "./modules/access-tasks/access-tasks.module.js";
import { ApprovalsModule } from "./modules/approvals/approvals.module.js";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module.js";
import { EmployeesModule } from "./modules/employees/employees.module.js";
import { OnboardingModule } from "./modules/onboarding/onboarding.module.js";
import { OffboardingModule } from "./modules/offboarding/offboarding.module.js";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    EmployeesModule,
    AccessRequestsModule,
    AccessTasksModule,
    ApprovalsModule,
    DiagnosticsModule,
    OnboardingModule,
    OffboardingModule
  ]
})
export class AppModule {}
