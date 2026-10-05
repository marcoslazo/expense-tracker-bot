# Self-hosting runbook

Everything you need to run your own copy of this bot: a Telegram bot, a
Google Sheet it can write to, an LLM API key, and either a local process or
a Cloud Run deployment.

## 1. Create the bot on Telegram

1. Open Telegram and message **@BotFather** (the official bot for creating
   bots).
2. Send `/newbot`, pick a display name, then a username ending in `bot`
   (e.g. `my_expenses_bot`).
3. BotFather returns a token shaped like
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — that's
   `TELEGRAM_BOT_TOKEN`. Never paste it into a chat, issue, or log; if you
   ever do, revoke it immediately from BotFather (`/mybots` → your bot →
   **API Token** → **Revoke current token**).

## 2. Find your `OWNER_TELEGRAM_ID`

The bot only responds to one Telegram user — this locks it down.

1. Message your new bot anything (e.g. "hi").
2. Run, replacing `<YOUR_TOKEN>`:
   ```bash
   curl -s https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. Look for `"from":{"id":...}` in the message you just sent — that number
   (not the bot's own id, which appears with `"is_bot":true`) is your
   `OWNER_TELEGRAM_ID`.
4. If the response has `"error_code":409` about a webhook being active,
   call `.../deleteWebhook` first and repeat step 2. If `"result":[]` comes
   back empty, Telegram already delivered that update once (e.g. you
   already ran the bot) — send another message and retry.

## 3. Pick an LLM provider

The bot supports three interchangeable providers via `LLM_PROVIDER` — only
configure the one you're using.

| `LLM_PROVIDER` | When to use it | Credential |
|---|---|---|
| `claude` | You care about output-schema guarantees and data privacy over cost | `ANTHROPIC_API_KEY` |
| `gemini` | Zero-cost testing (see privacy tradeoff below) | `GEMINI_API_KEY` |
| `ollama` | Local development, no external API calls at all | none — runs on your machine |

**`claude`**: create a key at console.anthropic.com → **API Keys** →
**Create Key**. Shown once — save it immediately.

**`gemini`**: create a key at aistudio.google.com → **Get API key**.
⚠️ On Gemini's free tier, Google may use the content you send (including
human review) to improve its products — see
[ai.google.dev/gemini-api/terms](https://ai.google.dev/gemini-api/terms).
Fine for testing, not for sensitive real data — use `claude` for that.
Optional: `GEMINI_MODEL` (default `gemini-3.1-flash-lite`) if you want a
different model.

**`ollama`**: `brew install ollama` (or install from ollama.com), then
`ollama pull qwen2.5` (or any model you like — set `OLLAMA_MODEL` if it
doesn't match the default). No credential needed; `OLLAMA_BASE_URL`
defaults to `http://localhost:11434`.

## 4. Google Sheets access (`GOOGLE_SERVICE_ACCOUNT_KEY` + `SPREADSHEET_ID`)

1. In console.cloud.google.com, create a project (or reuse one).
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service
   Account**. Default permissions are fine — this account only needs
   access to the one Sheet you share with it, not a project-wide role.
4. Open the new service account → **Keys** → **Add Key → Create new key
   → JSON**. Copy the full JSON content into `GOOGLE_SERVICE_ACCOUNT_KEY`.
5. Note the `client_email` field inside that JSON — you need it next.
6. Create (or reuse) a Google Sheet — the quickest way is to
   **[make a copy of the template](https://docs.google.com/spreadsheets/d/1TV_XWT2u95OiUpnrW2npxongEbXZuyGBtJxNT0ItzWE/copy)**, which already has the
   layout described below — click **Share**, paste that
   `client_email`, grant **Editor** (Google will warn it has no Gmail
   account attached — that's expected for service accounts).
7. `SPREADSHEET_ID` is the segment of the Sheet's URL between `/d/` and
   `/edit`.

**Required spreadsheet layout.** The bot doesn't create tabs — it expects
these to already exist, with these exact (Spanish) names:

| Tab | Used for |
|---|---|
| `Daily Expenses` | Day-to-day expenses (`expenseType` = `diario`) |
| `Extra Expenses` | One-off expenses (`expenseType` = `extraordinario`) |
| `Settings` | Your category list: one category per cell in column A, starting at `A2` (row 1 is a header). The LLM can only pick from this list. |

In both expense tabs, rows 1–2 are free for a title, and row 3 holds the
headers (`Description | Category | Date | Amount | Month | Comments`; the
bot never reads them, so the wording is up to you). The bot always inserts
new rows at **row 4**, pushing older ones down, and writes columns A–E of
each new row: description, category, date, amount, and a formula in E that
renders the date as month-year text — `=IF(ISBLANK(C4);"";TEXT(C4;"mmm-yy"))`
for row 4, with the row number adjusted for each inserted row. Column F
(`Comments`) is left empty for you to fill by hand. Reads (the `/gastos`
reports) cover `A4:D` of each tab. Row 4 should already be formatted the way you
want (date format on C, currency on D) — inserted rows inherit its
formatting. The column-E formula uses `;` as the argument separator, so the
spreadsheet's locale (**File → Settings → Locale**) must be one that uses
`;` — e.g. Argentina, which is what the reference sheet uses.

With everything above in your local `.env` (copied from `.env.example`),
run `npm run dev` to try the bot locally over long polling.

## 5. Voice notes (Google Cloud Speech-to-Text)

Optional — text messages work without this. Voice notes are transcribed
with Cloud Speech-to-Text (`es-AR`), authenticated with the same service
account as Sheets, so there's no extra env var:

1. In the same GCP project, enable **Cloud Speech-to-Text API**
   (**APIs & Services → Library**). The project needs billing enabled,
   even if you stay within the free monthly allowance.
2. Grant the service account the **Cloud Speech Client** role
   (`roles/speech.client`) under **IAM & Admin → IAM**.

Voice notes longer than 60 seconds are rejected before being downloaded,
to keep usage well inside Speech-to-Text's free tier.

## 6. `WEBHOOK_SECRET_TOKEN` / `PORT` (only needed for Docker/Cloud Run)

Not required for `npm run dev` — only `src/run-webhook.ts`, the entrypoint
that runs inside the container, reads these.

- `WEBHOOK_SECRET_TOKEN`: a secret Telegram echoes back on every webhook
  request (`X-Telegram-Bot-Api-Secret-Token` header). This is what makes
  it safe to expose the webhook publicly (`--allow-unauthenticated` on
  Cloud Run) without it being open to anyone — grammY rejects any request
  whose header doesn't match. Generate with `openssl rand -hex 32`.
- `PORT`: defaults to `8080` (what Cloud Run expects); only change it if
  you have a local port conflict.

## 7. Deploying to Cloud Run

This is a narrative writeup of how the reference deployment was set up —
manual `gcloud` commands, not a ready-to-run pipeline. Wire it into your
own CI if you want automation; the steps below work run by hand too.

```bash
export PROJECT_ID="<your-gcp-project-id>"
export REGION="southamerica-east1"   # pick whatever's closest to you
export SERVICE="telegram-expense-tracker"
```

**Enable APIs and create an Artifact Registry repo:**

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com --project="$PROJECT_ID"

gcloud artifacts repositories create telegram-expense-tracker \
  --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
```

**Store secrets in Secret Manager** (paste values interactively, never as
literal command-line text — that would land in your shell history):

```bash
read -rs -p "Paste TELEGRAM_BOT_TOKEN and press Enter: " VALUE; echo
printf '%s' "$VALUE" | gcloud secrets create TELEGRAM_BOT_TOKEN --data-file=- --project="$PROJECT_ID"
unset VALUE

# repeat the same pattern for your chosen LLM API key (e.g. GEMINI_API_KEY)
gcloud secrets create GOOGLE_SERVICE_ACCOUNT_KEY --data-file=/path/to/service-account.json --project="$PROJECT_ID"
openssl rand -hex 32 | gcloud secrets create WEBHOOK_SECRET_TOKEN --data-file=- --project="$PROJECT_ID"
```

**Create a runtime service account** (can only read those secrets, nothing
else):

```bash
gcloud iam service-accounts create expense-bot-runtime \
  --display-name="Expense bot runtime" --project="$PROJECT_ID"

for secret in TELEGRAM_BOT_TOKEN GEMINI_API_KEY GOOGLE_SERVICE_ACCOUNT_KEY WEBHOOK_SECRET_TOKEN; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:expense-bot-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID"
done
```

**Build, push, and deploy:**

```bash
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/telegram-expense-tracker/bot:latest"
docker build -t "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy "$SERVICE" \
  --image="$IMAGE" --region="$REGION" --platform=managed \
  --service-account="expense-bot-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --max-instances=1 \
  --allow-unauthenticated \
  --set-env-vars=LLM_PROVIDER=gemini,OWNER_TELEGRAM_ID=<your-id>,SPREADSHEET_ID=<your-sheet-id> \
  --set-secrets=TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_SERVICE_ACCOUNT_KEY=GOOGLE_SERVICE_ACCOUNT_KEY:latest,WEBHOOK_SECRET_TOKEN=WEBHOOK_SECRET_TOKEN:latest
```

`--max-instances=1` is deliberate, not a cost optimization: the bot keeps
one pending expense per chat in an in-memory `Map`, which only stays
correct with exactly one live process. `--allow-unauthenticated` is safe
here specifically because `WEBHOOK_SECRET_TOKEN` (step 6) gates every
request — grammY validates it before any handler runs, so Telegram is the
only caller that can reach the bot logic even though the URL itself is
public.

**Register the webhook** once you have the service URL:

```bash
gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)'
# then, with that URL as CLOUD_RUN_URL:
TELEGRAM_BOT_TOKEN=<your-token> WEBHOOK_SECRET_TOKEN=<your-secret> CLOUD_RUN_URL=<the-url> \
  ./scripts/set-webhook.sh
```

Verify with `curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` —
check `"url"` matches your service and `"last_error_message"` is empty.

## 8. Running it locally with Docker instead

If you'd rather not deploy to GCP at all: `docker compose up` builds and
runs the container locally using `docker-compose.yml`, with your local
`.env` mounted in. This runs in webhook mode, so you'd need something like
`ngrok` to give Telegram a public URL to call — for pure local development,
`npm run dev` (long polling, no public URL needed) is simpler.

## 9. Logs and troubleshooting

**Reading logs** (Cloud Run):

```bash
gcloud run services logs read "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --limit=50
gcloud run services logs tail "$SERVICE" --region="$REGION" --project="$PROJECT_ID"   # streaming
```

The bot's own log messages are in Spanish (see the language note in the
README), so the table quotes them verbatim — search for these exact strings —
with a translation alongside.

| Log line (verbatim) | Translation | Meaning |
|---|---|---|
| `Servidor webhook escuchando en el puerto 8080 — proveedor LLM: gemini, ...` | Webhook server listening on port 8080 — LLM provider: gemini | A new instance started (deploy, or Cloud Run recycled the process) |
| `POST 200 .../webhook` | — | Telegram sent an update and the bot handled it without crashing |
| `POST 401 .../webhook` | — | The `secret_token` Telegram sent doesn't match `WEBHOOK_SECRET_TOKEN` — check for a trailing newline in the secret (see below), or that the webhook wasn't re-registered with a different value |
| `Error procesando el mensaje: ...` | Error processing the message | The LLM call or parsing failed — the bot already told the user it couldn't process that message |
| `Error procesando la nota de voz: ...` | Error processing the voice note | Downloading or transcribing a voice note failed — check that Speech-to-Text is enabled and the service account has its role ([step 5](#5-voice-notes-google-cloud-speech-to-text)) |
| `Error guardando en la planilla: ...` | Error saving to the spreadsheet | `appendExpense` failed — check the service account's permissions on the Sheet, `SPREADSHEET_ID`, and that the expected tabs exist ([step 4](#4-google-sheets-access-google_service_account_key--spreadsheet_id)) |
| `Timeout esperando la respuesta del webhook ...` | Timed out waiting for the webhook response | A handler took longer than grammY's 10-second webhook timeout (usually a slow LLM call); the bot still answers Telegram with a 200 so it doesn't retry, the update keeps processing in the background, and the user still gets a reply — only worth a look if it happens often |

**Secrets with a trailing newline**: if you pasted a secret value followed
by Enter before Ctrl+D during `gcloud secrets create --data-file=-`, that
newline gets stored as part of the value — it can silently break an exact
string comparison (this is exactly what causes `POST 401` above). Detect
it without ever printing the value:

```bash
raw=$(gcloud secrets versions access latest --secret=NAME --project="$PROJECT_ID" | wc -c)
stripped=$(gcloud secrets versions access latest --secret=NAME --project="$PROJECT_ID")
echo "raw=$raw stripped=$(printf '%s' "$stripped" | wc -c)"
# if they differ, there's an extra trailing byte
```

Fix by adding a clean version and forcing a new revision (`--update-secrets`
with `:latest` does **not** re-resolve on an already-running revision):

```bash
VAL=$(gcloud secrets versions access latest --secret=NAME --project="$PROJECT_ID")
printf '%s' "$VAL" | gcloud secrets versions add NAME --data-file=- --project="$PROJECT_ID"
gcloud run services update "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --update-secrets=NAME=NAME:latest
```

**If `api.telegram.org` is unreachable from your network**: some ISPs
block or throttle specific Telegram IP ranges (DNS resolves fine, but the
TCP connection to `api.telegram.org` just hangs) — this is what originally
motivated deploying to Cloud Run instead of running the bot from a home
network. If you hit this while running things locally (e.g. registering
the webhook from your machine), `docker-compose.warp.yml` routes traffic
through a disposable Cloudflare WARP tunnel (via `gluetun` + `wgcf`) as a
workaround — it's optional, only relevant if you actually hit this kind of
block:

```bash
./scripts/generate-warp-profile.sh   # one-time: generates a WireGuard profile into ./warp (gitignored)
docker compose -f docker-compose.yml -f docker-compose.warp.yml up -d gluetun
docker compose exec gluetun wget -qO- https://www.cloudflare.com/cdn-cgi/trace   # look for warp=on
# run whatever needs the tunnel — e.g. scripts/set-webhook.sh — through gluetun's network,
# then: docker compose -f docker-compose.yml -f docker-compose.warp.yml down
```

To run the bot itself through the tunnel in one command, `./scripts/dev-warp.sh
[log-level]` does all of the above: it brings up `gluetun`, waits until it's
healthy, then rebuilds and starts the bot in long-polling mode inside the
tunnel (forcing `LLM_PROVIDER=gemini`, since a host-side Ollama isn't
reachable from the tunnel's network namespace). Ctrl+C tears everything
down. Note that `generate-warp-profile.sh` was written for macOS (it uses
BSD `sed -i ''`); on Linux, drop the `''` argument.
