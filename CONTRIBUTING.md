# Contributing

## The local loop

```bash
npm test                        # 44 assertions, no network, no key
node claimcheck.mjs --explain   # what it checks, in four lines
echo '{"last_assistant_message":"Done, all tests pass.","cwd":".","session_id":"x"}' | node claimcheck.mjs
```

There is nothing to install: claimcheck has no dependencies, runtime or dev. The tests
shell out to `git` and spawn the hook as a real process, because stdin in, stdout out is
the whole contract.

## Changing what counts as a claim

`TEST_CLAIM`, `COMMIT_CLAIM` and `PUSH_CLAIM` in [claimcheck.mjs](claimcheck.mjs) are the
lexicons; `HEDGE` and `ATTRIBUTION` are what withdraws a claim. Every one of them is
matched per sentence.

A false block is the only failure that hurts a user, so a new pattern earns its place by
measurement, not by intuition:

```bash
npm run sweep          # what it would have said across your own transcript history
node evals/suffix.mjs  # of the path findings, how many are a real file cited from elsewhere
node evals/drift.mjs   # of those, how many never existed in git history at all
```

Report the rate the same way the README does: the share of stops it fires on, and what a
sample of those findings actually were. A check that fires on more than about 1% of stops
without a matching share of true findings belongs behind a flag, as `paths` is.

## Releasing

The tag is the trigger and pushing it is manual. `release-drift.yml` fails on main if a
version sits untagged for more than two hours, and again on a daily schedule, so a
forgotten tag is noisy rather than silent.

1. Bump `version` in `package.json`.
2. Add the `## [x.y.z]` section to `CHANGELOG.md` — the release job refuses a version the
   changelog does not document, and the release notes are that section.
3. Merge to main.
4. Tag and push:

   ```bash
   npm test && git tag -a v0.1.1 -m "claimcheck 0.1.1" && git push origin v0.1.1
   ```

`release.yml` then runs the suite, checks the tag against `package.json` and the
changelog, publishes to npm, waits for the registry to serve the new version, cuts the
GitHub release and closes the matching milestone if it has no open issues. Every step is
rerun-safe: a version already on the registry is skipped, and an existing release is left
alone.

### The publish uses no token

Authentication is OIDC — npm Trusted Publishing, configured on the package at npmjs.com
against this repository and the workflow filename. Two consequences:

- **Do not rename `release.yml`.** The trusted publisher is bound to that literal name,
  and a rename produces an authentication error that does not mention filenames.
- **Do not add `registry-url` to `setup-node`.** It writes an `.npmrc` naming
  `NODE_AUTH_TOKEN`, npm then sees a configured credential and never performs the OIDC
  exchange, and the registry answers 404 rather than 401.

### Bootstrap, once

npm will not let a trusted publisher be configured for a package that does not exist, so
the first version is published by hand:

```bash
npm login
npm publish --access public
```

Then, on npmjs.com, under the package's **Settings → Trusted publisher**, add GitHub
Actions with repository `Allan-Nava/claimcheck` and workflow `release.yml`. Every release
after that is token-free, and the publish step skips any version already on the registry,
so re-running the job on an already-published tag is safe.
