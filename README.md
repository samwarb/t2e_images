# T2E Image Library

A web application for uploading, cleaning, organising and sharing Time2Eat catering product images.

Features: upload requires Name, PLU and Sector; images are named name_PLU_sector.extension, grouped by sector in the gallery, searchable and publicly shareable through a Copy URL Link button. Metadata is stored in Firestore and files in private Google Cloud Storage. Upload access requires a shared admin password. An optional OpenAI image edit uses low quality for minimum cost, with a server-side API key.

## Run locally

1. Create a Google Cloud project, a private Standard Cloud Storage bucket and a Firestore Native database.
2. Copy .env.example to .env.local. Set GCP_PROJECT_ID, GCS_BUCKET, UPLOAD_PASSWORD and a random AUTH_SECRET of 32+ characters.
3. Authenticate locally with: gcloud auth application-default login.
4. Run: npm install; npm test; npm run typecheck; npm run dev.
5. Visit http://localhost:3000. Use the Upload button and sign in with UPLOAD_PASSWORD.
6. Set OPENAI_API_KEY to enable the optional AI cleanup feature. Never put any secret in frontend code or commit it.

## Deploy with Google Cloud Run

Enable Cloud Run, Cloud Build, Artifact Registry, Storage, Firestore and Secret Manager APIs. Use us-central1 for the bucket to qualify for the relevant Cloud Storage Always Free quota. Create the first Firestore Native database in the project (the free tier covers only one database).

Create a dedicated Cloud Run runtime service account, grant it Firestore roles/datastore.user and bucket-scoped Storage Object Admin permissions, and grant Secret Manager Secret Accessor for your secrets. Set UPLOAD_PASSWORD, AUTH_SECRET and (optionally) OPENAI_API_KEY as Secret Manager secrets. Deploy the app using the included Dockerfile, for example:

gcloud run deploy t2e-images --source . --region us-central1 --allow-unauthenticated --service-account YOUR_RUNTIME_SA --set-env-vars GCP_PROJECT_ID=PROJECT_ID,GCS_BUCKET=BUCKET_NAME --set-secrets UPLOAD_PASSWORD=t2e-upload-password:latest,AUTH_SECRET=t2e-auth-secret:latest,OPENAI_API_KEY=t2e-openai-key:latest

Omit OPENAI_API_KEY from the deployment command if not using image cleanup. --allow-unauthenticated is necessary for public links; the write API checks authentication. Cloud Run may require additional permissions for building the container.

## Pricing and cautions

Google Cloud Storage Always Free provides 5 GB-months in eligible US regions (plus 5,000 Class A and 50,000 Class B operations), not unlimited free service. Firestore has a separate limited free tier (1 GiB, 50,000 reads/day and 20,000 writes/day for one database). Cloud Run, builds, registry use, networking and operations outside free usage may incur charges. Enable a budget alert. The gpt-image-1-mini model has low-quality 1024px output pricing around $0.005 plus input usage, and is deprecated; the model is overrideable through OPENAI_IMAGE_MODEL. Verify current pricing before using in production.

Files are only shareable by public URL through the app; the bucket remains private. Uploaded files are capped at 8 MB and checked for genuine JPEG/PNG/WebP signatures. The image URL remains stable regardless of filename collisions because each file has a UUID path. AI cleanup can change pictured details and should be reviewed before product use.

This is a starter release, not a live deployed service. Consider adding individual user identities, distributed password-login rate limiting, deletion controls and an audit log before opening team-wide upload access.
