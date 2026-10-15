# Payment Health Dashboard

A Spring Boot microservice (Java 21, Spring Boot 4.1) that monitors the
health of the payment pipeline's Spring Boot services on OpenShift and shows
them on one dashboard.

It polls each service's **Spring Boot Actuator** endpoints itself, so the
browser never calls your services directly and bearer tokens never reach it:

- `GET {baseUrl}/actuator/health`: overall status plus components (db, jms,
  diskSpace, custom indicators…)
- `GET {baseUrl}/actuator/health/liveness` and `/readiness`: Kubernetes probe
  groups (optional per service)
- `GET {baseUrl}/actuator/info`: build version, git commit, Java version

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

## Run locally

```bash
./mvnw spring-boot:run
```

Open http://localhost:8080. On an empty dashboard, click **Load demo
pipeline** to add eight sample services. This app serves them under `/demo/…`,
and they cycle through scripted incidents every six minutes. Set
`dashboard.demo.enabled=false` to turn the demo endpoints off; the OpenShift
ConfigMap does this.

Run the tests with `./mvnw test`.

## Adding services

There are two ways to add services, and you can use both:

1. **In configuration (recommended for OpenShift).** List services under
   `dashboard.services` in `application.yaml` or the ConfigMap. They show as
   read-only in the UI, and the list is version-controlled with your manifests.
2. **In the UI.** Click **Add service**. These are saved to
   `dashboard.store-file` (`data/services.json` by default, which is
   git-ignored).

```yaml
dashboard:
  services:
    - name: payment-transformer
      stage: Transformation          # groups cards and orders the pipeline strip
      environment: prod
      namespace: payments-prod
      base-url: http://payment-transformer.payments-prod.svc:8081
      health-path: /actuator/health  # default
      info-path: /actuator/info      # default; "" to skip
      check-probes: true             # default
      slow-threshold-ms: 1000        # default
      console-url: https://console-openshift-console.apps.<cluster>/k8s/ns/payments-prod/deployments/payment-transformer
      auth-token: ${PAYMENT_TRANSFORMER_TOKEN:}   # only if actuator is secured
```

For the base URL, prefer the in-cluster service address
(`http://<service>.<namespace>.svc:<port>`). Then the management port doesn't
need a Route. If Actuator runs on a separate management port, use that port.

Recommended settings on each monitored service:

```properties
management.endpoints.web.exposure.include=health,info
management.endpoint.health.show-components=always
management.endpoint.health.probes.enabled=true
management.info.build.enabled=true
management.info.git.enabled=true
```

## Configuration

| Property | Default | |
|---|---|---|
| `dashboard.poll-interval` | `15s` | How often every service is polled |
| `dashboard.timeout` | `5s` | Connect/read timeout per actuator call |
| `dashboard.history-length` | `60` | Checks kept per service for the timeline |
| `dashboard.store-file` | `data/services.json` | Where services added in the UI are saved |
| `dashboard.ssl-bundle` | *(blank)* | Name of a `spring.ssl.bundle.*` whose trust material is used for `https://` calls; blank uses the JVM truststore |
| `dashboard.demo.enabled` | `true` | Serve the `/demo` endpoints and the **Load demo pipeline** button |

To trust an internal CA (for example the cluster's service CA or the ingress
CA), define a PEM SSL bundle and point the dashboard at it:

```yaml
spring.ssl.bundle.pem.cluster-ca.truststore.certificate: file:/etc/pki/service-ca/service-ca.crt
dashboard.ssl-bundle: cluster-ca
```

Outbound calls use the standard `https.proxyHost` / `http.nonProxyHosts`
JVM proxy settings if they are set.

Check results and the status-change log are kept in memory. They rebuild
within one poll interval after a restart, so run a single replica.

## Deploying to OpenShift

`openshift/` contains:

| File | |
|---|---|
| `configmap.yaml` | Services to monitor, layered over the built-in config; plus a ConfigMap OpenShift fills with the service CA |
| `secret.yaml` | Bearer tokens, exposed as env vars and referenced from the ConfigMap as `${NAME:}` |
| `deployment.yaml` | Deployment (liveness/readiness/startup probes on its own actuator, non-root), Service, edge-TLS Route |
| `monitoring.yaml` | ServiceMonitor and PrometheusRule alerts (needs user-workload monitoring) |
| `kustomization.yaml` | Sets namespace and image for `oc apply -k` |

```bash
oc new-project payments-monitoring
# Build the image in-cluster from this directory, using the Dockerfile
oc new-build --name payment-health-dashboard --binary --strategy docker
oc start-build payment-health-dashboard --from-dir . --follow
# Edit openshift/configmap.yaml with your services, then:
oc apply -k openshift/
oc get route payment-health-dashboard
```

If your payment namespaces use NetworkPolicies, allow ingress from the
`payments-monitoring` namespace to the services' management port.

### Alerts and metrics

`/actuator/prometheus` exports one series per monitored service, labelled
`service`, `stage`, `namespace` and `environment`:

- `payment_service_up`: 1 when up or degraded, 0 when down
- `payment_service_degraded`: 1 when degraded
- `payment_service_health_latency_milliseconds`: latest health-call latency

`monitoring.yaml` alerts when a service has been down for 2 minutes, degraded
for 10 minutes, or when the dashboard stops reporting.

## API

| Method & path | |
|---|---|
| `GET /api/health` | Dashboard snapshot: every service, its latest check and history, recent status changes |
| `POST /api/health/check` | Check every service now |
| `POST /api/health/check/{id}` | Check one service now |
| `GET/POST /api/services`, `PUT/DELETE /api/services/{id}` | Manage UI-added services (config services return 409) |
| `POST /api/services/demo` | Add the demo pipeline (when demo is enabled) |
