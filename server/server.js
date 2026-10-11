/*
 * Сервер «Мечты» для проверки кассового модуля. Без зависимостей: node server/server.js
 *
 * Касса:   GET  /api/catalog, POST /api/baskets, GET /api/baskets/:id, DELETE /api/baskets/:id
 * Банк:    POST /api/authorize
 * Прил.:   GET  /api/users/:id, PUT /api/users/:id/blocked
 * Демо:    POST /api/demo/terminal  — эмулятор терминала + банка карты (шаги 2–6)
 *          POST /api/demo/reset, GET /api/health
 * Статика: /pos-demo/ (демо-касса), /pos-module/ (модуль)
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var Core = require('./mechta-core.js');

var PORT = Number(process.env.PORT) || 8080;
var ROOT = path.resolve(__dirname, '..');
var CATALOG_VERSION = '2026-10-11';

// Демо-карты: внутренний номер карты в банке (cardRef). Настоящий номер карты сервер не видит.
var DEMO = { userId: 'u1', mechtaCardRef: 'mechta-card-4821', blocked: ['alcohol', 'tobacco'] };

function loadExtraCatalog() {
  var file = path.join(__dirname, 'catalog-extra.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).items || {}; } catch (e) { return {}; }
}

var catalog, core;
function reset() {
  catalog = Object.assign({}, Core.CATALOG, loadExtraCatalog());
  core = Core.createCore();
  core.registerUser({ userId: DEMO.userId, cardRef: DEMO.mechtaCardRef, blocked: DEMO.blocked });
}
reset();

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var data = '';
    req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', function () {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { var err = new Error('Тело запроса — не JSON'); err.status = 400; reject(err); }
    });
    req.on('error', reject);
  });
}

var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') { res.writeHead(302, { Location: '/pos-demo/' }); return res.end(); }
  var p = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
  if (p.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end(); }
  if (pathname.endsWith('/')) p = path.join(p, 'index.html');
  fs.readFile(p, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Задержка ответа для проверки таймаутов модуля: MECHTA_DELAY_MS=3000
var DELAY = Number(process.env.MECHTA_DELAY_MS) || 0;

async function route(req, res, url) {
  var m, p = url.pathname, method = req.method;
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Mechta-Pos' });
    return res.end();
  }
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);
  if (DELAY) await new Promise(function (r) { setTimeout(r, DELAY); });

  if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, pending: core.pendingCount() });

  if (method === 'GET' && p === '/api/catalog') {
    return send(res, 200, { version: CATALOG_VERSION, categories: Core.CATEGORIES, items: catalog });
  }
  if (method === 'POST' && p === '/api/baskets') return send(res, 201, core.submitBasket(await readBody(req)));
  if (method === 'GET' && (m = /^\/api\/baskets\/([^/]+)$/.exec(p))) return send(res, 200, core.basketStatus(decodeURIComponent(m[1])));

  if (method === 'DELETE' && (m = /^\/api\/baskets\/([^/]+)$/.exec(p))) return send(res, 200, core.closeBasket(decodeURIComponent(m[1])));
  if (method === 'POST' && p === '/api/authorize') return send(res, 200, core.authorize(await readBody(req)));

  if (method === 'GET' && (m = /^\/api\/users\/([^/]+)$/.exec(p))) return send(res, 200, core.getUser(decodeURIComponent(m[1])));
  if (method === 'PUT' && (m = /^\/api\/users\/([^/]+)\/blocked$/.exec(p))) {
    var b = await readBody(req);
    return send(res, 200, core.setBlocked(decodeURIComponent(m[1]), b.blocked));
  }

  // Эмулятор: терминал отправил запрос в банк карты, банк спросил «Мечту».
  if (method === 'POST' && p === '/api/demo/terminal') {
    var t = await readBody(req);
    if (t.card !== 'mechta') return send(res, 200, { approved: true, responseCode: '00', note: 'обычная карта, «Мечта» не участвует' });
    var r = core.authorize({ cardRef: DEMO.mechtaCardRef, terminalId: t.terminalId, amount: t.amount });
    var ok = r.decision === 'APPROVE';
    // 05 — «не одобрено», обычный код отказа: терминал и эквайринг ничего нового не видят.
    return send(res, 200, { approved: ok, responseCode: ok ? '00' : '05', mechta: r });
  }
  if (method === 'POST' && p === '/api/demo/reset') { reset(); return send(res, 200, { ok: true }); }

  send(res, 404, { error: 'Нет такого метода' });
}

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, 'http://localhost');
  route(req, res, url).catch(function (e) { send(res, e.status || 500, { error: e.message }); });
});

if (require.main === module) {
  server.listen(PORT, function () { console.log('«Мечта»: http://localhost:' + PORT + '/pos-demo/'); });
}
module.exports = { server: server, reset: reset };
