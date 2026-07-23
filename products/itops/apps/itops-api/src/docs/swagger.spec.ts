import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupSwagger } from "./swagger.js";

describe("setupSwagger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts Swagger UI at /docs", () => {
    const app = {} as INestApplication;
    const document = { openapi: "3.0.0", info: { title: "test", version: "0.1.0" }, paths: {} };
    const createDocument = vi.spyOn(SwaggerModule, "createDocument").mockReturnValue(document);
    const setup = vi.spyOn(SwaggerModule, "setup").mockImplementation(() => undefined);

    setupSwagger(app);

    expect(createDocument).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        info: expect.objectContaining({
          title: "IT Ops Access Management API",
          version: "0.1.0"
        })
      })
    );
    expect(setup).toHaveBeenCalledWith("docs", app, document);
  });
});
