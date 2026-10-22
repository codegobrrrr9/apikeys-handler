# Classifier benchmark (holdout)

Labels: `labels2.jsonl`, 100 names, 18 labelled secret. Names only, value unknown. Method: [method.md](../skills/apikeys-handler/references/method.md).

| Metric | Result |
|---|---|
| Secret recall (labelled secret that the classifier marks P0 to P2) | **88.9%** (16 of 18) |
| Popularity-weighted recall | 91.7% |
| Secret precision (marked for rotation that is a secret) | **100%** (16 of 16) |
| Category accuracy (among correctly marked secrets) | **50%** (8 of 16) |

How the 100 names were classified: generate 0 · provider 3 · manual 13 · config (not rotated) 84.

## Missed secrets (2)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| AUTH_BEARER_TOKEN_CLOUDFLARE | Cloud & infra | Config/P3 | default |
| N8N_AI_ANTHROPIC_KEY | AI & LLM | Config/P3 | default |

## Wrong category (8)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| BETTER_AUTH_API_KEY | Auth & sessions | Other secret | generic-secret |
| ELASTICSEARCH_PASSWORD | Database | Other secret | password |
| GOOGLE_API_CREDENTIALS | Cloud & infra | Other secret | generic-secret |
| GOOGLE_GENERATIVE_AI_API_KEY | AI & LLM | Other secret | generic-secret |
| GOTRUE_EXTERNAL_DISCORD_SECRET | Auth & sessions | Other secret | generic-secret |
| LEON_LLAMACPP_API_KEY | AI & LLM | Other secret | generic-secret |
| MINIMAX_API_KEY | AI & LLM | Other secret | generic-secret |
| PYCARET_JWT_SECRET | Auth & sessions | Other secret | generic-secret |
