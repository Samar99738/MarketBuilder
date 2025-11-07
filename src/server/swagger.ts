/**
 * Swagger/OpenAPI Configuration
 * Auto-generates interactive API documentation
 */

import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Solana Trading Strategy API',
      version: '1.0.0',
      description: 'Production-ready REST API for managing trading strategies on Solana mainnet',
      contact: {
        name: 'API Support',
        email: 'support@example.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
        description: 'Local server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for authentication',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
        },
      },
      schemas: {
        Strategy: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'my-strategy-1' },
            name: { type: 'string', example: 'My Trading Strategy' },
            description: { type: 'string', example: 'A simple buy and sell strategy' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string', enum: ['buy', 'sell', 'wait', 'condition', 'get_price', 'custom'] },
                  amountInSol: { type: 'number' },
                  targetPrice: { type: 'number' },
                  onSuccess: { type: 'string' },
                  onFailure: { type: 'string' },
                },
              },
            },
            riskLimits: {
              type: 'object',
              properties: {
                maxPositionSizeSOL: { type: 'number', example: 10 },
                maxDailyLossSOL: { type: 'number', example: 5 },
                stopLossPercentage: { type: 'number', example: 5 },
                takeProfitPercentage: { type: 'number', example: 10 },
              },
            },
            isProduction: { type: 'boolean' },
            createdAt: { type: 'number' },
            updatedAt: { type: 'number' },
          },
        },
        Template: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'dca' },
            displayName: { type: 'string', example: 'Dollar Cost Averaging' },
            description: { type: 'string' },
            parameters: { type: 'array', items: { type: 'string' } },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                code: { type: 'string' },
                statusCode: { type: 'number' },
                details: { type: 'object' },
              },
            },
            timestamp: { type: 'string', format: 'date-time' },
            path: { type: 'string' },
          },
        },
      },
    },
    tags: [
      {
        name: 'Strategies',
        description: 'Strategy management endpoints',
      },
      {
        name: 'Templates',
        description: 'Pre-built strategy templates',
      },
      {
        name: 'Execution',
        description: 'Strategy execution management',
      },
      {
        name: 'Trading',
        description: 'Direct trading operations',
      },
      {
        name: 'System',
        description: 'System health and monitoring',
      },
    ],
    paths: {
      '/api/v1/strategies': {
        get: {
          tags: ['Strategies'],
          summary: 'List all strategies',
          description: 'Retrieve a list of all created strategies',
          responses: {
            200: {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          strategies: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/Strategy' },
                          },
                          total: { type: 'number' },
                        },
                      },
                      timestamp: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Strategies'],
          summary: 'Create a new strategy',
          description: 'Create a new trading strategy with custom steps',
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: {
                    id: { type: 'string', example: 'my-strategy-1' },
                    name: { type: 'string', example: 'My Strategy' },
                    description: { type: 'string', example: 'Strategy description' },
                    steps: {
                      type: 'array',
                      items: { type: 'object' },
                    },
                    riskLimits: {
                      type: 'object',
                      properties: {
                        maxPositionSizeSOL: { type: 'number' },
                        stopLossPercentage: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Strategy created successfully',
            },
            400: {
              description: 'Validation error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            429: {
              description: 'Rate limit exceeded',
            },
          },
        },
      },
      '/api/v1/strategies/{id}': {
        get: {
          tags: ['Strategies'],
          summary: 'Get strategy by ID',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: { description: 'Strategy details' },
            404: { description: 'Strategy not found' },
          },
        },
        put: {
          tags: ['Strategies'],
          summary: 'Update strategy',
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    steps: { type: 'array' },
                    riskLimits: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Strategy updated' },
            404: { description: 'Strategy not found' },
          },
        },
        delete: {
          tags: ['Strategies'],
          summary: 'Delete strategy',
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: { description: 'Strategy deleted' },
            404: { description: 'Strategy not found' },
          },
        },
      },
      '/api/v1/strategies/from-template': {
        post: {
          tags: ['Templates'],
          summary: 'Create strategy from template',
          description: 'Create a new strategy using a pre-built template',
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['templateName', 'config'],
                  properties: {
                    templateName: {
                      type: 'string',
                      enum: ['dca', 'grid', 'stop_loss', 'momentum'],
                      example: 'dca',
                    },
                    config: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: 'my-dca-strategy' },
                        buyAmountSOL: { type: 'number', example: 0.1 },
                        intervalMinutes: { type: 'number', example: 60 },
                        buyCount: { type: 'number', example: 10 },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Strategy created from template' },
            400: { description: 'Invalid template or configuration' },
          },
        },
      },
      '/api/v1/strategies/templates/list': {
        get: {
          tags: ['Templates'],
          summary: 'List available templates',
          description: 'Get a list of all available strategy templates',
          responses: {
            200: {
              description: 'List of templates',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          templates: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/Template' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: ['./src/server/routes/*.ts', './src/server/server.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Express): void {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Solana Trading API Docs',
  }));

  // JSON spec endpoint
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

