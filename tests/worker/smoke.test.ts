import { describe, it, expect } from 'vitest';
import {
  createSmokeQueue,
  createSmokeWorker,
  SMOKE_QUEUE_NAME,
} from '../../worker/src/queues/smokeQueue.js';

describe('Worker Foundation — BullMQ Smoke Queue Definition', () => {
  it('should create smoke queue with proper Redis configuration', () => {
    const queue = createSmokeQueue({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgresql://travel_user:travel_password@localhost:5432/travel_db',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_PASSWORD: '',
      REDIS_DB: 0,
      WORKER_CONCURRENCY: 1,
    });

    expect(queue.name).toBe(SMOKE_QUEUE_NAME);
  });

  it('should create smoke worker instance with concurrency setting', () => {
    const worker = createSmokeWorker({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgresql://travel_user:travel_password@localhost:5432/travel_db',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_PASSWORD: '',
      REDIS_DB: 0,
      WORKER_CONCURRENCY: 3,
    });

    expect(worker.name).toBe(SMOKE_QUEUE_NAME);
    expect(worker.opts.concurrency).toBe(3);
  });
});
