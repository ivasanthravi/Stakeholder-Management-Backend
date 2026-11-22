// Email delivery against Postmark's API contract (fetch stubbed): permanent rejections are recorded and never retried
// (so they can't fill the dead-job queue and page someone), temporary failures are retried by a job.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestContext, type TestContext } from './helpers'
import { createMailer, createPostmarkTransport, createSmtpTransport } from '../server/mail'
import { loadEnv } from '../server/env'
import { emailMessage, job } from '../server/db/schema'

let ctx: TestContext
beforeAll(async () => { ctx = await createTestContext() })
afterAll(async () => { vi.unstubAllGlobals(); await ctx.close() })

const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
const mailer = () => createMailer(ctx.db, createPostmarkTransport('server-token-for-tests'), { from: 'Meridian <no-reply@example.test>', appUrl: 'https://app.example.test', jobs: ctx.jobs })
const send = (to: string) => mailer().send({ to, template: 'verify', data: { url: 'https://app.example.test/verify?token=t' } })
const retries = async (to: string) => (await ctx.db.select().from(job).where(eq(job.kind, 'email.retry'))).filter(j => (j.payload.mail as { to?: string })?.to === to).length

describe('Postmark delivery', () => {
  test('accepted: sent with the provider message id; the token header is sent and nothing secret is stored', async () => {
    const f = reply(200, { ErrorCode: 0, MessageID: 'pm-123' }); vi.stubGlobal('fetch', f)
    expect((await send('ok@example.test')).status).toBe('sent')
    const [row] = await ctx.db.select().from(emailMessage).where(eq(emailMessage.to, 'ok@example.test'))
    expect(row.status).toBe('sent'); expect(row.providerMessageId).toBe('pm-123')
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['x-postmark-server-token']).toBe('server-token-for-tests')
    expect(JSON.stringify(row)).not.toContain('server-token-for-tests')
  })
  test('inactive recipient (406) and invalid address (300): failed, not retried', async () => {
    for (const [to, code] of [['bounced@example.test', 406], ['bad@example.test', 300]] as const) {
      vi.stubGlobal('fetch', reply(422, { ErrorCode: code, Message: 'You tried to send to a recipient that has been marked as inactive.' }))
      expect((await send(to)).status).toBe('failed')
      const [row] = await ctx.db.select().from(emailMessage).where(eq(emailMessage.to, to))
      expect(row.status).toBe('failed')
      expect(await retries(to)).toBe(0)
    }
  })
  test('a temporary failure (server error) is queued for retry', async () => {
    vi.stubGlobal('fetch', reply(503, { ErrorCode: 0, Message: 'Service unavailable' }))
    expect((await send('later@example.test')).status).toBe('queued')
    expect(await retries('later@example.test')).toBe(1)
  })
})

// SMTP (e.g. Gmail) against a stand-in for nodemailer's transport: nothing is sent and no network is used.
describe('SMTP delivery', () => {
  const opts = { host: 'smtp.gmail.com', port: 465, user: 'sender@example.test', password: 'app-password-for-tests' }
  const fake = (impl: (m: Record<string, unknown>) => Promise<unknown>) => {
    const created: Record<string, unknown>[] = []
    const factory = ((config: Record<string, unknown>) => { created.push(config); return { sendMail: impl } }) as unknown as Parameters<typeof createSmtpTransport>[1]
    return { factory, created }
  }
  const smtpSend = (factory: Parameters<typeof createSmtpTransport>[1], to: string) =>
    createMailer(ctx.db, createSmtpTransport(opts, factory), { from: 'Meridian <sender@example.test>', appUrl: 'https://app.example.test', jobs: ctx.jobs })
      .send({ to, template: 'verify', data: { url: 'https://app.example.test/verify?token=t' } })

  test('accepted: sent over TLS with the account login; the password is stored nowhere', async () => {
    const sent: Record<string, unknown>[] = []
    const f = fake(async m => { sent.push(m); return { messageId: '<smtp-1@example.test>' } })
    expect((await smtpSend(f.factory, 'smtp-ok@example.test')).status).toBe('sent')
    expect(f.created[0]).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'sender@example.test' } })
    expect(sent[0]).toMatchObject({ to: 'smtp-ok@example.test', from: 'Meridian <sender@example.test>' })
    const [row] = await ctx.db.select().from(emailMessage).where(eq(emailMessage.to, 'smtp-ok@example.test'))
    expect(row).toMatchObject({ status: 'sent', transport: 'smtp', providerMessageId: '<smtp-1@example.test>' })
    expect(JSON.stringify(row)).not.toContain('app-password-for-tests')
  })
  test('a recipient the server rejects (5xx on RCPT TO) fails and is not retried', async () => {
    const f = fake(async () => { throw Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { responseCode: 550, command: 'RCPT TO' }) })
    expect((await smtpSend(f.factory, 'smtp-nobody@example.test')).status).toBe('failed')
    expect(await retries('smtp-nobody@example.test')).toBe(0)
  })
  test('a temporary or login failure is queued for retry, and the error never carries the password', async () => {
    const f = fake(async () => { throw Object.assign(new Error('535-5.7.8 Username and Password not accepted'), { responseCode: 535, command: 'AUTH PLAIN' }) })
    expect((await smtpSend(f.factory, 'smtp-later@example.test')).status).toBe('queued')
    expect(await retries('smtp-later@example.test')).toBe(1)
    const [row] = await ctx.db.select().from(emailMessage).where(eq(emailMessage.to, 'smtp-later@example.test'))
    expect(row.error).toMatch(/SMTP 535/)
    expect(row.error).not.toContain('app-password-for-tests')
  })
  test('port 587 requires STARTTLS instead of connecting in TLS', () => {
    const f = fake(async () => ({ messageId: null }))
    createSmtpTransport({ ...opts, port: 587 }, f.factory)
    expect(f.created[0]).toMatchObject({ port: 587, secure: false, requireTLS: true })
  })
  test('settings: on Render the public URL comes from RENDER_EXTERNAL_URL unless APP_URL is set', () => {
    expect(loadEnv({ RENDER_EXTERNAL_URL: 'https://meridian.onrender.com' }).APP_URL).toBe('https://meridian.onrender.com')
    expect(loadEnv({ RENDER_EXTERNAL_URL: 'https://meridian.onrender.com', APP_URL: 'https://app.example.com' }).APP_URL).toBe('https://app.example.com')
  })
  test('settings: smtp needs a user and password; production accepts smtp as a real transport', () => {
    expect(() => loadEnv({ MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_USER and SMTP_PASSWORD/)
    expect(loadEnv({ MAIL_TRANSPORT: 'smtp', SMTP_USER: 'a@example.test', SMTP_PASSWORD: 'p' })).toMatchObject({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465 })
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://h/db', AUTH_SECRET: 'x'.repeat(40), APP_URL: 'https://app.example.com' }
    expect(loadEnv({ ...prod, MAIL_TRANSPORT: 'smtp', SMTP_USER: 'a@example.test', SMTP_PASSWORD: 'p' }).MAIL_TRANSPORT).toBe('smtp')
  })
})
