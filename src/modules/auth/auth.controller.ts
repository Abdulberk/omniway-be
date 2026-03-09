import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from './jwt.service';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Login request DTO
 */
class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/**
 * Login response DTO
 */
interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: {
    id: string;
    email: string;
    name: string | null;
    isSuperAdmin: boolean;
  };
}

/**
 * Authentication controller
 * Handles user authentication and token generation
 *
 * Password verification uses scrypt for new hashes and transparently upgrades
 * legacy SHA-256 hashes on successful login.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Login endpoint
   * Validates credentials and returns a JWT token
   *
   * POST /auth/login
   */
  @Post('login')
  async login(@Body() dto: LoginDto): Promise<LoginResponse> {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        isActive: true,
        isSuperAdmin: true,
      },
    });

    if (!user) {
      this.logger.warn(`Login attempt with non-existent email: ${dto.email}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      this.logger.warn(`Login attempt for disabled account: ${dto.email}`);
      throw new UnauthorizedException('Account is disabled');
    }

    const passwordCheck = this.verifyPassword(dto.password, user.passwordHash);
    if (!passwordCheck.isValid) {
      this.logger.warn(`Login attempt with invalid password: ${dto.email}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        passwordHash: passwordCheck.needsRehash
          ? this.hashPassword(dto.password)
          : undefined,
      },
    });

    // Generate JWT token
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    });

    this.logger.log(`User logged in: ${user.id} (${user.email})`);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.jwtService.getExpiresInSeconds(),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperAdmin: user.isSuperAdmin,
      },
    };
  }

  /**
   * Hash password using scrypt with a per-user random salt.
   */
  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${derivedKey}`;
  }

  private verifyPassword(
    password: string,
    storedHash: string | null,
  ): { isValid: boolean; needsRehash: boolean } {
    if (!storedHash) {
      return { isValid: false, needsRehash: false };
    }

    if (storedHash.startsWith('scrypt$')) {
      return {
        isValid: this.verifyScryptHash(password, storedHash),
        needsRehash: false,
      };
    }

    const legacyHash = createHash('sha256').update(password).digest('hex');
    const isValid = this.timingSafeCompare(legacyHash, storedHash);

    return {
      isValid,
      needsRehash: isValid,
    };
  }

  private verifyScryptHash(password: string, storedHash: string): boolean {
    const [, salt, expectedHash] = storedHash.split('$');

    if (!salt || !expectedHash) {
      return false;
    }

    const derivedKey = scryptSync(
      password,
      salt,
      expectedHash.length / 2,
    ).toString('hex');

    return this.timingSafeCompare(derivedKey, expectedHash);
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    try {
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }
}
