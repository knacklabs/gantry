import { Global, Module } from "@nestjs/common";

import { DatabaseProvider } from "./database.provider.js";

@Global()
@Module({
  providers: [DatabaseProvider],
  exports: [DatabaseProvider]
})
export class DatabaseModule {}
