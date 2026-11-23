# Deploying to Netlify

## How it runs on Netlify
| Part | Where it runs | File |
|---|---|---|
| The React app | Netlify's CDN, as static files from `app/dist` | `netlify.toml` |
| The API (`/api/*`) | A Netlify Function running the same Hono app as the Node server | `app/netlify/functions/api.ts` |
| Background jobs (email retries, exports, digests, billing sync) | A scheduled function, every 10 minutes | `app/netlify/functions/jobs.ts` |
| Database | Neon PostgreSQL (`meridian_prod`) | — |
| Email | Gmail SMTP | — |

**The CI/CD pipeline** is `.github/workflows/ci.yml`. On every push to `main` it:
1. runs `verify` (audit, typecheck, lint, tests on PGlite and PostgreSQL, AI gate, restore drill, build);
2. runs `e2e` (Playwright);
3. **only if both pass**, runs `deploy`:
   - applies database migrations;
   - builds the site and deploys it to Netlify production;
   - checks that `/api/health` answers.

Pull requests run steps 1–2 and never deploy. Netlify's own Git builds stay off, so nothing reaches the live site without passing the checks.

## One-time setup
### 1. Create the production database (Neon)
1. In the Neon console, open your project, then go to **Databases → New database**.
2. Name it `meridian_prod`. Keep `meridian` for development.
3. Click **Connect**, choose database `meridian_prod`, and turn **Connection pooling** on.
4. Copy the connection string (`postgresql://…-pooler…/meridian_prod?sslmode=require`). It is your `DATABASE_URL`.

### 2. Create a Netlify account
1. Go to **app.netlify.com/signup**.
2. Choose **Sign up with GitHub** and authorize Netlify. The free plan is enough to start.
3. Answer the short onboarding questions. When it offers to deploy a first project, skip it: the next step creates the project from your terminal.

### 3. Create the Netlify project
Run these in your own terminal, from the repository folder:

```bash
npx netlify-cli@27.16.2 login
```

A browser window opens. Click **Authorize**.

```bash
npx netlify-cli@27.16.2 sites:create --name meridian-yourname --disable-linking
```

- Choose your team when asked.
- The name becomes your address, `https://meridian-yourname.netlify.app`, so it must be unique across Netlify.
- The output shows a **Project ID** (a UUID). Copy it.

### 4. Set the app's settings in Netlify
In Netlify, open the project, then go to **Project configuration → Environment variables → Add a variable**. Add each variable below with scope **All scopes** (the functions must see them).

| Key | Value |
|---|---|
| `DEPLOY_ENV` | `production` |
| `AUTH_SECRET` | A long random string. Generate one with `openssl rand -base64 32` |
| `DATABASE_URL` | The `meridian_prod` connection string from step 1 |
| `MAIL_TRANSPORT` | `smtp` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | Your Gmail address |
| `SMTP_PASSWORD` | Your Google App Password (not your Gmail password). Tick **Contains secret values** |
| `MAIL_FROM` | `Meridian <your-gmail-address>` |
| `SIGNUP_ALLOWLIST` | Who may sign up, e.g. `@roanuz.com,you@gmail.com` |
| `APP_URL` | Optional: only for a custom domain. Netlify's own `https://…netlify.app` address is used automatically |

### 5. Create a Netlify access token
1. In Netlify, open your avatar menu, then **User settings → Applications → Personal access tokens → New access token**.
2. Name it `github-deploy` and set an expiry.
3. Copy the token. It is shown only once.

### 6. Give GitHub the deploy secrets
In the GitHub repository that should deploy (`ivasanthravi/Stakeholder-Management-Backend`), go to **Settings → Secrets and variables → Actions → New repository secret**, and add:

| Secret | Value |
|---|---|
| `NETLIFY_AUTH_TOKEN` | The token from step 5 |
| `NETLIFY_SITE_ID` | The Project ID from step 3 |
| `DATABASE_URL` | The same `meridian_prod` connection string; the pipeline uses it to apply migrations |

**Add them to one repository only.** A repository without these secrets runs the checks and skips the deploy, with a notice.

### 7. Deploy
1. Push to `main`, or re-run the latest workflow under **Actions → ci → Re-run all jobs**.
2. When `deploy` turns green, its log shows `Live at https://…netlify.app`.
3. Open that address and sign up with an allow-listed email. The verification email arrives from your Gmail.

## Day to day
- **Ship a change:** push to `main`. It goes live only if every check passes.
- **Roll back:** in Netlify, go to **Deploys**, pick an earlier deploy and choose **Publish deploy**. Database migrations are additive, so older code keeps working.
- **Change a setting** (for example `SIGNUP_ALLOWLIST`): edit it under **Environment variables**, then go to **Deploys → Trigger deploy → Deploy project without cache**, or push a commit. Functions read settings at deploy time.
- **Logs:** go to **Logs → Functions → api** (requests) or **jobs** (background runs).

## Limits to know
- **Background work runs every 10 minutes**, not continuously.
  - Sign-up, verification and reset emails are sent immediately.
  - Only retries of failed emails, data exports and digests wait for the next run.
- **Cold starts:** the first API request after a quiet period takes about 1–2 s longer.
- **The sign-in rate limit is per function instance:** it still slows guessing, but it is weaker than on a single server.
- **Request time:** API requests must finish within Netlify's function time limit. Everything in the app does today; very large exports run as background jobs.
- **Free-plan limits:** check usage under **Usage & billing**.

## Verified locally (2026-11-23)
**Setup:** `netlify serve` (netlify-cli 27.16.2) with a throwaway PostgreSQL.

**Results:**
- the site built and both functions bundled;
- `/api/health` answered;
- deep links returned the app;
- unknown API paths returned 404;
- the security headers were present;
- sign-up created a user;
- the scheduled `jobs` function ran queued jobs.

**Not yet verified:** a deploy to Netlify itself, which needs your account (steps 2–6).
