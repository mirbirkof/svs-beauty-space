/* lib/openapi-spec.js — INT-02 API Gateway: OpenAPI 3.0 опис публічного API (/api/v1).
   Документує реальні ендпоінти routes/public-api.js + схему авторизації по API-ключу
   (заголовок x-api-key або Bearer) і rate-limit. Сервиться як /api/v1/openapi.json,
   рендериться Swagger UI на /api-docs.html. Спека статична (без зовнішніх залежностей). */

function buildSpec(baseUrl) {
  const server = baseUrl || 'https://svs-shop-api.onrender.com';
  return {
    openapi: '3.0.3',
    info: {
      title: 'SVS Beauty Space — Public API',
      version: '1.0.0',
      description:
        'Зовнішній API салону для інтеграцій (сайт, мобільний застосунок, партнери).\n\n' +
        'Авторизація — за API-ключем у заголовку `x-api-key` (або `Authorization: Bearer <key>`). ' +
        'Ключі та scope створюються в адмінці (Система → API-ключі). ' +
        'Кожна відповідь обмежена rate-limit (заголовки `X-RateLimit-Limit` / `X-RateLimit-Remaining`, ' +
        'перевищення → `429`). Дані ізольовані по салону (мультитенант).',
    },
    servers: [{ url: `${server}/api/v1`, description: 'Production' }],
    security: [{ ApiKeyAuth: [] }],
    tags: [
      { name: 'Service', description: 'Службові' },
      { name: 'Catalog', description: 'Каталог послуг і майстрів' },
      { name: 'Leads', description: 'Зовнішні заявки' },
    ],
    paths: {
      '/ping': {
        get: {
          tags: ['Service'], summary: 'Перевірка ключа',
          description: 'Повертає назву ключа та його scope. Потрібен scope `read`.',
          security: [{ ApiKeyAuth: [] }],
          responses: {
            200: {
              description: 'Ключ дійсний',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean', example: true },
                  key: { type: 'string', example: 'Site integration' },
                  scopes: { type: 'array', items: { type: 'string' }, example: ['read', 'services.read'] },
                  ts: { type: 'string', format: 'date-time' },
                } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
      '/services': {
        get: {
          tags: ['Catalog'], summary: 'Список активних послуг',
          description: 'Активні послуги салону. Потрібен scope `services.read`.',
          responses: {
            200: {
              description: 'Список послуг',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Service' } },
                  count: { type: 'integer', example: 12 },
                } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
      '/services/categories': {
        get: {
          tags: ['Catalog'], summary: 'Категорії послуг',
          description: 'Категорії з кількістю послуг. Потрібен scope `services.read`.',
          responses: {
            200: {
              description: 'Категорії',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: {
                    type: 'object',
                    properties: { name: { type: 'string', example: 'Манікюр' }, services: { type: 'integer', example: 5 } } } },
                  count: { type: 'integer' },
                } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/masters': {
        get: {
          tags: ['Catalog'], summary: 'Майстри з онлайн-записом',
          description: 'Майстри з увімкненим онлайн-бронюванням. Потрібен scope `masters.read`.',
          responses: {
            200: {
              description: 'Список майстрів',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Master' } },
                  count: { type: 'integer' },
                } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/leads': {
        post: {
          tags: ['Leads'], summary: 'Створити зовнішню заявку',
          description: 'Приймає лід із зовнішнього джерела (сайт, лендінг). Потрібен scope `write`. ' +
            'Обовʼязково хоча б одне з полів `name` / `phone`.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                name: { type: 'string', example: 'Олена' },
                phone: { type: 'string', example: '+380501234567' },
                message: { type: 'string', example: 'Хочу записатися на манікюр' },
                source: { type: 'string', example: 'landing_page' },
              } } } },
          },
          responses: {
            200: {
              description: 'Заявку прийнято',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean', example: true },
                  lead_id: { type: 'integer', example: 101 },
                  created_at: { type: 'string', format: 'date-time' },
                } } } },
            },
            400: {
              description: 'Не вказано name або phone',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey', in: 'header', name: 'x-api-key',
          description: 'API-ключ салону. Альтернатива — `Authorization: Bearer <key>`.',
        },
      },
      schemas: {
        Service: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, name: { type: 'string' }, category: { type: 'string' },
            price: { type: 'number' }, duration_min: { type: 'integer' },
            description: { type: 'string' }, is_new: { type: 'boolean' }, is_hit: { type: 'boolean' },
          },
        },
        Master: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, name: { type: 'string' }, surname: { type: 'string' },
            specialty: { type: 'string' }, online_title: { type: 'string' },
            online_description: { type: 'string' }, avatar: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string', example: 'name_or_phone_required' } },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Невалідний або відсутній API-ключ',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Forbidden: {
          description: 'Недостатній scope ключа',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        RateLimited: {
          description: 'Перевищено rate-limit',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { error: { type: 'string', example: 'rate_limit_exceeded' }, retry_after: { type: 'integer' } } } } },
        },
      },
    },
  };
}

module.exports = { buildSpec };
