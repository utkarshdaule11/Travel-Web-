import pino from 'pino';
import { loadWorkerEnv } from './config/workerEnv.js';
import { createSmokeWorker } from './queues/smokeQueue.js';
import { createHoldExpiryWorker } from './queues/holdExpiryQueue.js';
import { DatabaseService } from '../../backend/src/infrastructure/database/index.js';
import { BookingRepository } from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { PassengerRepository } from '../../backend/src/modules/booking/repositories/passenger.repository.js';
import { IdempotencyRepository } from '../../backend/src/modules/booking/repositories/idempotency.repository.js';
import { DepartureRepository } from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import { InventoryHoldRepository } from '../../backend/src/modules/inventory/repositories/inventoryHold.repository.js';
import { TourPackageRepository } from '../../backend/src/modules/catalogue/repositories/tourPackage.repository.js';
import { BookingService } from '../../backend/src/modules/booking/services/booking.service.js';

import { loadEnv } from '../../backend/src/config/env.js';
import { DestinationRepository } from '../../backend/src/modules/catalogue/repositories/destination.repository.js';
import { ItineraryRepository } from '../../backend/src/modules/catalogue/repositories/itinerary.repository.js';

async function startWorker(): Promise<void> {
  const config = loadWorkerEnv();
  const envConfig = loadEnv();
  const logger = pino({ level: config.LOG_LEVEL });

  logger.info('⚙️ Starting Young Tours & Travels Asynchronous Worker...');

  // Initialize PostgreSQL Database Service
  const db = new DatabaseService(envConfig);

  const dbHealth = await db.checkHealth();
  if (dbHealth.status !== 'healthy') {
    logger.error({ err: dbHealth.error }, 'Database health check failed during worker startup');
  } else {
    logger.info('✅ Database connected successfully for worker.');
  }

  // Initialize Domain Repositories & Services
  const bookingRepo = new BookingRepository(db);
  const passengerRepo = new PassengerRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const departureRepo = new DepartureRepository(db);
  const inventoryHoldRepo = new InventoryHoldRepository(db);
  const tourPackageRepo = new TourPackageRepository(db);
  const itineraryRepo = new ItineraryRepository(db);
  const destinationRepo = new DestinationRepository(db);

  const bookingService = new BookingService(
    db,
    bookingRepo,
    passengerRepo,
    idempotencyRepo,
    departureRepo,
    inventoryHoldRepo,
    tourPackageRepo,
    itineraryRepo,
    destinationRepo,
  );

  // 1. Smoke Worker
  const smokeWorker = createSmokeWorker(config, (job) => {
    logger.info({ jobId: job.id, testId: job.data.testId }, 'Processed smoke test job');
  });

  // 2. Hold Expiry Worker
  const holdExpiryWorker = createHoldExpiryWorker(config, bookingService, {
    onProcessed: (job, result) => {
      logger.info(
        {
          jobId: job.id,
          holdId: result.holdId,
          bookingId: result.bookingId,
          outcome: result.outcome,
        },
        'Processed hold expiry job',
      );
    },
  });

  // Lifecycle Event Listeners
  holdExpiryWorker.on('completed', (job) => {
    logger.debug({ jobId: job?.id }, 'Hold expiry job completed');
  });

  holdExpiryWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Hold expiry job failed');
  });

  holdExpiryWorker.on('error', (err) => {
    logger.error({ err }, 'Hold expiry worker internal error');
  });

  logger.info('🚀 Worker process initialized and listening for jobs.');

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Gracefully stopping workers...`);
    try {
      await Promise.allSettled([smokeWorker.close(), holdExpiryWorker.close()]);
      await db.close();
      logger.info('Worker closed gracefully.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  void startWorker();
}

export { startWorker };
