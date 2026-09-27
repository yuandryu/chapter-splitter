#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('fs');
const { basename, dirname } = require('path');

const [file, localJobId, state, message, result = null] = process.argv.slice(2);
if (!file || !localJobId || !state || !message) process.exit(2);
mkdirSync(dirname(file), { recursive: true });
let current = {};
if (existsSync(file)) {
  try { current = JSON.parse(readFileSync(file, 'utf8')); } catch (_) { process.exit(3); }
}
const updatedAt = new Date().toISOString();
const payload = {
  ...current,
  localJobId: current.localJobId || localJobId || basename(file, '.json'),
  state,
  message,
  updatedAt,
  ...(result ? { result } : {}),
  mac: { ...(current.mac || {}), state, message, updatedAt, ...(result ? { result } : {}) }
};
const temporary = `${file}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
renameSync(temporary, file);
