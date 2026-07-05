import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AnalyticsEvent } from "../../../../packages/shared/src/index.js";
import {
  withSingleFlight,
  currentVersion,
  writeFallback,
  readFallback,
} from "../services/cache.js";
import { notFound, forbidden } from "../lib/errors.js";

const SearchQuery = z.object({ q: z.string().min(1).max(200) });

/**
 * Public bot-facing API. Auth via API key. Cached in Redis with versioned keys.
 * On primary-path failure, serves from the `kb_fallback:*` 24h emergency keyspace.
 */

type KbPayload = {
  success: true;
  data: Record<string, Array<{ id: string; data: unknown }>>;
  meta: { tenant_id: string; generated_at: string; entry_count: number; stale?: boolean };
};

async function buildKb(req: FastifyRequest): Promise<KbPayload["data"]> {
  return req.withTenant(async (tx) => {
    const modules = await tx.module.findMany({ where: { isActive: true } });
    const grouped: Record<string, Array<{ id: string; data: unknown }>> = {};
    for (const m of modules) {
      const entries = await tx.entry.findMany({
        where: { moduleId: m.id, status: "active" },
        select: { id: true, data: true, updatedAt: true },
      });
      grouped[m.slug] = entries.map((e) => ({ id: e.id, data: e.data }));
    }
    return grouped;
  });
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.apiKeyAuth);

  app.get("/knowledge-base", async (req) => {
    if (!req.apiKeyScopes?.includes("read:kb")) throw forbidden();
    const tenantId = req.tenantId!;
    const version = await currentVersion(tenantId);
    const key = `kb:${tenantId}:v${version}`;

    try {
      const payload = await withSingleFlight<KbPayload>(key, async () => {
        const data = await buildKb(req);
        const count = Object.values(data).reduce((n, arr) => n + arr.length, 0);
        return {
          success: true,
          data,
          meta: { tenant_id: tenantId, generated_at: new Date().toISOString(), entry_count: count },
        };
      });
      await writeFallback(tenantId, payload);
      return payload;
    } catch (err) {
      req.log.warn({ err }, "kb primary path failed, attempting fallback");
      const stale = await readFallback<KbPayload>(tenantId);
      if (!stale) throw err;
      return { ...stale, meta: { ...stale.meta, stale: true } };
    }
  });

  app.get("/modules/:slug/entries", async (req) => {
    const { slug } = req.params as { slug: string };
    if (!req.apiKeyScopes?.includes("read:kb")) throw forbidden();
    const entries = await req.withTenant(async (tx) => {
      const mod = await tx.module.findFirst({ where: { slug } });
      if (!mod) throw notFound();
      return tx.entry.findMany({ where: { moduleId: mod.id, status: "active" } });
    });
    return { success: true, data: entries };
  });

  app.get("/search", async (req) => {
    const { q } = SearchQuery.parse(req.query);
    if (!req.apiKeyScopes?.includes("read:kb")) throw forbidden();
    const results = await req.withTenant(async (tx) => {
      return tx.$queryRaw<Array<{ id: string; module_id: string; data: unknown }>>(Prisma.sql`
        SELECT id, module_id, data
        FROM entries
        WHERE status = 'active'
          AND (
            (data->>'name') % ${q}
            OR (data->>'name_en') % ${q}
            OR (data->>'name_ar') % ${q}
          )
        ORDER BY GREATEST(
          similarity(coalesce(data->>'name',''), ${q}),
          similarity(coalesce(data->>'name_en',''), ${q}),
          similarity(coalesce(data->>'name_ar',''), ${q})
        ) DESC
        LIMIT 20
      `);
    });
    return { success: true, data: results };
  });

  app.get("/kb-health", async (req) => {
    const tenantId = req.tenantId!;
    const version = await currentVersion(tenantId);
    const hasFallback = !!(await readFallback(tenantId));
    return { success: true, data: { last_updated_version: version, has_fallback: hasFallback } };
  });

  app.post("/analytics/event", async (req) => {
    const event = AnalyticsEvent.parse(req.body);
    if (!req.apiKeyScopes?.includes("write:analytics") && !req.apiKeyScopes?.includes("read:kb")) {
      throw forbidden();
    }
    await req.withTenant((tx) =>
      tx.contentAnalyticsEvent.create({
        data: {
          tenantId: req.tenantId!,
          entryId: event.entry_id,
          eventType: event.event_type,
          botConversationId: event.bot_conversation_id,
        },
      }),
    );
    return { success: true, data: { recorded: true } };
  });
};

export default routes;
