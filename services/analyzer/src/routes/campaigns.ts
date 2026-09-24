import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { DomainError, normalizeCompanyInput } from '../lib/domain.js';

interface CampaignRow {
  id: string;
  name: string;
  sector: string;
  city: string;
  language: string;
  page_limit: number;
  min_score: number;
  max_companies: number;
  service_fit?: Record<string, number>;
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      name: string;
      sector: string;
      city: string;
      language?: string;
      min_score?: number;
      max_companies?: number;
      page_limit?: number;
      service_fit?: Record<string, number>;
    };
  }>(
    '/campaigns',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'sector', 'city'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            sector: { type: 'string', minLength: 1, maxLength: 120 },
            city: { type: 'string', minLength: 1, maxLength: 120 },
            language: { type: 'string', enum: ['tr', 'en'] },
            min_score: { type: 'integer', minimum: 0, maximum: 100 },
            max_companies: { type: 'integer', minimum: 1, maximum: 20 },
            page_limit: { type: 'integer', minimum: 1, maximum: 5 },
            service_fit: {
              type: 'object',
              additionalProperties: { type: 'number', minimum: 0, maximum: 20 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, sector, city, language, min_score, max_companies, page_limit, service_fit } = request.body;
      const result = await query<CampaignRow>(
        `INSERT INTO pitchtrace.campaigns (name, sector, city, language, min_score, max_companies, page_limit, service_fit)
         VALUES ($1,$2,$3,COALESCE($4,'tr'),COALESCE($5,70),COALESCE($6,20),COALESCE($7,5),COALESCE($8::jsonb,'{}'::jsonb))
         RETURNING id, name, sector, city, language, page_limit, min_score, max_companies,
                   service_fit`,
        [
          name,
          sector,
          city,
          language ?? null,
          min_score ?? null,
          max_companies ?? null,
          page_limit ?? null,
          service_fit ? JSON.stringify(service_fit) : null,
        ],
      );
      return reply.code(201).send(result.rows[0]);
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string; website: string } }>(
    '/campaigns/:id/companies',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['name', 'website'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            website: { type: 'string', minLength: 3, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const campaign = await query('SELECT id FROM pitchtrace.campaigns WHERE id=$1', [
        request.params.id,
      ]);
      if (campaign.rowCount === 0) {
        return reply.code(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
      }

      let normalized;
      try {
        normalized = normalizeCompanyInput(request.body.website);
      } catch (err) {
        if (err instanceof DomainError) {
          return reply.code(422).send({ error: 'INVALID_WEBSITE', detail: err.message });
        }
        throw err;
      }

      const existing = await query<{ id: string }>(
        'SELECT id FROM pitchtrace.companies WHERE campaign_id=$1 AND normalized_domain=$2',
        [request.params.id, normalized.normalizedDomain],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        return reply.code(409).send({
          error: 'DUPLICATE_DOMAIN',
          company_id: existing.rows[0]!.id,
          normalized_domain: normalized.normalizedDomain,
        });
      }

      const inserted = await query<{ id: string }>(
        `INSERT INTO pitchtrace.companies
           (campaign_id, name, submitted_url, normalized_domain, source)
         VALUES ($1,$2,$3,$4,'manual') RETURNING id`,
        [
          request.params.id,
          request.body.name,
          normalized.submittedUrl,
          normalized.normalizedDomain,
        ],
      );

      return reply.code(201).send({
        company_id: inserted.rows[0]!.id,
        submitted_url: normalized.submittedUrl,
        normalized_domain: normalized.normalizedDomain,
        entry_url: normalized.entryUrl,
      });
    },
  );
}
