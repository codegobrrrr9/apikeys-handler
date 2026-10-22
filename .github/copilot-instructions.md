# apikeys-handler

Rules from https://github.com/codegobrrrr9/apikeys-handler. Copy the folder `skills/apikeys-handler/scripts/` from the repo to `scripts/apikeys-handler/`.

1. Never open or print `.env` files, variable values or tokens. Use `node scripts/apikeys-handler/apikeys-handler.js scan` and `plan`: they show names, categories and priorities, never values.
2. Never ask for a secret in chat. New keys go into the dashboard (`ui`), the hidden terminal prompt, or `AKH_NEW_<NAME>` set in the user's own terminal.
3. Plan first (`plan --exposed <services>`), show it, get a yes, then `rotate --apply`. `--yes` only for a plan the user approved.
4. One priority group at a time: P0, then P1, then P2. Run `status` between groups.
5. Say what it cannot do: it changes the variable on the platform, it does not revoke the old key at the provider and does not change a database password.
6. End with `status` and the manual steps left.
