import { requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { IssueService } from "../issues.js";

const fields = z.record(z.string(), z.unknown());
const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  projectId: z.string(),
  number: z.number(),
  /** Values by field key, system and custom. See GET /fields for the keys and types. */
  fields,
  spentSec: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
/** A ticket key, or its id (pickers store ids). */
const keyParam = z.object({ key: z.string().max(36) });

export async function issueRoutes(
  scope: FastifyInstance,
  issues: IssueService,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  // The service checks per ticket: project permission, reporter and assignee grants, security level.
  const custom = { permission: "custom" as const };

  r.post(
    "/issues",
    {
      config: custom,
      schema: {
        body: z.object({
          projectKey: z.string().max(10),
          type: z.string(),
          fields,
        }),
        response: { 201: issueSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await issues.create(
            requireUser(req),
            req.body.projectKey,
            req.body.type,
            req.body.fields,
          ),
        ),
  );

  r.get(
    "/issues/:key",
    {
      config: { ...custom, customers: true },
      schema: { params: keyParam, response: { 200: issueSchema } },
    },
    (req) => issues.get(req.user, req.params.key),
  );

  r.patch(
    "/issues/:key",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({ fields }),
        response: { 200: issueSchema },
      },
    },
    (req) => issues.update(requireUser(req), req.params.key, req.body.fields),
  );

  r.delete(
    "/issues/:key",
    {
      config: custom,
      schema: { params: keyParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      await issues.remove(requireUser(req), req.params.key);
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/issues/:key/move",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({
          projectKey: z.string().max(10),
          type: z.string().optional(),
        }),
        response: { 200: issueSchema },
      },
    },
    (req) =>
      issues.move(
        requireUser(req),
        req.params.key,
        req.body.projectKey,
        req.body.type,
      ),
  );

  r.post(
    "/issues/:key/type",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({ type: z.string() }),
        response: { 200: issueSchema },
      },
    },
    (req) => issues.changeType(requireUser(req), req.params.key, req.body.type),
  );

  r.get(
    "/issues/:key/history",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              actorId: z.string(),
              createdAt: z.string(),
              items: z.array(
                z.object({
                  field: z.string(),
                  from: z.string(),
                  to: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    (req) => issues.history(req.user, req.params.key),
  );

  r.get(
    "/projects/:key/issues",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(issueSchema) },
      },
    },
    (req) =>
      issues.list(req.user, req.params.key, req.query.limit, req.query.offset),
  );
}
