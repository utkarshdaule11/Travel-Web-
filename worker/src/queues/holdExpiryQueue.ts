import { Queue, Worker, Job } from 'bullmq';
import { WorkerEnvConfig } from '../config/workerEnv.js';
import { BookingService } from '../../../backend/src/modules/booking/services/booking.service.js';

export const HOLD_EXPIRY_QUEUE_NAME = 'booking-hold-expiry';

export interface HoldExpiryJobData {
  holdId: string;
  bookingId?: string;
}

export interface HoldExpiryJobResult {
  processed: boolean;
  holdId: string;
  bookingId?: string;
  outcome: 'EXPIRED' | 'COMMITTED' | 'ALREADY_EXPIRED' | 'CANCELLED' | 'NO_OP';
  completedAt: string;
}

export interface HoldExpiryWorkerOptions {
  onProcessed?: (
    job: Job<HoldExpiryJobData, HoldExpiryJobResult>,
    result: HoldExpiryJobResult,
  ) => void;
}

/**
 * Creates BullMQ Queue instance for Hold Expiry delayed jobs.
 */
export function createHoldExpiryQueue(
  config: Pick<WorkerEnvConfig, 'REDIS_HOST' | 'REDIS_PORT' | 'REDIS_PASSWORD' | 'REDIS_DB'>,
): Queue<HoldExpiryJobData, HoldExpiryJobResult> {
  return new Queue<HoldExpiryJobData, HoldExpiryJobResult>(HOLD_EXPIRY_QUEUE_NAME, {
    connection: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
      db: config.REDIS_DB,
    },
  });
}

/**
 * Enqueue a delayed hold-expiry job into BullMQ.
 * Deduplicated by deterministic `jobId: hold-expiry-${holdId}`.
 */
export async function enqueueHoldExpiry(
  queue: Queue<HoldExpiryJobData, HoldExpiryJobResult>,
  holdId: string,
  bookingId?: string,
  delayMs = 15 * 60 * 1000,
): Promise<Job<HoldExpiryJobData, HoldExpiryJobResult>> {
  return queue.add(
    'expire-hold',
    { holdId, bookingId },
    {
      delay: Math.max(0, delayMs),
      jobId: `hold-expiry-${holdId}`,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

/**
 * Creates BullMQ Worker for processing hold expiry jobs.
 * Integrates with domain BookingService and preserves canonical locking.
 */
export function createHoldExpiryWorker(
  config: WorkerEnvConfig,
  bookingService: BookingService,
  options?: HoldExpiryWorkerOptions,
): Worker<HoldExpiryJobData, HoldExpiryJobResult> {
  return new Worker<HoldExpiryJobData, HoldExpiryJobResult>(
    HOLD_EXPIRY_QUEUE_NAME,
    async (job: Job<HoldExpiryJobData, HoldExpiryJobResult>) => {
      const { holdId, bookingId } = job.data;

      // Execute transactional domain expiry with canonical lock ordering
      const result = await bookingService.expireHoldAndBooking(holdId, bookingId);

      const jobResult: HoldExpiryJobResult = {
        processed: true,
        holdId,
        bookingId,
        outcome: result.outcome,
        completedAt: new Date().toISOString(),
      };

      if (options?.onProcessed) {
        options.onProcessed(job, jobResult);
      }

      return jobResult;
    },
    {
      connection: {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD || undefined,
        db: config.REDIS_DB,
      },
      concurrency: config.WORKER_CONCURRENCY,
    },
  );
}
