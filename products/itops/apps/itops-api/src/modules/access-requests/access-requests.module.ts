import { Module } from "@nestjs/common";

import { AccessRequestsController } from "./access-requests.controller.js";
import { AccessRequestsRepository } from "./access-requests.repository.js";
import { AccessRequestsService } from "./access-requests.service.js";

@Module({
  controllers: [AccessRequestsController],
  providers: [AccessRequestsRepository, AccessRequestsService]
})
export class AccessRequestsModule {}
