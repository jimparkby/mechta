/*
 * Ядро сервера «Мечты».
 * Одна и та же логика работает в Node (server.js) и в браузере (демо без сервера).
 * Все суммы хранятся в копейках (целые числа), чтобы не было ошибок округления.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MechtaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Категории, которые пользователь может себе запретить.
  var CATEGORIES = {
    alcohol: { name: 'Алкоголь', hint: 'пиво, вино, крепкие напитки' },
    tobacco: { name: 'Табак', hint: 'сигареты, стики, вейпы' },
    energy: { name: 'Энергетики', hint: 'напитки с кофеином и таурином' },
    lottery: { name: 'Лотереи', hint: 'билеты и моментальные игры' }
  };

  // Демо-справочник «штрихкод (GTIN) → товар и категория». Коды условные.
  // В реальной системе категория маркированных товаров берётся из кода DataMatrix.
  var CATALOG = {
    '4810000000017': { name: 'Хлеб «Нарочанский»', price: 189, category: null },
    '4810000000024': { name: 'Молоко 3,2% 1 л', price: 249, category: null },
    '4810000000031': { name: 'Яблоки 1 кг', price: 315, category: null },
    '4810000000048': { name: 'Сигареты, пачка', price: 800, category: 'tobacco', marked: true },
    '4810000000055': { name: 'Пиво 0,5 л', price: 320, category: 'alcohol', marked: true },
    '4810000000062': { name: 'Вино красное 0,75 л', price: 1790, category: 'alcohol', marked: true },
    '4810000000079': { name: 'Энергетик 0,5 л', price: 290, category: 'energy' },
    '4810000000086': { name: 'Лотерейный билет', price: 500, category: 'lottery' }
  };

  var DEFAULT_WINDOW_MS = 2 * 60 * 1000; // чек ждёт оплату не дольше 2 минут

  function isPositiveInt(n) { return Number.isInteger(n) && n > 0; }

  function fail(message) {
    var e = new Error(message);
    e.status = 400;
    throw e;
  }

  /**
   * Модуль кассы: разбирает чек по справочнику.
   * items: [{ gtin, price, qty }], price — в копейках за штуку.
   * Возвращает итог чека и суммы по ограничиваемым категориям.
   */
  function classify(items, catalog) {
    catalog = catalog || CATALOG;
    var total = 0;
    var restricted = {};
    (items || []).forEach(function (it) {
      var qty = it.qty || 1;
      var sum = it.price * qty;
      total += sum;
      var entry = catalog[it.gtin];
      if (entry && entry.category) {
        restricted[entry.category] = (restricted[entry.category] || 0) + sum;
      }
    });
    return { total: total, restricted: restricted };
  }

  function createCore(opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };
    var windowMs = opts.windowMs || DEFAULT_WINDOW_MS;

    var users = {};   // userId → пользователь
    var cards = {};   // cardRef (внутренний номер карты в банке) → userId
    var baskets = {}; // basketId → чек от кассы
    var seq = 0;

    function purge() {
      var limit = now() - windowMs;
      Object.keys(baskets).forEach(function (id) {
        if (baskets[id].createdAt < limit) delete baskets[id];
      });
    }

    function requireUser(userId) {
      var u = users[userId];
      if (!u) { var e = new Error('Пользователь не найден'); e.status = 404; throw e; }
      return u;
    }

    function validateCategories(list) {
      if (!Array.isArray(list)) fail('blocked должен быть списком категорий');
      list.forEach(function (c) { if (!CATEGORIES[c]) fail('Неизвестная категория: ' + c); });
    }

    function publicUser(u) {
      return {
        userId: u.id,
        blocked: u.blocked.slice(),
        savings: u.savings,
        history: u.history.slice().reverse()
      };
    }

    return {
      /** Приложение: регистрация пользователя и привязка его карты. */
      registerUser: function (p) {
        if (!p || !p.userId || !p.cardRef) fail('Нужны userId и cardRef');
        validateCategories(p.blocked || []);
        users[p.userId] = { id: p.userId, cardRef: p.cardRef, blocked: (p.blocked || []).slice(), savings: 0, history: [] };
        cards[p.cardRef] = p.userId;
        return publicUser(users[p.userId]);
      },

      /** Приложение: пользователь меняет список запретов. */
      setBlocked: function (userId, blocked) {
        var u = requireUser(userId);
        validateCategories(blocked);
        u.blocked = blocked.slice();
        return publicUser(u);
      },

      /** Приложение: настройки, копилка и история. */
      getUser: function (userId) { return publicUser(requireUser(userId)); },

      /**
       * Касса → сервер (шаг 1). Касса шлёт чек, только если в нём есть
       * ограничиваемые товары. Данных карты и покупателя здесь нет.
       */
      submitBasket: function (p) {
        purge();
        if (!p || typeof p.terminalId !== 'string' || !p.terminalId) fail('Нужен terminalId');
        if (!isPositiveInt(p.amount)) fail('amount — сумма чека в копейках, целое число больше 0');
        var restricted = p.restricted || {};
        var cats = Object.keys(restricted);
        if (!cats.length) fail('В чеке нет ограничиваемых товаров, отправлять его не нужно');
        cats.forEach(function (c) {
          if (!CATEGORIES[c]) fail('Неизвестная категория: ' + c);
          if (!isPositiveInt(restricted[c])) fail('Сумма категории ' + c + ' должна быть в копейках');
        });
        var id = 'b' + (++seq);
        baskets[id] = {
          id: id,
          terminalId: p.terminalId,
          merchantId: p.merchantId || null,
          amount: p.amount,
          restricted: Object.assign({}, restricted),
          createdAt: now(),
          status: 'pending',
          declinedFor: [],
          savedTo: {}
        };
        return { basketId: id, expiresInSec: Math.round(windowMs / 1000) };
      },

      /**
       * Банк → сервер (шаги 4–5). Банк спрашивает про оплату картой «Мечта».
       * Сопоставление: тот же терминал, та же сумма, чек не старше окна ожидания.
       */
      authorize: function (p) {
        purge();
        if (!p || !p.cardRef || !p.terminalId || !isPositiveInt(p.amount)) fail('Нужны cardRef, terminalId и amount');
        var t = p.time || now();
        var userId = cards[p.cardRef];
        if (!userId) return { decision: 'APPROVE', reason: 'not_mechta_card' };
        var u = users[userId];

        var match = null;
        Object.keys(baskets).forEach(function (id) {
          var b = baskets[id];
          if (b.terminalId === p.terminalId && b.amount === p.amount && b.status !== 'paid' && b.status !== 'closed' &&
              b.createdAt <= t && b.createdAt >= t - windowMs) {
            if (!match || b.createdAt > match.createdAt) match = b;
          }
        });
        if (!match) return { decision: 'APPROVE', reason: 'no_restricted_basket' };

        var hits = Object.keys(match.restricted).filter(function (c) { return u.blocked.indexOf(c) !== -1; });
        if (!hits.length) {
          match.status = 'paid';
          return { decision: 'APPROVE', reason: 'not_blocked_by_user', basketId: match.id };
        }

        match.status = 'declined';
        match.declinedFor = hits;
        // В копилку — сумма запрещённых товаров, один раз на чек и пользователя.
        var saved = 0;
        if (!match.savedTo[userId]) {
          saved = hits.reduce(function (s, c) { return s + match.restricted[c]; }, 0);
          match.savedTo[userId] = true;
          u.savings += saved;
          u.history.push({ time: t, amount: saved, categories: hits });
        }
        return { decision: 'DECLINE', reason: 'blocked_category', categories: hits, basketId: match.id, saved: saved };
      },

      /** Касса → сервер (шаг 7): почему отказ и что убрать из чека. */
      basketStatus: function (basketId) {
        var b = baskets[basketId];
        if (!b) return { status: 'unknown' };
        var res = { status: b.status, categories: b.declinedFor.slice() };
        if (b.status === 'declined') {
          res.hint = 'Уберите из чека: ' + b.declinedFor.map(function (c) { return CATEGORIES[c].name.toLowerCase(); }).join(', ');
        }
        return res;
      },

      /**
       * Касса → сервер: чек больше не актуален (оплачен, изменён, покупатель ушёл).
       * Без этого старый чек с той же суммой на том же терминале мог бы
       * сработать на следующую оплату в пределах 2 минут.
       */
      closeBasket: function (basketId) {
        var b = baskets[basketId];
        if (!b) return { status: 'unknown' };
        b.status = 'closed';
        return { status: 'closed' };
      },

      /** Для демо: сколько чеков сейчас ждёт оплату. */
      pendingCount: function () { purge(); return Object.keys(baskets).length; }
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    CATALOG: CATALOG,
    DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
    classify: classify,
    createCore: createCore
  };
});
