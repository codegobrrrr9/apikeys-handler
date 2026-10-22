# Classifier benchmark (holdout-tuned)

Labels: `labels2.jsonl`, 100 names, 18 labelled secret. Names only, value unknown. Method: [method.md](../skills/apikeys-handler/references/method.md).

| Metric | Result |
|---|---|
| Secret recall (labelled secret that the classifier marks P0 to P2) | **94.4%** (17 of 18) |
| Popularity-weighted recall | 95.8% |
| Secret precision (marked for rotation that is a secret) | **100%** (17 of 17) |
| Category accuracy (among correctly marked secrets) | **88.2%** (15 of 17) |

How the 100 names were classified: generate 0 · provider 8 · manual 9 · config (not rotated) 83.

## Missed secrets (1)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| AUTH_BEARER_TOKEN_CLOUDFLARE | Cloud & infra | Config/P3 | default |

## Wrong category (2)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| BETTER_AUTH_API_KEY | Auth & sessions | Other secret | generic-secret |
| GOOGLE_API_CREDENTIALS | Cloud & infra | Other secret | generic-secret |
