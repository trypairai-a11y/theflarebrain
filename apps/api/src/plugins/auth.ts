import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwtPlugin from "@fastify/jwt";
import { env } from "../lib/env.js";
import { unauthorized } from "../lib/errors.js";
import type { Role } from "../../../../packages/shared/src/index.js";

type JwtPayload = {
  sub: string;
  tenantId: string;
  role: Role;
  kid?: string;
};

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
    authenticateAdmin: (req: FastifyRequest) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(jwtPlugin, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: "15m" },
  });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    try {
      const payload = await req.jwtVerify<JwtPayload>();
      req.tenantId = payload.tenantId;
      req.isAdmin = payload.role === "PAIR_ADMIN";
    } catch {
      throw unauthorized();
    }
  });

  app.decorate("authenticateAdmin", async (req: FastifyRequest) => {
    await app.authenticate(req);
    if (!req.isAdmin) throw unauthorized();
  });
};

export default fp(plugin, { name: "auth" });
