# Platforms: what is verified and what is not

"Verified" means checked against the vendor's live service or schema, not only against this repo's fake server.

| Platform | Reads | Writes | Restart | Status |
|---|---|---|---|---|
| **Railway** | variables per project, environment, service and shared, with `unrendered: true` so references stay references | `variableCollectionUpsert`, `skipDeploys: true`, never `replace` | `serviceInstanceRedeploy(environmentId, serviceId)` | **Operations verified against the live schema** by unauthenticated introspection on 2026-10-22 (field names, argument types, input shapes). **Not verified behind a token:** which projects an account or workspace token lists, what a project token may query, and the real behaviour of a write. Run the live test below. |
| **.env and docker-compose** | `KEY=VALUE`, quotes, `export`, trailing comments; compose `environment:` as a mapping or a list and `env_file:` | rewrites only the changed lines, atomically, keeping everything else byte for byte | prints the `docker compose up -d --force-recreate <service>` command; never runs it | Tested for real on temp repos (round trip, CRLF, quoting, tracked-file warning). Unsupported syntax is reported, not guessed: multiline values, anchors, aliases, flow mappings, block scalars. |
| **Netlify** | environment variables per site and deploy context (secret-marked values are unreadable) | `PUT /accounts/{id}/env/{key}` | `POST /sites/{id}/builds` | **Unverified.** Written from public docs, tested against a fake server only. |
| **Cloudflare** | Workers secrets (names only), Pages variables (secret values unreadable) | Workers `PUT .../secrets`, Pages `PATCH` of `deployment_configs` | a Worker picks up a new secret itself; Pages gets a new deployment | **Unverified.** Fake server only. |
| **Supabase** | Edge Function secret names | `POST /projects/{ref}/secrets` | prints a hint | **Unverified.** Fake server only. Only Edge Function secrets: the anon key, service-role key and JWT secret are dashboard-only and cannot be rotated from here. |

Every operation string is in one place (`OPS` in `railway.js` and `hosts.js`), so a wrong shape is a one-line fix.

## Live test (Railway), about ten minutes, in your own terminal

1. Create a throwaway Railway project with two services and a handful of variables, including one `${{Service.VAR}}` reference.
2. In your terminal (not in a chat): `$env:RAILWAY_API_TOKEN = "<an account token>"` (PowerShell) or
   `export RAILWAY_API_TOKEN=...`. For a project token use `RAILWAY_TOKEN`.
3. `apikeys-handler scan --platform railway`, then `plan`, then `rotate --apply` on one generated secret.
4. Check in the Railway dashboard that exactly that variable changed, the reference did not, and the service restarted once.

Rate limits (Railway docs): 100, 1,000 or 10,000 requests an hour by plan, 10 or 50 a second. `plan` prints the
number of write and restart requests; listing costs one request per service per environment. On the free plan, scan
one environment at a time (`--environment production`).
