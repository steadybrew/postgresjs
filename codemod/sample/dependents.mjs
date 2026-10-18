import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const out = new URL('./dependents.jsonl', import.meta.url)
const cursorFile = new URL('./dependents.cursor', import.meta.url)
const base = 'https://github.com/porsager/postgres/network/dependents?dependent_type=REPOSITORY'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let cursor = existsSync(cursorFile) ? readFileSync(cursorFile, 'utf8').trim() : ''
let pages = 0
let wait = 1000

while (true) {
  const res = await fetch(cursor ? base + '&dependents_after=' + cursor : base, { headers: { 'user-agent': 'Mozilla/5.0' } }).catch(e => ({ status: 'network ' + e.cause?.code }))
  if (res.status === 429 || typeof res.status === 'string' || res.status >= 500) {
    wait = Math.min(wait * 2, 120000)
    console.error('status', res.status, 'waiting', wait)
    await sleep(wait)
    continue
  }
  wait = 1000
  const html = await res.text()
  const rows = html.split('class="Box-row').slice(1)
  const lines = rows.map(row => {
    const repo = row.match(/data-hovercard-type="repository"[^>]*href="\/([^"]+)"/)
    const stars = row.match(/octicon-star[\s\S]*?<\/svg>\s*([\d,]+)/)
    return repo && JSON.stringify({ repo: repo[1], stars: stars ? +stars[1].replace(/,/g, '') : null })
  }).filter(Boolean)
  lines.length && appendFileSync(out, lines.join('\n') + '\n')
  const next = [...html.matchAll(/href="[^"]*dependents_after=([A-Za-z0-9%=_-]+)"/g)].pop()
  pages++
  pages % 50 === 0 && console.error('pages', pages)
  if (!next || next[1] === cursor)
    break
  cursor = next[1]
  writeFileSync(cursorFile, cursor)
  await sleep(wait)
}
console.error('done', pages)
