import { serve } from "@hono/node-server";

/** Loopback by default; the pilot TLS proxy is the only public ingress. */
export async function startReviewServer(
  handler: (request: Request) => Promise<Response>,
  tick: () => Promise<unknown>,
  options: { port?: number; hostname?: string; intervalMs?: number } = {}
) {
  let active: Promise<unknown> | undefined;
  let closing = false;
  const reconcile = () => {
    if (closing || active) return;
    active = tick()
      .catch(() => {
        process.stderr.write("REVIEW_RECONCILIATION_FAILED\n");
      })
      .finally(() => {
        active = undefined;
      });
  };
  let bound!: (url: string) => void;
  let failed!: (error: Error) => void;
  const listening = new Promise<string>((resolve, reject) => {
    bound = resolve;
    failed = reject;
  });
  const hostname = options.hostname ?? "127.0.0.1";
  const server = serve(
    {
      hostname,
      port: options.port ?? 8788,
      fetch: async (request) => {
        if (closing) return Response.json({ error: "SHUTTING_DOWN" }, { status: 503 });
        if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
          return Response.json({ status: "running" }, { headers: { "cache-control": "no-store" } });
        }
        try {
          return await handler(request);
        } catch {
          return Response.json({ error: "REVIEW_SERVICE_UNAVAILABLE" }, { status: 503 });
        }
      },
    },
    (address) => bound(`http://${hostname}:${address.port}`)
  );
  server.once("error", failed);
  const url = await listening;
  const timer = setInterval(reconcile, options.intervalMs ?? 5000);
  timer.unref();
  reconcile();
  return {
    url,
    async close() {
      closing = true;
      clearInterval(timer);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await active;
    },
  };
}
