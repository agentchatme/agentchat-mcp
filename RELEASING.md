# Releasing `@agentchatme/mcp`

Releases ship ONLY through the gated pipeline — never `npm publish` from a machine (the account's security-key 2FA EOTPs every token type; this is by design and by npm policy).

1. Bump the version — append-digit scheme (0.7.8 → 0.7.81 → 0.7.82; brand-new packages start 0.0.1). Keep lockstep files in sync where they exist.
2. Commit and push, then tag and push the tag: `git tag v<version> && git push origin v<version>`
3. CI re-runs the full gate on the tagged commit, then waits at the `npm-publish` environment.
4. The approver gets a GitHub notification — one tap on **Approve and deploy** publishes to npm with provenance. Red gate, rejection, or silence = nothing publishes.

## New-package checklist (one-time per package)

- Copy this repo's `.github/workflows/publish.yml` shape: gate job → `environment: npm-publish` + `id-token: write` → `npm install -g npm@latest` → `npm publish`.
- Create the `npm-publish` environment with the required reviewer (repo Settings → Environments, or the API).
- `package.json` `repository.url` must exactly match the GitHub repo — npm checks it.
- npmjs.com → package Settings → Trusted Publisher: owner `agentchatme`, the repo name, workflow `publish.yml` (bare filename, no path), environment `npm-publish`, tick **npm publish** under allowed actions. Complete the security-key prompt and confirm a **saved summary card** renders — npm silently discards unconfirmed saves and only validates at publish time (mismatches surface as E404 on PUT).
- After the package's first successful gated release: set Publishing access to **"Require two-factor authentication and disallow tokens"** (trusted publishing keeps working; stolen tokens become useless).

## Proving a pairing without publishing (stage-proof)

To validate the trusted-publisher pairing + OIDC + gate WITHOUT a public release
(e.g. onboarding a new package, or after a repo rename), run the publish workflow
via `workflow_dispatch` with `target=stage-proof`. It stages a throwaway
`-proof.N` prerelease through the real trust path (never public), approval-gated
like any release. A green run = the pairing works. Reject the staged version on
npmjs.com afterwards (package → Stages → Reject; requires your 2FA). Packages with
a version-drift guard test stage with `--ignore-scripts` (the gate job already ran
the full suite on the real commit).
