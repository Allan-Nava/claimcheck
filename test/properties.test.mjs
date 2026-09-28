// The properties that make the hook safe to leave switched on: it gets out of the way
// when it cannot know, it cannot loop, and it reads git rather than guessing.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HOOK, git, hook, repo, sessionId, tmp, transcript } from './helpers.mjs'

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

// npm installs the bin as a symlink in node_modules/.bin, so argv[1] is the link and not
// the file. 0.1.0 shipped a direct-invocation guard that compared the two unresolved: the
// published hook exited 0 in silence on every stop, indistinguishable from fail-open, and
// every test here passed because they all invoke the file by its own path.
describe('invoked the way npm installs it', () => {
  test('through a symlink it still decides', () => {
    const dir = tmp()
    const link = join(dir, 'claimcheck')
    symlinkSync(HOOK, link)

    const input = JSON.stringify({ session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' })
    const out = execFileSync('node', [link], { input, encoding: 'utf8' }).trim()
    assert.notEqual(out, '', 'a hook reached through its installed name must still answer')
    assert.equal(JSON.parse(out).decision, 'block')

    rmSync(dir, { recursive: true, force: true })
  })

  test('through a symlink it can still describe itself', () => {
    const dir = tmp()
    const link = join(dir, 'claimcheck')
    symlinkSync(HOOK, link)
    const out = execFileSync('node', [link, '--explain'], { encoding: 'utf8' })
    assert.match(out, /deterministic Stop hook/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('imported as a module it decides nothing on its own', async () => {
    // The other half of the guard: importing must not read stdin or exit.
    const mod = await import(HOOK)
    assert.equal(typeof mod.decide, 'function')
    assert.equal(typeof mod.checkTests, 'function')
  })
})

describe('used as a library across repositories', () => {
  // The suffix index is asked per repository. A single shared cache answered for
  // whichever asked first, so the second repository silently inherited the first
  // repository's file list — invisible in the hook, wrong in the eval runners.
  test('one repository\'s file index does not answer for another', async () => {
    const mod = await import(HOOK)
    const a = repo()
    const b = repo()
    writeFileSync(join(a, 'deep.mjs'), 'x\n')
    execFileSync('mkdir', ['-p', join(a, 'deep', 'lib')])
    writeFileSync(join(a, 'deep', 'lib', 'shared.mjs'), 'x\n')
    git(a, 'add', '-A')
    git(a, 'commit', '-qm', 'a')
    writeFileSync(join(b, 'unrelated.mjs'), 'x\n')
    git(b, 'add', '-A')
    git(b, 'commit', '-qm', 'b')

    const message = 'Fixed in `lib/shared.mjs`.'
    process.env.CLAIMCHECK_PATHS = '1'
    assert.equal(mod.checkPaths(message, a), null, 'a holds it under deep/, so the suffix rescues it')
    assert.ok(mod.checkPaths(message, b), 'b does not hold it at any depth, so it must be reported')
    delete process.env.CLAIMCHECK_PATHS

    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
})

describe('claims that name what they are about', () => {
  test('a tag the repository has not got', async () => {
    const mod = await import(HOOK)
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'x')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'one')
    git(dir, 'tag', 'v1.0.0')
    assert.ok(mod.checkTag('Done, I tagged v2.0.0.', dir), 'no such tag')
    assert.equal(mod.checkTag('Done, I tagged v1.0.0.', dir), null, 'the tag is there')
    assert.equal(mod.checkTag('Done, I tagged 1.0.0.', dir), null, 'v1.0.0 and 1.0.0 are one release')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a repository with no tags at all says nothing either way', async () => {
    const mod = await import(HOOK)
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'x')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'one')
    assert.equal(mod.checkTag('I tagged v2.0.0.', dir), null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a command the session never ran', async () => {
    const mod = await import(HOOK)
    const runs = [{ command: 'npm run lint', ok: true }]
    assert.ok(mod.checkRan('I ran `npm test`.', runs), 'never ran')
    assert.equal(mod.checkRan('I ran `npm run lint`.', runs), null, 'it did')
    assert.equal(mod.checkRan('I ran `npm run lint -- --fix`.', runs), null, 'same program, same first argument')
    assert.ok(mod.checkRan('I ran `npm run build`.', runs), 'a different script is a different command')
  })

  test('a command inside a compound the session ran', async () => {
    const mod = await import(HOOK)
    assert.equal(mod.checkRan('I ran `npm test`.', [{ command: 'npm run lint && npm test', ok: true }]), null)
  })

  test('no transcript, no opinion', async () => {
    const mod = await import(HOOK)
    assert.equal(mod.checkRan('I ran `npm test`.', null), null)
  })

  test('an instruction to the reader is not a claim', async () => {
    const mod = await import(HOOK)
    assert.equal(mod.checkRan('Run `npm test` to see for yourself.', []), null)
  })

  test('a fenced block is output, not a sentence the agent wrote', async () => {
    const mod = await import(HOOK)
    assert.equal(mod.claimed('CI said:\n\n```\nall tests pass\n```\n', mod.TEST_CLAIM), null)
    assert.ok(mod.claimed('All tests pass.', mod.TEST_CLAIM), 'outside a fence it still counts')
  })
})

describe('audit mode and the record it leaves', () => {
  const read = (dir) =>
    readFileSync(join(dir, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  test('judges for real, records, and never blocks', () => {
    const dir = tmp()
    const data = join(dir, 'data')
    const input = { session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' }
    assert.equal(hook(input, { CLAIMCHECK_MODE: 'audit', CLAIMCHECK_DATA: data }), null, 'audit always falls through')
    const rows = read(data)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].outcome, 'would-block')
    assert.deepEqual(rows[0].checks, ['tests'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('records the stops that found nothing too — without them there is no rate', () => {
    const dir = tmp()
    const data = join(dir, 'data')
    const base = { cwd: dir, transcript_path: transcript(dir, []) }
    hook({ ...base, session_id: sessionId(), last_assistant_message: 'Done, all tests pass.' }, { CLAIMCHECK_MODE: 'audit', CLAIMCHECK_DATA: data })
    hook({ ...base, session_id: sessionId(), last_assistant_message: 'Here is what I found.' }, { CLAIMCHECK_MODE: 'audit', CLAIMCHECK_DATA: data })
    const rows = read(data)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.outcome).sort(), ['clear', 'would-block'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('enforce records the same line and still blocks', () => {
    const dir = tmp()
    const data = join(dir, 'data')
    const d = hook({ session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' }, { CLAIMCHECK_DATA: data })
    assert.equal(d?.decision, 'block')
    assert.equal(read(data)[0].outcome, 'block')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a data directory that cannot be written does not stall the agent', () => {
    const dir = tmp()
    const d = hook(
      { session_id: sessionId(), cwd: dir, transcript_path: transcript(dir, []), last_assistant_message: 'Done, all tests pass.' },
      { CLAIMCHECK_DATA: '/proc/nowhere/claimcheck' },
    )
    assert.equal(d?.decision, 'block', 'the record is never a precondition')
    rmSync(dir, { recursive: true, force: true })
  })

  test('report counts what was recorded', () => {
    const dir = tmp()
    const data = join(dir, 'data')
    const base = { cwd: dir, transcript_path: transcript(dir, []) }
    for (const m of ['Done, all tests pass.', 'Nothing to report.', 'Fatto, i test passano.']) {
      hook({ ...base, session_id: sessionId(), last_assistant_message: m }, { CLAIMCHECK_MODE: 'audit', CLAIMCHECK_DATA: data })
    }
    const out = execFileSync('node', [HOOK, 'report'], { encoding: 'utf8', env: { ...process.env, CLAIMCHECK_DATA: data } })
    assert.match(out, /3 stops recorded/)
    assert.match(out, /fired on 2 of them/)
    assert.match(out, /tests\s+2/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('report with nothing recorded says so rather than failing', () => {
    const out = execFileSync('node', [HOOK, 'report'], { encoding: 'utf8', env: { ...process.env, CLAIMCHECK_DATA: join(tmp(), 'empty') } })
    assert.match(out, /nothing recorded yet/)
  })
})
