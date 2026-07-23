import { Module } from "@nestjs/common";

import { PoliciesModule } from "../policies/policies.module.js";
import { DiagnosticsController } from "./diagnostics.controller.js";
import { DiagnosticsRepository } from "./diagnostics.repository.js";
import { DiagnosticsService } from "./diagnostics.service.js";

@Module({
  imports: [PoliciesModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsRepository, DiagnosticsService]
})
export class DiagnosticsModule {}
