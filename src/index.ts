import { buildApp, type Env } from "./app";

// Cloudflare Workers entry. Wrap fetch in a try/catch so crashes surface as
// readable JSON instead of CF's generic 502.
let cached: { env: Env; app: ReturnType<typeof buildApp> } | null = null;

function errorJson(label: string, err: unknown) {
  const e = err as { message?: string; stack?: string; name?: string };
  return Response.json(
    {
      error: label,
      name: e?.name ?? null,
      message: e?.message ?? String(err),
      stack: e?.stack?.split("\n").slice(0, 8) ?? null,
    },
    { status: 500 },
  );
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    try {
      if (!cached) {
        try {
          cached = { env, app: buildApp(env) };
        } catch (err) {
          return errorJson("buildApp failed", err);
        }
      }
      return await cached.app.fetch(req, env, ctx);
    } catch (err) {
      return errorJson("request failed", err);
    }
  },
};
