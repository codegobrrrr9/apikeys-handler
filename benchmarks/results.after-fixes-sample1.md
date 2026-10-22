# Classifier benchmark (after-fixes-sample1)

Labels: `labels.jsonl`, 200 names, 36 labelled secret. Names only, value unknown. Method: [method.md](../skills/apikeys-handler/references/method.md).

| Metric | Result |
|---|---|
| Secret recall (labelled secret that the classifier marks P0 to P2) | **100%** (36 of 36) |
| Popularity-weighted recall | 100% |
| Secret precision (marked for rotation that is a secret) | **100%** (36 of 36) |
| Category accuracy (among correctly marked secrets) | **100%** (36 of 36) |

How the 200 names were classified: generate 0 · provider 18 · manual 18 · config (not rotated) 164.
