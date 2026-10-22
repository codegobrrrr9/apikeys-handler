<div align="center">

# 🔑 apikeys-handler

**After a breach, rotate every secret in the right order, from one place.**

Import every variable from Railway (or your `.env` and docker-compose files, Netlify, Cloudflare, Supabase), see them grouped by service, category and priority, rotate them in order, restart each service once. The model never sees a value, and nothing is ever stored.

[![test](https://github.com/codegobrrrr9/apikeys-handler/actions/workflows/test.yml/badge.svg)](https://github.com/codegobrrrr9/apikeys-handler/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

When a runtime is exploited, the standard advice is the same: patch, then rotate every secret the process could read. The **PHP2Shell** flaws (CVE-2026-109618 and CVE-2026-109619, disclosed around 21 October 2026) are the latest case: [Patchstack's alert](https://patchstack.com/articles/php-major-vulnerability-alert-10-2026/) says they can expose PHP worker memory, which holds passwords, tokens and API keys, and advises rotating the credentials on affected servers. Forty rotations across six services is the slow part. This tool keeps the inventory, the order and the progress.

**This tool does not patch anything.** Update PHP (8.5.12, 8.4.27, 8.3.36 or 8.2.35 per that alert) or whatever was vulnerable first, or the new secrets leak the same way.

## For your coding agent

Paste this into Claude Code, Codex, Cursor or Gemini CLI:

```
Install the apikeys-handler skill from https://github.com/codegobrrrr9/apikeys-handler, refer to the repo's AGENTS.md.
```

The agent plans and drives the rotation but **never reads, prints or asks for a secret**: you paste new keys into the dashboard or a hidden prompt in your own terminal.

## Try it with no account

```bash
npx --yes --allow-git=all github:codegobrrrr9/apikeys-handler demo
```

Opens the dashboard on a fake Railway project with made-up secrets. Nothing real is read or written.

## What it looks like

```
$ apikeys-handler plan --environment production --exposed web
apikeys-handler plan  ·  15 rotations  ·  P0 5 · P1 6 · P2 4  ·  6 writes + 5 restarts = 11 requests

P0  Database               PGPASSWORD  [manual]  Postgres  EXPOSED
    ! Changing this variable does not change the real database password. Change it in the database first…
P0  Auth & sessions        APP_KEY  [generate]  web  EXPOSED
    ! Existing sessions and anything encrypted with the old APP_KEY stop decrypting. …
P0  Payments               STRIPE_SECRET_KEY  [provider]  web  EXPOSED
    new key: https://dashboard.stripe.com/apikeys
P1  Auth & sessions        JWT_SECRET  [generate]  api, worker  (2 places, one value)
…
restart order: api → Postgres → web
skipped 2:
  web DATABASE_URL: built from other variables: rotate the source
```

(Made-up demo data.) Then `apikeys-handler rotate --apply`: values you paste are typed into a hidden prompt, generated values are made locally, each service restarts once, and the last line is always:

```
Still yours to do: delete or revoke the OLD keys at each provider, and change database passwords in the database itself.
```

### The dashboard

`apikeys-handler ui` opens a page on `127.0.0.1` (random port, one-time link, no outside requests): every service as a card, every variable with its priority, category and status, filters, "select all P0", one-click rotate with the warning for that key beside it, a hidden field for each key you have to create yourself, and an exportable report.

## How it decides

- **Container view.** Variables are grouped by service. A variable built from another (`${{Postgres.PGPASSWORD}}`) is never written to; the source is rotated and every service that references it restarts once.
- **Priority.** P0 databases, payments, cloud root keys, session, signing and encryption keys, publish tokens. P1 AI providers, email and SMS, webhooks, CI, unknown secrets. P2 monitoring. P3 config. Say which services were exposed (`--exposed web,worker`) and everything they can read moves up.
- **One secret, one rotation.** The same value in three services is one rotation and three writes, so shared secrets stay equal.
- **Who makes the new value.** `generate` only for secrets your app owns, on a short allowlist by name (`APP_KEY`, `JWT_SECRET`, `SESSION_SECRET`, `SECRET_KEY_BASE`, …), in the old value's format and length. Everything a provider issues (Stripe, OpenAI, AWS) you create there and paste: the tool shows the page. Database passwords, webhook secrets and encryption keys are **never** generated, because a made-up value would break production silently.
- **Safe writes.** One `variableCollectionUpsert` per service with `skipDeploys: true` and never `replace` (which would delete every variable not listed); one restart per service after all its variables are written.
- **Resumes.** State (`.apikeys-handler/state.json`) survives a crash or a closed laptop: finished keys are not rewritten.
- **Verified** means the platform now returns a different value. It does not mean the old key is revoked.

## Does it work

**Tests.** 46 run against a fake Railway server, temp git repos, and the real CLI and dashboard over HTTP. They cover, among others: no secret value ever appears in a result, a state file, a report, a CLI output or a dashboard response (including when a platform error echoes the request); a write never carries `replace`; references are never overwritten; one write per scope and one restart per service; resume after a failed restart; a wrong Host or Origin is refused. The three non-Railway platforms are tested against a fake only. See [`platforms.md`](skills/apikeys-handler/references/platforms.md) for what is and is not verified against a live service.

**Classifier benchmark** (names only, value unknown; method, labels and the order of events in [`method.md`](skills/apikeys-handler/references/method.md), numbers in [`benchmarks/`](benchmarks/)). Names come from the example env files of 77 popular public repos (3,182 unique names). I labelled 200 sampled names by hand before running the classifier:

| | First run, 200 names, 36 secrets | After fixing its misses, unseen 100 names, 18 secrets |
|---|---|---|
| Secrets the classifier marks for rotation (recall) | **91.7%** (33 of 36) | **88.9%** (16 of 18) |
| Marked names that are secrets (precision) | **100%** (33 of 33) | **100%** (16 of 16) |
| Right category among correct marks | **87.9%** (29 of 33) | **50%** (8 of 16) |

The right-hand column is the unseen sample as the rules stood **before** I looked at it: drawn after the first round of fixes, so these were names the rules had not been tuned on. Most of its category misses are secrets that fell into the generic "Other secret" bucket: still marked P1 and rotated, but not filed under their real category. I then fixed those too. The shipped rules score 100% on the first sample and 94.4% recall / 100% precision / 88.2% category on the second (`results.sample1-tuned.md`, `results.holdout-tuned.md`), and that is not evidence: they were tuned on exactly those names. Small samples: 36 and 18 secrets means wide error bars. The labels are mine, the same person who wrote the rules.

## Honest limits

- It changes the variable on the platform. It cannot revoke the old key at the provider and cannot change a database password. Both are listed as manual steps every time.
- It does not patch, and does not know whether a secret was actually stolen.
- Only Railway and local `.env` / docker-compose files have been exercised beyond a fake server, and Railway's behaviour behind a real token is not yet verified (the operations were checked against the live schema by introspection). Netlify, Cloudflare and Supabase are written from public docs and tested against fakes: treat them as unverified until you have run them on a throwaway project.
- Supabase: only Edge Function secrets. The anon key, service-role key and JWT secret are dashboard-only.
- Cloudflare Workers secrets and Netlify secret values are write-only: names are listed, and a rotation is reported as "unverified" because the platform will not show the new value back.
- A `.env` file tracked by git has its old values in history. The tool says so; it cannot rewrite history.
- The classifier is names and value shapes, not understanding. A custom name it does not know is reported as config and skipped unless you add a rule (`.apikeys-handler.json`).
- Compose support is limited on purpose: `environment:` mappings and lists and `env_file:`. Anchors, multiline values and the rest are reported, never guessed.
- The dashboard holds values in memory while it is open (needed to read the current format and compare fingerprints) and drops pasted values when the job ends. It is local only, but it is a page that handles secrets: close it when you are done.

## Commands

```bash
apikeys-handler scan   [--platform railway,dotenv,netlify,cloudflare,supabase] [--exposed web,worker] [--json]
apikeys-handler plan   [selection]                       # dry run, with the request count
apikeys-handler rotate [selection] --apply [--yes]
apikeys-handler status | report [--out file.md] | ui | demo
# selection: --name A,B  --priority P0  --up-to P1  --category Database  --service web  --include-config  --again
```

Tokens come from your own environment, never from chat: `RAILWAY_API_TOKEN` (account or workspace token) or `RAILWAY_TOKEN` (project token), `NETLIFY_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`. Pre-supply a new value with `AKH_NEW_<VARIABLE_NAME>` set in your own terminal.

## Install by agent

| Agent | How |
|---|---|
| **Claude Code** | `/plugin marketplace add codegobrrrr9/apikeys-handler` then `/plugin install apikeys-handler@apikeys-handler`. Adds `/apikeys-handler`. |
| **Codex** | Copy `skills/apikeys-handler/` to `~/.codex/skills/apikeys-handler/` and append the Rules from [`AGENTS.md`](AGENTS.md). |
| **Cursor** | Copy [`.cursor/rules/apikeys-handler.mdc`](.cursor/rules/apikeys-handler.mdc) and the folder `skills/apikeys-handler/scripts/` into the project. |
| **Gemini CLI** | `gemini extensions install https://github.com/codegobrrrr9/apikeys-handler` |
| **GitHub Copilot** | Copy [`.github/copilot-instructions.md`](.github/copilot-instructions.md). |
| **No agent** | `npx --yes --allow-git=all github:codegobrrrr9/apikeys-handler scan` |

## Credits

Same family as [seatbelt](https://github.com/codegobrrrr9/seatbelt), [cheapskate](https://github.com/codegobrrrr9/cheapskate), [alibi](https://github.com/codegobrrrr9/alibi), [shortlist](https://github.com/codegobrrrr9/shortlist), [grudge](https://github.com/codegobrrrr9/grudge) and [tollgate](https://github.com/codegobrrrr9/tollgate). Rotation tools that already exist for narrower cases: [keyrotate](https://github.com/Prompto-Studio/keyrotate), [secret-rotator](https://github.com/othaime-en/secret-rotator); secret managers such as Infisical, Doppler and Vault do rotation as a product you adopt before an incident. This is the one you reach for during one.

## License

MIT. Star ⭐ if it saved you an afternoon.
