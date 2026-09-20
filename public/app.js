'use strict';

const state = {
  queues: [],
  messages: [],
  history: [],
  selectedQueueId: null,
  selectedMessageId: null,
};

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- Load ----------
async function loadStatus() {
  const status = await api('/api/status');
  const pill = el('mq-status');
  if (status.mqAvailable) {
    pill.textContent = 'MQ client ready';
    pill.className = 'status-pill status-ok';
  } else {
    pill.textContent = 'MQ client unavailable — Dry Run only';
    pill.className = 'status-pill status-warn';
    pill.title = status.mqUnavailableReason || '';
  }
}

async function loadQueues() {
  state.queues = await api('/api/queues');
  renderQueueList();
  renderComposeQueueOptions();
}

async function loadMessages() {
  state.messages = await api('/api/messages');
  renderMessageList();
  renderComposeMessageOptions();
}

async function loadHistory() {
  state.history = await api('/api/history');
  renderHistory();
}

// ---------- Render: Queues ----------
function renderQueueList() {
  const container = el('queue-list');
  container.innerHTML = '';
  if (state.queues.length === 0) {
    container.innerHTML = '<div class="empty-hint">No saved queues yet. Click + to add one.</div>';
    return;
  }
  for (const q of state.queues) {
    const card = document.createElement('div');
    card.className = 'item-card' + (q.id === state.selectedQueueId ? ' selected' : '');
    card.innerHTML = `
      <div class="item-title">${escapeHtml(q.name)}</div>
      <div class="item-sub">${escapeHtml(q.queueManager)} · ${escapeHtml(q.host)}:${escapeHtml(String(q.port))} · ${escapeHtml(q.queueName)}</div>
      ${q.clientName ? `<span class="item-tag">${escapeHtml(q.clientName)}</span>` : ''}
      <div class="item-actions">
        <button data-action="edit" title="Edit">✎</button>
        <button data-action="delete" title="Delete">✕</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      if (action === 'edit') return openQueueModal(q);
      if (action === 'delete') return deleteQueue(q);
      selectQueue(q.id);
    });
    container.appendChild(card);
  }
}

function selectQueue(id) {
  state.selectedQueueId = id;
  el('compose-queue').value = id;
  renderQueueList();
}

async function deleteQueue(q) {
  if (!confirm(`Delete saved queue "${q.name}"?`)) return;
  await api(`/api/queues/${q.id}`, { method: 'DELETE' });
  if (state.selectedQueueId === q.id) state.selectedQueueId = null;
  await loadQueues();
}

function renderComposeQueueOptions() {
  const select = el('compose-queue');
  const prev = select.value;
  select.innerHTML = '<option value="">— Select a saved queue —</option>' +
    state.queues.map((q) => `<option value="${q.id}">${escapeHtml(q.name)}${q.clientName ? ' · ' + escapeHtml(q.clientName) : ''}</option>`).join('');
  select.value = state.queues.some((q) => q.id === prev) ? prev : (state.selectedQueueId || '');
}

// ---------- Render: Messages ----------
function renderMessageList() {
  const container = el('message-list');
  container.innerHTML = '';
  if (state.messages.length === 0) {
    container.innerHTML = '<div class="empty-hint">No saved messages yet. Click + to add one.</div>';
    return;
  }
  for (const m of state.messages) {
    const card = document.createElement('div');
    card.className = 'item-card' + (m.id === state.selectedMessageId ? ' selected' : '');
    card.innerHTML = `
      <div class="item-title">${escapeHtml(m.name)}</div>
      <div class="item-sub">${escapeHtml((m.body || '').slice(0, 60))}${(m.body || '').length > 60 ? '…' : ''}</div>
      ${m.clientName ? `<span class="item-tag">${escapeHtml(m.clientName)}</span>` : ''}
      <div class="item-actions">
        <button data-action="edit" title="Edit">✎</button>
        <button data-action="delete" title="Delete">✕</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      if (action === 'edit') return openMessageModal(m);
      if (action === 'delete') return deleteMessage(m);
      selectMessage(m.id);
    });
    container.appendChild(card);
  }
}

function selectMessage(id) {
  state.selectedMessageId = id;
  el('compose-message').value = id;
  applyMessageToCompose(id);
  renderMessageList();
}

async function deleteMessage(m) {
  if (!confirm(`Delete saved message "${m.name}"?`)) return;
  await api(`/api/messages/${m.id}`, { method: 'DELETE' });
  if (state.selectedMessageId === m.id) state.selectedMessageId = null;
  await loadMessages();
}

function renderComposeMessageOptions() {
  const select = el('compose-message');
  const prev = select.value;
  select.innerHTML = '<option value="">— Ad-hoc message —</option>' +
    state.messages.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}${m.clientName ? ' · ' + escapeHtml(m.clientName) : ''}</option>`).join('');
  select.value = state.messages.some((m) => m.id === prev) ? prev : (state.selectedMessageId || '');
}

function applyMessageToCompose(id) {
  if (!id) return;
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) return;
  el('compose-body').value = msg.body || '';
  renderVariables();
}

// ---------- Variables ----------
function extractVariables(text) {
  const found = new Set();
  const re = /\{\{\s*([\w.-]+)\s*\}\}/g;
  let match;
  while ((match = re.exec(text || ''))) found.add(match[1]);
  return Array.from(found);
}

function renderVariables() {
  const body = el('compose-body').value;
  const vars = extractVariables(body);
  const block = el('variables-block');
  const list = el('variables-list');
  if (vars.length === 0) {
    block.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  block.classList.remove('hidden');
  const existing = {};
  list.querySelectorAll('input').forEach((input) => { existing[input.dataset.var] = input.value; });
  list.innerHTML = vars.map((v) => `
    <div class="variable-row">
      <span class="var-name">{{${escapeHtml(v)}}}</span>
      <input type="text" data-var="${escapeHtml(v)}" value="${escapeHtml(existing[v] || '')}" placeholder="value for ${escapeHtml(v)}" />
    </div>
  `).join('');
}

function collectVariableValues() {
  const values = {};
  document.querySelectorAll('#variables-list input').forEach((input) => {
    values[input.dataset.var] = input.value;
  });
  return values;
}

// ---------- History ----------
function renderHistory() {
  const container = el('history-list');
  container.innerHTML = '';
  if (state.history.length === 0) {
    container.innerHTML = '<div class="empty-hint">No sends yet.</div>';
    return;
  }
  for (const h of state.history) {
    const row = document.createElement('div');
    row.className = 'history-entry';
    const time = new Date(h.at).toLocaleString();
    row.innerHTML = `
      <div class="history-entry-top">
        <div class="history-entry-title">${escapeHtml(h.queueName)} ${h.clientName ? '· ' + escapeHtml(h.clientName) : ''}</div>
        <span class="status-chip ${h.status}">${h.status}</span>
      </div>
      <div class="history-entry-detail">${escapeHtml(h.messageName)} — ${escapeHtml(h.detail || '')}</div>
      <div class="history-entry-time">${time}</div>
    `;
    container.appendChild(row);
  }
}

// ---------- Send ----------
async function handleSend() {
  const queueId = el('compose-queue').value;
  const messageSelectId = el('compose-message').value;
  const body = el('compose-body').value;
  const dryRun = el('dry-run-toggle').checked;
  const resultBox = el('send-result');
  resultBox.textContent = '';

  if (!queueId) {
    resultBox.innerHTML = '<span class="badge-error">Pick a target queue first.</span>';
    return;
  }
  if (!body.trim()) {
    resultBox.innerHTML = '<span class="badge-error">Message body is empty.</span>';
    return;
  }

  const payload = {
    queueId,
    variables: collectVariableValues(),
    dryRun,
  };
  if (messageSelectId) {
    payload.messageId = messageSelectId;
  } else {
    payload.adHocBody = body;
  }

  const sendBtn = el('send-btn');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  try {
    const result = await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    if (result.dryRun) {
      resultBox.innerHTML = '<span class="badge-sim">Simulated (dry run) — nothing was sent to MQ.</span>';
    } else {
      resultBox.innerHTML = '<span class="badge-ok">Sent successfully.</span>';
    }
    await loadHistory();
  } catch (err) {
    resultBox.innerHTML = `<span class="badge-error">Send failed: ${escapeHtml(err.message)}</span>`;
    await loadHistory();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send message';
  }
}

// ---------- Modals ----------
function closeModal() {
  el('modal-backdrop').classList.add('hidden');
  el('modal').innerHTML = '';
}

function openQueueModal(existing) {
  const isEdit = !!existing;
  const q = existing || { name: '', clientName: '', host: '', port: 1414, channel: '', queueManager: '', queueName: '', userId: '', password: '', useTLS: false, cipherSpec: '' };
  el('modal').innerHTML = `
    <h3>${isEdit ? 'Edit queue' : 'New saved queue'}</h3>
    <p class="modal-sub">Connection details for a client's payment-processor queue.</p>
    <div class="form-grid">
      <label class="field"><span>Label / name</span><input type="text" id="m-name" value="${attr(q.name)}" placeholder="e.g. Client A — Inbound Payments" /></label>
      <label class="field"><span>Client name</span><input type="text" id="m-client" value="${attr(q.clientName)}" placeholder="e.g. Client A" /></label>
      <label class="field"><span>Queue manager</span><input type="text" id="m-qmgr" value="${attr(q.queueManager)}" placeholder="QM1" /></label>
      <label class="field"><span>Queue name</span><input type="text" id="m-qname" value="${attr(q.queueName)}" placeholder="PAYMENTS.IN" /></label>
      <label class="field"><span>Host</span><input type="text" id="m-host" value="${attr(q.host)}" placeholder="mq.example.internal" /></label>
      <label class="field"><span>Port</span><input type="number" id="m-port" value="${attr(q.port)}" placeholder="1414" /></label>
      <label class="field"><span>Channel</span><input type="text" id="m-channel" value="${attr(q.channel)}" placeholder="CLIENT.SVRCONN" /></label>
      <label class="field"><span>Cipher spec (TLS, optional)</span><input type="text" id="m-cipher" value="${attr(q.cipherSpec)}" placeholder="ANY_TLS12_OR_HIGHER" /></label>
      <label class="field"><span>User ID (optional)</span><input type="text" id="m-user" value="${attr(q.userId)}" /></label>
      <label class="field"><span>Password (optional)</span><input type="password" id="m-pass" value="${attr(q.password)}" /></label>
    </div>
    <label class="checkbox"><input type="checkbox" id="m-tls" ${q.useTLS ? 'checked' : ''} /> Use TLS</label>
    <div class="modal-footer">
      ${isEdit ? '<button class="btn-secondary btn-danger" id="m-delete">Delete</button>' : ''}
      <button class="btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn-primary" id="m-save">${isEdit ? 'Save changes' : 'Add queue'}</button>
    </div>
  `;
  el('modal-backdrop').classList.remove('hidden');
  el('m-cancel').addEventListener('click', closeModal);
  if (isEdit) el('m-delete').addEventListener('click', async () => { await deleteQueue(q); closeModal(); });
  el('m-save').addEventListener('click', async () => {
    const record = {
      name: el('m-name').value.trim(),
      clientName: el('m-client').value.trim(),
      queueManager: el('m-qmgr').value.trim(),
      queueName: el('m-qname').value.trim(),
      host: el('m-host').value.trim(),
      port: Number(el('m-port').value) || 1414,
      channel: el('m-channel').value.trim(),
      cipherSpec: el('m-cipher').value.trim(),
      userId: el('m-user').value.trim(),
      password: el('m-pass').value,
      useTLS: el('m-tls').checked,
    };
    if (!record.name || !record.host || !record.channel || !record.queueManager || !record.queueName) {
      alert('Name, queue manager, queue name, host, and channel are required.');
      return;
    }
    if (isEdit) {
      await api(`/api/queues/${q.id}`, { method: 'PUT', body: JSON.stringify(record) });
    } else {
      await api('/api/queues', { method: 'POST', body: JSON.stringify(record) });
    }
    closeModal();
    await loadQueues();
  });
}

function openMessageModal(existing) {
  const isEdit = !!existing;
  const m = existing || { name: '', clientName: '', description: '', body: '' };
  el('modal').innerHTML = `
    <h3>${isEdit ? 'Edit message' : 'New saved message'}</h3>
    <p class="modal-sub">Use <code>{{variable}}</code> placeholders for values you'll fill in at send time (amount, account, reference…).</p>
    <div class="form-grid">
      <label class="field"><span>Label / name</span><input type="text" id="m-name" value="${attr(m.name)}" placeholder="e.g. ISO20022 pain.001 — happy path" /></label>
      <label class="field"><span>Client name</span><input type="text" id="m-client" value="${attr(m.clientName)}" placeholder="e.g. Client A" /></label>
    </div>
    <label class="field"><span>Description (optional)</span><input type="text" id="m-desc" value="${attr(m.description)}" /></label>
    <label class="field"><span>Body</span><textarea id="m-body" rows="12" placeholder='{"amount": "{{amount}}", "account": "{{account}}"}'>${escapeHtml(m.body)}</textarea></label>
    <div class="modal-footer">
      ${isEdit ? '<button class="btn-secondary btn-danger" id="m-delete">Delete</button>' : ''}
      <button class="btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn-primary" id="m-save">${isEdit ? 'Save changes' : 'Add message'}</button>
    </div>
  `;
  el('modal-backdrop').classList.remove('hidden');
  el('m-cancel').addEventListener('click', closeModal);
  if (isEdit) el('m-delete').addEventListener('click', async () => { await deleteMessage(m); closeModal(); });
  el('m-save').addEventListener('click', async () => {
    const record = {
      name: el('m-name').value.trim(),
      clientName: el('m-client').value.trim(),
      description: el('m-desc').value.trim(),
      body: el('m-body').value,
    };
    if (!record.name || !record.body) {
      alert('Name and body are required.');
      return;
    }
    if (isEdit) {
      await api(`/api/messages/${m.id}`, { method: 'PUT', body: JSON.stringify(record) });
    } else {
      await api('/api/messages', { method: 'POST', body: JSON.stringify(record) });
    }
    closeModal();
    await loadMessages();
  });
}

// ---------- Utils ----------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(v) { return escapeHtml(v ?? ''); }

// ---------- Wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  el('new-queue-btn').addEventListener('click', () => openQueueModal(null));
  el('new-message-btn').addEventListener('click', () => openMessageModal(null));
  el('refresh-history-btn').addEventListener('click', loadHistory);
  el('send-btn').addEventListener('click', handleSend);
  el('compose-body').addEventListener('input', renderVariables);
  el('compose-queue').addEventListener('change', (e) => { state.selectedQueueId = e.target.value || null; renderQueueList(); });
  el('compose-message').addEventListener('change', (e) => {
    state.selectedMessageId = e.target.value || null;
    if (state.selectedMessageId) applyMessageToCompose(state.selectedMessageId);
    renderMessageList();
  });
  el('modal-backdrop').addEventListener('click', (e) => { if (e.target === el('modal-backdrop')) closeModal(); });

  Promise.all([loadStatus(), loadQueues(), loadMessages(), loadHistory()]).catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err.message}`);
  });
});
