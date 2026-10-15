// The public demo's caps and its budget arithmetic against the Workers Free limits (ADR 0018). Every cap the Worker
// enforces is a constant here; test/node/demo-budget.test.ts recomputes the daily bounds from these constants and
// fails if any exceeds the demo's share, and test/worker-public-demo/budget.test.ts measures the per-unit costs that
// MEASURED claims as upper bounds.

/** Workers Free, per account and UTC day (developers.cloudflare.com, verified 2026-10-15). */
export const FREE_PLAN = {
  workerRequestsPerDay: 100_000, // Workflow executions count here too
  doRequestsPerDay: 100_000, // incoming WebSocket messages count 20 to 1
  doRowsWrittenPerDay: 100_000, // deletes count as rows written
  doStoredBytes: 5 * 1000 ** 3, // 5 GB in total
  workflowConcurrentInstances: 100,
} as const;

/** The account is shared with four other repositories, so the demo plans for half of each allowance. */
export const DEMO_SHARE = 0.5;

export const CAPS = {
  /** A sandbox, and every cookie for it, lives at most this long from its creation. */
  sandboxLifetimeMs: 4 * 60 * 60 * 1000,
  newSandboxesPerClientPerHour: 3,
  newSandboxesPerDay: 15,
  liveSandboxes: 10,
  unitsPerSandboxPerMinute: 240,
  unitsPerSandbox: 600,
  routinesPerSandbox: 1,
  maxBodyBytes: 8 * 1024,
  maxQuestionChars: 500,
  maxReasonChars: 300,
  maxQueryChars: 200,
  maxWsFrameBytes: 64 * 1024,
  wsFramesPerMinute: 20,
  /** The lifetime count is written to SQLite once per this many units (the per-minute window stays in memory). */
  unitFlushEvery: 25,
  /** Creation records of the gate are kept this long, then pruned. */
  gateRetentionMs: 2 * 24 * 60 * 60 * 1000,
  /** A sandbox object woken after its destruction (a late workflow step) destroys itself after this delay. */
  orphanCleanupSeconds: 120,
} as const;

/** What one request costs a sandbox, in units. */
export const UNITS = { read: 1, write: 12, chatTurn: 18, routine: 80 } as const;

/** Upper bounds per unit and per sandbox, measured by test/worker-public-demo/budget.test.ts. */
export const MEASURED = {
  doRequestsPerUnit: 5,
  rowsWrittenPerUnit: 2,
  rowsWrittenSeed: 300,
  bytesPerSandbox: 4 * 1024 * 1024,
} as const;

/** Worker requests a visitor makes to sign in (the landing's session probe, the sign-in, the first /api/me). */
export const SIGN_IN_REQUESTS = 3;
/** Gate calls per sandbox: the creation check, and the release on reset. */
export const GATE_CALLS = 2;

export type Caps = { [K in keyof typeof CAPS]: number };
export type Measured = { [K in keyof typeof MEASURED]: number };

export interface BudgetLine {
  quantity: string;
  bound: number;
  budget: number;
}

/** The daily bounds of ADR 0018's table, recomputed from the constants above. */
export function budgetTable(caps: Caps = CAPS, measured: Measured = MEASURED): BudgetLine[] {
  const perDay = caps.newSandboxesPerDay;
  const units = caps.unitsPerSandbox;
  return [
    { quantity: "Worker requests per day", bound: perDay * (units + SIGN_IN_REQUESTS), budget: FREE_PLAN.workerRequestsPerDay * DEMO_SHARE },
    { quantity: "Durable Object requests per day", bound: perDay * (units * measured.doRequestsPerUnit + GATE_CALLS), budget: FREE_PLAN.doRequestsPerDay * DEMO_SHARE },
    // the factor 2: the deletion at expiry writes every stored row once more
    { quantity: "SQLite rows written per day", bound: perDay * 2 * (measured.rowsWrittenSeed + units * measured.rowsWrittenPerUnit) + perDay * GATE_CALLS * 4, budget: FREE_PLAN.doRowsWrittenPerDay * DEMO_SHARE },
    { quantity: "Bytes stored at any time", bound: caps.liveSandboxes * measured.bytesPerSandbox, budget: 1024 ** 3 },
    { quantity: "Concurrent Workflow instances", bound: caps.liveSandboxes * caps.routinesPerSandbox, budget: FREE_PLAN.workflowConcurrentInstances * DEMO_SHARE },
  ];
}
