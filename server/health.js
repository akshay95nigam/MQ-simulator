'use strict';

// Health monitoring for the Spring Boot microservices in the payment
// pipeline. Services are polled server-side (no browser CORS issues, and
// bearer tokens never leave the server) via their Spring Boot Actuator
// endpoints: /actuator/health, optionally the Kubernetes probe groups
// (/actuator/health/liveness, /actuator/health/readiness) and /actuator/info.

const store = require('./store');

const COLLECTION = 'services';
const POLL_INTERVAL_MS = Number(process.env.HEALTH_POLL_INTERVAL_MS) || 15000;
const REQUEST_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS) || 5000;
const HISTORY_LENGTH = 60;
const MAX_EVENTS = 200;

// id -> latest result + rolling history. In memory only: it rebuilds within
// one poll interval after a restart.
const results = new Map();
const events = [];
let lastRunAt = null;
let running = false;

const DEFAULTS = {
  healthPath: '/actuator/health',
  infoPath: '/actuator/info',
  checkProbes: true,
  slowThresholdMs: 1000,
  enabled: true,
};

// ---------- Service records ----------

function withDefaults(svc) {
  return { ...DEFAULTS, ...svc };
}

// Never send the stored token back to the browser.
function sanitize(svc) {
  const { authToken, ...rest } = withDefaults(svc);
  return { ...rest, hasAuthToken: !!authToken };
}

function normalizeInput(body, existing) {
  const record = {
    name: String(body.name || '').trim(),
    stage: String(body.stage || '').trim(),
    environment: String(body.environment || '').trim(),
    namespace: String(body.namespace || '').trim(),
    description: String(body.description || '').trim(),
    baseUrl: String(body.baseUrl || '').trim().replace(/\/+$/, ''),
    healthPath: String(body.healthPath || DEFAULTS.healthPath).trim(),
    infoPath: String(body.infoPath ?? DEFAULTS.infoPath).trim(),
    consoleUrl: String(body.consoleUrl || '').trim(),
    checkProbes: body.checkProbes !== undefined ? !!body.checkProbes : DEFAULTS.checkProbes,
    slowThresholdMs: Number(body.slowThresholdMs) || DEFAULTS.slowThresholdMs,
    enabled: body.enabled !== undefined ? !!body.enabled : DEFAULTS.enabled,
  };
  // Blank token on edit keeps the stored one unless explicitly cleared.
  if (body.authToken) record.authToken = String(body.authToken);
  else if (body.clearAuthToken) record.authToken = '';
  else if (existing) record.authToken = existing.authToken || '';
  return record;
}

function validate(record) {
  if (!record.name) return 'Name is required.';
  if (!/^https?:\/\//i.test(record.baseUrl)) return 'Base URL must start with http:// or https://';
  if (!record.healthPath.startsWith('/')) return 'Health path must start with /';
  if (record.infoPath && !record.infoPath.startsWith('/')) return 'Info path must start with /';
  return null;
}

// ---------- Checking ----------

async function fetchJson(url, token) {
  const headers = { Accept: 'application/vnd.spring-boot.actuator.v3+json, application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = Date.now();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const latencyMs = Date.now() - started;
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body, e.g. an OpenShift router error page */ }
  return { httpStatus: res.status, body, latencyMs };
}

function describeError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Timed out after ${REQUEST_TIMEOUT_MS} ms`;
  // Dual-stack connects fail with an AggregateError that carries the codes in .errors.
  let cause = err.cause;
  if (cause && !cause.code && Array.isArray(cause.errors) && cause.errors[0]) cause = cause.errors[0];
  if (cause && cause.code) {
    const hints = {
      ENOTFOUND: 'DNS lookup failed — check the route/host name',
      ECONNREFUSED: 'Connection refused — pod down or wrong port',
      ECONNRESET: 'Connection reset by peer',
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS: unknown certificate issuer — set NODE_EXTRA_CA_CERTS to your cluster CA',
      SELF_SIGNED_CERT_IN_CHAIN: 'TLS: self-signed certificate in chain — set NODE_EXTRA_CA_CERTS to your cluster CA',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS: self-signed certificate — set NODE_EXTRA_CA_CERTS to your cluster CA',
      CERT_HAS_EXPIRED: 'TLS: certificate has expired',
    };
    return hints[cause.code] || `${cause.code}: ${cause.message || err.message}`;
  }
  return cause && cause.message ? `${err.message}: ${cause.message}` : err.message;
}

// Spring Boot 2.2+ uses "components"; older versions use "details".
// Nested composites (e.g. several datasources under "db") are flattened.
function flattenComponents(node, prefix = '') {
  const children = node && (node.components || node.details);
  if (!children || typeof children !== 'object') return [];
  const out = [];
  for (const [name, child] of Object.entries(children)) {
    if (!child || typeof child !== 'object' || !child.status) continue;
    const key = prefix ? `${prefix}.${name}` : name;
    const nested = flattenComponents(child, key);
    if (nested.length) out.push(...nested);
    else out.push({ name: key, status: String(child.status).toUpperCase(), details: child.details || null });
  }
  return out;
}

async function probe(url, token) {
  try {
    const { httpStatus, body } = await fetchJson(url, token);
    if (body && body.status) return String(body.status).toUpperCase();
    return httpStatus === 404 ? 'NOT_EXPOSED' : `HTTP ${httpStatus}`;
  } catch (err) {
    return 'UNREACHABLE';
  }
}

async function checkService(svc) {
  svc = withDefaults(svc);
  const token = svc.authToken || null;
  const checkedAt = new Date().toISOString();
  const result = {
    checkedAt,
    status: 'unknown',
    springStatus: null,
    httpStatus: null,
    latencyMs: null,
    components: [],
    probes: null,
    info: null,
    error: null,
    reasons: [],
  };

  try {
    const { httpStatus, body, latencyMs } = await fetchJson(svc.baseUrl + svc.healthPath, token);
    result.httpStatus = httpStatus;
    result.latencyMs = latencyMs;

    if (!body || !body.status) {
      result.status = 'down';
      result.error = httpStatus === 401 || httpStatus === 403
        ? `HTTP ${httpStatus} — health endpoint requires auth; add a bearer token`
        : httpStatus === 503
          ? 'HTTP 503 with no health body — OpenShift route has no ready pods behind it'
          : `HTTP ${httpStatus} — response is not an actuator health document`;
    } else {
      result.springStatus = String(body.status).toUpperCase();
      result.components = flattenComponents(body);
    }
  } catch (err) {
    result.status = 'down';
    result.error = describeError(err);
  }

  if (result.springStatus) {
    const extra = [];
    if (svc.checkProbes) extra.push(
      Promise.all([
        probe(`${svc.baseUrl}${svc.healthPath}/liveness`, token),
        probe(`${svc.baseUrl}${svc.healthPath}/readiness`, token),
      ]).then(([liveness, readiness]) => { result.probes = { liveness, readiness }; })
    );
    if (svc.infoPath) extra.push(
      fetchJson(svc.baseUrl + svc.infoPath, token)
        .then(({ body }) => { if (body && typeof body === 'object') result.info = summarizeInfo(body); })
        .catch(() => {})
    );
    await Promise.all(extra);

    const s = result.springStatus;
    if (s === 'DOWN' || s === 'OUT_OF_SERVICE') {
      result.status = 'down';
      const failing = result.components.filter((c) => c.status !== 'UP').map((c) => c.name);
      result.reasons.push(failing.length ? `Failing: ${failing.join(', ')}` : `Service reports ${s}`);
    } else if (s === 'UP') {
      result.status = 'up';
      const notUp = result.components.filter((c) => c.status !== 'UP');
      if (notUp.length) result.reasons.push(`Components not UP: ${notUp.map((c) => `${c.name} (${c.status})`).join(', ')}`);
      if (result.probes && result.probes.readiness !== 'UP' && result.probes.readiness !== 'NOT_EXPOSED') {
        result.reasons.push(`Readiness is ${result.probes.readiness} — not receiving traffic`);
      }
      if (result.probes && result.probes.liveness !== 'UP' && result.probes.liveness !== 'NOT_EXPOSED') {
        result.reasons.push(`Liveness is ${result.probes.liveness} — pod may be restarted`);
      }
      if (result.latencyMs > svc.slowThresholdMs) {
        result.reasons.push(`Slow response: ${result.latencyMs} ms (threshold ${svc.slowThresholdMs} ms)`);
      }
      if (result.reasons.length) result.status = 'degraded';
    } else {
      result.status = 'unknown';
      result.reasons.push(`Service reports ${s}`);
    }
  }

  return result;
}

function summarizeInfo(info) {
  const build = info.build || {};
  const git = info.git || {};
  const commit = git.commit || {};
  return {
    version: build.version || (info.app && info.app.version) || null,
    artifact: build.artifact || build.name || null,
    buildTime: build.time || null,
    commit: typeof commit.id === 'string' ? commit.id.slice(0, 7) : (commit.id && commit.id.abbrev) || null,
    branch: git.branch || null,
    java: (info.java && info.java.version) || null,
  };
}

function record(svc, result) {
  const prev = results.get(svc.id);
  const history = prev ? prev.history.slice(-(HISTORY_LENGTH - 1)) : [];
  history.push({ at: result.checkedAt, status: result.status, latencyMs: result.latencyMs });

  // Track when the current status began, and log transitions.
  let since = result.checkedAt;
  if (prev && prev.status === result.status) since = prev.since;
  else if (prev) {
    events.unshift({
      at: result.checkedAt,
      serviceId: svc.id,
      serviceName: svc.name,
      from: prev.status,
      to: result.status,
      detail: result.error || result.reasons[0] || null,
    });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  results.set(svc.id, { ...result, since, history });
}

async function checkAll() {
  if (running) return;
  running = true;
  try {
    const services = store.list(COLLECTION).filter((s) => withDefaults(s).enabled);
    await Promise.all(services.map(async (svc) => record(svc, await checkService(svc))));
    lastRunAt = new Date().toISOString();
  } finally {
    running = false;
  }
}

async function checkOne(id) {
  const svc = store.get(COLLECTION, id);
  if (!svc) return null;
  record(svc, await checkService(svc));
  return results.get(id);
}

function forget(id) {
  results.delete(id);
}

function snapshot() {
  const services = store.list(COLLECTION).map((svc) => ({
    service: sanitize(svc),
    health: results.get(svc.id) || null,
  }));
  return { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: REQUEST_TIMEOUT_MS, lastRunAt, services, events: events.slice(0, 50) };
}

function start() {
  checkAll().catch((err) => console.error('Health check run failed:', err));
  setInterval(() => checkAll().catch((err) => console.error('Health check run failed:', err)), POLL_INTERVAL_MS).unref();
}

module.exports = {
  COLLECTION,
  sanitize,
  normalizeInput,
  validate,
  checkAll,
  checkOne,
  forget,
  snapshot,
  start,
};
