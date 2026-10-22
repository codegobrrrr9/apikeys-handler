---
description: Rotate API keys and secrets after a breach. Shows progress, or plans a rotation (dry run). Never reads or prints a secret value.
allowed-tools: Bash(node:*), Bash(git:*)
---

1. If `$ARGUMENTS` is empty, run `node ${CLAUDE_PLUGIN_ROOT}/skills/apikeys-handler/scripts/apikeys-handler.js status`
   and quote it. If nothing is tracked yet, say so and ask which platform (Railway, .env files, Netlify,
   Cloudflare, Supabase) and which services were exposed.
2. Otherwise run `node ${CLAUDE_PLUGIN_ROOT}/skills/apikeys-handler/scripts/apikeys-handler.js $ARGUMENTS`
   (a `scan`, `plan` or `report`), and quote the output as printed.
3. Never run `rotate --apply` from this command. Show the plan, ask the person, and follow the rules in the skill.
4. Never ask for a secret in chat. Tokens and new keys are set in the person's own terminal or the dashboard.
