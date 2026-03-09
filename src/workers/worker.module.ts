import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { BillingModule } from '../modules/billing/billing.module';
import { UsageModule } from '../modules/usage/usage.module';
import { StripeModule } from '../modules/stripe/stripe.module';
import { configValidationSchema } from '../config/config.validation';
import { getRedisConnectionOptions } from '../redis/redis-connection.util';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
      envFilePath: ['.env.local', '.env'],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: getRedisConnectionOptions(configService),
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    RedisModule,
    BillingModule,
    UsageModule,
    StripeModule,
  ],
})
export class WorkerModule {}
