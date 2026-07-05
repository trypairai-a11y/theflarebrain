import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticate } from "../../_auth.js";
import { withTenant } from "../../_db.js";

// Slash-path twin of ../modules-with-counts.ts. The web client calls the
// canonical REST path /api/v1/modules/with-counts (which the real Fastify
// server serves under the /modules prefix); this flat stub serves the same
// path on Vercel without booting the full Fastify app.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: { message: "Method not allowed" } });
  }

  const auth = await authenticate(req.headers.authorization as string);
  if (!auth) {
    return res.status(401).json({ success: false, error: { message: "Unauthorized" } });
  }

  const modules = await withTenant(
    auth.tenantId,
    async (tx: any) => {
      return tx.module.findMany({
        where: { isActive: true },
        select: {
          id: true,
          slug: true,
          label: true,
          icon: true,
          _count: { select: { entries: true } },
        },
        orderBy: { createdAt: "asc" },
      });
    },
    auth.isAdmin,
  );

  const data = modules.map((m: any) => ({
    id: m.id,
    slug: m.slug,
    label: m.label,
    icon: m.icon,
    entryCount: m._count.entries,
  }));

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return res.json({ success: true, data });
}
