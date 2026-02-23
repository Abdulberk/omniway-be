import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AdminRateLimitGuard } from './guards/admin-rate-limit.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, RedisModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, AdminRateLimitGuard],
  exports: [AdminService],
})
export class AdminModule { }
