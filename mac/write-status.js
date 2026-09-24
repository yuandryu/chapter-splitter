#!/usr/bin/env node
const { mkdirSync, renameSync, writeFileSync } = require('fs');
const { dirname } = require('path');

const [file, state, message, result = null] = process.argv.slice(2);
if (!file || !state || !message) process.exit(2);
mkdirSync(dirname(file), { recursive: true });
const payload = { state, message, updatedAt: new Date().toISOString(), ...(result ? { result } : {}) };
const temporary = `${file}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
renameSync(temporary, file);
