---
name: apikeys-handler
description: Rotates API keys and secrets after a breach or exposure, in priority order, without the model ever seeing a value. Imports every variable from Railway (or local .env and docker-compose files, Netlify, Cloudflare, Supabase), sorts them by service (container), category and priority, generates new values for secrets the app owns (JWT, session, APP_KEY), walks the user through third-party keys, writes the changes, restarts each service once, and keeps progress across restarts. Use when the user says rotate keys, rotate secrets, credentials leaked, exposed .env, got hacked, breach, remote code execution, or /apikeys-handler.
license: MIT
metadata:
  author: codegobrrrr9
  version: "0.1.0"
  homepage: https://github.com/codegobrrrr9/apikeys-handler
---

# apikeys-handler

After a breach the slow part is not finding the secrets, it is doing forty rotations in the right order
without breaking production. This tool keeps the inventory, the order and the progress. **It never prints a
secret value, never stores one, and the model must never see one.**

It does not patch anything. If a runtime was vulnerable, patch it first, or the new secrets leak the same way.

## Rules

1. **Do not read secrets.** Never open or print a `.env` file, a variable value or a token. Use `scan` and `plan`:
   they show names, categories, priorities and short fingerprints, never values.
2. **Never ask the user to type a secret into the chat.** New third-party keys go into the dashboard
   (`apikeys-handler ui`), the hidden terminal prompt, or an environment variable the user sets in their own
   terminal (`AKH_NEW_<VARIABLE_NAME>`). Tokens for the platforms (`RAILWAY_API_TOKEN`, `RAILWAY_TOKEN`,
   `NETLIFY_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`) are set the same way.
3. **Start with a dry run.** `apikeys-handler plan --exposed <services>` and show the user the order, the
   warnings and the request count. **Ask before `--apply`.** Pass `--yes` only after the user approved that
   exact plan.
4. **Ask which services were exposed**, then pass `--exposed web,worker`. Everything those services can read goes first.
5. **One priority group at a time**: P0 (databases, payments, cloud, session and encryption keys, publish tokens),
   then P1, then P2. Check `status` between groups.
6. **Say what the tool cannot do**, every time, in the final message: it changes the variable on the platform;
   it does not revoke the old key at the provider, and it does not change a database password. For a database
   password the user changes it in the database first, then pastes the same value.
7. **Never generate what a provider issues.** The tool already refuses (webhook secrets, database passwords,
   encryption keys and provider-prefixed keys are never generated). Do not work around it by passing your own value.
8. Ask before touching a workflow file, deleting variables, or running anything that restarts production by hand
   (the dotenv adapter prints the `docker compose` command; it never runs it).
9. End with `apikeys-handler status` and list what is still manual.

## Commands

```
apikeys-handler scan   [--platform railway,dotenv,netlify,cloudflare,supabase] [--exposed web,worker] [--json]
apikeys-handler plan   [selection]                 dry run
apikeys-handler rotate [selection] --apply [--yes]
apikeys-handler status                             progress, survives a restart
apikeys-handler report [--out file.md]             names and statuses only
apikeys-handler ui                                 local dashboard (127.0.0.1, one-time link)
apikeys-handler demo                               the dashboard on made-up data, no account needed
selection: --name A,B  --priority P0  --up-to P1  --category Database  --service web  --include-config  --again
```

What each status means: **written** the platform variable changed; **redeployed** the service restarted once;
**verified** the platform now returns a different value than before. Verified is about the variable, not the
provider: the old key is dead only when the user revokes it there.

The classification rules, how `how` (generate / provider / manual) is decided, and the benchmark are in
[`references/method.md`](references/method.md). What is verified against a live platform and what is not is in
[`references/platforms.md`](references/platforms.md).

## Final message shape

```
apikeys-handler · verified 9 · written 2 · failed 0 · P0 done, P1 next
Still yours: revoke the old Stripe and OpenAI keys; change the database password at the source; restart by hand: docker compose up -d --force-recreate web
```
