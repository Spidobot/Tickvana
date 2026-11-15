import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { uuidv7 } from "../db/id.js";

/** An error the client is meant to see. Anything else becomes a blank 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Body of every non-2xx response. */
export const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

export interface ServerOptions {
  /** "tickvana" or "nuvenna". Shown in health and API docs. */
  name: string;
  version: string;
  /** Path the app lives under, e.g. "/tickvana". */
  prefix: string;
  /** API routes, mounted under `${prefix}/api`. */
  routes: FastifyPluginAsync;
  /** Built web app. Unknown non-API paths get its index.html. */
  webRoot?: string;
  /** Throws when a dependency (the database) is down. Used by the health route. */
  ready?: () => Promise<void>;
  logger?: boolean;
  /** True when a reverse proxy sits in front, so client addresses come from X-Forwarded-For. */
  trustProxy?: boolean;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

export async function createServer(
  opts: ServerOptions,
): Promise<FastifyInstance> {
  const api = `${opts.prefix}/api`;
  const app = Fastify({
    logger: opts.logger ?? false,
    // Ids are ours, never taken from a request header.
    genReqId: () => uuidv7(),
    requestIdHeader: false,
    trustProxy: opts.trustProxy ?? false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // Scripts only from us (no inline script, no eval), no plugins, no
    // framing by other sites (clickjacking). Styles may be inline: the
    // editors and React set style attributes. Attachments override this
    // with a sandbox.
    reply.header("content-security-policy", CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const send = (
      status: number,
      code: string,
      message: string,
      details?: unknown,
    ) =>
      reply
        .status(status)
        .send({ error: { code, message, details, requestId: req.id } });

    if (err instanceof AppError)
      return send(err.status, err.code, err.message, err.details);
    if (hasZodFastifySchemaValidationErrors(err)) {
      return send(
        400,
        "validation",
        "Request validation failed",
        err.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
      );
    }
    // Fastify's own client errors (malformed JSON, payload too large …).
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return send(status, "bad_request", (err as Error).message);
    }
    req.log.error(err);
    return send(500, "internal", "Internal server error");
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: opts.name.charAt(0).toUpperCase() + opts.name.slice(1),
        version: opts.version,
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: `${api}/docs` });

  await app.register(
    async (scope) => {
      scope.withTypeProvider<ZodTypeProvider>().get(
        "/health",
        {
          schema: {
            response: {
              200: z.object({
                status: z.literal("ok"),
                app: z.string(),
                version: z.string(),
              }),
            },
          },
        },
        async () => {
          try {
            await opts.ready?.();
          } catch (cause) {
            scope.log.error(cause);
            throw new AppError(503, "unavailable", "Service unavailable");
          }
          return {
            status: "ok" as const,
            app: opts.name,
            version: opts.version,
          };
        },
      );
      await scope.register(opts.routes);
    },
    { prefix: api },
  );

  if (opts.webRoot) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: `${opts.prefix}/`,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === api || req.url.startsWith(`${api}/`);
    const inApp =
      req.url === opts.prefix || req.url.startsWith(`${opts.prefix}/`);
    // Client-side routes: any other GET inside the app gets the web shell.
    if (opts.webRoot && req.method === "GET" && inApp && !isApi) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({
      error: { code: "not_found", message: "Not found", requestId: req.id },
    });
  });

  return app;
}
