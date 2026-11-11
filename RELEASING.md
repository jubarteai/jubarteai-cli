# Releasing jubarteai

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs `.github/workflows/release.yml`: the whole CI matrix, then a publish job that checks the tag equals the `package.json` version and that the commit is on `main`, builds, and runs `npm publish --provenance --access public`.

There is no npm token anywhere. Publishing uses npm trusted publishing (OIDC): npm trusts one GitHub repository and one workflow file name. Keep the workflow named `release.yml`, and keep the repository `jubarteai/jubarteai-cli` public (provenance is not generated from a private repo).

## One-time owner setup (before the first release)

These steps need the owner's npm account. Do them in order.

1. **Account.** An npm user account with two-factor authentication enabled (`npm profile get` shows `two-factor auth`). Log in on the machine you will publish from with `npm login`.

2. **Claim the name.** Check it is free:

   ```bash
   npm view jubarteai
   ```

   Expected: `npm error code E404`. If it prints a package, stop: the name was taken, and the plan's name decision (grill D21) needs the owner again.

3. **Create the `@jubarteai` organization.** On npmjs.com: profile menu, **Add an Organization**, name `jubarteai`, the free "Unlimited public packages" plan. Then in the organization's settings turn on **Require two-factor authentication** for members. This keeps the `@jubarteai/*` scope for later; the CLI itself is the unscoped `jubarteai`.

4. **Publish the `0.0.0` placeholder. This step is required.** npm can configure a trusted publisher only for a package that already exists, so the package must be created by hand first. From an empty directory outside any checkout:

   ```bash
   mkdir jubarteai-placeholder && cd jubarteai-placeholder
   npm init -y
   npm pkg delete main scripts keywords author
   npm pkg set name=jubarteai version=0.0.0 license=MIT \
     description="Placeholder that reserves the name. The real package is published by GitHub Actions." \
     repository.type=git repository.url=git+https://github.com/jubarteai/jubarteai-cli.git
   npm publish --access public
   ```

   npm asks for a one-time code from the owner's authenticator. This publish has no provenance; that is expected. Verify:

   ```bash
   npm view jubarteai version
   ```

   Expected: `0.0.0`. The `repository` field must match the real GitHub repository (case-sensitive), or provenance fails on the first real publish.

Do not configure the trusted publisher yet.

## Before every tag: re-check the Node floor

The floor is the security-patched Node release of each LTS line (grill D33). On 2026-11-10 it was `22.23.4` / `24.22.1` / `26.12.1`; the 2026-11-11 Node security release (High severity on all three lines) was announced but not out (`docs/plans/jubarteai-cli-proofs/p4-node-npm.md` in the app repo).

**On or after 2026-11-11, before the first tag**, and again before each later release:

1. Read `https://nodejs.org/en/blog/vulnerability` and `https://nodejs.org/dist/index.json`. Take the newest entry with `"security": true` for each of lines 22, 24 and 26.
2. If any is newer than the current floor, change the floor everywhere in one commit:
   - spec section 2 (`docs/plans/jubarteai-cli-spec.md` in the app repo),
   - `engines.node` in `package.json` (`^22.X || ^24.Y || >=26.Z`),
   - `NODE_FLOORS` and `ENGINES_RANGE` in `src/node-floor.ts`,
   - the `FLOORS` table and the header comment in `bin/jubarteai.js`,
   - the `node:` matrix in `.github/workflows/ci.yml` (the first three entries),
   - the app repo: `CLI_MIN_NODE` in `src/lib/cli/constants.ts`, `SKILLS_CLI_MIN_NODE` in `src/lib/mcp/ide-configs.ts`, and their tests,
   - the Node requirement line in `README.md` ("Requires Node ...").
3. Verify the CLI side agrees with itself:

   ```bash
   npx vitest run src/node-floor.test.ts
   ```

   Expected: all tests pass. They compare `NODE_FLOORS`, the `bin` table, `engines.node` and the CI matrix.

## Configure the trusted publisher (right before the tag)

An unused trusted-publisher configuration expires 2 days after it is created. Do this step on the day you tag, after the floor re-check and after the release commit is on `main`.

1. On npmjs.com open the `jubarteai` package, **Settings**, **Trusted Publisher**, choose **GitHub Actions**, and enter:
   - Organization or user: `jubarteai`
   - Repository: `jubarteai-cli`
   - Workflow filename: `release.yml`
   - Environment name: leave empty (the workflow uses no GitHub environment)
   - Allowed action: `npm publish`

   Or, with npm 11.15.0 or newer:

   ```bash
   npm trust github jubarteai --file release.yml --repo jubarteai/jubarteai-cli --allow-publish
   ```

2. Verify:

   ```bash
   npm trust list jubarteai
   ```

   Expected: one entry naming `jubarteai/jubarteai-cli` and `release.yml`. npm does not validate the configuration when you save it: a wrong file name or repository only fails at publish time (`E404` or an OIDC error in the publish job). A configuration cannot be edited; delete it (`npm trust revoke --id <id>`) and create it again.

## Tag procedure

1. The CLI lands through two pull requests (PR 1 and PR 2). Merge each with a **merge commit or a rebase merge, never a squash**: the app repository pins CLI commits by SHA (the `jubarteai-cli` submodule), and a squash would leave the pinned commits unreachable from `main`.
2. On `main`, set the version in `package.json` and `package-lock.json` (for `0.1.0` they are already at `0.1.0`; for later releases `npm version <X.Y.Z> --no-git-tag-version`). Commit it, and wait for CI to be green on that commit.
3. Tag and push:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   The tag must equal `v` plus the `package.json` version, and the tagged commit must be on `main`, or the publish job stops before publishing.
4. Watch the **Release** run in GitHub Actions: the test matrix first, then **Publish to npm**.
5. Verify the release:

   ```bash
   npm view jubarteai version
   npm view jubarteai@X.Y.Z dist.attestations.provenance
   npx --yes jubarteai@X.Y.Z --version
   ```

   Expected: `X.Y.Z`; a provenance object (npm also shows a "Built and signed on GitHub Actions" badge on the package page); and `X.Y.Z` printed by the CLI.
6. **First release only:** on npmjs.com, package **Settings**, **Publishing access**, choose **Require two-factor authentication and disallow tokens**. It only affects token authentication, so the trusted publisher keeps working.
7. Anything outside this repository that tells people to run the CLI through npm (the skills README, install pages, the app's install and update scripts) waits until step 5 passes on production.

## Rollback

Never `npm unpublish`: it breaks everyone who already installed or pinned the version, and npm will not let the same version number be reused.

1. Mark the bad version:

   ```bash
   npm deprecate jubarteai@X.Y.Z "<reason, and the fixed version once known>"
   ```

   The deprecation message is shown on every install of that version. This needs the owner's 2FA; it is not done from the workflow.
2. Fix forward: land the fix on `main` and release a patch version (`X.Y.Z+1`) with the tag procedure above. npm moves `latest` to it.
3. If the previous version is the good one and a fix will take time, point `latest` back at it: `npm dist-tag add jubarteai@<good-version> latest`.
4. If the publish job fails after the tag was pushed (before anything was published), fix the cause, then delete and re-push the tag on the corrected commit: `git push origin :refs/tags/vX.Y.Z`, then tag again. Check first that `npm view jubarteai@X.Y.Z` returns `E404`; if the version is already on npm, do not reuse it, release the next patch.
