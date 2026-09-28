// What the hook decides, message by message. A false block is the only failure that
// hurts a user, so most of these assert silence.

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { hook, sessionId, tmp, transcript } from './helpers.mjs'

const dir = tmp()
writeFileSync(join(dir, 'real.mjs'), 'one\ntwo\nthree\n')
after(() => rmSync(dir, { recursive: true, force: true }))

const decide = (message, runs = [['ls', true]], env = {}) =>
  hook({ session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, runs), last_assistant_message: message }, env)

describe('test claims', () => {
  test('claimed but no test command ran', () => {
    const d = decide('Done — all tests pass.')
    assert.equal(d?.decision, 'block')
    assert.match(d.reason, /no test command ran/)
  })

  test('claimed but the last test command failed', () => {
    const d = decide('Done, tests pass now.', [['npm test', false]])
    assert.match(d.reason, /last test command in this session failed/)
  })

  test('claimed and they did pass', () => {
    assert.equal(decide('Done, all tests pass.', [['npm test', true]]), null)
  })

  test('a failure followed by a passing rerun is not a contradiction', () => {
    assert.equal(decide('Done, all tests pass.', [['npm test', false], ['npm test', true]]), null)
  })

  test('recognises the common runners', () => {
    for (const cmd of ['npm test', 'pnpm test', 'yarn test', 'npm run test', 'pytest -q', 'go test ./...', 'cargo test', 'node --test', 'vitest run', 'make test']) {
      assert.equal(decide('Done, all tests pass.', [[cmd, true]]), null, `${cmd} should count as a test run`)
    }
  })

  test('finds the test inside a compound command', () => {
    assert.equal(decide('Done, all tests pass.', [['npm run lint && npm test', true]]), null)
  })
})

describe('what is not a claim', () => {
  const quiet = [
    ['a hedge: should', 'This should make the tests pass.'],
    ['a hedge: once', 'Once the tests pass we can ship.'],
    ['a hedge: if', 'If the tests pass, merge it.'],
    ['a plan', 'Next I will run the tests and check the build.'],
    ['a question', 'Do the tests pass for you?'],
    ['no claim at all', 'Here is what I found in the config.'],
    ['someone else claiming', 'The issue says the tests pass on main.'],
  ]
  for (const [name, message] of quiet) {
    test(name, () => assert.equal(decide(message), null))
  }

  test('a hedge in one sentence does not excuse a claim in another', () => {
    const d = decide('The build should be fine. All tests pass.')
    assert.equal(d?.decision, 'block')
  })
})

describe('language', () => {
  test('an Italian claim with no test run', () => {
    assert.equal(decide('Fatto, i test passano.')?.decision, 'block')
  })

  test('an Italian claim that holds', () => {
    assert.equal(decide('Fatto, i test passano.', [['pytest -q', true]]), null)
  })

  test('an Italian hedge', () => {
    assert.equal(decide('Se i test passano, facciamo il merge.'), null)
  })
})

describe('cited paths (opt-in)', () => {
  const on = { CLAIMCHECK_PATHS: '1' }

  test('off by default', () => {
    assert.equal(decide('See [the fix](src/nope.mjs).'), null)
    assert.equal(decide('Fixed in `real.mjs:99`.'), null)
  })

  test('a markdown link to a file that does not exist', () => {
    const d = decide('See [the fix](src/nope.mjs).', [['ls', true]], on)
    assert.match(d.reason, /does not exist/)
  })

  test('a markdown link to a file that does exist', () => {
    assert.equal(decide('See [the fix](real.mjs).', [['ls', true]], on), null)
  })

  test('a line past the end of the file', () => {
    const d = decide('Fixed in `real.mjs:99`.', [['ls', true]], on)
    assert.match(d.reason, /past the end of the file/)
  })

  test('the line exactly past the end is past the end', () => {
    // `real.mjs` holds three lines and a trailing newline. Counting the split parts made
    // it look four lines long, so a citation to line 4 went unreported.
    const d = decide('Fixed in `real.mjs:4`.', [['ls', true]], on)
    assert.match(d.reason, /past the end of the file/)
    assert.match(d.reason, /has 3 lines/)
  })

  test('the last real line is inside the file', () => {
    assert.equal(decide('Fixed in `real.mjs:3`.', [['ls', true]], on), null)
  })

  test('a line inside the file', () => {
    assert.equal(decide('Fixed in `real.mjs:2`.', [['ls', true]], on), null)
  })

  test('a URL is not a path', () => {
    assert.equal(decide('Docs at `https://example.dev/a/b.md` explain it.', [['ls', true]], on), null)
  })

  test('a bare identifier is not a path', () => {
    assert.equal(decide('The `node:fs` import handles it.', [['ls', true]], on), null)
  })

  test('a leading slash is a route, not a file at the filesystem root', () => {
    assert.equal(decide('Published at `/blog/2026/post.html`.', [['ls', true]], on), null)
  })

  test('a generated tree proves nothing when nobody has built it', () => {
    assert.equal(decide('Bundled into `dist/app.js`.', [['ls', true]], on), null)
  })

  test('a bare filename that is missing proves nothing — it may live in any subdirectory', () => {
    assert.equal(decide('Fixed in `elsewhere.mjs`.', [['ls', true]], on), null)
  })
})
