// Background work on Netlify: every 10 minutes, enqueue recurring jobs and run queued ones (email retries, exports,
// digests, billing sync) for up to ~20 s. Scheduled functions run on the published production deploy only.
import { errorFields, log } from '../../server/log'
import { enqueueRecurring } from '../../server/runtime'
import { getServer } from '../serverless'

const BUDGET_MS = 20_000

export default async () => {
  const { deps } = await getServer()
  const jobs = deps.jobs
  const started = Date.now()
  let ran = 0
  try {
    await enqueueRecurring(jobs)
    while (Date.now() - started < BUDGET_MS && await jobs.drain(1) > 0) ran++
  } catch (e) { log('warn', 'scheduled jobs run failed', errorFields(e)) }
  log('info', 'scheduled jobs run', { ran, ms: Date.now() - started })
}

export const config = { schedule: '*/10 * * * *' }
