# Changelog

All notable changes to this project are documented here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-28

The first release: a deterministic `Stop` hook, measured against real transcript
history before any default was chosen.

### Added
- The `tests` check: a claim that the tests pass is blocked when no test command ran in
  the session, or when the last one failed. Every `Bash` `tool_use` is paired with the
  `tool_result` carrying its id, so a command's fate is read rather than inferred.
- The `commit` and `push` checks, answered by git: files still staged against a claim of
  a commit, commits still ahead of the upstream against a claim of a push.
- The `paths` check, **off by default** — it fired on 11.74% of 673 real stops and
  roughly half of those were honest references. `CLAIMCHECK_PATHS=1` opts in.
- Claim detection in English and Italian, per sentence, with hedges, questions and
  reported speech withdrawing the claim.
- One block per stop, keyed on session and message, so the agent cannot loop.
- `--explain`, and `evals/` — the sweep over real transcripts plus the two follow-up
  measurements that separated invented paths from merely moved ones.
- CI on Node 18, 20, 22 and 24 (and macOS), with guards for dependency-freedom,
  fail-open on malformed input, and the packed file list.
- Published as `@allan-nava/claimcheck`: the unscoped `claimcheck` on npm is an
  unrelated Dafny tool. The command the package installs is still `claimcheck`.
- `release.yml`: the tag is the trigger, the publish authenticates over OIDC with no
  token anywhere, and every step is rerun-safe. `release-drift.yml` fails when a version
  sits on main untagged past a two-hour grace, on push and on a daily schedule.

[Unreleased]: https://github.com/Allan-Nava/claimcheck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Allan-Nava/claimcheck/releases/tag/v0.1.0
