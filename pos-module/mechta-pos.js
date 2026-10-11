/*
 * Модуль кассы «Мечта» (mechta-pos) — v0.1.0
 *
 * Встраивается в кассовую программу в момент «оплата картой», до отправки
 * суммы на терминал. Делает три вещи:
 *   1. по штрихкоду, коду маркировки или пометке в базе магазина находит
 *      ограничиваемые товары (алкоголь, табак, энергетики, лотереи);
 *   2. если такие есть — отправляет серверу «Мечты» номер терминала, сумму
 *      к оплате и суммы по категориям (шаг 1 схемы). Данных карты и
 *      покупателя модуль не знает и не передаёт;
 *   3. после отказа терминала спрашивает сервер, почему, и отдаёт кассе
 *      подсказку для кассира: что убрать из чека (шаг 7).
 *
 * Главное правило: модуль никогда не мешает оплате. Любая ошибка, таймаут
 * или недоступность сервера → оплата идёт как обычно.
 *
 * Без зависимостей. Работает в браузере, Node 18+ и любом JS-рантайме
 * с fetch и AbortController. Все суммы — в копейках (целые числа).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MechtaPos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1.0';

  var CATEGORIES = {
    alcohol: 'алкоголь',
    tobacco: 'табак',
    energy: 'энергетики',
    lottery: 'лотереи'
  };

  var DEFAULTS = {
    basketTimeoutMs: 1500,     // сколько ждать ответа на отправку чека
    statusTimeoutMs: 1000,     // таймаут одного запроса статуса
    statusPollMs: 250,         // пауза между опросами статуса
    statusPollTotalMs: 2500,   // сколько всего ждать решения после отказа терминала
    closeTimeoutMs: 500,       // сколько ждать закрытия прошлого чека перед новой оплатой
    catalogTimeoutMs: 3000,
    catalogRefreshMs: 6 * 60 * 60 * 1000 // обновлять справочник раз в 6 часов
  };

  // ---------------------------------------------------------------- коды

  var GS = '\u001d'; // разделитель полей GS1 (FNC1)

  /** Нормализует штрихкод: только цифры, GTIN-14 с ведущим 0 → GTIN-13. */
  function normalizeGtin(code) {
    if (code == null) return null;
    var s = String(code).replace(/\D/g, '');
    if (!s) return null;
    if (s.length === 14 && s.charAt(0) === '0') s = s.slice(1);
    return s;
  }

  /**
   * Разбирает то, что пришло со сканера: обычный штрихкод (EAN-13/8, UPC)
   * или код маркировки DataMatrix (GS1, с AI 01 или «короткий» код пачки).
   * Возвращает { gtin, marked, raw }. Сканер в режиме клавиатуры может
   * потерять символ GS и добавить префикс «]d2» / «]C1» — это учтено.
   */
  function parseScan(raw) {
    if (raw == null) return { gtin: null, marked: false, raw: raw };
    var s = String(raw).replace(/^\](d2|C1|Q3|e0)/, '').replace(/[\r\n]+$/, '');
    // Обычный штрихкод: только цифры, 8–14 знаков.
    if (/^\d{8,14}$/.test(s)) return { gtin: normalizeGtin(s), marked: false, raw: raw };
    // GS1 DataMatrix: AI 01 + 14 цифр GTIN, дальше серийный номер и т. д.
    var m = /^(?:\u001d)?01(\d{14})/.exec(s);
    if (m && s.length > 16) return { gtin: normalizeGtin(m[1]), marked: true, raw: raw };
    // Код пачки сигарет без AI: 14 цифр GTIN + серийный номер + код проверки.
    if (/^\d{14}[\x21-\x7e]{11,}$/.test(s) && s.indexOf(GS) === -1 && (s.length === 25 || s.length === 29)) {
      return { gtin: normalizeGtin(s.slice(0, 14)), marked: true, raw: raw };
    }
    return { gtin: null, marked: false, raw: raw };
  }

  // ---------------------------------------------------------------- разбор чека

  function lineSum(it) {
    if (Number.isInteger(it.sum)) return it.sum;
    var qty = it.qty == null ? 1 : it.qty;
    return Math.round((it.price || 0) * qty);
  }

  /**
   * Определяет категорию строки чека. Порядок источников:
   *   1. it.category — касса уже знает нашу категорию;
   *   2. it.group — группа товара в базе магазина, через opts.groupMap;
   *   3. справочник сервера по GTIN (из it.gtin или it.markCode).
   */
  function categoryOf(it, catalog, groupMap) {
    if (it.category && CATEGORIES[it.category]) return it.category;
    if (it.group != null && groupMap && groupMap[it.group] && CATEGORIES[groupMap[it.group]]) {
      return groupMap[it.group];
    }
    var gtin = normalizeGtin(it.gtin) || (it.markCode ? parseScan(it.markCode).gtin : null);
    var entry = gtin && catalog ? catalog[gtin] : null;
    if (entry && entry.category && CATEGORIES[entry.category]) return entry.category;
    return null;
  }

  /**
   * Разбирает чек. items: [{ gtin?, markCode?, category?, group?, price, qty?, sum? }]
   * sum — итог строки с учётом скидок (если касса его знает, лучше передавать).
   * Возвращает { total, restricted: {категория: копейки}, lines: [категория|null] }.
   */
  function classify(items, catalog, groupMap) {
    var total = 0, restricted = {}, lines = [];
    (items || []).forEach(function (it) {
      var sum = lineSum(it);
      total += sum;
      var cat = categoryOf(it, catalog, groupMap);
      lines.push(cat);
      if (cat && sum > 0) restricted[cat] = (restricted[cat] || 0) + sum;
    });
    return { total: total, restricted: restricted, lines: lines };
  }

  // ---------------------------------------------------------------- сеть

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function joinUrl(base, path) {
    if (!base) return path;
    return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
  }

  function createHttp(opts) {
    var f = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    if (!f) throw new Error('mechta-pos: нужен fetch (передайте opts.fetch)');
    return function call(method, path, body, timeoutMs) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer;
      var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          if (ctrl) ctrl.abort();
          var e = new Error('timeout ' + timeoutMs + ' мс'); e.code = 'TIMEOUT'; reject(e);
        }, timeoutMs);
      });
      var headers = { 'Accept': 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
      headers['X-Mechta-Pos'] = 'mechta-pos/' + VERSION;
      var req = f(joinUrl(opts.serverUrl, path), {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { /* не JSON */ }
          if (!r.ok) {
            var err = new Error((j && j.error) || ('HTTP ' + r.status)); err.code = 'HTTP_' + r.status; err.status = r.status;
            throw err;
          }
          return j;
        });
      });
      return Promise.race([req, timeout]).then(
        function (v) { clearTimeout(timer); return v; },
        function (e) { clearTimeout(timer); throw e; }
      );
    };
  }

  // ---------------------------------------------------------------- модуль

  /**
   * Создаёт модуль для одной кассы.
   * opts:
   *   serverUrl   — адрес сервера «Мечты» ('' — тот же хост);
   *   terminalId  — номер платёжного терминала (TID), обязателен;
   *   merchantId  — номер магазина у эквайера (MID), необязателен;
   *   apiKey      — ключ кассы (пилот), необязателен;
   *   catalog     — встроенный справочник { gtin: { category } } на случай, если сервер недоступен;
   *   groupMap    — соответствие групп товаров в базе магазина нашим категориям, { 'ALC': 'alcohol' };
   *   enabled     — выключатель модуля (по умолчанию true);
   *   fetch, log, now — для тестов и встраивания.
   */
  function createPosModule(opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    if (!opts.terminalId || typeof opts.terminalId !== 'string') throw new Error('mechta-pos: нужен terminalId (строка)');
    var http = createHttp(opts);
    var log = opts.log || function () {};
    var now = opts.now || function () { return Date.now(); };

    var catalog = Object.assign({}, opts.catalog || {});
    var catalogVersion = null;
    var catalogLoadedAt = 0;
    var stats = { baskets: 0, skipped: 0, failOpen: 0, declinedByMechta: 0, declinedOther: 0 };
    var openBasketId = null; // чек, отправленный серверу и ещё не закрытый

    /**
     * Закрывает чек на сервере: он больше не должен совпасть ни с какой оплатой.
     * Ошибки глотаются — сервер всё равно забудет чек через 2 минуты.
     */
    function closeBasket(id) {
      if (!id) return Promise.resolve();
      if (openBasketId === id) openBasketId = null;
      return http('DELETE', 'api/baskets/' + encodeURIComponent(id), null, opts.closeTimeoutMs)
        .catch(function (e) { log('warn', 'чек не закрыт', { basketId: id, error: e.message }); });
    }

    function categoryNames(list) {
      return list.map(function (c) { return CATEGORIES[c] || c; }).join(', ');
    }

    /** Загружает справочник штрихкодов с сервера. Ошибка не страшна — остаётся прошлый. */
    function loadCatalog() {
      return http('GET', 'api/catalog', null, opts.catalogTimeoutMs).then(function (j) {
        var items = (j && (j.items || j.catalog)) || j || {};
        var next = {};
        Object.keys(items).forEach(function (g) {
          var e = items[g];
          var cat = typeof e === 'string' ? e : e && e.category;
          var key = normalizeGtin(g);
          if (key) next[key] = { category: cat || null, name: e && e.name };
        });
        catalog = Object.assign({}, opts.catalog || {}, next);
        catalogVersion = (j && j.version) || null;
        catalogLoadedAt = now();
        log('info', 'справочник загружен', { size: Object.keys(next).length, version: catalogVersion });
        return { ok: true, size: Object.keys(catalog).length, version: catalogVersion };
      }).catch(function (e) {
        log('warn', 'справочник не загружен, работаю со старым', { error: e.message });
        return { ok: false, size: Object.keys(catalog).length, error: e.message };
      });
    }

    function maybeRefreshCatalog() {
      if (now() - catalogLoadedAt > opts.catalogRefreshMs) loadCatalog();
    }

    /**
     * Шаг 1. Вызывать, когда кассир выбрал «оплата картой», ДО отправки суммы на терминал.
     *   items  — строки чека;
     *   amount — сумма, которая уйдёт на терминал, в копейках. Если не передана,
     *            считается по строкам. При смешанной оплате — только карточная часть.
     * Никогда не бросает исключений. Возвращает сессию оплаты:
     *   { basketId|null, amount, restricted, lines, sent, reason }
     * Модуль ждёт ответа сервера не дольше basketTimeoutMs; после этого касса
     * в любом случае отправляет сумму на терминал.
     */
    function beforeCardPayment(items, amount) {
      var session = { basketId: null, amount: 0, restricted: {}, lines: [], sent: false, reason: '' };
      try {
        if (opts.enabled === false) { session.reason = 'disabled'; return Promise.resolve(session); }
        // Прошлый чек (отказ, смена товаров, ушедший покупатель) закрываем ДО новой суммы на
        // терминале: иначе при той же сумме сервер снова найдёт его и откажет по ошибке.
        if (openBasketId) return closeBasket(openBasketId).then(function () { return beforeCardPayment(items, amount); });
        maybeRefreshCatalog();
        var cls = classify(items, catalog, opts.groupMap);
        session.lines = cls.lines;
        session.restricted = cls.restricted;
        session.amount = Number.isInteger(amount) ? amount : cls.total;
        if (!Object.keys(cls.restricted).length) {
          stats.skipped++;
          session.reason = 'no_restricted_items';
          return Promise.resolve(session);
        }
        if (!(session.amount > 0)) { session.reason = 'zero_amount'; return Promise.resolve(session); }
        var body = { terminalId: opts.terminalId, amount: session.amount, restricted: cls.restricted };
        if (opts.merchantId) body.merchantId = opts.merchantId;
        return http('POST', 'api/baskets', body, opts.basketTimeoutMs).then(function (j) {
          session.basketId = j && j.basketId ? String(j.basketId) : null;
          session.sent = !!session.basketId;
          if (session.sent) openBasketId = session.basketId;
          session.reason = session.sent ? 'sent' : 'bad_response';
          if (session.sent) stats.baskets++; else stats.failOpen++;
          log('info', 'чек отправлен', { basketId: session.basketId, amount: session.amount, restricted: cls.restricted });
          return session;
        }).catch(function (e) {
          stats.failOpen++;
          session.reason = 'server_unavailable';
          session.error = e.message;
          log('warn', 'сервер «Мечты» не ответил, оплата идёт как обычно', { error: e.message });
          return session;
        });
      } catch (e) {
        stats.failOpen++;
        session.reason = 'module_error';
        session.error = e.message;
        log('error', 'ошибка модуля, оплата идёт как обычно', { error: e.message });
        return Promise.resolve(session);
      }
    }

    /**
     * Шаг 7. Вызывать после ответа терминала.
     *   session  — то, что вернул beforeCardPayment;
     *   approved — true, если терминал одобрил оплату.
     * Возвращает:
     *   { mechta: false } — отказ не от «Мечты» (нет денег и т. п.) или оплата прошла;
     *   { mechta: true, categories, hint, removeLines: [индексы строк] } — отказ «Мечты».
     * Никогда не бросает исключений.
     */
    function afterCardResult(session, approved) {
      var none = { mechta: false, categories: [], hint: null, removeLines: [] };
      if (!session || !session.basketId) {
        if (!approved) stats.declinedOther++;
        return Promise.resolve(none);
      }
      if (approved) {
        // Оплата прошла: чек больше не нужен (важно для обычной карты — там сервер его не трогал).
        closeBasket(session.basketId);
        return Promise.resolve(none);
      }
      var deadline = now() + opts.statusPollTotalMs;
      function poll() {
        return http('GET', 'api/baskets/' + encodeURIComponent(session.basketId), null, opts.statusTimeoutMs)
          .then(function (st) {
            if (st && st.status === 'declined' && st.categories && st.categories.length) {
              stats.declinedByMechta++;
              var cats = st.categories.filter(function (c) { return CATEGORIES[c]; });
              var removeLines = [];
              session.lines.forEach(function (c, i) { if (c && cats.indexOf(c) !== -1) removeLines.push(i); });
              return {
                mechta: true,
                categories: cats,
                hint: st.hint || ('Уберите из чека: ' + categoryNames(cats)),
                cashierText: 'Карта «Мечта»: покупатель запретил себе ' + categoryNames(cats) +
                  '. Уберите эти товары и повторите оплату — можно той же картой.',
                removeLines: removeLines
              };
            }
            if (st && st.status === 'pending' && now() < deadline) {
              return sleep(opts.statusPollMs).then(poll);
            }
            stats.declinedOther++;
            closeBasket(session.basketId);
            return none;
          })
          .catch(function (e) {
            if (now() < deadline && e.code === 'TIMEOUT') return poll();
            log('warn', 'не удалось узнать причину отказа', { error: e.message });
            stats.declinedOther++;
            closeBasket(session.basketId);
            return none;
          });
      }
      return poll();
    }

    /** Помощник: убирает из чека строки, указанные в removeLines. */
    function removeLines(items, indexes) {
      var drop = {};
      (indexes || []).forEach(function (i) { drop[i] = true; });
      return (items || []).filter(function (_, i) { return !drop[i]; });
    }

    /** Кассир отменил чек или покупатель ушёл: закрыть открытый чек на сервере. */
    function cancel() { return closeBasket(openBasketId); }

    return {
      version: VERSION,
      loadCatalog: loadCatalog,
      cancel: cancel,
      classify: function (items) { return classify(items, catalog, opts.groupMap); },
      beforeCardPayment: beforeCardPayment,
      afterCardResult: afterCardResult,
      removeLines: removeLines,
      catalogSize: function () { return Object.keys(catalog).length; },
      lookup: function (gtin) { return catalog[normalizeGtin(gtin)] || null; },
      stats: function () { return Object.assign({}, stats); }
    };
  }

  return {
    VERSION: VERSION,
    CATEGORIES: CATEGORIES,
    parseScan: parseScan,
    normalizeGtin: normalizeGtin,
    classify: classify,
    createPosModule: createPosModule
  };
});
