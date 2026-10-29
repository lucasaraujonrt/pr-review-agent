# pr-review-agent

Automatic pull request reviewer built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
It receives GitHub's `pull_request` webhook, makes a shallow checkout of the HEAD, lets the agent read
the code (only `Read`, `Grep` and `Glob`) and comments its findings on the PR.

```
PR opened or pushed → webhook → 202 right away → queue → checkout of HEAD → Agent SDK → PR comment
```

Example comment:

> [pr-reviewer] no medium or high findings · HEAD 79550803
>
> Only touches tests; the timings match the production code.
>
> | Severity | Where | Problem | Fix |
> |---|---|---|---|
> | ⚪ low | `src/editor.test.ts:61` | The debounce value is repeated in the test… | Export the constant… |
>
> <sub>Estimated cost: US$ 0.039</sub>

## What the reviewer asks

1. What unexpected input breaks this?
2. Can any state end up false or inconsistent?
3. Are the gate, permission or flag right?
4. Race condition or double execution?
5. Security issue or data leak?
6. Would the tests fail if the code were wrong?

Severity: **high** = bug or production risk; **medium** = likely bug, or a test that doesn't protect;
**low** = improvement. With a medium or high finding, the `pr-reviewer` status check (if enabled) turns red.

## Security

- The webhook is verified with HMAC (`X-Hub-Signature-256`).
- The agent runs with `permissionMode: 'dontAsk'` and read-only tools; Bash, edits and web access are removed.
- The agent process gets a minimal environment: it never sees the GitHub token or the webhook secret.
- The GitHub token goes in a `git` header, never in a URL or in logs.
- Fork PRs are ignored.
- The comment never contains "APPROVED": it informs, it doesn't approve anything.

## Configuration

| Variable | Required | Default / notes |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | |
| `GITHUB_TOKEN` | yes | fine-grained: `contents:read`, `pull_requests:write`, `statuses:write` |
| `ANTHROPIC_API_KEY` | yes | |
| `REVIEW_REPOS` | yes | comma-separated `owner/repo` |
| `REVIEW_INSTRUCTIONS` | no | project context appended to the prompt (stack, conventions, review language) |
| `REVIEW_MODEL` | no | `claude-sonnet-5-5` |
| `REVIEW_MAX_TURNS` | no | `40` |
| `REVIEW_SET_STATUS` | no | off; `on` enables the status check |
| `PORT` | no | `3000` |

## Run

```sh
pnpm install
pnpm test
pnpm tsx scripts/dry-run.ts owner/repo 123   # reviews and prints, posts nothing
```

`dry-run` uses `gh auth token` and, without `ANTHROPIC_API_KEY`, your local Claude Code login.

In production, with Docker:

```sh
docker build -t pr-review-agent .
docker run -p 3000:3000 --env-file .env pr-review-agent
```

On GitHub: Settings → Webhooks → `https://<your-host>/webhook`, content type `application/json`,
the same secret as `GITHUB_WEBHOOK_SECRET`, event **Pull requests**. `GET /health` returns `{"status":"ok"}`.

## Cost

A review of a small PR cost between US$ 0.04 and US$ 0.06 with Sonnet in our tests.
The exact value is in the footer of each comment.

## License

MIT
