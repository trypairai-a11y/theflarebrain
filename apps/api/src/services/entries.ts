import type { Prisma } from "@prisma/client";
import {
  buildEntryDataSchema,
  type FieldDefinition,
} from "../../../../packages/shared/src/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { bumpVersion } from "./cache.js";

export async function validateData(tx: Prisma.TransactionClient, moduleId: string, data: unknown) {
  const mod = await tx.module.findUnique({ where: { id: moduleId } });
  if (!mod) throw notFound("Module not found");
  const fields = mod.fieldDefinitions as unknown as FieldDefinition[];
  const schema = buildEntryDataSchema(fields);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw badRequest(parsed.error.message, "INVALID_ENTRY_DATA");
  return { mod, data: parsed.data };
}

export async function createEntry(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    moduleId: string;
    data: unknown;
    userId?: string;
    status?: "draft" | "scheduled" | "active";
    publishAt?: Date | null;
    expiresAt?: Date | null;
    externalId?: string;
  },
) {
  const { data } = await validateData(tx, params.moduleId, params.data);

  const entry = await tx.entry.create({
    data: {
      tenantId: params.tenantId,
      moduleId: params.moduleId,
      data: data as Prisma.InputJsonValue,
      status: params.status ?? "active",
      publishAt: params.publishAt ?? null,
      expiresAt: params.expiresAt ?? null,
      externalId: params.externalId,
      createdBy: params.userId,
    },
  });

  await tx.entryVersion.create({
    data: {
      entryId: entry.id,
      tenantId: params.tenantId,
      versionNumber: 1,
      dataSnapshot: data as Prisma.InputJsonValue,
      changedBy: params.userId,
      changeSummary: "created",
    },
  });

  await bumpVersion(params.tenantId);
  return entry;
}

export async function updateEntry(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    entryId: string;
    data: unknown;
    userId?: string;
    changeSummary?: string;
  },
) {
  const existing = await tx.entry.findUnique({ where: { id: params.entryId } });
  if (!existing) throw notFound("Entry not found");
  const { data } = await validateData(tx, existing.moduleId, params.data);

  const latest = await tx.entryVersion.findFirst({
    where: { entryId: existing.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const next = (latest?.versionNumber ?? 0) + 1;

  const updated = await tx.entry.update({
    where: { id: existing.id },
    data: { data: data as Prisma.InputJsonValue },
  });

  await tx.entryVersion.create({
    data: {
      entryId: existing.id,
      tenantId: params.tenantId,
      versionNumber: next,
      dataSnapshot: data as Prisma.InputJsonValue,
      changedBy: params.userId,
      changeSummary: params.changeSummary ?? "updated",
    },
  });

  // Retain last 50 versions
  const count = await tx.entryVersion.count({ where: { entryId: existing.id } });
  if (count > 50) {
    const toDelete = await tx.entryVersion.findMany({
      where: { entryId: existing.id },
      orderBy: { versionNumber: "asc" },
      take: count - 50,
      select: { id: true },
    });
    await tx.entryVersion.deleteMany({
      where: { id: { in: toDelete.map((v) => v.id) } },
    });
  }

  await bumpVersion(params.tenantId);
  return updated;
}
