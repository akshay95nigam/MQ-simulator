'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureFile(name) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fp, '[]\n', 'utf8');
  }
  return fp;
}

function readAll(name) {
  const fp = ensureFile(name);
  const raw = fs.readFileSync(fp, 'utf8').trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Data file ${name}.json is corrupted: ${err.message}`);
  }
}

function writeAll(name, records) {
  const fp = ensureFile(name);
  fs.writeFileSync(fp, JSON.stringify(records, null, 2) + '\n', 'utf8');
}

function list(name) {
  return readAll(name);
}

function get(name, id) {
  return readAll(name).find((r) => r.id === id) || null;
}

function create(name, record) {
  const records = readAll(name);
  const now = new Date().toISOString();
  const toSave = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...record,
  };
  records.push(toSave);
  writeAll(name, records);
  return toSave;
}

function update(name, id, patch) {
  const records = readAll(name);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const updated = {
    ...records[idx],
    ...patch,
    id: records[idx].id,
    createdAt: records[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  records[idx] = updated;
  writeAll(name, records);
  return updated;
}

function remove(name, id) {
  const records = readAll(name);
  const next = records.filter((r) => r.id !== id);
  if (next.length === records.length) return false;
  writeAll(name, next);
  return true;
}

// Prepend, cap history length so the file doesn't grow unbounded.
function pushHistory(name, record, maxEntries = 500) {
  const records = readAll(name);
  const toSave = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...record,
  };
  records.unshift(toSave);
  if (records.length > maxEntries) records.length = maxEntries;
  writeAll(name, records);
  return toSave;
}

module.exports = { list, get, create, update, remove, pushHistory };
