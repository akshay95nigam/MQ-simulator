'use strict';

const path = require('path');
const express = require('express');
const store = require('./store');
const mqClient = require('./mqClient');
const health = require('./health');
const { demoRouter, demoServiceRecords } = require('./demoActuator');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Status ----------
app.get('/api/status', (req, res) => {
  res.json({
    mqAvailable: mqClient.isAvailable(),
    mqUnavailableReason: mqClient.unavailableReason(),
  });
});

// ---------- Generic CRUD for "queues" and "messages" ----------
function crudRoutes(resourceName, collectionName) {
  const base = `/api/${resourceName}`;

  app.get(base, (req, res) => {
    res.json(store.list(collectionName));
  });

  app.post(base, (req, res) => {
    res.status(201).json(store.create(collectionName, req.body || {}));
  });

  app.put(`${base}/:id`, (req, res) => {
    const updated = store.update(collectionName, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  });

  app.delete(`${base}/:id`, (req, res) => {
    const ok = store.remove(collectionName, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  });
}

crudRoutes('queues', 'queues');
crudRoutes('messages', 'messages');

app.get('/api/history', (req, res) => {
  res.json(store.list('history'));
});

// ---------- Send ----------
function applyVariables(template, variables) {
  if (!variables) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
  });
}

app.post(
  '/api/send',
  asyncHandler(async (req, res) => {
    const { queueId, messageId, adHocBody, variables, dryRun, mqmd } = req.body || {};

    const queue = queueId ? store.get('queues', queueId) : null;
    if (queueId && !queue) return res.status(404).json({ error: 'Saved queue not found' });
    if (!queue) return res.status(400).json({ error: 'queueId is required' });

    let bodyTemplate = adHocBody;
    let messageName = 'Ad-hoc message';
    if (messageId) {
      const message = store.get('messages', messageId);
      if (!message) return res.status(404).json({ error: 'Saved message not found' });
      bodyTemplate = message.body;
      messageName = message.name;
    }
    if (bodyTemplate === undefined || bodyTemplate === null) {
      return res.status(400).json({ error: 'messageId or adHocBody is required' });
    }

    const finalBody = applyVariables(bodyTemplate, variables);
    const buffer = Buffer.from(finalBody, 'utf8');

    const baseHistory = {
      queueId: queue.id,
      queueName: queue.name,
      clientName: queue.clientName || null,
      messageId: messageId || null,
      messageName,
      body: finalBody,
      dryRun: !!dryRun,
    };

    if (dryRun) {
      const entry = store.pushHistory('history', {
        ...baseHistory,
        status: 'simulated',
        detail: 'Dry run — no MQ connection was made.',
      });
      return res.json({ ok: true, dryRun: true, history: entry });
    }

    try {
      const result = await mqClient.connectAndPut(
        {
          host: queue.host,
          port: queue.port,
          channel: queue.channel,
          queueManager: queue.queueManager,
          queueName: queue.queueName,
          userId: queue.userId,
          password: queue.password,
          useTLS: queue.useTLS,
          cipherSpec: queue.cipherSpec,
        },
        buffer,
        mqmd || {}
      );

      const entry = store.pushHistory('history', {
        ...baseHistory,
        status: 'sent',
        detail: `Delivered. MsgId: ${result.msgId || 'n/a'}`,
        msgId: result.msgId || null,
      });
      res.json({ ok: true, dryRun: false, history: entry });
    } catch (err) {
      const entry = store.pushHistory('history', {
        ...baseHistory,
        status: 'error',
        detail: err.message,
        mqReasonCode: err.mqReasonCode ?? null,
        mqReasonName: err.mqReasonName ?? null,
      });
      res.status(502).json({ ok: false, error: err.message, history: entry });
    }
  })
);

// ---------- Service health dashboard ----------
app.get('/api/services', (req, res) => {
  res.json(store.list(health.COLLECTION).map(health.sanitize));
});

app.post('/api/services', (req, res) => {
  const record = health.normalizeInput(req.body || {});
  const error = health.validate(record);
  if (error) return res.status(400).json({ error });
  const created = store.create(health.COLLECTION, record);
  health.checkOne(created.id).catch(() => {});
  res.status(201).json(health.sanitize(created));
});

app.put('/api/services/:id', (req, res) => {
  const existing = store.get(health.COLLECTION, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const record = health.normalizeInput(req.body || {}, existing);
  const error = health.validate(record);
  if (error) return res.status(400).json({ error });
  const updated = store.update(health.COLLECTION, req.params.id, record);
  health.forget(updated.id);
  health.checkOne(updated.id).catch(() => {});
  res.json(health.sanitize(updated));
});

app.delete('/api/services/:id', (req, res) => {
  const ok = store.remove(health.COLLECTION, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  health.forget(req.params.id);
  res.status(204).end();
});

// Adds the sample payment pipeline served by /demo below.
app.post(
  '/api/services/demo',
  asyncHandler(async (req, res) => {
    const existing = new Set(store.list(health.COLLECTION).map((s) => s.baseUrl));
    const baseUrl = `http://localhost:${PORT}`;
    const added = demoServiceRecords(baseUrl)
      .filter((r) => !existing.has(r.baseUrl))
      .map((r) => store.create(health.COLLECTION, r));
    await health.checkAll();
    res.status(201).json({ added: added.length });
  })
);

app.get('/api/health', (req, res) => {
  res.json(health.snapshot());
});

app.post(
  '/api/health/check',
  asyncHandler(async (req, res) => {
    await health.checkAll();
    res.json(health.snapshot());
  })
);

app.post(
  '/api/health/check/:id',
  asyncHandler(async (req, res) => {
    const result = await health.checkOne(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  })
);

app.use('/demo', demoRouter());

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`MQ Payment Simulator running at http://localhost:${PORT}`);
  console.log(`Service health dashboard at http://localhost:${PORT}/health.html`);
  health.start();
  if (!mqClient.isAvailable()) {
    console.log('Note: real MQ sends are unavailable until the "ibmmq" native module is set up. Dry Run mode still works.');
  }
});
