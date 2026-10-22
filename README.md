# T2E Image Library — GitHub Pages + Cloudinary + OpenAI AI cleanup

A static web app for catering product images. Each upload requires **Name**, **PLU**, and **Sector**. Images are saved with `name_PLU_sector.ext` filenames, organised by sector, searchable and individually shareable using **Copy URL Link**.

**AI cleanup is already implemented** in the initial version. Tick *Clean up with AI* before upload. The Cloudflare Worker calls OpenAI's images/edits endpoint with `gpt-image-1-mini`, `quality=low`, `size=1024x1024`, and WebP output, then sends the result to Cloudinary. OpenAI API fees apply to input tokens and image output. As of Oct 2026, the mini model is deprecated, so the model may need changing when it is retired.

## Architecture

- **GitHub Pages:** statically exported Next.js gallery (no database/server on Pages).
- **Cloudinary (Free plan):** image CDN and contextual metadata (Name, PLU, Sector, AI cleaned); Cloudinary Admin API serves as catalogue. Image IDs include UUID folder paths to avoid collisions but URLs end in `name_PLU_sector.ext`.
- **Cloudflare Workers (Free plan):** public listing, password-protected upload API and confidential OpenAI/Cloudinary credentials.
- **OpenAI API:** optional low-quality GPT Image editing. Requires an API key with credit/billing enabled. No keys are stored in this repository or sent to the browser.

## 1. Create a Cloudinary account

1. Go to https://cloudinary.com/users/register_free and select the Free plan (no payment card required).
2. Find your **Cloud name**, **API key**, and **API secret** on the Cloudinary dashboard.
3. Never post your API secret or OpenAI API key in chat or put them in GitHub repository files.
4. Do not create an unsigned upload preset; our Worker uses signed, server-side uploads.

Cloudinary's free plan currently includes 25 credits per month across storage, transformations and bandwidth; not 25 GB in every category simultaneously. Its API has rate limits.

## 2. Create a free Cloudflare account

1. Visit https://dash.cloudflare.com/ and register or sign in.
2. Go to Workers & Pages -> **Create application -> Worker**. Make a Worker named `t2e-image-api`.
3. Once created, choose **Settings -> Variables and Secrets -> Add**. Add:
   
   | Name | Type | Value |
   | ---- | ---- | ----- |
   | CLOUDINARY_CLOUD_NAME | Secret | Cloudinary cloud name |
   | CLOUDINARY_API_KEY | Secret | Cloudinary API key |
   | CLOUDINARY_API_SECRET | Secret | Cloudinary API secret |
   | UPLOAD_PASSWORD | Secret | Your long, unique uploader password (12+ chars) |
   | OPENAI_API_KEY | Secret | Your OpenAI API key |
   | ALLOWED_ORIGIN | Plain text variable | https://samwarb.github.io |
   | OPENAI_IMAGE_MODEL | Plain text variable | gpt-image-1-mini |

   Worker secrets are hidden by Cloudflare after saving. **Do not send them to me.**
4. Deploy `worker/index.mjs` using the Cloudflare dashboard editor (copy the entire file into the Worker, save, deploy). Alternatively, from a local checkout authenticated with Cloudflare, run `npx wrangler deploy`; then `npx wrangler secret put CLOUDINARY_CLOUD_NAME`, and repeat for the four other secrets. `wrangler.toml` contains the same worker configuration.
5. Copy the resulting URL such as `https://t2e-image-api.YOUR-SUBDOMAIN.workers.dev`. Open `/health` to check `{"ok":true,"configured":true}`.

**Free Workers limitation:** 100,000 requests per day and 10ms CPU time per request. Heavy image conversion may exceed the CPU allowance for some images; if it does, the upload will fail and you may need another backend or a paid Worker. Image editing runs remotely at OpenAI, but encoding/decoding still consumes Worker CPU.

## 3. Configure GitHub Pages

1. Open https://github.com/samwarb/t2e_images/settings/variables/actions.
2. Add a **repository variable** called `T2E_API_URL` with your deployed Worker base URL (no trailing slash).
3. Open https://github.com/samwarb/t2e_images/settings/pages and select **GitHub Actions** as the Pages build/deployment source.
4. Open https://github.com/samwarb/t2e_images/actions/workflows/pages.yml and click **Run workflow** on `main`. This builds the static web app and publishes it to:
   
   **https://samwarb.github.io/t2e_images/**

5. Open the site and upload a small test JPG with a Name, PLU and Sector. Tick **Clean up with AI** to test the paid OpenAI path. The output is stored in Cloudinary; Copy URL Link copies its actual CDN URL.

The app loads and stores the upload password **only in the tab memory**. A refresh or new tab requires signing in again. For production/team-wide use, upgrade to individual identities and rate limiting; the shared password is intended only for a small initial prototype.

## Technical notes and development

```bash
npm install
npm test
npm run typecheck
npm run dev
# For Cloudflare backend after authenticating with Wrangler:
npm run worker:dev
npm run worker:deploy
```

For local UI development, create a `.env.local` with `NEXT_PUBLIC_T2E_API_URL=http://127.0.0.1:8787`. Run `npm run dev` and `npm run worker:dev` separately. Configure secrets for local development using `.dev.vars` (gitignored) with the five values listed above.

The public listing uses Cloudinary's rate-limited Admin API, including the `context` field. The gallery loads 48 records per request. Sector filters and searches apply to entries already loaded. Image files are public via Cloudinary URL, so never upload private data or company assets that haven't been approved for third-party hosting. OpenAI cleanup may change the appearance of food, packaging, or ingredients. Confirm accuracy before production use.

No GCP project, GCP billing or Supabase account is required. This repository contains **no Cloudinary, OpenAI, or Cloudflare secrets**, and the Worker is not automatically deployed until configured.
