import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

@Global()
@Module({
    providers: [
        {
            provide: 'REDIS_CLIENT',
            useFactory: async (configService: ConfigService) => {
                const Redis = await import('ioredis');
                const redisUrl = configService.get<string>('REDIS_URL');

                if (!redisUrl) {
                    throw new Error('REDIS_URL environment variable is required');
                }

                const client = new Redis.default(redisUrl, {
                    maxRetriesPerRequest: 3,
                    retryStrategy: (times: number) => {
                        if (times > 10) {
                            return null; // Stop retrying
                        }
                        return Math.min(times * 100, 3000);
                    },
                    enableReadyCheck: true,
                    lazyConnect: false,
                });

                return client;
            },
            inject: [ConfigService],
        },
        RedisService,
    ],
    exports: ['REDIS_CLIENT', RedisService],
})
export class RedisModule { }