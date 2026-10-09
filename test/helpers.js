// Test harness: a real local Postgres reached through the production driver (@neondatabase/serverless)
// via a tiny WebSocket -> TCP proxy that speaks the same "?address=host:port" contract as Neon's wsproxy.
import { WebSocketServer, WebSocket } from 'ws';
import net from 'node:net';
import { neonConfig, Pool } from '@neondatabase/serverless';

export const PG_HOST = process.env.TEST_PG_HOST || '127.0.0.1';
export const PG_PORT = Number(process.env.TEST_PG_PORT || 55432);
const ADMIN_URL = `postgresql://postgres@${PG_HOST}:${PG_PORT}/postgres`;

let proxy, proxyPort;
export async function startProxy() {
  if (proxy) return proxyPort;
  proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  proxy.on('connection', (ws, req) => {
    const addr = new URL(req.url, 'http://x').searchParams.get('address') || `${PG_HOST}:${PG_PORT}`;
    const [host, port] = addr.split(':');
    const sock = net.connect(Number(port), host);
    const pending = [];
    sock.on('connect', () => { for (const d of pending) sock.write(d); pending.length = 0; });
    ws.on('message', d => (sock.connecting ? pending.push(d) : sock.write(d)));
    sock.on('data', d => ws.readyState === 1 && ws.send(d));
    ws.on('close', () => sock.destroy());
    sock.on('close', () => ws.close());
    sock.on('error', () => ws.close());
  });
  await new Promise(r => proxy.on('listening', r));
  proxyPort = proxy.address().port;
  neonConfig.webSocketConstructor = WebSocket;  // Node 20 on the box; Vercel's Node 24 has a global WebSocket
  neonConfig.wsProxy = () => `127.0.0.1:${proxyPort}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  return proxyPort;
}
export const stopProxy = () => new Promise(r => { if (!proxy) return r(); for (const c of proxy.clients) c.terminate(); proxy.close(() => r()); proxy = null; });

/** Fresh empty database; sets DATABASE_URL to it. */
export async function freshDb(name) {
  await startProxy();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = `postgresql://postgres@${PG_HOST}:${PG_PORT}/${name}`;
  process.env.DATABASE_URL = url;
  delete process.env.DATABASE_URL_UNPOOLED;
  return url;
}

export const req = (path, init = {}) => new Request('https://creds.test' + path, init);
