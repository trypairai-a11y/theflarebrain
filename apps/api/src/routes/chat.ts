import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  parseUtterance,
  translateField,
  simulateBot,
  type ParsedAction,
} from "../../../../packages/prompts/src/index.js";
import type { FieldDefinition } from "../../../../packages/shared/src/index.js";
import { appendTurn, getTurns } from "../services/session-memory.js";
import { createEntry, updateEntry } from "../services/entries.js";
import { audit, activity } from "../services/audit.js";
import { notFound, badRequest } from "../lib/errors.js";

const ParseBody = z.object({
  sessionId: z.string().uuid(),
  utterance: z.string().min(1),
});

const ConfirmBody = z.object({
  sessionId: z.string().uuid(),
  action: z.record(z.unknown()),
});

const TestItBody = z.object({
  module: z.string(),
  fields: z.record(z.unknown()),
  question: z.string(),
  locale: z.enum(["en", "ar"]).default("en"),
});

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  /** Parse: user utterance → preview card (action + optional AR translation). */
  app.post("/parse", async (req) => {
    const body = ParseBody.parse(req.body);
    const tenantId = req.tenantId!;

    const { modules, recentEntriesByModule, session } = await req.withTenant(async (tx) => {
      const mods = await tx.module.findMany({ where: { isActive: true } });
      const recent: Record<string, Array<{ id: string; name: string; data: unknown }>> = {};
      for (const m of mods) {
        const entries = await tx.entry.findMany({
          where: { moduleId: m.id, status: "active" },
          orderBy: { updatedAt: "desc" },
          take: 3,
        });
        recent[m.slug] = entries.map((e) => {
          const d = e.data as Record<string, unknown>;
          return {
            id: e.id,
            name: String(d.name ?? d.name_en ?? d.question_en ?? e.id),
            data: d,
          };
        });
      }
      const session = await tx.chatSession.upsert({
        where: { id: body.sessionId },
        create: {
          id: body.sessionId,
          tenantId,
          userId: (req.user as { sub: string } | undefined)?.sub ?? "",
          messages: [],
        },
        update: { lastActiveAt: new Date() },
      });
      return {
        modules: mods.map((m) => ({
          slug: m.slug,
          label: m.label,
          fields: m.fieldDefinitions as unknown as FieldDefinition[],
        })),
        recentEntriesByModule: recent,
        session,
      };
    });

    const turns = await getTurns(tenantId, body.sessionId);

    const result = await parseUtterance({
      utterance: body.utterance,
      tenantId,
      modules,
      recentEntriesByModule,
      sessionHistory: turns.map((t) => ({ role: t.role, content: t.content })),
      summary: session.summary ?? undefined,
    });

    await appendTurn(tenantId, body.sessionId, {
      role: "user",
      content: body.utterance,
      at: Date.now(),
    });

    if (!result.ok)
      return {
        success: false,
        error: { code: "PARSE_FAILED", message: result.error, status: 422 },
      };

    // For CREATE / SCHEDULE / DUPLICATE: auto-translate localized fields with empty counterpart.
    const enriched = await autoTranslateAction(result.action, modules);

    await appendTurn(tenantId, body.sessionId, {
      role: "assistant",
      content: JSON.stringify(enriched),
      at: Date.now(),
    });

    return {
      success: true,
      data: {
        card: enriched,
        metrics: result.metrics,
      },
    };
  });

  /** Confirm: turn a preview-card action into a real write. */
  app.post("/confirm", async (req) => {
    const body = ConfirmBody.parse(req.body);
    const action = body.action as unknown as ParsedAction;
    const tenantId = req.tenantId!;
    const userId = (req.user as { sub: string } | undefined)?.sub;

    const result = await req.withTenant(async (tx) => {
      const mod = await tx.module.findFirst({ where: { slug: (action as any).module } });
      if (!mod) throw notFound("Unknown module");

      switch (action.action) {
        case "CREATE": {
          const entry = await createEntry(tx, {
            tenantId,
            moduleId: mod.id,
            data: action.fields,
            userId,
          });
          await audit(tx, {
            tenantId,
            userId,
            action: "create",
            entityType: "entry",
            entityId: entry.id,
            diff: action.fields,
          });
          await activity(tx, { tenantId, userId, action: "create", moduleSlug: mod.slug });
          return { entry };
        }
        case "SCHEDULE": {
          const entry = await createEntry(tx, {
            tenantId,
            moduleId: mod.id,
            data: action.fields,
            userId,
            status: "scheduled",
            publishAt: new Date(action.publish_at),
          });
          await tx.scheduledJob.create({
            data: {
              tenantId,
              entryId: entry.id,
              action: "publish",
              scheduledAt: new Date(action.publish_at),
            },
          });
          await audit(tx, {
            tenantId,
            userId,
            action: "schedule",
            entityType: "entry",
            entityId: entry.id,
            diff: action.fields,
          });
          return { entry };
        }
        case "UPDATE": {
          if (!action.match.entry_id)
            throw badRequest("UPDATE needs match.entry_id (resolve on client)");
          const entry = await updateEntry(tx, {
            tenantId,
            entryId: action.match.entry_id,
            data: action.fields,
            userId,
          });
          await audit(tx, {
            tenantId,
            userId,
            action: "update",
            entityType: "entry",
            entityId: entry.id,
            diff: action.fields,
          });
          return { entry };
        }
        case "BULK_UPDATE": {
          const entries = await tx.entry.findMany({ where: { moduleId: mod.id } });
          const matching = entries.filter((e) => matchesWhere(e.data as any, action.where));
          for (const e of matching) {
            await updateEntry(tx, {
              tenantId,
              entryId: e.id,
              data: { ...(e.data as object), ...action.set },
              userId,
              changeSummary: `bulk: ${JSON.stringify(action.where)}`,
            });
          }
          await audit(tx, {
            tenantId,
            userId,
            action: "bulk_update",
            entityType: "module",
            entityId: mod.id,
            diff: { where: action.where, set: action.set, count: matching.length },
          });
          return { updated: matching.length };
        }
        case "DELETE": {
          if (!action.match.entry_id) throw badRequest("DELETE needs match.entry_id");
          await tx.entry.delete({ where: { id: action.match.entry_id } });
          await audit(tx, {
            tenantId,
            userId,
            action: "delete",
            entityType: "entry",
            entityId: action.match.entry_id,
          });
          return { deleted: action.match.entry_id };
        }
        case "DUPLICATE": {
          if (!action.source.entry_id) throw badRequest("DUPLICATE needs source.entry_id");
          const src = await tx.entry.findUnique({ where: { id: action.source.entry_id } });
          if (!src) throw notFound();
          const entry = await createEntry(tx, {
            tenantId,
            moduleId: mod.id,
            userId,
            data: { ...(src.data as object), ...action.changes },
          });
          return { entry };
        }
        case "QUERY":
          return { query: action.query };
      }
    });

    return { success: true, data: result };
  });

  /** Test It: stateless bot simulation using KB + pending card merged in memory. */
  app.post("/test-it", async (req) => {
    const body = TestItBody.parse(req.body);
    const snapshot = await req.withTenant(async (tx) => {
      const modules = await tx.module.findMany({ where: { isActive: true } });
      const out: Record<string, Array<{ id: string; data: unknown }>> = {};
      for (const m of modules) {
        const entries = await tx.entry.findMany({
          where: { moduleId: m.id, status: "active" },
          select: { id: true, data: true },
        });
        out[m.slug] = entries.map((e) => ({ id: e.id, data: e.data }));
      }
      // Merge pending card
      const target = out[body.module] ?? [];
      target.push({ id: "pending", data: body.fields });
      out[body.module] = target;
      return out;
    });
    const result = await simulateBot({
      botSystemPrompt:
        "You are Fai, the Flare Fitness customer bot. Answer using only the provided KB. Be warm and concise.",
      kbSnapshot: snapshot,
      userQuestion: body.question,
      locale: body.locale,
    });
    return { success: true, data: result };
  });
};

async function autoTranslateAction(
  action: ParsedAction,
  modules: Array<{ slug: string; fields: FieldDefinition[] }>,
): Promise<ParsedAction> {
  if (action.action !== "CREATE" && action.action !== "SCHEDULE" && action.action !== "DUPLICATE") {
    return action;
  }
  const mod = modules.find((m) => m.slug === (action as any).module);
  if (!mod) return action;
  const target: Record<string, unknown> =
    action.action === "DUPLICATE" ? { ...action.changes } : { ...action.fields };
  const localized = mod.fields.filter((f) => f.localized);
  for (const f of localized) {
    const en = target[`${f.key}_en`];
    const ar = target[`${f.key}_ar`];
    if (typeof en === "string" && !ar) {
      const r = await translateField({ text: en, from: "en", to: "ar", fieldLabel: f.label });
      target[`${f.key}_ar`] = r.text;
      target[`${f.key}_ar_confidence`] = r.confidence;
    } else if (typeof ar === "string" && !en) {
      const r = await translateField({ text: ar, from: "ar", to: "en", fieldLabel: f.label });
      target[`${f.key}_en`] = r.text;
      target[`${f.key}_en_confidence`] = r.confidence;
    }
  }
  if (action.action === "DUPLICATE") return { ...action, changes: target };
  return { ...action, fields: target };
}

function matchesWhere(data: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (data[k] !== v) return false;
  }
  return true;
}

export default routes;
