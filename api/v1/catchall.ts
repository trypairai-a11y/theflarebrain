/**
 * Vercel catch-all for /api/v1/* paths not matched by a more-specific
 * file in api/v1/. Routes the request into the hardened Fastify app at
 * apps/api/src/server.ts so admin, kb, knowledge-base, search, voice,
 * media, translate, analytics, kb-health, import, and any newly added
 * Fastify routes are served without per-route Vercel stubs.
 *
 * Named catchall.ts (not [...path].ts) because Vercel's filesystem
 * routing for plain api/ functions only matched a single path segment
 * in production; a vercel.json rewrite of /api/v1/:path* to this file
 * handles arbitrary depth. Filesystem routes are checked before
 * rewrites, so the flat demo stubs (health.ts, auth/, me/, modules.ts,
 * modules-with-counts.ts, activity.ts, entries/search.ts) still take
 * precedence on their own paths. req.url keeps the original request
 * path, which is what fastify.inject() needs.
 *
 * Implementation: delegates to fastify.inject() rather than piping the
 * raw HTTP stream. Vercel's @vercel/node runtime parses the body into
 * req.body before handing off, which makes stream-based delegation
 * unreliable. inject() accepts an already-materialised payload and
 * round-trips cleanly for JSON and small binary bodies. Large multipart
 * uploads are out of scope here (Vercel serverless has a 4.5 MB body
 * limit anyway); those should use the Docker-hosted Fastify instance.
 *
 * Boot: Fastify is built once per cold-started serverless instance and
 * reused for warm invocations. env.superRefine in lib/env.ts requires
 * all production secrets, so a missing var manifests as a clear 500
 * with the Zod message rather than a silent no-op.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

type InjectOptions = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  payload?: unknown;
};

type InjectResult = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawPayload: Buffer;
};

type ReadyApp = {
  inject: (opts: InjectOptions) => Promise<InjectResult>;
  ready: () => Promise<void>;
};

let appPromise: Promise<ReadyApp> | null = null;

function getApp(): Promise<ReadyApp> {
  if (!appPromise) {
    appPromise = (async (): Promise<ReadyApp> => {
      const mod: { buildApp: () => Promise<ReadyApp> } =
        await import("../../apps/api/src/server.js");
      const app = await mod.buildApp();
      await app.ready();
      return app;
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const app = await getApp();
    const result = await app.inject({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      payload: req.body,
    });
    for (const [k, v] of Object.entries(result.headers)) {
      if (v !== undefined) res.setHeader(k, v as string | string[]);
    }
    res.status(result.statusCode).send(result.rawPayload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      success: false,
      error: { code: "FASTIFY_BOOT_FAILED", message, status: 500 },
    });
  }
}
