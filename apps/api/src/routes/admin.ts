import type { FastifyPluginAsync } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ModuleSchema, Role } from "../../../../packages/shared/src/index.js";
import { MARKETPLACE } from "../services/marketplace.js";

const CreateTenantBody = z.object({
  name: z.string(),
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  primaryColor: z.string().optional(),
  weeklyReportEmail: z.string().email().optional(),
  timezone: z.string().default("Asia/Kuwait"),
});

const CreateUserBody = z.object({
  tenantId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string(),
  role: Role,
});

const CreateApiKeyBody = z.object({
  tenantId: z.string().uuid(),
  label: z.string(),
  scopes: z.array(z.string()).default(["read:kb"]),
});

/** Admin routes run as PAIR_ADMIN; all writes go through req.withTenant so the
 *  is_admin session var is set and RLS policies allow cross-tenant writes. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticateAdmin);

  app.post("/tenants", async (req) => {
    const body = CreateTenantBody.parse(req.body);
    const tenant = await req.withTenant((tx) => tx.tenant.create({ data: body }));
    return { success: true, data: tenant };
  });

  app.post("/modules", async (req) => {
    const body = z.object({ tenantId: z.string().uuid() }).merge(ModuleSchema).parse(req.body);
    const mod = await req.withTenant((tx) =>
      tx.module.create({
        data: {
          tenantId: body.tenantId,
          slug: body.slug,
          label: body.label,
          icon: body.icon,
          fieldDefinitions: body.fields as object,
          behaviors: body.behaviors as object,
        },
      }),
    );
    return { success: true, data: mod };
  });

  app.post("/users", async (req) => {
    const body = CreateUserBody.parse(req.body);
    const hash = await bcrypt.hash(body.password, 10);
    const user = await req.withTenant((tx) =>
      tx.user.create({
        data: {
          tenantId: body.tenantId,
          email: body.email,
          name: body.name,
          role: body.role,
          passwordHash: hash,
        },
      }),
    );
    return {
      success: true,
      data: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });

  app.get("/marketplace", async () => ({ success: true, data: MARKETPLACE }));

  app.post("/marketplace/install", async (req) => {
    const body = z
      .object({ tenantId: z.string().uuid(), slugs: z.array(z.string()).min(1) })
      .parse(req.body);
    const installed = await req.withTenant(async (tx) => {
      const out = [];
      for (const slug of body.slugs) {
        const def = MARKETPLACE.find((m) => m.slug === slug);
        if (!def) continue;
        const mod = await tx.module.upsert({
          where: { tenantId_slug: { tenantId: body.tenantId, slug: def.slug } },
          create: {
            tenantId: body.tenantId,
            slug: def.slug,
            label: def.label,
            icon: def.icon,
            fieldDefinitions: def.fields as object,
          },
          update: { fieldDefinitions: def.fields as object, label: def.label, icon: def.icon },
        });
        out.push(mod);
      }
      return out;
    });
    return { success: true, data: installed };
  });

  app.post("/api-keys", async (req) => {
    const body = CreateApiKeyBody.parse(req.body);
    const raw = `tb_live_${randomBytes(24).toString("hex")}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await req.withTenant((tx) =>
      tx.apiKey.create({
        data: {
          tenantId: body.tenantId,
          label: body.label,
          scopes: body.scopes,
          keyHash: hash,
          keyPrefix: raw.slice(0, 12),
        },
      }),
    );
    return { success: true, data: { apiKey: raw }, meta: { warning: "shown once" } };
  });
};

export default routes;
