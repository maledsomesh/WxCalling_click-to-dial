# Deploy to Google Cloud Run (all from Cloud Shell)

Follow the parts in order. Each part ends with a **Check**. Do not move on until it passes.
Everything runs in **Google Cloud Shell**: no admin rights are needed on your laptop, and Cloud Run does not
need to be connected to GitHub. You copy the code into Cloud Shell and deploy it with one command.

The Webex token is passed to the service as a plain **environment variable** (no Secret Manager).

---

## Part 0: Gather these first

| Item | Where to get it | Example |
|---|---|---|
| Google Cloud **project ID** | Console, project picker | `my-project-123` |
| **Region** | Pick one close to your users | `europe-west1` |
| Service App **access token** | developer.webex.com, your Service App, after a Control Hub admin has authorised it | `NzE...` |
| **Destination number** | Customer Assist queue or auto attendant number | `+15551234567` |
| **Diagnostics key** (optional) | Make up a long random string. Enables the `/api/diagnostics` check. | |

If the Service App is not ready yet, do Phase 1 and 2 of [SETUP-GUIDE.md](SETUP-GUIDE.md) first.

The access token **expires**. Its expiry is shown where you generate it. See *Replacing the token* below.

---

## Part 1: Prepare the project (Cloud Shell)

Open Cloud Shell (the `>_` icon, top right of the console):

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

**Check:** no errors.

---

## Part 2: Get the code into Cloud Shell

Try this first:

```bash
cd ~
git clone https://github.com/maledsomesh/WxCalling_click-to-dial.git
cd WxCalling_click-to-dial
git checkout main && git pull
ls
```

**Check:** `ls` shows `Dockerfile`, `server`, `public`, `package.json`.

If you get "Repository not found", or it asks for a username and password, the repo is private. Sign in with
**one** of these, then clone again.

**Option A: GitHub CLI** (already in Cloud Shell)

```bash
gh auth login
```

Choose `GitHub.com`, `HTTPS`, `Yes` to authenticate Git, `Login with a web browser`. Open
https://github.com/login/device, enter the code it shows, and approve. Then:

```bash
gh repo clone maledsomesh/WxCalling_click-to-dial && cd WxCalling_click-to-dial
```

**Option B: Personal access token**

1. GitHub: **Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token**.
2. Repository access: only `WxCalling_click-to-dial`. Permission: **Contents: Read-only**. Short expiry.
3. In Cloud Shell: `git clone https://github.com/maledsomesh/WxCalling_click-to-dial.git`. Username is your
   GitHub name; for the password paste the token.

---

## Part 3: Deploy (one command)

Run it from inside the `WxCalling_click-to-dial` folder. The first line asks for the token without showing it
or saving it in your shell history.

```bash
read -s -p "Service App access token: " TOKEN; echo
gcloud run deploy webex-c2c \
  --source . \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --set-env-vars "WEBEX_SERVICE_APP_ACCESS_TOKEN=$TOKEN,C2C_DESTINATION=YOUR_NUMBER,TRUST_PROXY=1,DIAGNOSTICS_KEY=YOUR_KEY"
```

What to expect:

- First time, it asks to create an Artifact Registry repository `cloud-run-source-deploy`. Answer **`Y`**.
- It builds the image from the `Dockerfile` and deploys (a few minutes).
- It ends with `Service URL: https://webex-c2c-....run.app`.

Notes:

- `--allow-unauthenticated` is required: website visitors have no Google login.
- `TRUST_PROXY=1` is required on Cloud Run, otherwise all visitors share one rate limit.
- Optional: `--min-instances 1` avoids a slow first call after idle time (small monthly cost).

**Check:**

```bash
URL=$(gcloud run services describe webex-c2c --region YOUR_REGION --format='value(status.url)')
echo $URL
curl $URL/healthz
```

You want `{"status":"ok"}`.

---

## Part 4: Check the Webex connection

```bash
curl -s -H "X-Diagnostics-Key: YOUR_KEY" $URL/api/diagnostics
```

**Check:** `"ok":true` with all three steps `"ok":true`.

| Failing step | Likely cause |
|---|---|
| Service App access token / Guest token (401) | The token is wrong or expired. Generate a new one and replace it (below). |
| Guest token (403) | Service App is missing the `guest-issuer:read` and `guest-issuer:write` scopes, or is not authorised |
| Call token (400 / 403) | Click-to-call not enabled in Control Hub, click-to-call scope missing, no Customer Assist license, or the destination is not click-to-call enabled |

---

## Part 5: Place a test call

1. Sign in to the **Webex App** as an agent of the destination queue and set yourself available.
2. On your laptop open the `https://...run.app` address.
3. Click **Call us**, enter a name, click **Start call**, allow the microphone.
4. The agent's Webex App rings. Answer and check two-way audio. Try Mute, Hold, Keypad, End call.

```bash
gcloud run services logs read webex-c2c --region YOUR_REGION --limit 20
```

**Check:** a `session created` line appears, and its `ip` is **your own public IP**. If it is a Google
address, `TRUST_PROXY` is not `1`.

---

## Part 6: Put the button on the customer's website

Add the website address to the allow-list. Use `--update-env-vars`, which changes only the variables you name:

```bash
gcloud run services update webex-c2c --region YOUR_REGION \
  --update-env-vars "ALLOWED_ORIGINS=https://www.customer.com"
```

Use the exact website address (no trailing slash). For several addresses use a different separator so the
comma is not misread: `--update-env-vars "^@^ALLOWED_ORIGINS=https://a.com,https://b.com"`.

Then add to the website pages:

```html
<link rel="stylesheet" href="https://YOUR-SERVICE-URL/c2c-widget.css">
<script src="https://YOUR-SERVICE-URL/c2c-widget.js"
        data-api-base="https://YOUR-SERVICE-URL" data-label="Call us" defer></script>
```

---

## Replacing the token (when it expires)

No rebuild needed. This is the only change when the token expires:

```bash
read -s -p "New Service App access token: " TOKEN; echo
gcloud run services update webex-c2c --region YOUR_REGION \
  --update-env-vars "WEBEX_SERVICE_APP_ACCESS_TOKEN=$TOKEN"
```

Signs the token expired: test calls fail, diagnostics shows 401, and the Cloud Run log says
`Service App token rejected or expired: set a new WEBEX_SERVICE_APP_ACCESS_TOKEN`. Write the expiry date
somewhere you will see it.

## Updating after code changes

Cloud Run does not redeploy by itself. In Cloud Shell:

```bash
cd ~/WxCalling_click-to-dial && git pull
gcloud run deploy webex-c2c --source . --region YOUR_REGION
```

Your existing variables are kept. Do **not** use `--set-env-vars` for small changes: it replaces all variables.
Use `--update-env-vars`.

## Security note

Environment variables are visible to anyone who can view the service in the console or with `gcloud`. Keep
that access limited. For production, consider a secret store (see *Production considerations* in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md)).

## Troubleshooting

| Problem | What to do |
|---|---|
| `git clone`: "Repository not found" | The repo is private. Sign in with Option A or B in Part 2. |
| Deploy: "Permission denied" on build or Artifact Registry | Ask a project admin for **Cloud Build Editor**, **Artifact Registry Writer** and **Service Account User** on the project |
| Build fails with a permission error for the build account | Ask a project admin to give the Compute Engine default service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) the role **Cloud Build Service Account** (`roles/cloudbuild.builds.builder`) |
| `--allow-unauthenticated` refused, or the URL returns 403 | An organisation policy blocks public services. An org admin must allow it for this project. |
| "Container failed to start" | Run the logs command in Part 5. The server prints which setting is missing, e.g. `Set C2C_DESTINATION`. |
| Browser: "Origin not allowed" | The website address is missing from `ALLOWED_ORIGINS`, or has a typo or trailing slash |
| "Too many call attempts" | Per-visitor limit reached (5 per 10 minutes). Wait, or raise `RATE_LIMIT_MAX`. |
| Stuck on "Connecting..." | Webex traffic is blocked on the visitor's network. Try another network. |

When opening a Cisco TAC case, include the `trackingId` from the Cloud Run logs.
