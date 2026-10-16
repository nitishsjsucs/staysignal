// npm run docs:tour: the README's guided-tour animation (docs/images/tour.gif) and its still poster for viewers who
// prefer reduced motion (docs/images/tour-poster.png). Each frame is one committed walkthrough screenshot
// (docs/screenshots/*.png, taken from the public demo served locally by npm run docs:screenshots) above a caption bar
// in the app's design tokens, composed in Chromium and encoded with ffmpeg. No server and no model run here: every
// number on screen is synthetic and every chat answer is a replayed recording. Frames go to var/tour (gitignored).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export const FRAMES: readonly { shot: string; title: string; caption: string }[] = [
  { shot: "03-forecast", title: "Forecast", caption: "Expected voluntary departures with 80% and 95% ranges, beside the trailing-rate status quo" },
  { shot: "16-individual-refused", title: "The boundary", caption: "Asking which engineers are most likely to leave is refused before any model call" },
  { shot: "04-what-changed", title: "What changed", caption: "An exact Shapley split of the change since the previous run" },
  { shot: "05-data-health-held", title: "A bad payroll file", caption: "Checks fail upstream of the forecast features, and the candidate run is held" },
  { shot: "06-data-health-repaired", title: "Repair and replay", caption: "An approved mapping fix publishes; a fresh-warehouse replay gives the same hash" },
  { shot: "07-reviews-self-approval-refused", title: "Accountable review", caption: "Approving your own submission is refused with SELF_APPROVAL" },
  { shot: "09-trust", title: "Trust", caption: "Backtests, calibration and coverage against nominal" },
];

const OUT_DIR = join("docs", "images");
const WORK = join("var", "tour");
const GIF_MAX = 3_000_000;
const POSTER_MAX = 400_000;
const SECONDS_PER_FRAME = 3;
const WIDTH = 1200;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One frame: the screenshot (1440 by 900) above a 110-pixel caption bar, in the light theme's tokens. */
export function frameHtml(i: number, fontDataUri: string, shotDataUri: string): string {
  const f = FRAMES[i]!;
  const steps = FRAMES.map((_, k) => `<span class="${k <= i ? "on" : ""}"></span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "InterTour"; src: url(${fontDataUri}) format("woff2"); font-weight: 100 900; }
html, body { margin: 0; background: #f9f9f7; }
body { width: 1440px; font-family: "InterTour", sans-serif; color: #0b0b0b; -webkit-font-smoothing: antialiased; }
img { display: block; width: 1440px; height: 900px; }
.bar { box-sizing: border-box; height: 110px; padding: 18px 40px 0; background: #fcfcfb; border-top: 1px solid #d3d2ca; }
.row { display: flex; align-items: baseline; gap: 16px; }
.n { font-size: 20px; font-weight: 600; color: #1c5cab; font-variant-numeric: tabular-nums; }
.t { font-size: 30px; font-weight: 650; letter-spacing: -0.01em; }
.steps { display: flex; gap: 6px; align-self: center; margin-left: 24px; }
.steps span { width: 34px; height: 6px; border-radius: 3px; background: #e1e0d9; }
.steps span.on { background: #1c5cab; }
.c { margin-top: 8px; display: flex; align-items: baseline; }
.cap { font-size: 23px; color: #52514e; }
.foot { margin-left: auto; font-size: 15px; color: #6d6c67; white-space: nowrap; }
</style></head><body><img src="${shotDataUri}" alt=""><div class="bar">
<div class="row"><span class="n">${i + 1} of ${FRAMES.length}</span><span class="t">${esc(f.title)}</span><span class="foot">Public demo · synthetic company Larkspur Systems · recorded model output</span><span class="steps">${steps}</span></div>
<div class="c"><span class="cap">${esc(f.caption)}</span></div>
</div></body></html>`;
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
}

async function main(): Promise<void> {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    console.error("[tour] ffmpeg is not on PATH; install it (for example `brew install ffmpeg`) and run again");
    process.exit(1);
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const font = `data:font/woff2;base64,${readFileSync(join("node_modules", "@fontsource-variable", "inter", "files", "inter-latin-wght-normal.woff2")).toString("base64")}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1010 }, deviceScaleFactor: 1 });
    for (const [i, f] of FRAMES.entries()) {
      const shot = `data:image/png;base64,${readFileSync(join("docs", "screenshots", `${f.shot}.png`)).toString("base64")}`;
      await page.setContent(frameHtml(i, font, shot), { waitUntil: "load" });
      await page.evaluate("document.fonts.ready.then(() => true)");
      const out = join(WORK, `frame-${String(i + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1440, height: 1010 } });
      console.log(`[tour] ${out}`);
    }
  } finally {
    await browser.close();
  }
  const gif = join(OUT_DIR, "tour.gif");
  const poster = join(OUT_DIR, "tour-poster.png");
  ffmpeg([
    "-y",
    "-framerate", String(1 / SECONDS_PER_FRAME),
    "-i", join(WORK, "frame-%02d.png"),
    "-vf", `scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    "-loop", "0",
    gif,
  ]);
  ffmpeg(["-y", "-i", join(WORK, "frame-01.png"), "-vf", `scale=${WIDTH}:-1:flags=lanczos`, poster]);
  const gifBytes = statSync(gif).size;
  const posterBytes = statSync(poster).size;
  console.log(`[tour] ${gif} ${gifBytes.toLocaleString("en-US")} bytes; ${poster} ${posterBytes.toLocaleString("en-US")} bytes`);
  if (gifBytes > GIF_MAX || posterBytes > POSTER_MAX) {
    console.error(`[tour] over budget: the GIF must stay under ${GIF_MAX.toLocaleString("en-US")} bytes and the poster under ${POSTER_MAX.toLocaleString("en-US")}`);
    process.exit(1);
  }
}

await main();
