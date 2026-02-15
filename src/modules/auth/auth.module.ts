import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { PolicyService } from './policy.service';
import { AuthGuard } from './guards/auth.guard';

@Module({
    providers: [AuthService, ApiKeyService, PolicyService, AuthGuard],
    exports: [AuthService, ApiKeyService, PolicyService, AuthGuard],
})
export class AuthModule { }