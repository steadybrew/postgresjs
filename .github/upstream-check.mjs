import { readFileSync } from 'fs'

const write = /reading 'write'/
const reasons = {
  'reserved-after-terminate': write,
  'begin-terminated-midstatement:prepared': write,
  'begin-terminated-midstatement:unprepared': write,
  'begin-network-cut': write,
  'begin-after-session-ended:idle-timeout:return': write,
  'begin-after-session-ended:idle-timeout:statement': write,
  'begin-after-session-ended:terminate:return': write,
  'begin-after-session-ended:terminate:statement': write,
  'reserved-inflight-terminate': write,
  'terminated-inflight-then-query:prepared': /'57P01' !== 1/,
  'terminated-inflight-then-query:unprepared': /'57P01' !== 1/,
  'stale-transaction-reads-through-rls': /read replacement\/second/,
  'late-drain-commits-other-transaction': /25001/,
  'type-query-fatal': /terminating connection due to administrator command/,
  'connect-timeout-prefer-standby': /CONNECT_TIMEOUT/,
  'connect-timeout-primary': /CONNECT_TIMEOUT/,
  'connect-timeout-busy-pool': /CONNECT_TIMEOUT/,
  'reset-mid-begin': /\+   9/,
  'begin-at-pipeline-limit': /UNSAFE_TRANSACTION/,
  'concurrent-begins-busy-pool': /UNSAFE_TRANSACTION|25001/,
  'begin-write-always-true': /idle in transaction/,
  'queued-statement-never-settles:socket-error': /queued: 'still_pending'/,
  'queued-statement-never-settles:terminate': /queued: 'still_pending'/,
  'begin-inflight-end': /'hang' !== 'resolved'/,
  'begin-inflight-end-reset': /'hang' !== 'resolved'/,
  'phase:end-queued-cold': /3 !== 'end'/
}

const [file, ...names] = process.argv.slice(2)
const rows = readFileSync(file, 'utf8').split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x))
  .filter(x => !names.length || names.includes(x.name))
let bad = false
for (const row of rows) {
  const reason = reasons[row.name]
  const wrong = !row.passed && reason && !reason.test(row.output)
  bad = bad || row.passed || wrong
  console.log((row.passed ? 'PASSED ON UPSTREAM ' : wrong ? 'FAILS FOR ANOTHER REASON ' : 'fails on upstream ') + row.name +
    (reason ? ' (expected ' + reason + ')' : '') + '\n' + row.output + '\n')
}
const missing = names.filter(x => !rows.some(row => row.name === x))
missing.length && console.log('NOT RUN ' + missing.join(' '))
process.exitCode = bad || missing.length || !rows.length ? 1 : 0
