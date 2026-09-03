import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'vast-supervisor', environment: process.env.NODE_ENV || 'development' },
  redact: {
    paths: ['req.headers.authorization', '*.authorization', '*.apiKey', '*.secret', '*.payload.webhookPayload'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { type: error.name, message: error.message, stack: error.stack };
  return { type: typeof error, message: String(error) };
}
