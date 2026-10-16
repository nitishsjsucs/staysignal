# Production setup

**Not deployed.** The production path is built and tested against fakes, and has never run: no Cloudflare Access application, AI Gateway, BigQuery dataset or production runner exists for StaySignal, and production BigQuery has never been used. The only deployment is the [public demo](../PUBLIC-DEMO.md), which needs none of this. Builders create, change and deploy nothing in either cloud; the repository owner runs these steps.

## What production would be

Cloudflare Workers Free behind Cloudflare Access, Durable Objects with SQLite, Workflows, Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`) through AI Gateway with metadata-only logging, R2 for raw extracts, and BigQuery datasets prefixed `staysignal_` with dataset-scoped grants. The README's "What runs where" table compares it with the public demo and the local stand-ins; [DEVELOPMENT.md](../DEVELOPMENT.md#what-runs-where-in-full) has the full matrix.

Two paths:

- **Path A, a fixtures-mode deployment**, needs no Google resource: the built app behind Access with the committed fixtures as the warehouse.
- **Path B, the full BigQuery path**, is not ready: the Worker side is built (`npm run deploy -- --production`), and `prod:validate`, `prod:load` and `runner:prod` print their plans, but jobs that should write to BigQuery (a production publish) are not wired to the production runner yet.

`npm run doctor` (read-only: versions, `wrangler whoami`, the Workers AI catalog, `gcloud` and `bq` reads) reports which steps are still open, each with its fix.

## Steps

1. Cloudflare dashboard: Zero Trust, Settings, Authentication, Login methods: add **One-time PIN**.
2. Create an Access application for the Worker's workers.dev hostname with a policy for the demo principals' email addresses, and record its team domain and audience in `.prod/state.json` as `{"access": {"team_domain": "https://<team>.cloudflareaccess.com", "aud": "<audience>"}}` (gitignored). `npm run setup:prod -- --phase A` prints this and every other phase A step, marking those already done.
3. AI Gateway: create a gateway named `staysignal` with authentication on, and a Cloudflare API token with only Workers AI Read and AI Gateway Run. Record the account ID and gateway ID in `.prod/state.json` as `"account_id"` and `{"ai_gateway": {"id": "staysignal"}}`.
4. Set the Worker secrets `SS_HMAC_MASTER_KEY` (32 random bytes, base64), `SS_ROLE_BINDINGS` (JSON mapping each Access identity to a role, for example `{"you+lead@example.com": {"role": "pa_lead"}}`) and `SS_AIG_TOKEN` (the token of step 3) with `npx wrangler secret put`.
5. `npm run deploy -- --fixtures --dry-run` (renders `infra/cloudflare/wrangler.fixtures.template.jsonc` with placeholders, checks the Workers Free rules and the 8 MiB upload, builds, runs `wrangler deploy --dry-run`), then `npm run deploy -- --fixtures --yes` to deploy: the built app behind Access, both Durable Objects, the routine Workflow and `/mcp`, the committed fixtures as the warehouse, engine jobs completed inline from the committed job fixtures, and `@cf/qwen/qwen3-30b-a3b-fp8` through the gateway (metadata-only logs, `/no_think`, a cap of 1,500 neurons a day reserved before each turn and settled from its usage; over the cap a turn is refused with `BUDGET_EXHAUSTED` and the page's buttons still work). Production chat on Workers Free is best effort: a turn runs in one Durable Object invocation under the Free CPU limits.
6. Path B (later): reopen or link a billing account for the Google Cloud project, set a budget with the label `app=staysignal`, then `npm run setup:prod -- --phase B` prints the commands for the `staysignal_*` datasets, service accounts and dataset-scoped grants from `infra/gcp/grants.json`, only for what is missing. The Worker side is ready (`npm run deploy -- --production`), but the data path is not (see above).

## MCP clients in production

`/mcp` serves StaySignal's governed read tools and `prepare_review` under the same permissions as the chat (the README's "Connect an MCP client" has the local use). In production, Cloudflare Access protects `/mcp`; MCP clients cannot complete the one-time PIN login, so they use the `staysignal-mcp` Access service token, for example through `mcp-remote`:

```sh
npx mcp-remote https://<worker-host>/mcp --header "CF-Access-Client-Id:${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret:${CF_ACCESS_CLIENT_SECRET}"
```

The service token's principal is `svc:` plus its common name, bound to a read role through `SS_ROLE_BINDINGS`. In production all seven principals are the operator's own plus-addressed mailboxes, so separation of duties is enforced between principals, and the demo has one operator.
