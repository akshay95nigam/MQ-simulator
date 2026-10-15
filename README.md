# MQ Payment Simulator

A small local tool for simulating payment-processor messages over IBM MQ.
Save named queue connections and message templates, fill in per-send
variables, and put messages onto a real IBM MQ queue — or use **Dry Run**
to exercise the whole flow without touching MQ at all.

## Features

- **Saved queues** — name, client, queue manager, host/port, channel, queue
  name, optional TLS cipher spec and credentials. Stored in `data/queues.json`.
- **Saved messages** — reusable message bodies with `{{variable}}`
  placeholders (amount, account, reference, etc.), filled in per send.
  Stored in `data/messages.json`.
- **Compose & send** — pick a saved queue + saved message (or write an
  ad-hoc body), fill in variables, and send. **Dry Run** is on by default so
  nothing goes to a real queue manager until you switch it off.
- **Send history** — every send (simulated, successful, or failed) is logged
  with the MQ reason code when available. Stored in `data/history.json`.

## Setup

```bash
npm install
npm start
```

Then open http://localhost:4173.

By default the app works fully in **Dry Run** mode with no extra setup —
useful for building out queue/message profiles before you have MQ access.

### Enabling real MQ sends

Real sends use the official [`ibmmq`](https://github.com/ibm-messaging/mq-mqi-nodejs)
Node client, which wraps IBM's MQI native library. This needs the IBM MQ
client redistributable libraries on your machine before `npm install` can
build the native addon:

1. Download the **IBM MQ Redistributable Client** for your OS from IBM
   (Fix Central or the IBM MQ downloads page).
2. Extract it somewhere and set `MQ_INSTALLATION_PATH` (see the `ibmmq`
   package README for OS-specific env vars) before running `npm install`.
3. Re-run `npm install` so the native addon builds against it.
4. Restart the app — the status pill in the top right will read
   **"MQ client ready"** once it can load the module.

If the module isn't available, the app still runs and every feature works
except real sends — Dry Run continues to work, and the UI tells you why.

## Data & secrets

Saved queue profiles can include a channel user ID/password for MQ
connection authentication. These live in `data/*.json` on disk, which is
git-ignored by default (`.gitignore`) — do not commit real credentials or
production connection details if you put this project under version
control. Treat `data/` like any other local secrets file.

## Notes on "clients"

Both saved queues and saved messages have an optional **Client name**
field, so you can tag which simulated client (e.g. "Client A", "Client B")
a queue or message belongs to — handy when testing multiple upstream
clients sending to the same payment processor.

## Service health dashboard

The health dashboard for the payment pipeline's Spring Boot services is a
separate Spring Boot microservice in [`health-dashboard/`](health-dashboard/README.md).
