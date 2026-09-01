import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limit/rate-limiter.service';
import { ThrottleGuard } from './rate-limit/throttle.guard';

@Global()
@Module({
  providers: [RateLimiterService, ThrottleGuard],
  exports: [RateLimiterService, ThrottleGuard],
})
export class CommonModule {}
