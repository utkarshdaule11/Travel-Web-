import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z
    .string()
    .default('postgresql://travel_user:travel_password@localhost:5432/travel_db'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().default(0),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

export type WorkerEnvConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(): WorkerEnvConfig {
  const result = workerEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid worker configuration: ${result.error.message}`);
  }
  return result.data;
}
