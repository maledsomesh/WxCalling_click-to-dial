# Deploy to Google Cloud Run (from Cloud Shell + console)

Follow the parts in order. Each part ends with a **Check**. Do not move on until the check passes.
No admin rights are needed on your laptop: everything runs in Cloud Shell or the Google Cloud console.

---

## Part 0: Gather these first

| Item | Where to get it | Example |
|---|---|---|
| Google Cloud **project ID** | Console, project picker | `my-project-123` |
| **Region** | Pick one close to your users | `europe-west1` |
| Service App **Client ID** | developer.webex.com, My Webex Apps, your Service App | `C1234...` |
| Service App **Client Secret** | Same page (shown once when created) | `abcd...` |
| Service App **Refresh token** | Developer Portal, after the admin has authorised the Service App in Control Hub | `NzE...` |
| **Destination number** | Number of your Customer Assist queue or auto attendant | `+15551234567` |

If the Service App is not ready yet, finish Phase 1 and 2 of [SETUP-GUIDE.md](SETUP-GUIDE.md) first.

---

## Part 1: Prepare the project (Cloud Shell)

Open Cloud Shell (the `>_` icon, top right of the console) and run:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com
```

**Check:** the command ends without errors (it can take a minute).

---

## Part 2: Store the Webex secrets (Cloud Shell)

Each command asks you to paste a value. Nothing is shown on screen or saved in shell history.

```bash
read -s -p "Webex Client Secret: " V; echo; printf '%s' "$V" | gcloud secrets create webex-client-secret --data-file=-; unset V
read -s -p "Webex Refresh Token: " V; echo; printf '%s' "$V" | gcloud secrets create webex-refresh-token --data-file=-; unset V
read -s -p "Diagnostics key (make up a long random string): " V; echo; printf '%s' "$V" | gcloud secrets create c2c-diagnostics-key --data-file=-; unset V
```

Write down your diagnostics key. You need it in Part 5.

Now let the Cloud Run service read these secrets:

```bash
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
for S in webex-client-secret webex-refresh-token c2c-diagnostics-key; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done
```

**Check:** `gcloud secrets list` shows the three secrets.

---

## Part 3: Create the service (console)

1. Open **Cloud Run**, then **Deploy container**, then **Web service**.
2. Select **Continuous deployment from a repository**, then **Set up with Cloud Build**.
3. Authorise GitHub when asked, and pick `maledsomesh/WxCalling_click-to-dial`.
4. Branch: `main`.
5. Build type: **Dockerfile**. Source location: `/Dockerfile`. Click **Save**.
6. Fill in the service settings:

   | Setting | Value |
   |---|---|
   | Service name | `webex-c2c` |
   | Region | your region from Part 0 |
   | Authentication | **Allow public access** (website visitors have no Google login) |
   | Billing | Request-based |
   | Minimum instances | `1` avoids a slow first call (small monthly cost). `0` is fine for a lab. |

7. Expand **Container(s), Volumes, Networking, Security**. Leave the port at its default.
8. On the **Variables & secrets** tab, under **Environment variables**, add:

   | Name | Value |
   |---|---|
   | `WEBEX_CLIENT_ID` | your Client ID |
   | `C2C_DESTINATION` | your destination number |
   | `TRUST_PROXY` | `1` |

   Leave `ALLOWED_ORIGINS` out for now (Part 6).

9. Under **Secrets**, click **Reference a secret** three times. For each, set **Exposed as** to **Environment variable**, and version `latest`:

   | Secret | Environment variable name |
   |---|---|
   | `webex-client-secret` | `WEBEX_CLIENT_SECRET` |
   | `webex-refresh-token` | `WEBEX_REFRESH_TOKEN` |
   | `c2c-diagnostics-key` | `DIAGNOSTICS_KEY` |

10. Click **Create** and wait for the build and deploy (a few minutes).

**Check:** the service page shows a green tick and a URL ending in `.run.app`.

---

## Part 4: Check that the service is up (Cloud Shell)

```bash
URL=$(gcloud run services describe webex-c2c --region YOUR_REGION --format='value(status.url)')
echo $URL
curl $URL/healthz
```

**Check:** the output is `{"status":"ok"}`.

---

## Part 5: Check the Webex connection (Cloud Shell)

```bash
read -s -p "Diagnostics key: " K; echo
curl -s -H "X-Diagnostics-Key: $K" $URL/api/diagnostics
```

**Check:** you see `"ok":true` and three steps that all say `"ok":true`.

If a step fails, read its `error` message:

| Failing step | Likely cause |
|---|---|
| Service App access token (401) | Wrong client id / secret / refresh token, or the Service App is not authorised in Control Hub |
| Guest token (403) | Service App is missing the `guest-issuer:read` and `guest-issuer:write` scopes |
| Call token (400 / 403) | Click-to-call is not enabled in Control Hub, the click-to-call scope is missing, there is no Customer Assist license, or `C2C_DESTINATION` is not click-to-call enabled |

After fixing it on the Webex side, run the same `curl` again. For a changed secret or variable, use **Edit & deploy new revision** in the console.

---

## Part 6: Place a test call

1. Sign in to the **Webex App** as an agent of the destination queue and set yourself available.
2. On your laptop, open the `https://...run.app` address from Part 4.
3. Click **Call us**, enter a name, click **Start call**, and allow the microphone.
4. The agent's Webex App rings. Answer it and check you can hear each other both ways.
5. Try **Mute**, **Hold**, **Keypad** and **End call**.

Then check the logs in Cloud Shell:

```bash
gcloud run services logs read webex-c2c --region YOUR_REGION --limit 20
```

**Check:** a `session created` line appears, and its `ip` is your own public IP. If the `ip` is a Google address, `TRUST_PROXY` is not set to `1`.

---

## Part 7: Put the button on the customer's website

1. Console, Cloud Run, `webex-c2c`, **Edit & deploy new revision**, add the variable
   `ALLOWED_ORIGINS` = `https://www.customer.com` (the exact website address, no trailing slash).
   Several addresses can be separated by commas. Deploy.
2. Add these lines to the website pages:

   ```html
   <link rel="stylesheet" href="https://YOUR-SERVICE-URL/c2c-widget.css">
   <script src="https://YOUR-SERVICE-URL/c2c-widget.js"
           data-api-base="https://YOUR-SERVICE-URL" data-label="Call us" defer></script>
   ```

**Check:** the button appears on the website and a test call connects.

---

## What happens when you change the code

The service rebuilds and redeploys on every push to `main`. Only merge finished work to `main`.

## Troubleshooting

| Problem | What to do |
|---|---|
| Build fails with "no Dockerfile" | Check the branch is `main` and the build type is **Dockerfile** at `/Dockerfile` |
| "Allow public access" is greyed out or refused | An organisation policy blocks public services. An org admin must allow it for this project. |
| Service shows "Container failed to start" | Open the revision's **Logs**. The server prints which setting is missing, for example `Set C2C_DESTINATION`. |
| Browser shows "Origin not allowed" | The website address is not in `ALLOWED_ORIGINS`, or has a typo or trailing slash |
| Call fails with "Too many call attempts" | The per-visitor limit was reached (5 per 10 minutes). Wait, or raise `RATE_LIMIT_MAX`. |
| Stuck on "Connecting..." | Webex traffic is blocked on the visitor's network. Try another network. |

When you open a Cisco TAC case, include the `trackingId` from the Cloud Run logs.
