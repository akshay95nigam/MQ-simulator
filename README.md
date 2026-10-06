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

Open http://localhost:4173/health.html (or use the **Service health** link in
the top bar) to monitor the Spring Boot microservices in the payment
pipeline running on OpenShift.

The server polls each service's **Spring Boot Actuator** endpoints, not the
browser. This avoids CORS problems, and bearer tokens stay on the server:

- `GET {baseUrl}/actuator/health`: overall status plus components (db, jms,
  diskSpace, custom indicators…)
- `GET {baseUrl}/actuator/health/liveness` and `/readiness`: Kubernetes probe
  groups (optional per service)
- `GET {baseUrl}/actuator/info`: build version, git commit, Java version

Each service is shown as:

| Status | Meaning |
|---|---|
| **Up** | Actuator reports `UP`, all components and probes `UP`, response under the slow threshold |
| **Degraded** | Actuator reports `UP` but a component or probe isn't, or the response was slow |
| **Down** | Actuator reports `DOWN`/`OUT_OF_SERVICE`, or the endpoint is unreachable, times out, or returns a non-actuator response (e.g. an OpenShift router 503 when no pods are ready) |

The page shows a summary row, a pipeline strip (worst status per stage, in
message-flow order: Intake → Validation → Transformation → Enrichment →
Routing → Delivery → Acknowledgement), one card per service with its recent
check timeline, and a log of status changes. Click a card for component
details, probe states and version info.

Click **Load demo pipeline** on an empty dashboard to add eight sample
services. This app serves them under `/demo/…`, and they cycle through
scripted incidents every six minutes, so you can see the dashboard working
before you point it at the cluster.

### Adding your services

For each service, add its **base URL**: the OpenShift route
(`https://payment-transformer-payments-prod.apps.<cluster>`), or the
in-cluster service URL (`http://payment-transformer.payments-prod.svc:8080`)
if this app runs inside the cluster. If Actuator runs on a separate
management port, use that port.

Recommended Spring Boot settings on each service:

```properties
management.endpoints.web.exposure.include=health,info
management.endpoint.health.show-components=always
management.endpoint.health.probes.enabled=true
management.info.build.enabled=true
management.info.git.enabled=true
```

If Actuator is secured, set a bearer token on the service. It's stored in
`data/services.json` (git-ignored) and never sent back to the browser.

### Configuration

| Env var | Default | |
|---|---|---|
| `HEALTH_POLL_INTERVAL_MS` | `15000` | How often every service is polled |
| `HEALTH_TIMEOUT_MS` | `5000` | Per-request timeout |
| `NODE_EXTRA_CA_CERTS` | — | Path to your cluster/ingress CA bundle if routes use an internal CA |

Check results and the status-change log are kept in memory. They rebuild
within one poll interval after a restart.
