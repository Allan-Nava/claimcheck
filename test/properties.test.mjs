// The properties that make the hook safe to leave switched on: it gets out of the way
// when it cannot know, it cannot loop, and it reads git rather than guessing.

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { git, hook, repo, sessionId, tmp, transcript } from './helpers.mjs'

describe('fail-open', () => {
  const quiet = [
    ['stdin is not JSON', 'not json at all'],
    ['stdin is empty', ''],
    ['stdin is an empty object', '{}'],
    ['the message is null', JSON.stringify({ last_assistant_message: null })],
    ['the message is not a string', JSON.stringify({ last_assistant_message: 42 })],
    ['the message is blank', JSON.stringify({ last_assistant_message: '   ' })],
  ]
  for (const [name, input] of quiet) {
    test(name, () => assert.equal(hook(input), null))
  }

  test('a test claim with no transcript says nothing — it cannot be known', () => {
    const d = hook({ session_id: sessionId(), cwd: process.cwd(), transcript_path: '/nonexistent/x.jsonl', last_assistant_message: 'Done, all tests pass.' })
    assert.equal(d, null)
  })

  test('a test claim with an unreadable transcript path says nothing', () => {
    const d = hook({ session_id: sessionId(), cwd: process.cwd(), last_assistant_message: 'Done, all tests pass.' })
    assert.equal(d, null)
  })
})

describe('one block per stop', () => {
  test('the same message in the same session is answered once', () => {
    const dir = tmp()
    const input = { session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' }
    assert.equal(hook(input)?.decision, 'block', 'the first stop blocks')
    assert.equal(hook(input), null, 'the second does not, so the agent cannot loop')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a different session is judged on its own', () => {
    const dir = tmp()
    const base = { cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' }
    assert.equal(hook({ ...base, session_id: sessionId() })?.decision, 'block')
    assert.equal(hook({ ...base, session_id: sessionId() })?.decision, 'block')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('commit claims', () => {
  test('claimed while files are still staged', () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git(dir, 'add', 'a.txt')
    const d = hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'I committed the change.' })
    assert.match(d.reason, /still staged and uncommitted/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('claimed with nothing staged', () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'first')
    assert.equal(hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'I committed the change.' }), null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('outside a repository it says nothing', () => {
    const dir = tmp()
    assert.equal(hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'I committed it.' }), null)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('push claims', () => {
  test('no upstream means nothing to be ahead of', () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'first')
    assert.equal(hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'I pushed it.' }), null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('claimed while commits are still ahead of the upstream', () => {
    const dir = repo()
    const bare = tmp()
    git(bare, 'init', '-q', '--bare')
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'first')
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD')

    writeFileSync(join(dir, 'b.txt'), 'more')
    git(dir, 'add', 'b.txt')
    git(dir, 'commit', '-qm', 'second')
    const d = hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'Done, I pushed it.' })
    assert.match(d.reason, /still ahead of/)

    git(dir, 'push', '-q')
    assert.equal(hook({ session_id: sessionId(), cwd: dir, last_assistant_message: 'Done, I pushed it.' }), null)
    rmSync(dir, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('the block itself', () => {
  test('is the shape a Stop hook must answer with', () => {
    const dir = tmp()
    const d = hook({ session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' })
    assert.equal(d.decision, 'block')
    assert.equal(typeof d.reason, 'string')
    assert.ok(d.reason.length > 0)
    assert.deepEqual(Object.keys(d).sort(), ['decision', 'reason'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('names every contradiction it found, not just the first', () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git(dir, 'add', 'a.txt')
    const d = hook({ session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done — all tests pass and I committed it.' })
    assert.match(d.reason, /\(1\).*\(2\)/s)
    rmSync(dir, { recursive: true, force: true })
  })
})
