'use strict';

// Fake Spring Boot Actuator endpoints for a sample payment pipeline, so the
// health dashboard can be tried without access to the OpenShift cluster.
// Each service's state drifts over time on a fixed cycle so the dashboard
// shows transitions, degraded components and outages.

const express = require('express');

const DEMO_SERVICES = [
  { slug: 'mq-inbound-listener', name: 'mq-inbound-listener', stage: 'Intake', components: ['jms', 'diskSpace', 'ping'], version: '3.4.1' },
  { slug: 'message-validator', name: 'message-validator', stage: 'Validation', components: ['diskSpace', 'ping', 'schemaRegistry'], version: '2.9.0' },
  { slug: 'payment-transformer', name: 'payment-transformer', stage: 'Transformation', components: ['db', 'diskSpace', 'ping', 'redis'], version: '5.1.3' },
  { slug: 'iso20022-mapper', name: 'iso20022-mapper', stage: 'Transformation', components: ['diskSpace', 'ping'], version: '1.12.0' },
  { slug: 'enrichment-service', name: 'enrichment-service', stage: 'Enrichment', components: ['db', 'diskSpace', 'ping', 'referenceDataApi'], version: '4.0.2' },
  { slug: 'routing-service', name: 'routing-service', stage: 'Routing', components: ['db', 'diskSpace', 'ping'], version: '2.2.7' },
  { slug: 'client-delivery-service', name: 'client-delivery-service', stage: 'Delivery', components: ['jms', 'diskSpace', 'ping', 'clientGateway'], version: '6.3.0' },
  { slug: 'ack-handler', name: 'ack-handler', stage: 'Acknowledgement', components: ['jms', 'db', 'diskSpace', 'ping'], version: '1.8.4' },
];

// Scripted incidents on a 6-minute loop: [service, startSec, endSec, effect].
const CYCLE_SEC = 360;
const INCIDENTS = [
  ['enrichment-service', 40, 130, { slow: true }],
  ['client-delivery-service', 150, 220, { failComponent: 'clientGateway', down: true }],
  ['payment-transformer', 250, 300, { failComponent: 'redis' }],
  ['ack-handler', 310, 340, { readiness: 'OUT_OF_SERVICE' }],
];

function activeEffect(slug) {
  const t = Math.floor(Date.now() / 1000) % CYCLE_SEC;
  const hit = INCIDENTS.find(([s, from, to]) => s === slug && t >= from && t < to);
  return hit ? hit[3] : {};
}

function componentBody(name, failing) {
  const status = failing ? 'DOWN' : 'UP';
  switch (name) {
    case 'db': return { status, details: { database: 'PostgreSQL', validationQuery: 'isValid()' } };
    case 'jms': return { status, details: { provider: 'IBM MQ 9.3.4.0' } };
    case 'diskSpace': return { status, details: { total: 21474836480, free: 15032385536, threshold: 10485760, exists: true } };
    case 'redis': return failing ? { status, details: { error: 'RedisConnectionFailureException: Unable to connect to redis:6379' } } : { status, details: { version: '7.2.4' } };
    case 'clientGateway': return failing ? { status, details: { error: 'Connect timed out to client SFTP gateway' } } : { status, details: { endpoint: 'sftp-gw.client.example:22' } };
    default: return { status };
  }
}

function demoRouter() {
  const router = express.Router();
  const bySlug = new Map(DEMO_SERVICES.map((s) => [s.slug, s]));

  router.use('/:slug', (req, res, next) => {
    const svc = bySlug.get(req.params.slug);
    if (!svc) return res.status(404).json({ error: 'Unknown demo service' });
    req.demo = svc;
    req.effect = activeEffect(svc.slug);
    // Small natural jitter; "slow" incidents push latency over the threshold.
    const delay = req.effect.slow ? 1400 + Math.random() * 600 : 20 + Math.random() * 120;
    setTimeout(next, delay);
  });

  router.get('/:slug/actuator/health', (req, res) => {
    const { demo, effect } = req;
    const components = {};
    for (const c of demo.components) components[c] = componentBody(c, effect.failComponent === c);
    const status = effect.down ? 'DOWN' : 'UP';
    res.status(effect.down ? 503 : 200).json({ status, components });
  });

  router.get('/:slug/actuator/health/liveness', (req, res) => {
    res.json({ status: 'UP' });
  });

  router.get('/:slug/actuator/health/readiness', (req, res) => {
    const status = req.effect.readiness || (req.effect.down ? 'OUT_OF_SERVICE' : 'UP');
    res.status(status === 'UP' ? 200 : 503).json({ status });
  });

  router.get('/:slug/actuator/info', (req, res) => {
    const { demo } = req;
    res.json({
      build: { artifact: demo.slug, name: demo.name, version: demo.version, time: '2026-09-28T14:12:03Z' },
      git: { branch: 'release/2026.10', commit: { id: 'a1b2c3d4e5f6' } },
      java: { version: '21.0.4' },
    });
  });

  return router;
}

function demoServiceRecords(baseUrl) {
  return DEMO_SERVICES.map((s) => ({
    name: s.name,
    stage: s.stage,
    environment: 'demo',
    namespace: 'payments-demo',
    description: 'Demo service served by this app — replace with your real OpenShift routes.',
    baseUrl: `${baseUrl}/demo/${s.slug}`,
    healthPath: '/actuator/health',
    infoPath: '/actuator/info',
    consoleUrl: '',
    checkProbes: true,
    slowThresholdMs: 1000,
    enabled: true,
    authToken: '',
  }));
}

module.exports = { demoRouter, demoServiceRecords };
