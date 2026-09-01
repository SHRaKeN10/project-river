import { Global, Module } from '@nestjs/common';
import { TableManager } from './table-manager';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Global()
@Module({
  controllers: [TablesController],
  providers: [TablesService, TableManager],
  exports: [TablesService, TableManager],
})
export class TablesModule {}
