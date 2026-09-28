# claimcheck

[![CI](https://github.com/Allan-Nava/claimcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Allan-Nava/claimcheck/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/license-MIT-2f5d8a?labelColor=1b1a18)](LICENSE)

**A `Stop` hook that refuses to let a claim of completion stand when the session's own
record contradicts it.** Deterministic — no model, no network, no API key, no
dependencies. One file, Node 18+.

It never judges whether the work is good. It checks one thing: did what the message
says happened actually happen.

```
claimcheck: the session's own record does not support this message.
(1) the message says the tests pass, but no test command ran in this session.
    Claimed: "Done — 369 tests green."
Verify each point and say plainly what is actually done and what is not.
```

## What it checks

| Check | Blocks when | Default |
|---|---|---|
| `tests` | the message says the tests pass, but no test command ran this session, or the last one failed | on |
| `commit` | the message says a commit was made, but files are still staged | on |
| `push` | the message says the work was pushed, but commits are still ahead of the upstream | on |
| `paths` | the message cites a file that does not exist, or a line past the end of one | **off** |

Everything else is silence. The test check reads the transcript and pairs every `Bash`
`tool_use` with the `tool_result` carrying its id, so a command's fate is known rather
than inferred from its output.

## Measured

Against 1,745 real Claude Code transcripts — 673 stops, 2026-09-28, Node 23.3:

| | |
|---|---|
| stops that make a claim at all | **10.25%** — the rest never reach a check |
| `tests` fires on | **0.30%** of stops |
| `paths` fires on | **11.74%** of stops |
| latency, no claim (the common case) | p50 **56 ms**, p95 58 ms |
| latency, every check running | p50 **71 ms**, p95 93 ms |

Both `tests` findings in that history were genuine: one message claimed 369 passing
tests with no test command run in the session, another claimed green while the last
test command had failed.

`paths` is off by default because that 11.74% does not survive inspection. Of 140
findings, 68 were a real file cited relative to somewhere other than `cwd` — suffix
matching against `git ls-files` now rescues those — and a good share of the rest were
honest cross-repo references. The precision is not worth a blocked turn.
`CLAIMCHECK_PATHS=1` opts in anyway.

Reproduce the sweep over your own history with `npm run sweep`; `evals/suffix.mjs` and
`evals/drift.mjs` are the two follow-up measurements that separated the invented paths
from the merely moved ones.

## The rules

1. **Fail-open.** Malformed stdin, missing transcript, unreadable repository, any
   exception at all: exit 0, empty stdout, no decision. A hook that stalls the agent is
   worse than no hook.
2. **Absence of evidence blocks nothing** — except where the absence *is* the finding
   (a test claim with no test run).
3. **A hedge withdraws the claim.** "tests should pass", "once the tests pass", a
   question, and reported speech ("the issue says the tests pass") are not claims.
   Judged per sentence, not per message.
4. **One block per stop**, keyed on session and message, so the agent cannot loop.
5. **Claims are read in English and Italian.** A claim is a claim in whatever language
   it is made; `TEST_CLAIM`, `COMMIT_CLAIM` and `PUSH_CLAIM` are where you add yours.

## Install

Clone it anywhere, then register the hook in `~/.claude/settings.json` for every
project, or in a project's `.claude/settings.json` for one:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/claimcheck/claimcheck.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

To turn the path check on as well, set `CLAIMCHECK_PATHS=1` in that environment.

## Verify

```bash
npm test                      # 44 assertions: the decisions, and the properties
node claimcheck.mjs --explain # what it checks, in four lines
npm run sweep                 # what it would have said across your own transcripts
```

## Relation to hookgate

[hookgate](https://github.com/Allan-Nava/hookgate) answers the same `Stop` question with
a calibrated model, which covers the general case — *does this message claim a
completion the visible state does not support?* — that no deterministic check can reach.
claimcheck covers only what is provable without one, and costs nothing to run. They
compose: claimcheck is the free first filter, hookgate the judgement behind it.

## Licence

MIT.
