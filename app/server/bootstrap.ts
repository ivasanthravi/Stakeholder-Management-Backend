// Builds the API and its dependencies. Shared by the long-running Node server (server/index.ts) and the
// Netlify functions (netlify/functions), which run the same app without a resident process.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from './env'
import { createDatabase, migrate } from './db/client'
import { createLogTransport, createMailer, createPostmarkTransport, createSmtpTransport } from './mail'
import { createJobs } from './jobs'
import { createBilling } from './billing'
import { createAuth } from './auth'
import { createApp } from './app'

export interface BootOptions {
  /** Apply pending migrations on start (the Node server). Serverless deploys migrate once, before deploying. */
  migrate?: boolean
  /** Connections per process; keep it small where many short-lived instances share one database. */
  poolMax?: number
}

export async function createServer(opts: BootOptions = {}) {
  const env = loadEnv()
  if (!env.DATABASE_URL) mkdirSync(env.PGLITE_DIR, { recursive: true })
  const database = await createDatabase({ url: env.DATABASE_URL, dataDir: env.DATABASE_URL ? undefined : env.PGLITE_DIR, poolMax: opts.poolMax })
  if (opts.migrate ?? true) await migrate(database)
  const jobs = createJobs(database.db)
  const transport = env.MAIL_TRANSPORT === 'postmark' ? createPostmarkTransport(env.POSTMARK_SERVER_TOKEN!, env.POSTMARK_MESSAGE_STREAM)
    : env.MAIL_TRANSPORT === 'smtp' ? createSmtpTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER!, password: env.SMTP_PASSWORD! })
    : createLogTransport(database.db)
  const mailer = createMailer(database.db, transport, { from: env.MAIL_FROM, appUrl: env.APP_URL, jobs })
  const auth = createAuth(database.db, env, mailer)
  // In development the simulator keeps its provider-side state in .data so subscriptions survive restarts.
  const billing = createBilling(env, { simulatorStatePath: env.DATABASE_URL ? undefined : path.join(env.PGLITE_DIR, '..', 'billing-simulator.json') })
  const deps = { db: database.db, auth, env, mailer, jobs, billing: billing.provider, simulator: billing.simulator }
  const app = createApp(deps)
  return { env, database, transport, billing, deps, app }
}
