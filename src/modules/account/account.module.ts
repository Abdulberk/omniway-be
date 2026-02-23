import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { UserGuard } from './guards/user.guard';
import { UserRateLimitGuard } from './guards/user-rate-limit.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, RedisModule, AuthModule],
  controllers: [AccountController],
  providers: [AccountService, UserGuard, UserRateLimitGuard],
  exports: [AccountService],
})
export class AccountModule { }
