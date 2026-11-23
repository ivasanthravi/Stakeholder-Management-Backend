import { log } from './log'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { startSchedule } from './runtime'
import { createServer } from './bootstrap'

const { env, database, transport, billing, deps, app } = await createServer()
const stopSchedule = env.JOBS_ENABLED === 'false' ? () => {} : startSchedule(deps)

// In production the same process serves the built client (single origin: no CORS, first-party cookies).
if (env.NODE_ENV === 'production') {
  const dist = path.resolve('dist')
  const index = readFileSync(path.join(dist, 'index.html'), 'utf8')
  app.use('/assets/*', serveStatic({ root: './dist' }))
  app.get('*', c => c.html(index))
}

serve({ fetch: app.fetch, port: env.PORT }, info => {
  log('info', `Meridian API on http://localhost:${info.port}`, { database: database.kind, mail: transport.name, billing: billing.provider?.label ?? 'not configured', jobs: env.JOBS_ENABLED !== 'false' })
})

const shutdown = async () => { stopSchedule(); await database.close(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
