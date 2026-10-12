// StaySignal Worker entry. M0: health only; the API, agents and workflows arrive in M1.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "staysignal", authMode: env.SS_AUTH_MODE, dataMode: env.SS_DATA_MODE, label: "synthetic" });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
