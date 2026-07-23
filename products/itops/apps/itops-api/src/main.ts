import "reflect-metadata";

import { loadConfig, loadEnvFiles } from "@itops/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { setupSwagger } from "./docs/swagger.js";

async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();

  const app = await NestFactory.create(AppModule);
  setupSwagger(app);

  await app.listen(config.itopsApiPort, config.itopsApiHost);
  console.info(
    JSON.stringify({
      level: "info",
      service: "itops-api",
      message: "IT Ops API listening",
      host: config.itopsApiHost,
      port: config.itopsApiPort
    })
  );
}

await bootstrap();
