import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * JWT payload structure
 * Follows standard JWT claims structure
 */
export interface JwtPayload {
    sub: string; // Subject - user ID
    email: string;
    isSuperAdmin?: boolean;
    iat: number; // Issued at
    exp: number; // Expiration
    iss: string; // Issuer
    aud: string; // Audience
}

/**
 * JWT token generation and verification service
 * Implements HS256 algorithm with timing-safe comparison
 */
@Injectable()
export class JwtService {
    private readonly secret: string;
    private readonly expiresIn: string;
    private readonly issuer = 'omniway-api';
    private readonly audience = 'omniway-clients';

    constructor(private readonly config: ConfigService) {
        this.secret = this.config.get<string>('JWT_SECRET')!;
        this.expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '7d');

        if (!this.secret) {
            throw new Error('JWT_SECRET must be configured');
        }
    }

    /**
     * Generate a signed JWT token for a user
     */
    sign(payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'>): string {
        const now = Math.floor(Date.now() / 1000);
        const expiresInSeconds = this.parseExpiration(this.expiresIn);

        const fullPayload: JwtPayload = {
            ...payload,
            iat: now,
            exp: now + expiresInSeconds,
            iss: this.issuer,
            aud: this.audience,
        };

        // Create header
        const header = {
            alg: 'HS256',
            typ: 'JWT',
        };

        // Encode header and payload
        const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
        const encodedPayload = this.base64UrlEncode(JSON.stringify(fullPayload));
        const data = `${encodedHeader}.${encodedPayload}`;

        // Sign with HMAC-SHA256
        const signature = createHmac('sha256', this.secret)
            .update(data)
            .digest('base64url');

        return `${data}.${signature}`;
    }

    /**
     * Verify and decode a JWT token
     * Throws UnauthorizedException if token is invalid
     */
    verify(token: string): JwtPayload {
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new UnauthorizedException('Invalid token format');
        }

        const [encodedHeader, encodedPayload, signature] = parts;
        const data = `${encodedHeader}.${encodedPayload}`;

        // Verify signature (timing-safe to prevent timing attacks)
        const expectedSignature = createHmac('sha256', this.secret)
            .update(data)
            .digest('base64url');

        if (!this.timingSafeCompare(signature, expectedSignature)) {
            throw new UnauthorizedException('Invalid token signature');
        }

        // Decode payload
        let payload: JwtPayload;
        try {
            const payloadJson = Buffer.from(encodedPayload, 'base64url').toString();
            payload = JSON.parse(payloadJson);
        } catch {
            throw new UnauthorizedException('Invalid token payload');
        }

        // Validate required claims
        if (!payload.sub || !payload.email) {
            throw new UnauthorizedException('Missing required claims');
        }

        // Validate expiration
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
            throw new UnauthorizedException('Token has expired');
        }

        // Validate issuer
        if (payload.iss !== this.issuer) {
            throw new UnauthorizedException('Invalid token issuer');
        }

        // Validate audience
        if (payload.aud !== this.audience) {
            throw new UnauthorizedException('Invalid token audience');
        }

        return payload;
    }

    /**
     * Decode token without verification (for debugging only)
     * WARNING: Do not use for authentication!
     */
    decode(token: string): JwtPayload | null {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                return null;
            }

            const [, encodedPayload] = parts;
            const payloadJson = Buffer.from(encodedPayload, 'base64url').toString();
            return JSON.parse(payloadJson);
        } catch {
            return null;
        }
    }

    /**
     * Timing-safe string comparison to prevent timing attacks
     */
    private timingSafeCompare(a: string, b: string): boolean {
        if (a.length !== b.length) {
            return false;
        }

        const bufA = Buffer.from(a);
        const bufB = Buffer.from(b);

        try {
            return timingSafeEqual(bufA, bufB);
        } catch {
            return false;
        }
    }

    /**
     * Base64 URL encode (without padding)
     */
    private base64UrlEncode(str: string): string {
        return Buffer.from(str).toString('base64url');
    }

    /**
     * Parse expiration string (e.g., '7d', '24h', '3600s')
     */
    private parseExpiration(exp: string): number {
        const match = exp.match(/^(\d+)([dhms])$/);
        if (!match) {
            // Default to 7 days if format is invalid
            return 604800;
        }

        const [, value, unit] = match;
        const num = parseInt(value, 10);

        switch (unit) {
            case 'd':
                return num * 86400;
            case 'h':
                return num * 3600;
            case 'm':
                return num * 60;
            case 's':
                return num;
            default:
                return 604800; // Default: 7 days
        }
    }
}
