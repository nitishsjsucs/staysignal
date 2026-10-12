// Inline 16px stroke icons (no icon font, no external request).
import type { ReactElement } from "react";

type P = { size?: number; title?: string };

function svg(path: ReactElement, { size = 16, title }: P, fill = "none") {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : "presentation"} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}

export const IconForecast = (p: P) => svg(<><path d="M2 13h12" /><path d="M3 10.5 6 7l2.5 2L13 4" /><path d="M10.5 4H13v2.5" /></>, p);
export const IconChanges = (p: P) => svg(<><path d="M2 13h12" /><path d="M3.5 13V5" /><path d="M6.5 8V5" /><path d="M9.5 8v3" /><path d="M12.5 11v2" /></>, p);
export const IconTrust = (p: P) => svg(<><circle cx="8" cy="8" r="6.2" /><circle cx="8" cy="8" r="3.2" /><circle cx="8" cy="8" r="0.6" /></>, p);
export const IconQuality = (p: P) => svg(<><path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z" /><path d="m5.6 8 1.7 1.7L10.6 6.3" /></>, p);
export const IconReviews = (p: P) => svg(<><rect x="3" y="2.5" width="10" height="11.5" rx="1.5" /><path d="M6 2.5V2h4v.5" /><path d="m5.8 8.3 1.5 1.5 3-3" /></>, p);
export const IconFlows = (p: P) => svg(<><path d="M2 4h3c3 0 3 8 6 8h3" /><path d="M2 12h3c3 0 3-8 6-8h3" /></>, p);
export const IconMemory = (p: P) => svg(<><path d="M3 3.5h7l3 3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" /><path d="M5 8h6M5 10.5h4" /></>, p);
export const IconTraces = (p: P) => svg(<><path d="M2 3.5h5M4 7h7M6 10.5h8" /><path d="M2 13h12" /></>, p);
export const IconGovernance = (p: P) => svg(<><path d="M8 1.8 2.5 4.5h11z" /><path d="M3.5 6v6M6.5 6v6M9.5 6v6M12.5 6v6" /><path d="M2 13.5h12" /></>, p);
export const IconAsk = (p: P) => svg(<><path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a2 2 0 0 1-1.5-2z" /></>, p);
export const IconSun = (p: P) => svg(<><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" /></>, p);
export const IconMoon = (p: P) => svg(<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6z" />, p);
export const IconClose = (p: P) => svg(<path d="M4 4l8 8M12 4l-8 8" />, p);
export const IconSend = (p: P) => svg(<><path d="M2.5 8 13.5 2.5 10 13.5 7.5 9z" /><path d="m7.5 9 6-6.5" /></>, p);
export const IconFlask = (p: P) => svg(<><path d="M6 2h4M6.5 2v4L3 13a1 1 0 0 0 .9 1.4h8.2A1 1 0 0 0 13 13L9.5 6V2" /><path d="M4.6 10.5h6.8" /></>, p);
export const IconCheck = (p: P) => svg(<><circle cx="8" cy="8" r="6.2" /><path d="m5.4 8.1 1.8 1.8 3.4-3.6" /></>, p);
export const IconAlert = (p: P) => svg(<><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></>, p);
export const IconStop = (p: P) => svg(<><path d="M5.3 1.8h5.4l3.5 3.5v5.4l-3.5 3.5H5.3l-3.5-3.5V5.3z" /><path d="M8 5v3.5M8 10.8v.1" /></>, p);
export const IconInfo = (p: P) => svg(<><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2V11M8 5v.1" /></>, p);
export const IconHold = (p: P) => svg(<><circle cx="8" cy="8" r="6.2" /><path d="M6.5 5.5v5M9.5 5.5v5" /></>, p);
export const IconLink = (p: P) => svg(<><path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7" /><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7" /></>, p);
export const IconUndo = (p: P) => svg(<><path d="M5 4 2 7l3 3" /><path d="M2 7h7.5a4 4 0 0 1 0 8H7" /></>, p);
export const IconPlay = (p: P) => svg(<path d="M5 3.2v9.6L12.6 8z" />, p);

export function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 11.5c2.2 0 2.6-5 5-5s2.8 3 5 3" fill="none" stroke="var(--accent-ink)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12.2" cy="9.5" r="1.6" fill="var(--accent-ink)" />
    </svg>
  );
}
