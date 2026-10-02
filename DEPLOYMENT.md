# Persistent Storage and Free Hosting

## Local development

Run `npm install` once, then `npm start`. Reports and uploaded photos are saved under `data/` and `uploads/reports/`, so they survive server restarts on this computer. Both folders are ignored by Git.

## Supabase setup

1. Create a free Supabase project.
2. Open the Supabase SQL Editor and run [`supabase/schema.sql`](supabase/schema.sql).
3. In Project Settings, copy the project URL and the `service_role` key. Keep the service role key private; never put it in browser code or commit it.

## Render hosting

1. Push this project to a GitHub repository. Git is not currently available in this workspace, so the repository connection must be created from a computer with Git installed or by uploading the project through GitHub.
2. In Render, choose **New > Blueprint**, connect the GitHub repository, and apply `render.yaml`.
3. Enter `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a long random `ADMIN_SECRET` when Render prompts for them.
4. After the first deploy, open the Render service URL. Future pushes to the connected branch are deployed automatically.

The Render free service has no persistent disk, which is why the hosted app uses Supabase for both report records and private photo storage. Free hosting has limits: Render may spin down an idle service, and Supabase free projects can pause after extended inactivity. Requests can be slower while either service wakes up.

The local YOLO/PyTorch photo analyzer is not installed on the free Render service because its model and memory requirements are too large to promise on that tier. With the blueprint's `AI_ANALYSIS_OPTIONAL=true`, reports are still saved when the analyzer is unavailable, but cloud reports may have no detected-object analysis. The analyzer remains available when running locally with the Python environment and models installed.

## Android APK

The Android wrapper opens the deployed web app, so report pages and future site updates come from the configured HTTPS URL. Run the **Build Android APK** workflow in GitHub Actions and provide the current app URL. The workflow uploads a debug-signed APK as an artifact; download it from the completed workflow run and install it on Android. Debug builds are for direct testing and sideloading, not Play Store publication.

The current Cloudflare quick tunnel is temporary. Use the stable Render service URL for an APK intended to keep working. A new APK is only needed when changing the wrapper itself; web app changes appear through the hosted URL.
