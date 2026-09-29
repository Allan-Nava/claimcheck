# Changelog

All notable changes to this project are documented here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-09-29

No change to what the hook does. The npm listing shows this README, and until now it
showed neither the mark nor a link to the documentation.

### Added
- A mark, in `assets/`, and the README header that carries it. It is a check never
  finished: the hook is drawn, the rise begins, and where the tip should be there is only
  a point — a claim made and not verified.
- A link to the page, which now has a social card of its own, so a link to it stops
  rendering bare.


## [0.2.0] — 2026-09-28

The v0.2.0 milestone: more kinds of claim, and a way to see what the hook has been doing.

### Added
- **Audit mode and `claimcheck report`.** `CLAIMCHECK_MODE=audit` judges every stop for
  real, records it, and always falls through; `report` reads that record. Every stop is
  recorded, not only the ones that fire — without the stops that found nothing there is no
  denominator, and "how often does it fire" has no answer. A record that cannot be written
  is never a reason to stall the agent.

  This is the prerequisite the other two items needed: a new lexicon can now run in audit
  for a week before it is allowed to block anything.

- **`tagged`**, on by default: the message says a version was tagged and the repository
  has no such tag. `v1.2.3` and `1.2.3` are one release; a repository with no tags at all
  says nothing either way.

- **`ran`** and **`merged`**, both off by default. `ran` matches only a command named in
  backticks — *"I ran the linter"* is a sentence, *"I ran `npm run lint`"* is a claim about
  the session's own record — and is the check most likely to misfire on ordinary English.
  `merged` needs a pull request number and reaches the network inside a hook's budget.

  The claims that were listed but not built are the ones that name nothing: *"I merged
  it"*, *"I reverted it"*, *"I deleted the branch"*. A lexicon for them would fire on
  sentences no session can check.

### Fixed
- **A fenced block was being read as a sentence the agent wrote.** Measured over 670 real
  stops, a Raft status table with a `COMMITTED` column, a CI log reading `PR #24 merged`
  and an HTML paragraph all counted as claims. Fenced blocks and HTML tags are stripped
  before a claim is looked for; inline code stays, because `` I ran `npm test` `` names
  its command that way. This removed every false positive the sweep turned up.
- `pushed us over the limit` is an idiom, like `pushed back`.
- A version at the end of a sentence took the full stop with it, so `I tagged v1.0.0.`
  never matched the tag `v1.0.0`.
- `npm run lint` and `npm run build` were the same command to `ran`, which took the first
  two words of each.

### Measured
- 112 labelled messages in `evals/claims.jsonl`, six kinds, **100% precision and recall**
  on all of them. `evals/sweep-claims.mjs` measures the same lexicons over real transcript
  history: across 670 stops the new kinds fire on 0.15% and under.


## [0.1.2] — 2026-09-28

### Fixed
- **A file looked one line longer than it is.** A trailing newline terminates the last
  line; counting the parts of `split('\n')` counted it as starting another. A citation
  one past the end of a file went unreported, and when a finding did fire its line count
  was one too high.
- **One repository's file index answered for another.** The suffix index behind the path
  check was cached in a module-level variable rather than per repository, so the second
  repository in a process silently inherited the first one's tracked files. Invisible in
  the hook, which runs one process per stop, and wrong in the eval runners, which walk
  hundreds of repositories in one.

### Changed
- The measured figures in the README are re-stated against the current code. Claims are
  made on **4.93%** of stops, not 10.25%: that first number was taken before negation and
  reported speech withdrew a claim, and half of what it counted was a sentence saying the
  opposite of one. The path check fires on 9.57%, not 11.74%.


## [0.1.1] — 2026-09-28

### Fixed
- **The installed hook did nothing at all.** npm installs the bin as a symlink in
  `node_modules/.bin`, so `process.argv[1]` is the link while `import.meta.url` is the
  file it points at. The direct-invocation guard compared the two unresolved, decided it
  was being imported rather than run, and exited 0 with empty stdout on every stop —
  indistinguishable from fail-open, and therefore silent. Both sides are now resolved
  through the filesystem with `realpathSync`.

  Every test passed because they all invoked the file by its own path. Three tests now
  reach the hook through a symlink, the way an install does.
- `exports` blocked `require('@allan_nava/claimcheck/package.json')`; the subpath is
  declared now.

### Note
- 0.1.0 is published but inert once installed. Use 0.1.1.

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
- Published as `@allan_nava/claimcheck`: the unscoped `claimcheck` on npm is an
  unrelated Dafny tool, and the npm scope is the npm username `allan_nava` — an
  underscore, where GitHub has the hyphen of `Allan-Nava`. The command the package
  installs is still `claimcheck`.
- `release.yml`: the tag is the trigger, the publish authenticates over OIDC with no
  token anywhere, and every step is rerun-safe. `release-drift.yml` fails when a version
  sits on main untagged past a two-hour grace, on push and on a daily schedule.

[Unreleased]: https://github.com/Allan-Nava/claimcheck/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Allan-Nava/claimcheck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Allan-Nava/claimcheck/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Allan-Nava/claimcheck/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Allan-Nava/claimcheck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Allan-Nava/claimcheck/releases/tag/v0.1.0
