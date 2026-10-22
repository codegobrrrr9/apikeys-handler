# Classifier benchmark (first)

Labels: `labels.jsonl`, 200 names, 36 labelled secret. Names only, value unknown. Method: [method.md](../skills/apikeys-handler/references/method.md).

| Metric | Result |
|---|---|
| Secret recall (labelled secret that the classifier marks P0 to P2) | **91.7%** (33 of 36) |
| Popularity-weighted recall | 93.3% |
| Secret precision (marked for rotation that is a secret) | **100%** (33 of 33) |
| Category accuracy (among correctly marked secrets) | **87.9%** (29 of 33) |

How the 200 names were classified: generate 0 · provider 13 · manual 20 · config (not rotated) 167.

## Missed secrets (3)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| FEISHU_PUSH_MIRROR_WEBHOOK_URL | Webhooks & signing | Config/P3 | default |
| GOOGLE_WEBHOOK_URL | Webhooks & signing | Config/P3 | default |
| SERPAPI_KEYS | Other secret | Config/P3 | default |

## Wrong category (4)

| name | labelled | classifiedAs | rule |
|---|---|---|---|
| CRYPTOQUANT_API_KEY | Other secret | Auth & sessions | encryption-key |
| GOOGLE_OAUTH_REFRESH_TOKEN | Auth & sessions | Other secret | generic-secret |
| IMAP_PASSWORD | Email & SMS | Other secret | password |
| TWITTER_CONSUMER_SECRET | Auth & sessions | Other secret | generic-secret |
