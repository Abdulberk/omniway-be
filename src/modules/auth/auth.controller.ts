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
import { createHash } from 'crypto';

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
 * NOTE: This is a basic implementation using SHA-256 for password hashing.
 * In production, use bcrypt or argon2 for proper password hashing.
 */
@Controller('auth')
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
    ) { }

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

        // Verify password
        // NOTE: In production, use bcrypt.compare() instead of SHA-256
        const passwordHash = this.hashPassword(dto.password);
        if (passwordHash !== user.passwordHash) {
            this.logger.warn(`Login attempt with invalid password: ${dto.email}`);
            throw new UnauthorizedException('Invalid credentials');
        }

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
            expires_in: 604800, // 7 days in seconds
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                isSuperAdmin: user.isSuperAdmin,
            },
        };
    }

    /**
     * Hash password using SHA-256
     *
     * SECURITY NOTE: This is a basic implementation for demonstration.
     * In production, use bcrypt or argon2 with proper salt rounds.
     */
    private hashPassword(password: string): string {
        return createHash('sha256').update(password).digest('hex');
    }
}
