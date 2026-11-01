# apikeys-handler — instructions for coding agents

You are reading this because a user pasted something like:

> Install the apikeys-handler skill from https://github.com/codegobrrrr9/apikeys-handler, refer to the repo's AGENTS.md.

Do the install for the agent you are, confirm in one line, then follow the rules below for the rest
of the session. Do not explain what apikeys-handler is unless asked.

## Install

`<repo>` is a clone of this repository, or the raw files fetched from
`https://raw.githubusercontent.com/codegobrrrr9/apikeys-handler/main/`. The tool is a folder of
zero-dependency Node files (`skills/apikeys-handler/scripts/`), not one file: copy the whole folder.

| Agent | Do this |
|-------|---------|
| Claude Code | Run `/plugin marketplace add codegobrrrr9/apikeys-handler` then `/plugin install apikeys-handler@apikeys-handler`. Adds `/apikeys-handler`. If plugins are unavailable, copy `<repo>/skills/apikeys-handler/` to `~/.claude/skills/apikeys-handler/`. |
| Codex | Copy `<repo>/skills/apikeys-handler/` to `~/.codex/skills/apikeys-handler/`, or run `npx skills add codegobrrrr9/apikeys-handler`. Append the **Rules** below to the project's `AGENTS.md`. |
| Cursor | Copy `<repo>/.cursor/rules/apikeys-handler.mdc` to `.cursor/rules/`, and the folder `<repo>/skills/apikeys-handler/scripts/` to `scripts/apikeys-handler/`. |
| Gemini CLI | Run `gemini extensions install https://github.com/codegobrrrr9/apikeys-handler`. |
| GitHub Copilot | Copy `<repo>/.github/copilot-instructions.md` into the project's `.github/`, and the scripts folder as for Cursor. |
| Anything else | Append the **Rules** below to the agent's instruction file and keep the scripts folder in the project. |

No install needed to run it: `npx --yes --allow-git=all github:codegobrrrr9/apikeys-handler scan`.

After installing, say: `apikeys-handler on. I will not read or print secret values, I will plan before I rotate, and I will ask before applying.`

## Rules

1. **Never read secrets.** Do not open or print `.env` files, variable values or tokens. Use `scan` and `plan`:
   they show names, categories, priorities and short fingerprints, never values.
2. **Never ask for a secret in chat.** New keys go into the dashboard (`apikeys-handler ui`), the hidden terminal
   prompt, or `AKH_NEW_<NAME>` set in the user's own terminal. Platform tokens (`RAILWAY_API_TOKEN`,
   `RAILWAY_TOKEN`, `NETLIFY_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`) are set the same way.
3. **Plan first, ask, then apply.** `apikeys-handler plan --exposed <services>`, show the order and warnings,
   get a yes, then `rotate --apply`. Pass `--yes` only for a plan the user approved.
4. **Ask which services were exposed** and pass `--exposed`.
5. **One priority group at a time**: P0, then P1, then P2. `apikeys-handler status` between groups.
6. **Say what it cannot do**: it changes the variable on the platform, it does not revoke the old key at the
   provider and does not change a database password. Never claim a secret is safe because its variable changed.
7. Never generate a value the tool classed as provider-issued, and never overwrite a variable built from a
   reference (`${{Service.VAR}}`).
8. End with `apikeys-handler status` and the list of manual steps.

## Commands

```
apikeys-handler scan   [--platform railway,dotenv,netlify,cloudflare,supabase] [--exposed a,b] [--seen seen.json] [--json]
apikeys-handler plan | rotate --apply [--yes] | status | report [--out f] | ui | demo
selection: --name A,B  --priority P0  --up-to P1  --category Database  --service web  --include-config  --again
```
