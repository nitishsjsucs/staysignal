// The app releases every response body it will not read. The Worker's responses are not cached (Cache-Control:
// no-store), and a no-store body that nobody reads keeps its request open in Chromium, so the screenshot specs, which
// wait for the network to go idle, never finished on the dev-mode 404 of the public demo's session probe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJSON, postJSON } from "../../src/web/api";
import { demoSessionInfo } from "../../src/web/demo";

/** A response whose body stays open until it is read or cancelled, as a network body does. */
function openBody(status: number): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"error":"not found"}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status, headers: { "content-type": "application/json" } }), cancelled: () => cancelled };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("response bodies the app does not read", () => {
  it("are cancelled: the session probe outside the public demo, and API errors", async () => {
    for (const [status, call] of [
      [404, () => demoSessionInfo()],
      [503, () => demoSessionInfo()],
      [500, () => getJSON("/api/x").catch(() => null)],
      [403, () => postJSON("/api/x", {}).catch(() => null)],
    ] as const) {
      const b = openBody(status);
      vi.stubGlobal("fetch", vi.fn(async () => b.response));
      await call();
      await new Promise((r) => setTimeout(r, 0));
      expect(b.cancelled(), String(status)).toBe(true);
    }
  });
});
