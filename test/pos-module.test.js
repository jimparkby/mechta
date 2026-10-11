'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var Pos = require('../pos-module/mechta-pos.js');
var srv = require('../server/server.js');

var BEER = '4810000000055', BREAD = '4810000000017', CIGS = '4810000000048', ENERGY = '4810000000079';

var base;
test.before(function () {
  return new Promise(function (r) { srv.server.listen(0, function () { base = 'http://127.0.0.1:' + srv.server.address().port; r(); }); });
});
test.after(function () { srv.server.close(); });
test.beforeEach(function () { srv.reset(); });

function terminal(amount, card, tid) {
  return fetch(base + '/api/demo/terminal', { method: 'POST', body: JSON.stringify({ terminalId: tid || 'T-1', amount: amount, card: card }) }).then(function (r) { return r.json(); });
}
function mod(extra) { return Pos.createPosModule(Object.assign({ serverUrl: base, terminalId: 'T-1', merchantId: 'M-1' }, extra || {})); }

// ---------------------------------------------------------------- коды

test('parseScan: EAN-13, GTIN-14, DataMatrix с AI 01, код пачки, префиксы сканера', function () {
  assert.deepEqual(Pos.parseScan('4810000000055').gtin, BEER);
  assert.equal(Pos.parseScan('04810000000055').gtin, BEER);
  var dm = '0104810000000055215Ab7%x\u001d93dGVz';
  assert.deepEqual([Pos.parseScan(dm).gtin, Pos.parseScan(dm).marked], [BEER, true]);
  assert.equal(Pos.parseScan(']d2' + dm).gtin, BEER, 'префикс AIM');
  assert.equal(Pos.parseScan('0104810000000055215Ab7%x93dGVz').gtin, BEER, 'сканер потерял GS');
  var pack = '04810000000048' + 'AbC-12z' + 'Xy9Q' + 'kLm0'; // 29 знаков, без AI
  assert.deepEqual([Pos.parseScan(pack).gtin, Pos.parseScan(pack).marked], [CIGS, true]);
  assert.equal(Pos.parseScan('hello').gtin, null);
  assert.equal(Pos.parseScan('4810000000055\r\n').gtin, BEER);
});

test('classify: штрихкод, пометка в базе магазина, код маркировки, скидки', function () {
  var cat = { [BEER]: { category: 'alcohol' } };
  var r = Pos.classify([
    { gtin: BEER, price: 320, qty: 2 },
    { gtin: '999', group: 'TOB', price: 800 },
    { markCode: '0104810000000055215Ab7%x', price: 300, sum: 250 },
    { gtin: BREAD, price: 189 },
    { gtin: '111', category: 'lottery', price: 500 }
  ], cat, { TOB: 'tobacco' });
  assert.equal(r.total, 640 + 800 + 250 + 189 + 500);
  assert.deepEqual(r.restricted, { alcohol: 890, tobacco: 800, lottery: 500 });
  assert.deepEqual(r.lines, ['alcohol', 'tobacco', 'alcohol', null, 'lottery']);
});

// ---------------------------------------------------------------- сценарии

test('пример из ТЗ: 43,75 с пивом 8,73 → отказ, подсказка, убрали пиво → оплата 35,02', async function () {
  var pos = mod();
  await pos.loadCatalog();
  var cart = [
    { gtin: BREAD, sum: 3502 },     // остальная корзина
    { gtin: BEER, sum: 873 }
  ];
  var s = await pos.beforeCardPayment(cart);
  assert.equal(s.reason, 'sent');
  assert.equal(s.amount, 4375);
  assert.deepEqual(s.restricted, { alcohol: 873 });

  var t = await terminal(s.amount, 'mechta');
  assert.equal(t.approved, false);
  assert.equal(t.mechta.saved, 873);

  var d = await pos.afterCardResult(s, t.approved);
  assert.equal(d.mechta, true);
  assert.deepEqual(d.categories, ['alcohol']);
  assert.match(d.hint, /алкоголь/);
  assert.deepEqual(d.removeLines, [1]);

  cart = pos.removeLines(cart, d.removeLines);
  var s2 = await pos.beforeCardPayment(cart);
  assert.equal(s2.reason, 'no_restricted_items', 'без пива касса ничего не шлёт');
  var t2 = await terminal(s2.amount, 'mechta');
  assert.equal(t2.approved, true);
  assert.equal(s2.amount, 3502);
});

test('обычная карта: чек отправлен, но оплата проходит, подсказки нет', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: CIGS, price: 800 }]);
  var t = await terminal(s.amount, 'other');
  assert.equal(t.approved, true);
  assert.equal((await pos.afterCardResult(s, true)).mechta, false);
});

test('категория не запрещена пользователем (энергетик) → одобрено', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: ENERGY, price: 290 }, { gtin: BREAD, price: 189 }]);
  assert.equal(s.reason, 'sent');
  assert.equal((await terminal(s.amount, 'mechta')).approved, true);
});

test('отказ банка по другой причине: статус pending → mechta:false, касса показывает обычный отказ', async function () {
  var pos = mod({ statusPollTotalMs: 300, statusPollMs: 50 }); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  var d = await pos.afterCardResult(s, false); // банк отказал сам, «Мечту» не спрашивал
  assert.equal(d.mechta, false);
});

test('сумма к оплате передаётся явно (смешанная оплата): сервер матчит по карточной части', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }, { gtin: BREAD, price: 189 }], 400);
  assert.equal(s.amount, 400);
  assert.equal((await terminal(400, 'mechta')).approved, false);
});

test('другой терминал того же магазина не цепляет чужой чек', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  assert.equal((await terminal(s.amount, 'mechta', 'T-2')).approved, true);
});

// ---------------------------------------------------------------- отказоустойчивость

test('сервер недоступен → оплата не блокируется, ошибок нет', async function () {
  var logs = [];
  var pos = Pos.createPosModule({ serverUrl: 'http://127.0.0.1:1', terminalId: 'T-1', catalog: { [BEER]: { category: 'alcohol' } }, log: function (l, m) { logs.push(l); } });
  var t0 = Date.now();
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  assert.equal(s.basketId, null);
  assert.equal(s.reason, 'server_unavailable');
  assert.ok(Date.now() - t0 < 1600);
  assert.equal((await pos.afterCardResult(s, false)).mechta, false);
  assert.equal(pos.stats().failOpen, 1);
  assert.ok(logs.indexOf('warn') !== -1);
});

test('сервер завис → модуль ждёт не дольше basketTimeoutMs', async function () {
  var hang = function () { return new Promise(function () {}); };
  var pos = Pos.createPosModule({ serverUrl: 'x', terminalId: 'T-1', fetch: hang, basketTimeoutMs: 200, catalog: { [BEER]: { category: 'alcohol' } } });
  var t0 = Date.now();
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  var dt = Date.now() - t0;
  assert.equal(s.reason, 'server_unavailable');
  assert.ok(dt >= 190 && dt < 600, 'ждали ' + dt + ' мс');
});

test('сервер отвечает ошибкой 400/500 → оплата идёт как обычно', async function () {
  var bad = function () { return Promise.resolve(new Response('{"error":"boom"}', { status: 500 })); };
  var pos = Pos.createPosModule({ serverUrl: 'x', terminalId: 'T-1', fetch: bad, catalog: { [BEER]: { category: 'alcohol' } } });
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  assert.equal(s.basketId, null);
});

test('мусор в чеке не роняет модуль', async function () {
  var pos = mod();
  var s = await pos.beforeCardPayment(null);
  assert.equal(s.reason, 'no_restricted_items');
  var s2 = await pos.beforeCardPayment([{ gtin: null }, {}, { category: 'nonsense', price: 5 }]);
  assert.equal(s2.reason, 'no_restricted_items');
});

test('справочник: загрузка с сервера, при сбое остаётся встроенный', async function () {
  var pos = mod();
  assert.equal(pos.lookup(BEER), null);
  var r = await pos.loadCatalog();
  assert.equal(r.ok, true);
  assert.equal(pos.lookup(BEER).category, 'alcohol');
  var off = Pos.createPosModule({ serverUrl: 'http://127.0.0.1:1', terminalId: 'T-1', catalog: { '1': { category: 'tobacco' } } });
  assert.equal((await off.loadCatalog()).ok, false);
  assert.equal(off.lookup('1').category, 'tobacco');
});

test('модуль выключен → ничего не отправляет', async function () {
  var calls = 0;
  var pos = Pos.createPosModule({ serverUrl: 'x', terminalId: 'T-1', enabled: false, fetch: function () { calls++; return new Promise(function () {}); }, catalog: { [BEER]: { category: 'alcohol' } } });
  var s = await pos.beforeCardPayment([{ gtin: BEER, price: 320 }]);
  assert.equal(s.reason, 'disabled');
  assert.equal(calls, 0);
});

test('без terminalId модуль не создаётся (ошибка конфигурации видна сразу)', function () {
  assert.throws(function () { Pos.createPosModule({ serverUrl: 'x' }); }, /terminalId/);
});

// ---------------------------------------------------------------- закрытие чеков

test('после отказа заменили пиво на сок той же цены → оплата проходит (старый чек закрыт)', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BREAD, sum: 189 }, { gtin: BEER, sum: 320 }]);
  var t = await terminal(509, 'mechta');
  assert.equal(t.approved, false);
  await pos.afterCardResult(s, false);
  var s2 = await pos.beforeCardPayment([{ gtin: BREAD, sum: 189 }, { gtin: '4810000000000', sum: 320 }]);
  assert.equal(s2.reason, 'no_restricted_items');
  assert.equal(s2.amount, 509);
  assert.equal((await terminal(509, 'mechta')).approved, true);
});

test('покупатель с обычной картой оплатил пиво → следующий с «Мечтой» и той же суммой не получает чужой отказ', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BEER, sum: 320 }]);
  assert.equal((await terminal(320, 'other')).approved, true);
  await pos.afterCardResult(s, true);
  await new Promise(function (r) { setTimeout(r, 50); }); // закрытие идёт в фоне
  var s2 = await pos.beforeCardPayment([{ gtin: BREAD, sum: 320 }]);
  assert.equal(s2.reason, 'no_restricted_items');
  assert.equal((await terminal(320, 'mechta')).approved, true);
});

test('кассир отменил чек (cancel) → тот же терминал и сумма больше не матчатся', async function () {
  var pos = mod(); await pos.loadCatalog();
  await pos.beforeCardPayment([{ gtin: BEER, sum: 320 }]);
  await pos.cancel();
  assert.equal((await terminal(320, 'mechta')).approved, true);
});

test('повтор той же корзины после отказа снова отказывает (новый чек); сейчас сервер считает копилку по каждой попытке — см. INTEGRATION.md', async function () {
  var pos = mod(); await pos.loadCatalog();
  var s = await pos.beforeCardPayment([{ gtin: BEER, sum: 320 }]);
  assert.equal((await terminal(320, 'mechta')).mechta.saved, 320);
  await pos.afterCardResult(s, false);
  var s2 = await pos.beforeCardPayment([{ gtin: BEER, sum: 320 }]);
  assert.notEqual(s2.basketId, s.basketId);
  var t2 = await terminal(320, 'mechta');
  assert.equal(t2.approved, false);
  var u = await (await fetch(base + '/api/users/u1')).json();
  assert.equal(u.savings, 640, 'поведение сервера-прототипа: каждая попытка засчитывается');
});
