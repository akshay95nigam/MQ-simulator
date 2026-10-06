'use strict';

const REFRESH_MS = 5000;
const STAGE_ORDER = ['Intake', 'Validation', 'Transformation', 'Enrichment', 'Routing', 'Delivery', 'Acknowledgement'];
const SEVERITY = { down: 3, degraded: 2, unknown: 1, up: 0 };
const STATUS_LABEL = { up: 'Up', degraded: 'Degraded', down: 'Down', unknown: 'Unknown', disabled: 'Paused', pending: 'Pending' };

const state = {
  snapshot: null,
  filters: { env: '', ns: '', status: '', search: '' },
};

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null;
  try { body = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

// ---------- Data ----------
async function load() {
  try {
    state.snapshot = await api('/api/health');
    render();
  } catch (err) {
    const pill = el('overall-status');
    pill.textContent = 'Dashboard backend unreachable';
    pill.className = 'status-pill status-down';
    console.error(err);
  }
}

function statusOf(entry) {
  if (entry.service.enabled === false) return 'disabled';
  return entry.health ? entry.health.status : 'pending';
}

function worst(statuses) {
  let w = null;
  for (const s of statuses) {
    if (!(s in SEVERITY)) continue;
    if (w === null || SEVERITY[s] > SEVERITY[w]) w = s;
  }
  return w || 'unknown';
}

function filtered() {
  const { env, ns, status, search } = state.filters;
  const q = search.trim().toLowerCase();
  return state.snapshot.services.filter((e) => {
    const s = e.service;
    const st = statusOf(e);
    if (env && s.environment !== env) return false;
    if (ns && s.namespace !== ns) return false;
    if (status === 'problems' && st !== 'down' && st !== 'degraded') return false;
    if (status && status !== 'problems' && st !== status) return false;
    if (q && !`${s.name} ${s.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function stageRank(stage) {
  const i = STAGE_ORDER.findIndex((s) => s.toLowerCase() === (stage || '').toLowerCase());
  return i === -1 ? STAGE_ORDER.length : i;
}

function groupByStage(entries) {
  const groups = new Map();
  for (const e of entries) {
    const stage = e.service.stage || 'Other';
    if (!groups.has(stage)) groups.set(stage, []);
    groups.get(stage).push(e);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => stageRank(a) - stageRank(b) || a.localeCompare(b))
    .map(([stage, items]) => [stage, items.sort((x, y) => (SEVERITY[statusOf(y)] ?? -1) - (SEVERITY[statusOf(x)] ?? -1) || x.service.name.localeCompare(y.service.name))]);
}

function availability(history) {
  if (!history || !history.length) return null;
  const ok = history.filter((h) => h.status === 'up' || h.status === 'degraded').length;
  return (ok / history.length) * 100;
}

function avgLatency(history) {
  const vals = (history || []).map((h) => h.latencyMs).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// ---------- Render ----------
function render() {
  renderFilterOptions();
  const entries = filtered();
  renderOverall(entries);
  renderKpis(entries);
  renderPipeline(entries);
  renderGroups(entries);
  renderEvents();
  const { lastRunAt, pollIntervalMs } = state.snapshot;
  el('last-poll').textContent = lastRunAt
    ? `Polled ${timeAgo(lastRunAt)} · every ${Math.round(pollIntervalMs / 1000)}s`
    : 'Waiting for first poll…';
}

function renderFilterOptions() {
  const services = state.snapshot.services.map((e) => e.service);
  fillSelect(el('filter-env'), uniq(services.map((s) => s.environment)), 'All environments', state.filters.env);
  fillSelect(el('filter-ns'), uniq(services.map((s) => s.namespace)), 'All namespaces', state.filters.ns);
}

function fillSelect(select, values, allLabel, current) {
  const html = [`<option value="">${allLabel}</option>`, ...values.map((v) => `<option value="${attr(v)}">${escapeHtml(v)}</option>`)].join('');
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = values.includes(current) ? current : '';
}

function renderOverall(entries) {
  const pill = el('overall-status');
  const active = entries.filter((e) => e.service.enabled !== false);
  if (!active.length) {
    pill.textContent = 'No services monitored';
    pill.className = 'status-pill';
    return;
  }
  const down = active.filter((e) => statusOf(e) === 'down').length;
  const degraded = active.filter((e) => statusOf(e) === 'degraded').length;
  if (down) {
    pill.textContent = `${down} service${down > 1 ? 's' : ''} down`;
    pill.className = 'status-pill status-down';
  } else if (degraded) {
    pill.textContent = `${degraded} degraded`;
    pill.className = 'status-pill status-degraded';
  } else {
    pill.textContent = 'All systems operational';
    pill.className = 'status-pill status-ok';
  }
  document.title = down ? `(${down} down) Service Health` : 'Service Health';
}

function renderKpis(entries) {
  const active = entries.filter((e) => e.service.enabled !== false);
  const count = (s) => active.filter((e) => statusOf(e) === s).length;
  const histories = active.map((e) => e.health && e.health.history).filter(Boolean);
  const allHistory = histories.flat();
  const avail = availability(allHistory);
  const lat = avgLatency(active.map((e) => e.health && e.health.history && e.health.history[e.health.history.length - 1]).filter(Boolean));
  const kpis = [
    { label: 'Monitored', value: active.length, sub: `${entries.length - active.length} paused`, cls: '' },
    { label: 'Up', value: count('up'), sub: 'healthy', cls: 'up' },
    { label: 'Degraded', value: count('degraded'), sub: 'slow or partial', cls: 'degraded' },
    { label: 'Down', value: count('down'), sub: 'unreachable or DOWN', cls: 'down' },
    { label: 'Availability', value: avail === null ? '—' : `${avail.toFixed(1)}%`, sub: 'recent checks, all services', cls: '' },
    { label: 'Avg latency', value: lat === null ? '—' : `${lat} ms`, sub: 'latest health call', cls: '' },
  ];
  el('kpis').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
}

function renderPipeline(entries) {
  const active = entries.filter((e) => e.service.enabled !== false);
  const groups = groupByStage(active);
  if (!groups.length) {
    el('pipeline').innerHTML = '<div class="muted small">Add services with a pipeline stage to see the message flow.</div>';
    return;
  }
  el('pipeline').innerHTML = groups.map(([stage, items], i) => {
    const st = worst(items.map(statusOf));
    const bad = items.filter((e) => ['down', 'degraded'].includes(statusOf(e))).length;
    const sub = bad ? `${bad} of ${items.length} with issues` : `${items.length} service${items.length > 1 ? 's' : ''} healthy`;
    return `${i ? '<div class="pipe-arrow" aria-hidden="true">→</div>' : ''}
      <div class="pipe-stage ${st}" data-stage="${attr(stage)}" title="${attr(STATUS_LABEL[st])}">
        <div class="pipe-stage-name">${escapeHtml(stage)}</div>
        <div class="pipe-stage-sub">${STATUS_LABEL[st]} · ${sub}</div>
      </div>`;
  }).join('');
  el('pipeline').querySelectorAll('.pipe-stage').forEach((node) => {
    node.addEventListener('click', () => {
      const target = document.querySelector(`.stage-group[data-stage="${CSS.escape(node.dataset.stage)}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderGroups(entries) {
  const container = el('service-groups');
  if (!state.snapshot.services.length) {
    container.innerHTML = `
      <div class="panel empty-state">
        <h3>No services yet</h3>
        <p>Add each Spring Boot service by its OpenShift route (or in-cluster service URL). The dashboard polls
        <code>/actuator/health</code>, the liveness/readiness probe groups, and <code>/actuator/info</code>.</p>
        <div class="actions">
          <button class="btn-primary" id="empty-add">Add service</button>
          <button class="btn-secondary" id="empty-demo">Load demo pipeline</button>
        </div>
      </div>`;
    el('empty-add').addEventListener('click', () => openServiceModal(null));
    el('empty-demo').addEventListener('click', loadDemo);
    return;
  }
  if (!entries.length) {
    container.innerHTML = '<div class="panel empty-hint">No services match these filters.</div>';
    return;
  }
  container.innerHTML = groupByStage(entries).map(([stage, items]) => `
    <section class="stage-group" data-stage="${attr(stage)}">
      <h3>${escapeHtml(stage)} · ${items.length}</h3>
      <div class="service-grid">${items.map(renderCard).join('')}</div>
    </section>`).join('');
  container.querySelectorAll('.svc-card').forEach((card) => {
    card.addEventListener('click', () => openDetailModal(card.dataset.id));
  });
}

function renderCard(entry) {
  const s = entry.service;
  const h = entry.health;
  const st = statusOf(entry);
  const avail = h ? availability(h.history) : null;
  const tags = [s.environment, s.namespace, h && h.info && h.info.version ? `v${h.info.version}` : null].filter(Boolean);
  const problem = h && (h.error || (h.reasons && h.reasons[0]));

  return `
    <article class="svc-card ${st}" data-id="${attr(s.id)}" tabindex="0">
      <div class="svc-head">
        <div>
          <div class="svc-name">${escapeHtml(s.name)}</div>
          <div class="svc-tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
        <span class="badge ${st}">${STATUS_LABEL[st]}</span>
      </div>
      <div class="svc-metrics">
        <div><div class="metric-label">Latency</div><div class="metric-value">${h && h.latencyMs != null ? `${h.latencyMs} ms` : '—'}</div></div>
        <div><div class="metric-label">Availability</div><div class="metric-value">${avail === null ? '—' : `${avail.toFixed(0)}%`}</div></div>
        <div><div class="metric-label">${st === 'up' ? 'Up for' : 'Since'}</div><div class="metric-value">${h && h.since ? duration(h.since) : '—'}</div></div>
      </div>
      ${renderTimeline(h)}
      ${renderChips(h)}
      ${problem && st !== 'up' ? `<div class="svc-problem">${escapeHtml(problem)}</div>` : ''}
      <div class="svc-foot">
        <span>${h ? `Checked ${timeAgo(h.checkedAt)}` : s.enabled === false ? 'Polling paused' : 'Awaiting first check'}</span>
        <span>${h && h.httpStatus ? `HTTP ${h.httpStatus}` : ''}</span>
      </div>
    </article>`;
}

function renderTimeline(h) {
  if (!h || !h.history || !h.history.length) return '';
  const slots = 40;
  const recent = h.history.slice(-slots);
  const pad = Array(slots - recent.length).fill('<span></span>').join('');
  const bars = recent.map((p) => `<span class="${p.status}" title="${attr(`${new Date(p.at).toLocaleTimeString()} — ${STATUS_LABEL[p.status]}${p.latencyMs != null ? `, ${p.latencyMs} ms` : ''}`)}"></span>`).join('');
  return `<div><div class="timeline" aria-label="Recent checks">${pad}${bars}</div>
    <div class="timeline-caption"><span>${recent.length} checks</span><span>now</span></div></div>`;
}

function renderChips(h) {
  if (!h) return '';
  const chips = [];
  if (h.probes) {
    for (const [name, value] of Object.entries(h.probes)) {
      if (value === 'NOT_EXPOSED') continue;
      chips.push(`<span class="chip ${value === 'UP' ? 'up' : 'bad'}" title="${name} probe">${name === 'liveness' ? 'live' : 'ready'}: ${escapeHtml(value)}</span>`);
    }
  }
  for (const c of h.components || []) {
    const cls = c.status === 'UP' ? 'up' : c.status === 'UNKNOWN' ? 'neutral' : 'bad';
    chips.push(`<span class="chip ${cls}" title="${attr(c.status)}">${escapeHtml(c.name)}</span>`);
  }
  return chips.length ? `<div class="chips">${chips.join('')}</div>` : '';
}

function renderEvents() {
  const list = state.snapshot.events;
  if (!list.length) {
    el('events').innerHTML = '<div class="empty-hint">No status changes since the dashboard started.</div>';
    return;
  }
  el('events').innerHTML = list.map((e) => `
    <div class="event ${e.to}">
      <div class="event-title">${escapeHtml(e.serviceName)}: ${STATUS_LABEL[e.from]} → ${STATUS_LABEL[e.to]}</div>
      <div class="event-detail">${new Date(e.at).toLocaleTimeString()}${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</div>
    </div>`).join('');
}

// ---------- Actions ----------
async function checkNow() {
  const btn = el('check-now-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    state.snapshot = await api('/api/health/check', { method: 'POST' });
    render();
  } catch (err) {
    alert(`Check failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check now';
  }
}

async function loadDemo() {
  await api('/api/services/demo', { method: 'POST' });
  await load();
}

function findEntry(id) {
  return state.snapshot.services.find((e) => e.service.id === id);
}

// ---------- Modals ----------
function closeModal() {
  el('modal-backdrop').classList.add('hidden');
  el('modal').className = 'modal';
  el('modal').innerHTML = '';
}

function openDetailModal(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const s = entry.service;
  const h = entry.health;
  const st = statusOf(entry);
  const info = (h && h.info) || {};
  const rows = [
    ['Status', `<span class="badge ${st}">${STATUS_LABEL[st]}</span>${h && h.springStatus ? ` <span class="muted small">actuator reports ${escapeHtml(h.springStatus)}</span>` : ''}`],
    ['Health URL', `<span class="mono">${escapeHtml(s.baseUrl + s.healthPath)}</span>`],
    ['Stage', escapeHtml(s.stage || '—')],
    ['Environment', escapeHtml(s.environment || '—')],
    ['Namespace', escapeHtml(s.namespace || '—')],
    ['Version', escapeHtml([info.version, info.commit && `(${info.commit})`, info.branch].filter(Boolean).join(' ') || '—')],
    ['Java', escapeHtml(info.java || '—')],
    ['Latency', h && h.latencyMs != null ? `${h.latencyMs} ms (slow above ${s.slowThresholdMs} ms)` : '—'],
    ['Last checked', h ? `${new Date(h.checkedAt).toLocaleString()}` : '—'],
  ];
  if (s.consoleUrl) rows.push(['OpenShift', `<a href="${attr(s.consoleUrl)}" target="_blank" rel="noopener">Open in console ↗</a>`]);
  if (s.description) rows.push(['Notes', escapeHtml(s.description)]);

  const issues = h ? [h.error, ...(h.reasons || [])].filter(Boolean) : [];
  const components = (h && h.components) || [];

  el('modal').className = 'modal wide';
  el('modal').innerHTML = `
    <h3>${escapeHtml(s.name)}</h3>
    <p class="modal-sub">${escapeHtml([s.stage, s.namespace].filter(Boolean).join(' · ') || 'Service details')}</p>
    ${issues.length ? `<div class="svc-problem" style="margin-bottom:14px">${issues.map(escapeHtml).join('<br>')}</div>` : ''}
    <dl class="detail-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${h && h.probes ? `<h4>Kubernetes probes</h4><div class="chips">${Object.entries(h.probes).map(([k, v]) =>
      `<span class="chip ${v === 'UP' ? 'up' : v === 'NOT_EXPOSED' ? 'neutral' : 'bad'}">${k}: ${escapeHtml(v === 'NOT_EXPOSED' ? 'not exposed' : v)}</span>`).join('')}</div>` : ''}
    <h4>Components</h4>
    ${components.length ? `<table class="comp-table">
      <thead><tr><th>Component</th><th>Status</th><th>Details</th></tr></thead>
      <tbody>${components.map((c) => `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td><span class="chip ${c.status === 'UP' ? 'up' : 'bad'}">${escapeHtml(c.status)}</span></td>
        <td class="details">${c.details ? escapeHtml(formatDetails(c.details)) : ''}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="muted small">No component breakdown. Set <code>management.endpoint.health.show-components=always</code> (or <code>show-details</code>) on the service to see db, jms, diskSpace etc.</p>'}
    <div class="modal-footer">
      <button class="btn-secondary" id="d-edit">Edit</button>
      <button class="btn-secondary" id="d-recheck">Re-check</button>
      <button class="btn-primary" id="d-close">Close</button>
    </div>`;
  el('modal-backdrop').classList.remove('hidden');
  el('d-close').addEventListener('click', closeModal);
  el('d-edit').addEventListener('click', () => openServiceModal(s));
  el('d-recheck').addEventListener('click', async () => {
    el('d-recheck').disabled = true;
    el('d-recheck').textContent = 'Checking…';
    try {
      await api(`/api/health/check/${s.id}`, { method: 'POST' });
      await load();
      openDetailModal(id);
    } catch (err) {
      alert(err.message);
      el('d-recheck').disabled = false;
      el('d-recheck').textContent = 'Re-check';
    }
  });
}

function formatDetails(details) {
  return Object.entries(details).map(([k, v]) => {
    if (typeof v === 'number' && /total|free|threshold/i.test(k)) v = bytes(v);
    else if (typeof v === 'object') v = JSON.stringify(v);
    return `${k}: ${v}`;
  }).join(' · ');
}

function openServiceModal(existing) {
  const isEdit = !!existing;
  const s = existing || {
    name: '', stage: '', environment: '', namespace: '', description: '', baseUrl: '',
    healthPath: '/actuator/health', infoPath: '/actuator/info', consoleUrl: '',
    checkProbes: true, slowThresholdMs: 1000, enabled: true, hasAuthToken: false,
  };
  el('modal').className = 'modal wide';
  el('modal').innerHTML = `
    <h3>${isEdit ? 'Edit service' : 'Add service'}</h3>
    <p class="modal-sub">A Spring Boot service exposing Actuator. Use its OpenShift route, or the in-cluster service URL if this dashboard runs in the cluster.</p>
    <div class="form-grid">
      <label class="field"><span>Service name</span><input type="text" id="s-name" value="${attr(s.name)}" placeholder="payment-transformer" /></label>
      <label class="field"><span>Pipeline stage</span><input type="text" id="s-stage" list="stage-options" value="${attr(s.stage)}" placeholder="Transformation" /></label>
      <label class="field"><span>Environment</span><input type="text" id="s-env" value="${attr(s.environment)}" placeholder="prod / uat / sit" /></label>
      <label class="field"><span>OpenShift namespace</span><input type="text" id="s-ns" value="${attr(s.namespace)}" placeholder="payments-prod" /></label>
    </div>
    <label class="field"><span>Base URL</span><input type="url" id="s-url" value="${attr(s.baseUrl)}" placeholder="https://payment-transformer-payments-prod.apps.cluster.example.com" /></label>
    <p class="hint">If Actuator runs on a separate management port, point the base URL at that port.</p>
    <div class="form-grid">
      <label class="field"><span>Health path</span><input type="text" id="s-health" value="${attr(s.healthPath)}" /></label>
      <label class="field"><span>Info path (blank to skip)</span><input type="text" id="s-info" value="${attr(s.infoPath)}" /></label>
      <label class="field"><span>Slow threshold (ms)</span><input type="number" id="s-slow" value="${attr(s.slowThresholdMs)}" min="50" /></label>
      <label class="field"><span>Bearer token (optional)</span><input type="password" id="s-token" autocomplete="off" placeholder="${s.hasAuthToken ? 'Saved — leave blank to keep' : 'If actuator is secured'}" /></label>
    </div>
    <label class="field"><span>OpenShift console link (optional)</span><input type="url" id="s-console" value="${attr(s.consoleUrl)}" placeholder="https://console-openshift-console.apps.cluster.example.com/k8s/ns/payments-prod/deployments/payment-transformer" /></label>
    <label class="field"><span>Notes (optional)</span><input type="text" id="s-desc" value="${attr(s.description)}" placeholder="Owner team, on-call channel…" /></label>
    <div class="checks-row">
      <label class="checkbox"><input type="checkbox" id="s-probes" ${s.checkProbes ? 'checked' : ''} /> Check liveness/readiness probe groups</label>
      <label class="checkbox"><input type="checkbox" id="s-enabled" ${s.enabled !== false ? 'checked' : ''} /> Polling enabled</label>
      ${s.hasAuthToken ? '<label class="checkbox"><input type="checkbox" id="s-cleartoken" /> Remove saved token</label>' : ''}
    </div>
    <div class="modal-footer">
      ${isEdit ? '<button class="btn-secondary btn-danger" id="s-delete">Delete</button>' : ''}
      <button class="btn-secondary" id="s-cancel">Cancel</button>
      <button class="btn-primary" id="s-save">${isEdit ? 'Save changes' : 'Add service'}</button>
    </div>`;
  el('modal-backdrop').classList.remove('hidden');
  el('s-cancel').addEventListener('click', closeModal);
  if (isEdit) {
    el('s-delete').addEventListener('click', async () => {
      if (!confirm(`Stop monitoring "${s.name}"?`)) return;
      await api(`/api/services/${s.id}`, { method: 'DELETE' });
      closeModal();
      await load();
    });
  }
  el('s-save').addEventListener('click', async () => {
    const record = {
      name: el('s-name').value.trim(),
      stage: el('s-stage').value.trim(),
      environment: el('s-env').value.trim(),
      namespace: el('s-ns').value.trim(),
      baseUrl: el('s-url').value.trim(),
      healthPath: el('s-health').value.trim() || '/actuator/health',
      infoPath: el('s-info').value.trim(),
      slowThresholdMs: Number(el('s-slow').value) || 1000,
      authToken: el('s-token').value,
      clearAuthToken: !!(el('s-cleartoken') && el('s-cleartoken').checked),
      consoleUrl: el('s-console').value.trim(),
      description: el('s-desc').value.trim(),
      checkProbes: el('s-probes').checked,
      enabled: el('s-enabled').checked,
    };
    try {
      if (isEdit) await api(`/api/services/${s.id}`, { method: 'PUT', body: JSON.stringify(record) });
      else await api('/api/services', { method: 'POST', body: JSON.stringify(record) });
    } catch (err) {
      alert(err.message);
      return;
    }
    closeModal();
    await load();
    // The first check runs in the background; refresh again once it lands.
    setTimeout(load, 1500);
  });
}

// ---------- Utils ----------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(v) { return escapeHtml(v ?? ''); }
function uniq(values) { return [...new Set(values.filter(Boolean))].sort(); }

function timeAgo(iso) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function duration(iso) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ---------- Wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  el('check-now-btn').addEventListener('click', checkNow);
  el('add-service-btn').addEventListener('click', () => openServiceModal(null));
  el('modal-backdrop').addEventListener('click', (e) => { if (e.target === el('modal-backdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('svc-card')) openDetailModal(e.target.dataset.id);
  });

  const bindFilter = (id, key, evt = 'change') => el(id).addEventListener(evt, (e) => {
    state.filters[key] = e.target.value;
    if (state.snapshot) render();
  });
  bindFilter('filter-env', 'env');
  bindFilter('filter-ns', 'ns');
  bindFilter('filter-status', 'status');
  bindFilter('filter-search', 'search', 'input');

  load();
  setInterval(() => {
    if (document.hidden) return;
    load();
  }, REFRESH_MS);
});
