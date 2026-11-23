// Netlify runtime defaults, applied before the app reads its settings. Values set in the Netlify dashboard win.
import { createServer } from '../server/bootstrap'

process.env.NODE_ENV ??= 'production'
// Netlify's edge sets this header itself; clients can't forge it (see server/net.ts).
process.env.CLIENT_IP_HEADER ??= 'x-nf-client-connection-ip'
// Netlify exposes the site's primary https address as URL; an explicit APP_URL (a custom domain) wins.
if (!process.env.APP_URL && process.env.URL) process.env.APP_URL = process.env.URL
// Functions don't run the resident worker loop; the scheduled `jobs` function drains the queue instead.
process.env.JOBS_ENABLED = 'false'

let server: ReturnType<typeof createServer> | undefined
/** One app per warm function instance. Migrations run in the deploy pipeline, not on cold start. */
export function getServer() {
  server ??= createServer({ migrate: false, poolMax: 3 }).catch(e => { server = undefined; throw e })
  return server
}
