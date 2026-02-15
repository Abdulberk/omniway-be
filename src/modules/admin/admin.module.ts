import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';

@Module({
    imports: [PrismaModule, RedisModule],
    controllers: [AdminController],
    providers: [AdminService, AdminGuard],
    exports: [AdminService],
})
export class AdminModule { }