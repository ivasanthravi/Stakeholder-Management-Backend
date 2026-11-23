// Background job handlers and the recurring schedule. Handlers are registered on every process (so any process can
// run a queued job); the worker loop and schedule run only where JOBS_ENABLED isn't "false".
import { errorFields, log } from './log'
import type { Deps } from './context'
import { processTrials, reconcileAll, syncSubscription } from './billing/sync'
import { processDataRequests, runExport } from './modules/data'
import { sendCommitmentDigests } from './modules/notifications'

export function registerJobs(deps: Deps) {
  const jobs = deps.jobs!
  const billing = () => ({ db: deps.db, jobs, billing: deps.billing ?? null, notify: deps.billingNotify })
  jobs.register('billing.sync', async p => { await syncSubscription(billing(), String(p.subscriptionId)) })
  jobs.register('billing.reconcile', async () => { await reconcileAll(billing()) })
  jobs.register('billing.trials', async () => { await processTrials(billing()) })
  jobs.register('data.export', async p => { await runExport(deps, String(p.requestId)) })
  jobs.register('data.process', async () => { await processDataRequests(deps) })
  jobs.register('notifications.digest', async () => { await sendCommitmentDigests(deps) })
}

const HOUR = 3_600_000
/** Enqueues recurring jobs; the dedupe key per time bucket keeps several processes from doubling them. */
/** Enqueues the recurring jobs due in the current time bucket; the dedupe key per bucket keeps repeats from doubling them. */
export async function enqueueRecurring(jobs: NonNullable<Deps['jobs']>) {
  const bucket = (ms: number) => Math.floor(Date.now() / ms)
  await jobs.enqueue('billing.trials', {}, { dedupeKey: `billing.trials:${bucket(HOUR)}` })
  await jobs.enqueue('billing.reconcile', {}, { dedupeKey: `billing.reconcile:${bucket(24 * HOUR)}` })
  for (const extra of scheduled) await jobs.enqueue(extra.kind, {}, { dedupeKey: `${extra.kind}:${bucket(extra.everyMs)}` })
}

/** Long-running processes: enqueue recurring jobs every 10 minutes and run the worker loop. */
export function startSchedule(deps: Deps) {
  const jobs = deps.jobs!
  const tick = async () => {
    try { await enqueueRecurring(jobs) } catch (e) { log('warn', 'schedule tick failed', errorFields(e)) }
  }
  void tick()
  const timer = setInterval(tick, 10 * 60_000)
  jobs.start()
  return () => { clearInterval(timer); jobs.stop() }
}

/** Other modules add recurring work here (notification digests, data retention). */
export const scheduled: { kind: string; everyMs: number }[] = [
  { kind: 'data.process', everyMs: HOUR },
  { kind: 'notifications.digest', everyMs: 24 * HOUR },
]
