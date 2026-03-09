import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { PolicyService } from './policy.service';
import { JwtService } from './jwt.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './guards/auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, ApiKeyService, PolicyService, JwtService, AuthGuard],
  exports: [AuthService, ApiKeyService, PolicyService, JwtService, AuthGuard],
})
export class AuthModule {}
