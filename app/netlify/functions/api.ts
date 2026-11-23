// Every /api/* request is served by the Hono app (the same one the Node server runs).
import { getServer } from '../serverless'

export default async (req: Request) => (await getServer()).app.fetch(req)

export const config = { path: '/api/*' }
