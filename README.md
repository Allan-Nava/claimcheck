<p align="center">
  <img src="https://raw.githubusercontent.com/Allan-Nava/claimcheck/main/assets/logo.svg" width="72" height="72" alt="claimcheck">
</p>

# claimcheck

[![docs](https://img.shields.io/badge/docs-allan--nava.github.io%2Fclaimcheck-2f5d8a?labelColor=1b1a18)](https://allan-nava.github.io/claimcheck/)
[![CI](https://github.com/Allan-Nava/claimcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Allan-Nava/claimcheck/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40allan_nava%2Fclaimcheck?color=2f5d8a&labelColor=1b1a18)](https://www.npmjs.com/package/@allan_nava/claimcheck)
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
| `tagged` | the message says a version was tagged, and the repository has no such tag | on |
| `paths` | the message cites a file that does not exist, or a line past the end of one | **off** |
| `ran` | the message names a command in backticks that the session never ran | **off** |
| `merged` | the message says a numbered pull request was merged, and GitHub disagrees | **off** |

Everything else is silence. The test check reads the transcript and pairs every `Bash`
`tool_use` with the `tool_result` carrying its id, so a command's fate is known rather
than inferred from its output.

## Measured

Everything here is reproducible from the repository; `evals/results/` holds the dated
runs. Node 23.3, 2026-09-28.

### Claim detection — `node evals/run.mjs`

74 labelled messages in `evals/claims.jsonl`, 30 of them carrying a claim, English and
Italian:

| kind | precision | recall | fp | fn |
|---|---|---|---|---|
| `tests` | 100% | 100% | 0 | 0 |
| `commit` | 100% | 100% | 0 | 0 |
| `push` | 100% | 100% | 0 | 0 |

That table is the second draft. The first labelled set scored 100% too, and it was worth
nothing: it only held messages written by someone who knew the patterns. Fifteen boundary
cases later — negation, idiom, reported speech — it found **six false positives**, all of
them a sentence that says the opposite of a claim: *nothing was pushed*, *the tests do not
pass*, *non ho committato nulla*. A false positive is a blocked turn on an honest message,
so CI fails on one; a missed claim only costs coverage and is reported.

### Latency — `node evals/bench.mjs`

| case | p50 | over Node startup |
|---|---|---|
| no claim, 100-command transcript | 60 ms | **12 ms** |
| no claim, 1k-command transcript | 59 ms | 11 ms |
| claim, all checks, 100-command transcript | 76 ms | 28 ms |
| claim, all checks, 1k-command transcript | 79 ms | 31 ms |
| claim, all checks, 10k-command transcript | 105 ms | 57 ms |

Node's own startup is 48 ms of every one of those, measured in the same run and reported
beside them, because most of the wall clock is the interpreter and claiming otherwise
would flatter the hook.

### Against real history — `npm run sweep`

Over 1,744 Claude Code transcripts, 669 stops:

- **4.93%** of stops make a claim at all; the rest never reach a check. (The first
  measurement said 10.25%, taken before negation and reported speech withdrew a claim.
  Half of what counted as a claim was a sentence saying the opposite of one.)
- **`tests`** fires on **0.30%** of stops. Both findings were genuine: one message claimed
  369 passing tests with no test command run in the session, another claimed green while
  the last test command had failed.
- **`paths`** fires on **9.57%**, and that is why it is off by default. Of 140 findings,
  68 were a real file cited relative to somewhere other than `cwd` — suffix matching
  against `git ls-files` now rescues those — and a good share of the rest were honest
  cross-repo references. `CLAIMCHECK_PATHS=1` opts in anyway.

`evals/suffix.mjs` and `evals/drift.mjs` are the two follow-up measurements that separated
the invented paths from the merely moved ones.

## Seeing what it did

The hook blocks or it stays silent, and neither told you anything. Audit mode judges
every stop for real, records it, and always falls through:

```bash
CLAIMCHECK_MODE=audit   # in the environment Claude Code runs in
claimcheck report       # how often it fires, on what, over time
```

Every stop is recorded, not only the ones that fire — without the stops that found nothing
there is no denominator and "how often does it fire" has no answer. The record lands in
`~/.claimcheck/decisions.jsonl`, or wherever `CLAIMCHECK_DATA` points. A record that
cannot be written is never a reason to stall the agent.

This is what a new lexicon has to pass before it is allowed to block anything, and it is
how the three checks that are off by default earn their way on.

## A claim has to name what it is about

`tagged`, `ran` and `merged` check something the session can look up, which means the
sentence has to say what. *"I merged it"* names nothing; *"I merged #42"* names one thing,
and that is the difference between a check and a guess.

`ran` and `merged` are off by default for different reasons. `ran` is the check most
likely to misfire on ordinary English — the many ways of saying "I looked at it" that
claim nothing. `merged` reaches the network inside a hook's ten-second budget, and a stop
that waits on GitHub has stopped being free. `CLAIMCHECK_RAN=1` and `CLAIMCHECK_MERGED=1`
turn them on.

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

On npm as **`@allan_nava/claimcheck`** — the unscoped name belongs to an unrelated
project. Install it globally, or clone this repository anywhere; either way the hook is
a single file you point Claude Code at.

```bash
npm install -g @allan_nava/claimcheck   # then the command is `claimcheck`
```

Register it in `~/.claude/settings.json` for every project, or in a project's
`.claude/settings.json` for one:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claimcheck",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

From a clone rather than a global install, the command is
`node /absolute/path/to/claimcheck/claimcheck.mjs` instead.

To turn the path check on as well, set `CLAIMCHECK_PATHS=1` in that environment.

## Verify

```bash
npm test                      # 63 assertions: the decisions, and the properties
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
