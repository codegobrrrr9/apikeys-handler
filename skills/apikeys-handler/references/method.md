# apikeys-handler: how it decides, and how it was measured

Definitions here were fixed before the benchmark labels were written. The labels file is committed before the
classifier is run on it (see git history).

## Classification

Each variable gets a **category**, a **priority** and a **how**.

- **Name rules** (`scripts/rules.json`), tested in order against the uppercased name; the first match wins. A rule can
  require that the value, when the platform lets us read it, looks like a credential (`requireValue`): a
  `DATABASE_URL=sqlite:///app.db` is not a secret.
- **Value shapes**: well-known prefixes (`sk_live_`, `ghp_`, `AKIA`, `sk-ant-`, `xoxb-`, connection URLs with a
  password, private-key blocks). A shape wins over a generic name, and it forces `provider` over `generate`.
- **Unknown**: a name that matches nothing is Config (P3), which is not rotated unless you ask for it by name.
  A name ending in `SECRET`, `TOKEN`, `API_KEY`, `PASSWORD` and similar that matches no provider is "Other secret" (P1, manual).
- Your own rules: put `{"rules":[{"id","re","category","priority","how"}]}` in `.apikeys-handler.json` next to your
  project. They run before the built-in ones.

**Priority**: P0 databases, payments, cloud root keys, session, signing and encryption keys, publish tokens for code
and packages; P1 AI providers, email and SMS, webhook secrets, CI tokens, unknown secrets; P2 monitoring and
analytics; P3 config. With `--exposed web,worker`, what those services can read keeps its priority and the rest drops
one step; references are followed (a database password that `web` builds its URL from is exposed to `web`).

**how**:
- `generate`: the app owns the secret, so a random value is safe to write. **A tight allowlist by name**: `APP_KEY`,
  `JWT_SECRET`, `SESSION_SECRET`, `COOKIE_SECRET`, `SECRET_KEY`, `SECRET_KEY_BASE`, `NEXTAUTH_SECRET`, `AUTH_SECRET`,
  `BETTER_AUTH_SECRET`, `APP_SECRET` and a few like them. The new value keeps the old one's format and length.
  Every one carries a warning (sessions end; `APP_KEY` also breaks anything encrypted with it).
- `provider`: a third party issued it. Create a new one there, paste it. The tool shows the provider's key page.
- `manual`: rotating the variable is not enough (a database password must be changed in the database; an encryption key
  needs a re-encrypt step). The tool says what to do and takes the value after you did it.
- **Never generated**: database passwords, webhook secrets issued by a sender, encryption keys, anything with a provider
  prefix, anything unknown. A generated value pushed over a secret the provider issued would silently break production.

**Derived variables** (`${{Postgres.PGPASSWORD}}`, `${DB_PASS}`) are never written to. The tool rotates the source and
restarts every service that references it. A connection URL that embeds the same password as another variable is
flagged so the two change together.

## Rotation

1. Group variables with the same value (keyed fingerprint): one secret used in three services is one rotation.
2. Order by priority, then category, exposed first.
3. Stage every new value in memory, write one `variableCollectionUpsert` per service with `skipDeploys: true`
   (never `replace`), then restart each affected service once.
4. State (`.apikeys-handler/state.json`) holds names, statuses, timestamps and 12-character keyed-hash fingerprints.
   Never values. A crash between write and restart resumes without writing anything twice.
5. **Verified** = the platform now returns a different fingerprint. It does not mean the old secret is revoked.

Fingerprints are HMAC-SHA256 with a random per-machine key in `~/.apikeys-handler/key`. They let the tool say "same secret
in three services" and "still the old value" without holding the value.

## Benchmark: how well does the classifier recognise real variable names?

**Question.** On variable names the rules were not tuned on, how many that should be rotated does the classifier
mark for rotation, how many that should not does it wrongly mark, and when it picks a category, is it right?

**Data.** Names only, taken from the root `.env.example` (or `.env.sample`, `.env.template`, `.env.local.example`,
`example.env`, `.env.dist`) of public repositories found by topic search (`benchmarks/collect.js`, topics and files
listed in `benchmarks/repos.json`). Values are placeholders and are not used: the classifier is run with the value
unknown, the way it sees a write-only platform. `benchmarks/names.json` is the list of unique names and the number of
repos each appears in.

**Sample.** A random sample of 200 unique names, drawn with a fixed seed (`benchmarks/sample.js`). Rules were
written before this data was collected.

**Labels (fixed before the classifier is run).** One line per sampled name in `benchmarks/labels.jsonl`:
`{"name", "secret": true|false, "category"}`. `secret` is true when disclosing the value would let someone
act as you or read protected data: passwords, API keys, access and auth tokens, client secrets, private keys,
signing and encryption keys, webhook secrets, connection strings that carry credentials. It is false for public ids and
keys (client ids, app ids, publishable and anon keys), URLs without credentials, hosts, ports, regions, bucket and
database names, usernames, emails, feature flags, modes and timeouts. A name that is ambiguous without its value
(`DATABASE_URL`) is labelled as it would be in a real deployment. Categories use the tool's own list; an unknown
secret is "Other secret". The labels were written by the author of the rules, which is a limitation: the same person's
idea of a secret is behind both. They were written without running the classifier.

**Metrics (fixed in advance).**
1. Secret recall: of names labelled secret, the share the classifier marks for rotation (priority P0 to P2).
2. Secret precision: of names the classifier marks for rotation, the share labelled secret.
3. Category accuracy: of names labelled secret and marked for rotation, the share where the classifier's category equals
   the label's. A generic "Other secret" answer for a label with a specific category counts as wrong.
4. The misses: every secret labelled but not marked, and every non-secret marked, are listed in `results.md`.
5. Popularity-weighted recall: metric 1 again, with each name weighted by the number of repos it appears in. The
   uniform sample over-represents rare, custom names, which is the hard case; the weighted figure is closer to what a
   typical project has. Both are reported, uniform first.

Draw: unique names ordered as in `names.json`, sampled uniformly without replacement with a fixed seed (20261022).

**Not measured.** Whether a rotation works against a live platform; value-shape detection on real values (names only
here); names that exist in private repositories; recall on names in other languages.
