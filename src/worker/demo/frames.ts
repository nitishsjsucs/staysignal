// WebSocket frames in the public demo (ADR 0018): each frame is at most CAPS.maxWsFrameBytes, and a connection that
// sends more than CAPS.wsFramesPerMinute frames in a minute is closed. Incoming frames are Durable Object requests (20
// to 1) on Workers Free, and a closed connection costs a new upgrade, which the sandbox's units count. The guard wraps
// the agent's onMessage after the SDK installed its own wrappers, so it sees every frame first.
import type { Connection, WSMessage } from "agents";
import { CAPS } from "../../shared/demo/budget";

interface Framed {
  onMessage(connection: Connection, message: WSMessage): unknown;
}

export function guardFrames(agent: Framed, caps: { maxWsFrameBytes: number; wsFramesPerMinute: number } = CAPS): void {
  const inner = agent.onMessage.bind(agent);
  const seen = new Map<string, number[]>();
  agent.onMessage = (connection: Connection, message: WSMessage) => {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > caps.maxWsFrameBytes) {
      seen.delete(connection.id);
      connection.close(1009, "frame too large");
      return;
    }
    const now = Date.now();
    const times = (seen.get(connection.id) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= caps.wsFramesPerMinute) {
      seen.delete(connection.id);
      connection.close(4429, "too many messages");
      return;
    }
    times.push(now);
    seen.set(connection.id, times);
    return inner(connection, message);
  };
}
