/**
 * 让 Node 的 fetch 走 HTTP 代理（本机 7897）。
 * 仅测试用：Node 22 的 fetch 不读 HTTP_PROXY。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PROXY = new URL(process.env.HTTPS_PROXY || 'http://127.0.0.1:7897');

function rawRequest(target, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const isHttps = targetUrl.protocol === 'https:';

    const connectReq = http.request({
      host: PROXY.hostname,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || (isHttps ? 443 : 80)}`,
    });
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const req = (isHttps ? https : http).request(
        {
          host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search,
          method,
          headers,
          socket,
          agent: false,
          servername: targetUrl.hostname,
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              ok: r.statusCode >= 200 && r.statusCode < 300,
              status: r.statusCode,
              text: async () => Buffer.concat(chunks).toString('utf8'),
              json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
      if (body) req.write(body);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

export function installProxyFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = { ...(init.headers ?? {}) };
    return rawRequest(url, init.method ?? 'GET', headers, init.body, init.signal);
  };
  // AbortSignal.timeout 在自定义实现下需要存在
  if (typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = (ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    };
  }
}
