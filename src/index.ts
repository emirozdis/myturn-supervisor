import { app } from './app';
import { config } from './config';
import { pool } from './db';
import { logger, errorContext } from './logger';
import { startOrchestrator, stopOrchestrator } from './orchestrator';

const server = app.listen(config.port, config.host, () => {
  logger.info({ event: 'service.started', host: config.host, port: config.port, reconcileIntervalMs: config.reconcileIntervalMs }, 'Vast supervisor API and orchestration loop started');
  startOrchestrator();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: 'service.shutdown_started', signal }, 'Supervisor graceful shutdown started');
  server.close();
  await stopOrchestrator().catch((error) => logger.error({ event: 'service.orchestrator_stop_failed', ...errorContext(error) }, 'Orchestrator did not stop cleanly'));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error) => logger.fatal({ event: 'process.unhandled_rejection', ...errorContext(error) }, 'Unhandled promise rejection'));
process.on('uncaughtExceptionMonitor', (error) => logger.fatal({ event: 'process.uncaught_exception', ...errorContext(error) }, 'Uncaught exception'));
