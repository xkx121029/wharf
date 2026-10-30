import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = '1.0.0';
export const PORT = Number(process.env.PORT || 8787);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const DRIVE_DIR = path.join(DATA_DIR, 'drive');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const EVENTS_FILE = path.join(DATA_DIR, 'activity.jsonl');

export const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES || 2 * 1024 * 1024);
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
export const MAX_IMPORT_BYTES = Number(process.env.MAX_IMPORT_BYTES || 64 * 1024 * 1024);
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

for (const dir of [DATA_DIR, DRIVE_DIR, WORKSPACE_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readOrCreateToken() {
  const envToken = (process.env.AUTH_TOKEN || '').trim();
  if (envToken && envToken !== 'auto') return envToken;

  const file = path.join(DATA_DIR, '.token');
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }

  const token = `wharf_${crypto.randomBytes(18).toString('hex')}`;
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export const AUTH_TOKEN = readOrCreateToken();
