import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { nanoid } from "nanoid";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { setClaudeObserver } from "../../../packages/prompts/src/index.js";
import { initSentry, Sentry } from "./lib/sentry.js";
import {
  registry as metricsRegistry,
  httpRequestDurationMs,
  llmCallTotal,
  llmCallDurationMs,
} from "./lib/metrics.js";
import tenantContext from "./plugins/tenant-context.js";
import auth from "./plugins/auth.js";
import apiKey from "./plugins/api-key.js";
import errorHandler from "./plugins/error-handler.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import moduleRoutes from "./routes/modules.js";
import entryRoutes from "./routes/entries.js";
import kbRoutes from "./routes/kb.js";
import chatRoutes from "./routes/chat.js";
import importRoutes from "./routes/import.js";
import activityRoutes from "./routes/activity.js";
import voiceRoutes from "./routes/voice.js";
import mediaRoutes from "./routes/media.js";
import meRoutes from "./routes/me.js";
import translateRoutes from "./routes/translate.js";

export async function buildApp() {
  initSentry(env.SENTRY_DSN, env.NODE_ENV);
  setClaudeObserver(({ model, latencyMs, status }) => {
    llmCallTotal.labels("anthropic", model, status).inc();
    llmCallDurationMs.labels("anthropic", model).observe(latencyMs);
  });
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    genReqId: () => nanoid(12),
    disableRequestLogging: false,
    bodyLimit: 1_048_576,
    connectionTimeout: env.REQUEST_TIMEOUT_MS,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    (req as unknown as { _startHr?: bigint })._startHr = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req, reply) => {
    const start = (req as unknown as { _startHr?: bigint })._startHr;
    if (!start) return;
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    const route = req.routeOptions?.url ?? "unmatched";
    const status = reply.statusCode;
    const statusClass = `${Math.floor(status / 100)}xx`;
    httpRequestDurationMs.labels(req.method, route, statusClass).observe(elapsed);
  });

  const allowedOrigins = env.CORS_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", ...allowedOrigins],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  // Global multipart ceiling. Routes enforce tighter per-file limits (voice 25MB, media/import 10MB).
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
      fieldSize: 1 * 1024 * 1024,
      fields: 20,
    },
  });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req.tenantId ?? req.ip) + ":" + (req.routeOptions?.url ?? ""),
  });
  await app.register(errorHandler);
  await app.register(tenantContext);
  await app.register(auth);
  await app.register(apiKey);

  // API documentation: available in dev and staging; disabled in production.
  if (env.NODE_ENV !== "production") {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "The Brain API",
          description: "Multi-tenant knowledge hub API.",
          version: "0.0.1",
        },
        servers: [{ url: `http://localhost:${env.PORT}` }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            apiKey: { type: "http", scheme: "bearer", bearerFormat: "tb_live_..." },
          },
        },
      },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });
  }

  // Metrics endpoint. Gated by the api-key plugin (require `read:metrics` scope).
  app.get("/metrics", { onRequest: [app.apiKeyAuth] }, async (req, reply) => {
    if (!req.apiKeyScopes?.includes("read:metrics")) {
      reply.code(403);
      return { success: false, error: { code: "FORBIDDEN", status: 403 } };
    }
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.get("/health", async () => {
    let db = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      /* db unreachable */
    }
    try {
      redisOk = (await redis.ping()) === "PONG";
    } catch {
      /* redis unreachable */
    }
    return {
      success: true,
      data: {
        status: db && redisOk ? "ok" : "degraded",
        db,
        redis: redisOk,
        timestamp: new Date().toISOString(),
      },
    };
  });

  app.get("/", async () => ({
    success: true,
    data: { message: "The Brain API. See /health for status." },
  }));

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(moduleRoutes, { prefix: "/api/v1/modules" });
  await app.register(entryRoutes, { prefix: "/api/v1/entries" });
  await app.register(kbRoutes, { prefix: "/api/v1" });
  await app.register(chatRoutes, { prefix: "/api/v1/chat" });
  await app.register(importRoutes, { prefix: "/api/v1/import" });
  await app.register(activityRoutes, { prefix: "/api/v1/activity" });
  await app.register(voiceRoutes, { prefix: "/api/v1/voice" });
  await app.register(mediaRoutes, { prefix: "/api/v1/media" });
  await app.register(meRoutes, { prefix: "/api/v1/me" });
  await app.register(translateRoutes, { prefix: "/api/v1/translate" });

  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  async function shutdown(signal: string) {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
    // Flush Sentry before exit so the last batch of errors isn't dropped.
    try {
      await Sentry.close(2_000);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only boot the HTTP server when this module is the process entry point.
// Tests import `buildApp` from this file and must not trigger `app.listen`.
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
