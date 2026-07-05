import type { FastifyPluginAsync } from "fastify";
import * as XLSX from "xlsx";
import type { FieldDefinition } from "../../../../packages/shared/src/index.js";
import { buildEntryDataSchema } from "../../../../packages/shared/src/index.js";
import { createEntry } from "../services/entries.js";
import { notFound, badRequest } from "../lib/errors.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.post("/preview", async (req) => {
    const file = await req.file();
    if (!file) throw badRequest("No file");
    const buf = await file.toBuffer();
    if (buf.byteLength > 10 * 1024 * 1024) throw badRequest("Import file >10MB");
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]!]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    const headers = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];

    const modules = await req.withTenant((tx) => tx.module.findMany({ where: { isActive: true } }));
    const detected = detectModule(headers, modules);

    return {
      success: true,
      data: {
        rowCount: rows.length,
        headers,
        detectedModuleSlug: detected?.slug,
        sample: rows.slice(0, 5),
      },
    };
  });

  app.post("/commit/:moduleSlug", async (req) => {
    const { moduleSlug } = req.params as { moduleSlug: string };
    const file = await req.file();
    if (!file) throw badRequest("No file");
    const buf = await file.toBuffer();
    if (buf.byteLength > 10 * 1024 * 1024) throw badRequest("Import file >10MB");
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]!]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    const tenantId = req.tenantId!;
    const userId = (req.user as { sub: string } | undefined)?.sub;

    const result = await req.withTenant(async (tx) => {
      const mod = await tx.module.findFirst({ where: { slug: moduleSlug } });
      if (!mod) throw notFound();
      const fields = mod.fieldDefinitions as unknown as FieldDefinition[];
      const schema = buildEntryDataSchema(fields);

      const errors: Array<{ row: number; error: string }> = [];
      let imported = 0;
      for (const [idx, row] of rows.entries()) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          errors.push({ row: idx + 2, error: parsed.error.message }); // +2 for header + 1-index
          continue;
        }
        try {
          await createEntry(tx, {
            tenantId,
            moduleId: mod.id,
            data: parsed.data,
            userId,
            externalId: String(row["external_id"] ?? row["id"] ?? `row_${idx}`),
          });
          imported++;
        } catch (err) {
          errors.push({ row: idx + 2, error: err instanceof Error ? err.message : String(err) });
        }
      }

      await tx.importLog.create({
        data: {
          tenantId,
          filename: file.filename,
          moduleId: mod.id,
          rowsImported: imported,
          rowsFailed: errors.length,
          errors: errors as unknown as object,
        },
      });
      return { imported, failed: errors.length, errors };
    });

    return { success: true, data: result };
  });
};

function detectModule(
  headers: string[],
  modules: Array<{ slug: string; fieldDefinitions: unknown }>,
): { slug: string } | null {
  const lower = new Set(headers.map((h) => h.toLowerCase()));
  let best: { slug: string; score: number } | null = null;
  for (const m of modules) {
    const fields = (m.fieldDefinitions as FieldDefinition[]) ?? [];
    let score = 0;
    for (const f of fields) {
      if (lower.has(f.key)) score++;
      if (f.localized) {
        if (lower.has(`${f.key}_en`)) score++;
        if (lower.has(`${f.key}_ar`)) score++;
      }
    }
    if (!best || score > best.score) best = { slug: m.slug, score };
  }
  return best && best.score > 0 ? { slug: best.slug } : null;
}

export default routes;
