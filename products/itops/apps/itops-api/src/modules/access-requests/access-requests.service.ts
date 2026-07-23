import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { formatZodIssues, isUuid } from "../../common/validation.js";
import {
  AccessRequestsRepository,
  type AccessRequest,
  type AccessRequestDetail,
  type AccessTask
} from "./access-requests.repository.js";
import { createAccessRequestSchema } from "./dto/create-access-request.dto.js";

@Injectable()
export class AccessRequestsService {
  constructor(private readonly accessRequestsRepository: AccessRequestsRepository) {}

  async createAccessRequest(input: unknown): Promise<AccessRequest> {
    const parsed = createAccessRequestSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid access request payload.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const createAccessRequestDto = parsed.data;
    const employee = await this.accessRequestsRepository.findEmployeeById(createAccessRequestDto.employeeId);

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    const system = await this.accessRequestsRepository.findSystemByKey(createAccessRequestDto.systemKey);

    if (!system) {
      throw new NotFoundException("System not found.");
    }

    const resource = await this.accessRequestsRepository.findResourceBySystemIdAndKey(
      system.id,
      createAccessRequestDto.resourceKey
    );

    if (!resource) {
      throw new NotFoundException("Access resource not found.");
    }

    const role = await this.accessRequestsRepository.findRoleBySystemIdAndKey(system.id, createAccessRequestDto.roleKey);

    if (!role) {
      throw new NotFoundException("Role not found.");
    }

    if (
      createAccessRequestDto.action === "revoke" &&
      system.key === "google_workspace" &&
      resource.key === "company_email"
    ) {
      throw new BadRequestException("Google Workspace company email revocation is only supported through offboarding.");
    }

    const duplicateAccessRequest = await this.accessRequestsRepository.findOpenAccessRequest({
      employeeId: employee.id,
      systemId: system.id,
      resourceId: resource.id,
      roleId: role.id,
      action: createAccessRequestDto.action
    });

    if (duplicateAccessRequest) {
      throw new ConflictException("Open access request already exists for this employee, resource, role, and action.");
    }

    return this.accessRequestsRepository.createAccessRequest({
      employeeId: employee.id,
      systemId: system.id,
      resourceId: resource.id,
      roleId: role.id,
      action: createAccessRequestDto.action,
      reason: createAccessRequestDto.reason ?? null,
      requestedByExternalUserId: createAccessRequestDto.requestedByExternalUserId,
      requestedFrom: createAccessRequestDto.requestedFrom ?? null
    });
  }

  async findAccessRequestById(id: string): Promise<AccessRequestDetail> {
    if (!isUuid(id)) {
      throw new NotFoundException("Access request not found.");
    }

    const accessRequest = await this.accessRequestsRepository.findAccessRequestDetailById(id);

    if (!accessRequest) {
      throw new NotFoundException("Access request not found.");
    }

    return accessRequest;
  }

  async listAccessTasksByAccessRequestId(id: string): Promise<AccessTask[]> {
    if (!isUuid(id)) {
      throw new NotFoundException("Access request not found.");
    }

    const accessRequest = await this.accessRequestsRepository.findAccessRequestDetailById(id);

    if (!accessRequest) {
      throw new NotFoundException("Access request not found.");
    }

    return this.accessRequestsRepository.listAccessTasksByAccessRequestId(id);
  }
}
