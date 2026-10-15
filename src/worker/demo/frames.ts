// WebSocket frames in the public demo (ADR 0018): each frame is at most CAPS.maxWsFrameBytes, a connection sends at
// most CAPS.wsFramesPerMinute frames a minute and CAPS.wsFramesPerConnection frames in its life, and then it is closed.
// Incoming frames are Durable Object requests (20 to 1) on Workers Free, and a new connection spends the sandbox's
// units (UNITS.socket), so the frames a sandbox can send are bounded by its units. The counts live in the connection's
// attachment (its state), which survives hibernation; an in-memory count would restart every time the object sleeps.
// The guard wraps the agent's onMessage after the SDK installed its own wrappers, so it sees every frame first, and an
// optional filter then decides, per frame, what reaches the SDK at all: nothing the filter drops is ever persisted.
import type { Connection, WSMessage } from "agents";
import { CAPS } from "../../shared/demo/budget";

interface Framed {
  onMessage(connection: Connection, message: WSMessage): unknown;
}

export interface FrameCaps {
  maxWsFrameBytes: number;
  wsFramesPerMinute: number;
  wsFramesPerConnection: number;
}

/** The frame to hand to the SDK (the original or a rewritten one), or null to drop it. Only text frames reach it. */
export type FrameFilter = (connection: Connection, message: string) => string | null | Promise<string | null>;

/** The connection-state key that carries the counts: frames in all, and the current minute's start and count. */
export const FRAME_COUNTS = "_ss_frames";

interface Counts {
  n: number;
  w: number;
  k: number;
}

function frameBytes(message: WSMessage, max: number): number {
  if (typeof message !== "string") return message.byteLength;
  // a UTF-16 length under a third of the limit cannot exceed it in UTF-8
  return message.length * 3 <= max ? message.length : new TextEncoder().encode(message).byteLength;
}

export function guardFrames(agent: Framed, opts: { caps?: Partial<FrameCaps>; filter?: FrameFilter } = {}): void {
  const caps: FrameCaps = { maxWsFrameBytes: CAPS.maxWsFrameBytes, wsFramesPerMinute: CAPS.wsFramesPerMinute, wsFramesPerConnection: CAPS.wsFramesPerConnection, ...opts.caps };
  const inner = agent.onMessage.bind(agent);
  agent.onMessage = async (connection: Connection, message: WSMessage) => {
    if (frameBytes(message, caps.maxWsFrameBytes) > caps.maxWsFrameBytes) {
      connection.close(1009, "frame too large");
      return;
    }
    const now = Date.now();
    const state = (connection.state ?? {}) as Record<string, unknown>;
    const prev = (state[FRAME_COUNTS] as Counts | undefined) ?? { n: 0, w: now, k: 0 };
    const sameMinute = now - prev.w < 60_000;
    const next: Counts = { n: prev.n + 1, w: sameMinute ? prev.w : now, k: sameMinute ? prev.k + 1 : 1 };
    if (next.k > caps.wsFramesPerMinute) {
      connection.close(4429, "too many messages");
      return;
    }
    if (next.n > caps.wsFramesPerConnection) {
      connection.close(4429, "this connection has sent its frames; reconnect");
      return;
    }
    connection.setState({ ...state, [FRAME_COUNTS]: next });
    if (!opts.filter) return inner(connection, message);
    // the protocols used here are JSON text; a binary frame is never part of them
    if (typeof message !== "string") return;
    const passed = await opts.filter(connection, message);
    if (passed === null) return;
    return inner(connection, passed);
  };
}
