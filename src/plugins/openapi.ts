import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: { title: 'mena-backend-services', version: '0.1.0' },
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  },
  { name: 'openapi' },
);
