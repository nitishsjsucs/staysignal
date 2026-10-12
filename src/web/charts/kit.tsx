// Chart kit: responsive width, a shared tooltip, axis ticks. Charts are SVG built with d3-scale and d3-shape; labels
// and values use text tokens, never series colors; the hover layer is part of every chart (dataviz rules).
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function useWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.max(240, Math.floor(cw)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

export function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = useCallback((e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }), []);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show, hide };
}

export function Tooltip({ tip }: { tip: TipState | null }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, tip.x + 14);
    const top = tip.y + 14 + r.height > window.innerHeight ? tip.y - r.height - 10 : tip.y + 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div className="tooltip" ref={ref} style={pos ? { left: pos.left, top: pos.top } : { left: tip.x + 14, top: tip.y + 14, visibility: "hidden" }} role="tooltip">
      {tip.content}
    </div>,
    document.body,
  );
}

export function TipRow({ name, value, swatch, line }: { name: string; value: ReactNode; swatch?: string; line?: string }) {
  return (
    <div className="tt-row">
      <span className="tt-name">
        {line ? <span className="legend-line" style={{ background: line }} /> : swatch ? <span className="legend-swatch" style={{ background: swatch }} /> : null}
        {name}
      </span>
      <span className="tt-value">{value}</span>
    </div>
  );
}

/** Clean axis ticks (0, 5, 10, ...) for a count axis. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  if (out[out.length - 1]! < max) out.push(Math.round((out[out.length - 1]! + step) * 1000) / 1000);
  return out;
}

export function monthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

/** The calendar month that ends on the day before `iso` (curve knots are dated at the first day after the month). */
export function monthEnding(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export function fmtVal(v: number, step = 0.1): string {
  return step >= 1 ? Math.round(v).toLocaleString("en-US") : (Math.round(v * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
