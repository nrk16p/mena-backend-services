import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

export default fp(
  async (app) => {
    app.setNotFoundHandler((req, reply) =>
      reply.status(404).send({ code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.url} not found` }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.setErrorHandler((err: any, req, reply) => {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send({ code: err.code, message: err.message, details: err.details });
      }
      if (err.validation) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: err.message, details: err.validation });
      }
      if (err.code === 11000) {
        return reply.status(409).send({
          code: 'DUPLICATE_KEY',
          message: 'A record with the same unique key already exists',
          details: err.keyValue,
        });
      }
      const status = err.statusCode ?? 500;
      if (status < 500) {
        return reply.status(status).send({ code: err.code ?? 'BAD_REQUEST', message: err.message });
      }
      req.log.error({ err }, 'unhandled error');
      return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    });
  },
  { name: 'errors' },
);
