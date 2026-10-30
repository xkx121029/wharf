import crypto from 'node:crypto';
import { AUTH_TOKEN } from './config.js';

export function tokenFrom(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return (req.get('x-wharf-token') || req.query.token || '').toString().trim();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function requireToken(req, res, next) {
  const token = tokenFrom(req);
  if (token && safeEqual(token, AUTH_TOKEN)) return next();
  res.status(401).json({ error: '需要访问令牌', code: 'EUNAUTH' });
}

export function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Wharf-Token, X-Wharf-Actor, Mcp-Session-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

export function actorOf(req) {
  const raw = (req.get('x-wharf-actor') || '').toLowerCase();
  if (raw === 'ai' || raw === 'api' || raw === 'system') return raw;
  return 'ui';
}
