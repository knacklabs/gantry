import { Module } from "@nestjs/common";

import { EmailModule } from "../email/email.module.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesRepository } from "./employees.repository.js";
import { EmployeesService } from "./employees.service.js";

@Module({
  imports: [EmailModule],
  controllers: [EmployeesController],
  providers: [EmployeesRepository, EmployeesService]
})
export class EmployeesModule {}
