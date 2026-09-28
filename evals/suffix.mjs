// Of the "never existed" findings, how many are just a SUFFIX of a real tracked file
// (docs/x.md cited when the file is at sub/docs/x.md)? Those are honest references my
// cwd-relative resolution mishandles, not inventions.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { citedPaths } from '../claimcheck.mjs'

const root = join(homedir(), '.claude', 'projects')
const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, stdio: ['ignore','pipe','ignore'] }).trim() } catch { return null } }
const filesCache = new Map()
function tracked(cwd) {
  if (!filesCache.has(cwd)) {
    const all = git(cwd, ['ls-files'])
    const hist = git(cwd, ['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A'])
    filesCache.set(cwd, new Set([...(all ?? '').split('\n'), ...(hist ?? '').split('\n')].filter(Boolean)))
  }
  return filesCache.get(cwd)
}
let suffixHit = 0, trueMiss = 0
const missSamples = []
for (const proj of readdirSync(root)) {
  const d = join(root, proj)
  let files; try { if (!statSync(d).isDirectory()) continue; files = readdirSync(d).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    let lines; try { const p = join(d, f); if (statSync(p).size > 12e6) continue; lines = readFileSync(p, 'utf8').split('\n') } catch { continue }
    let lastText = null, lastRole = null, cwd = null
    for (const line of lines) {
      if (!line) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.cwd && !cwd) cwd = e.cwd
      const c = e.message?.content; if (!Array.isArray(c)) continue
      if (e.type === 'assistant') { for (const b of c) if (b.type === 'text' && b.text) lastText = b.text; lastRole = 'assistant' }
      else if (e.type === 'user') {
        if (c.some(b => b.type === 'text') && lastRole === 'assistant' && lastText && cwd && existsSync(cwd) && git(cwd,['rev-parse','--is-inside-work-tree'])==='true') {
          for (const [p, { rooted }] of citedPaths(lastText)) {
            if (!rooted || existsSync(join(cwd, p))) continue
            const set = tracked(cwd)
            let hit = false
            for (const t of set) if (t === p || t.endsWith('/' + p)) { hit = true; break }
            if (hit) suffixHit++
            else { trueMiss++; if (missSamples.length < 12) missSamples.push(`${p}  (${cwd.split('/').slice(-1)[0]})`) }
          }
          lastText = null
        }
        lastRole = 'user'
      }
    }
  }
}
console.log(`suffix of a real tracked file  ${suffixHit}   <- honest reference, my resolution was wrong`)
console.log(`no such file, any depth, ever  ${trueMiss}   <- a genuinely invented path`)
console.log(`\n--- genuinely invented ---`); missSamples.forEach(s => console.log('  • ' + s))
