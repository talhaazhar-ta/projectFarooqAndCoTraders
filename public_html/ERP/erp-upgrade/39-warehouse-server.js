/* ════════════════════════════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — WAREHOUSE APP · MODULE 39
   THE WAREHOUSE APP ON THE SERVER DATABASE

   The Warehouse app (farooq-co-warehouse-pwa.html) used to keep its own copy of the stock in the browser
   (`farooqco_erp_v1`), and the office app overwrote it from its own tables — so what the warehouse "received" and
   "dispatched" never reached the real stock. Now, when the server says `data_backend` = 'server', the Warehouse
   app reads the company database (the same one the office uses) and writes to it through the SAME driver
   (01b-server-db.js: atomic, revision-checked commits, append-only audit log). This file is only the part that is
   specific to the Warehouse app: which stores it needs, and the two operations it can do.

   WHAT A WAREHOUSE ENTRY BECOMES (byte-for-byte the records the office screens make — 07-transactions.js StockDocs.save;
   test-warehouse-server.mjs runs both and compares them, so the two cannot drift apart unnoticed):
     · "Receive stock"  → a RECEIVE stock document (RCV-…): its lines, one ADJUSTMENT_IN movement per line, the stock row,
                          an audit row. It adds BAGS ONLY — the supplier's bill (money) is entered in the office.
     · "Dispatch stock" → a DISPATCH stock document (DSP-…): one DISPATCH_OUT movement per line and the stock row. If the
                          load is for an invoice that ALREADY took the bags out of stock, the document is linked to it and
                          stock is NOT taken out a second time (the same rule as the office's Dispatch screen); otherwise the
                          dispatch takes the bags out itself.

   RULES (same spirit as 01b-server-db.js):
     1. Never guess. If the server cannot be reached the app says so; it never falls back to the old browser copy.
     2. Nothing is "saved on this device to upload later": a save is one commit to the server, or it did not happen. (The old
        offline queue was never persisted and never uploaded — a dispatch made without a signal was simply lost.)
     3. The stock rows and the number counters are re-read from the server at the start of every save (SD.hot), so the
        checks ("only N bags available") are made against the truth, and two people saving at once can never take the same
        number or push a shelf below zero (the server also checks each row's revision — the second save is refused).
     4. While a save is running the app does not refresh itself under the user's hands; it catches up right after.
   ════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var FDB = global.FDB, M = global.Money;
if (!FDB || !FDB.server || !M) return;
var SD = FDB.server;

var WH = global.FcWH = {
  active: false,      /* true once this page runs on the server database */
  busy: false,        /* a save is in flight */
  stale: false,       /* somebody else has saved since we last looked */
  user: null,         /* { id, role, name, username } from the server */
  skipped: 0,         /* records left out because their id could not be used safely on the page */
  onChange: null      /* called when the server has news (the page decides when to repaint) */
};

var STICKY_KEY = 'farooqco_backend';                 /* same key as 01b: a device that has run on the server never falls back */
var BASE = ['products', 'warehouses', 'regions', 'customers', 'suppliers', 'inventory', 'business', 'sequences'];
var RECENT = 40;                                     /* the history list shows the newest movements only */
var TYPES = {
  RECEIVE:  { seq: 'RCV', title: 'Stock received', out: false },
  DISPATCH: { seq: 'DSP', title: 'Dispatch',       out: true }
};

/* ── small helpers ───────────────────────────────────────────────────────── */
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function nowISO() { return new Date().toISOString(); }
function todayISO() {                                 /* the LOCAL date (toISOString() would say yesterday in Pakistan until 05:00) */
  var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function who() { var u = SD.user || WH.user; return (u && (u.name || u.username)) || 'Warehouse'; }
function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9._:\-]{1,120}$/.test(id); }   /* ids are printed inside attributes unescaped */
function ikey(pid, wid) { return pid + '|' + wid; }
function rows(store) { return SD.rows(store); }
function clock(iso) {
  var d = new Date(iso); if (isNaN(d.getTime())) return 'earlier';
  var now = new Date();
  if (d.toDateString() === now.toDateString()) {
    var h = d.getHours(), ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
    return h + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() + ' ' + ap;
  }
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}

/* ── the model the page shows (built from the driver's cache) ───────────── */
WH.model = function () {
  var skipped = 0;
  function keep(r) { if (safeId(r.id)) return true; skipped++; return false; }
  var raw = { products: {}, warehouses: {}, regions: {}, customers: {} };

  var products = rows('products').filter(function (p) { return keep(p) && p.active !== false; }).map(function (p) {
    raw.products[p.id] = p;
    return { id: p.id, ur: esc(p.ur || p.name || ''), en: esc(p.en || p.nameEn || ''), cat: esc(p.cat || p.category || ''),
             kg: p.kg || null, min: p.min === undefined ? null : p.min, sourceFolio: esc(p.sourceFolio || ''), normalizedName: esc(p.normalizedName || '') };
  });
  var warehouses = rows('warehouses').filter(function (w) { return keep(w) && w.active !== false; }).map(function (w) {
    raw.warehouses[w.id] = w; return { id: w.id, name: esc(w.name || w.id) };
  });
  var regions = rows('regions').filter(function (r) { return keep(r) && r.active !== false && !r.deleted; }).map(function (r) {
    raw.regions[r.id] = r; return { id: r.id, ur: esc(r.ur || ''), en: esc(r.en || '') };
  });
  var shops = rows('customers').filter(function (c) { return keep(c) && c.active !== false; }).map(function (c) {
    raw.customers[c.id] = c; return { id: c.id, sh: esc(c.sh || c.nameUr || c.id), region: c.region || null, wa: c.wa || '' };
  });
  var suppliers = rows('suppliers').filter(function (s) { return keep(s) && s.active !== false; }).map(function (s) {
    return { id: s.id, name: esc(s.co || s.nameUr || s.id) };
  }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  var stock = {};
  rows('inventory').forEach(function (r) { if (r.productId && r.warehouseId) stock[ikey(r.productId, r.warehouseId)] = Number(r.qty) || 0; });

  var history = rows('stockMovements').filter(function (m) { return m.bucket !== 'damaged' && Number(m.qtyDelta); })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; })
    .slice(0, RECENT).map(function (m) {
      return { t: m.qtyDelta > 0 ? 'in' : 'out', pid: m.productId, wid: m.warehouseId, qty: Math.abs(m.qtyDelta),
               who: esc(m.note || m.ref || m.kind || ''), region: null, when: clock(m.createdAt), today: new Date(m.createdAt).toDateString() === new Date().toDateString() };
    });

  var biz = rows('business')[0] || {};
  WH.skipped = skipped;
  return { products: products, warehouses: warehouses, regions: regions, shops: shops, suppliers: suppliers, stock: stock, history: history,
           allowNegative: !!biz.allowNegativeStock, user: who(), raw: raw };
};

/* ── start-up, refresh ──────────────────────────────────────────────────── */
function load() {
  return Promise.all([SD.loadPartial(BASE), SD.loadPartial(['stockMovements'], { recent: RECENT })]).then(function () {
    if (!rows('products').length || !rows('warehouses').length) {
      throw new Error('The company data on the server has no products or warehouses yet.');
    }
  });
}
function onStale() { WH.stale = true; if (typeof WH.onChange === 'function') { try { WH.onChange(); } catch (e) {} } }

/* Resolves 'server' or 'browser'. 'browser' = the switch is off (or there is no server API): the page keeps its old behaviour. */
WH.start = function () {
  return SD._decide().then(function (mode) {
    if (mode !== 'server') return 'browser';
    return FDB.open().then(function () {
      if (SD.hot.indexOf('inventory') < 0) SD.hot.push('inventory');
      SD.onStale = onStale;
      return load();
    }).then(function () {
      try { global.localStorage.setItem(STICKY_KEY, 'server'); } catch (e) {}
      WH.active = true; WH.user = SD.user;
      return 'server';
    });
  });
};
/* catch up with what other people saved (never while a save is running) */
WH.refresh = function () {
  if (!WH.active || WH.busy) return Promise.resolve(false);
  return load().then(function () { WH.stale = false; return true; });
};
WH.online = function () { return !(global.navigator && global.navigator.onLine === false); };

/* the shop's invoices (for "which invoice is this load for?") — read on demand, not at start-up */
WH.invoicesFor = function (customerId) {
  return SD.loadPartial(['invoices'], { aux: true }).then(function () {
    return rows('invoices').filter(function (i) { return safeId(i.id) && i.customerId === customerId && i.status !== 'DRAFT' && i.status !== 'CANCELLED'; })
      .sort(function (a, b) { return String(b.invoiceDate || '') < String(a.invoiceDate || '') ? -1 : 1; }).slice(0, 30)
      .map(function (i) { return { id: i.id, no: esc(i.invoiceNumber || ''), date: esc(i.invoiceDate || ''), bags: Number(i.totalQty) || 0, dispatched: esc(i.dispatchNumber || ''), taken: !!i.stockApplied }; });
  });
};

/* ── the two operations ─────────────────────────────────────────────────── */
function refuse(errs) { return Promise.reject({ validation: errs }); }

/* draft: { warehouseId, items:[{productId, quantity}], clientOpId, date?,
            RECEIVE: reason (required), notes?   ·   DISPATCH: customerId (required), invoiceId?, vehicleNo?, driver? }        */
WH.post = function (type, draft) {
  var def = TYPES[type];
  if (!WH.active) return refuse(['The Warehouse app is not connected to the server database.']);
  if (!def) return refuse(['Unknown stock document type.']);
  if (WH.busy) return refuse(['A save is already in progress.']);
  if (!WH.online()) return refuse(['There is no internet connection, so nothing was saved. Connect and try again.']);

  var m = WH.model(), errs = [];
  if (!draft.warehouseId || !m.raw.warehouses[draft.warehouseId]) errs.push('Choose a warehouse.');
  if (type === 'DISPATCH' && (!draft.customerId || !m.raw.customers[draft.customerId])) errs.push('Choose the shop the load is going to.');
  if (type === 'RECEIVE' && !draft.reason) errs.push('Give a reason for adding this stock.');
  var lines = (draft.items || []).filter(function (l) { return l && l.productId; });
  if (!lines.length) errs.push('Add at least one product line.');
  lines.forEach(function (l, n) {
    var p = m.raw.products[l.productId];
    if (!p) errs.push('Line ' + (n + 1) + ': that product no longer exists.');
    else if (!(M.qty(l.quantity) > 0)) errs.push('Line ' + (n + 1) + ' (' + (p.en || p.ur) + '): quantity must be more than zero.');
  });
  if (errs.length) return refuse(errs);

  var id = draft.id || FDB.uid('sd');
  var opId = (draft.clientOpId || id) + '#0';
  WH.busy = true;
  var finish = function () { WH.busy = false; };

  /* the invoice (if the load is for one) is re-read first, so the link is checked against what the server holds now */
  var pre = draft.invoiceId ? SD.loadPartial(['invoices'], { aux: true }) : Promise.resolve();
  return pre.then(function () {
    return FDB.tx(['sequences', 'stockDocs', 'stockDocItems', 'inventory', 'stockMovements', 'auditLog', 'operations', 'invoices'], function (api) {
      return FDB.claimOperation(api, opId, 'StockDoc:' + type, { entityId: id }).then(function () {
        return Promise.all([
          FDB.nextNumber(api, def.seq),
          draft.invoiceId ? api.get('invoices', draft.invoiceId) : Promise.resolve(null),
          api.all('inventory')
        ]);
      }).then(function (got) {
        var number = got[0], inv = got[1], inventory = got[2];
        var fresh = {}; inventory.forEach(function (r) { fresh[r.id] = r; });
        var bizRows = rows('business'); var allowNeg = !!(bizRows[0] && bizRows[0].allowNegativeStock);
        var user = who();

        if (draft.invoiceId) {
          if (!inv) throw { validation: ['That invoice no longer exists.'] };
          if (type !== 'DISPATCH' || inv.customerId !== draft.customerId) throw { validation: ['That invoice belongs to a different shop.'] };
          if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') throw { validation: ['A draft or cancelled invoice cannot be dispatched against.'] };
        }
        /* a dispatch against an invoice that already moved the stock must not move it a second time (same rule as StockDocs.save) */
        var deduct = type !== 'DISPATCH' || !(inv && inv.stockApplied);

        function row(pid, wid) {
          var k = ikey(pid, wid);
          if (!fresh[k]) fresh[k] = { id: k, productId: pid, warehouseId: wid, qty: 0, damagedQty: 0, avgCostP: 0 };
          return fresh[k];
        }
        function costOf(pid, wid) {                               /* Inventory.costOf */
          var r = row(pid, wid); if (r.avgCostP) return r.avgCostP;
          var any = 0; Object.keys(fresh).forEach(function (k) { if (fresh[k].productId === pid && fresh[k].avgCostP) any = any || fresh[k].avgCostP; });
          if (any) return any;
          var p = m.raw.products[pid]; return p && p.buy ? M.toP(p.buy) : 0;
        }

        /* stock check, per product (several lines of one product are added first) — only when this dispatch takes the bags out */
        if (type === 'DISPATCH' && deduct && !allowNeg) {
          var demand = {}; lines.forEach(function (l) { demand[l.productId] = (demand[l.productId] || 0) + M.qty(l.quantity); });
          var short = [];
          Object.keys(demand).forEach(function (pid) {
            var have = row(pid, draft.warehouseId).qty;
            if (demand[pid] > have) { var p = m.raw.products[pid] || {}; short.push('Only ' + have + ' bags of ' + (p.en || p.ur || pid) + ' are available in ' + m.raw.warehouses[draft.warehouseId].name + '. Requested: ' + demand[pid] + '.'); }
          });
          if (short.length) throw { validation: short };
        }

        var c = draft.customerId ? m.raw.customers[draft.customerId] : null, rg = c && c.region ? m.raw.regions[c.region] : null;
        var whN = m.raw.warehouses[draft.warehouseId].name;
        var rec = {
          id: id, docNumber: number, type: type, clientOpId: draft.clientOpId || id,
          docDate: draft.date || todayISO(),
          warehouseId: draft.warehouseId, warehouseSnapshot: whN,
          toWarehouseId: null, toWarehouseSnapshot: '',
          customerId: draft.customerId || null, customerSnapshot: c ? c.sh : '',
          regionSnapshot: rg ? rg.ur + ' — ' + rg.en : '',
          invoiceId: draft.invoiceId || null, invoiceNumber: inv ? inv.invoiceNumber : '',
          stockApplied: deduct,
          vehicleNo: (draft.vehicleNo || '').toUpperCase(), driver: draft.driver || '',
          reason: draft.reason || '', notes: draft.notes || '',
          totalQty: 0, lineCount: 0, status: 'POSTED',
          createdBy: user, createdAt: nowISO()
        };
        var qty = 0;
        lines.forEach(function (l, ix) {
          var p = m.raw.products[l.productId], q = M.qty(l.quantity);
          var unitCostP = costOf(l.productId, draft.warehouseId);
          var extraNow = (function () {                           /* Inventory.rawExtraOf */
            var x = p.extraP !== undefined && p.extraP !== null ? Number(p.extraP) : (p.extra ? M.toP(p.extra) : 0);
            return x > 0 ? x : 0;
          })();
          var sdItem = {                                          /* snapshot() in 07-transactions.js */
            id: FDB.uid('sdi'), docId: rec.id, sortOrder: ix, direction: def.out ? 'OUT' : 'IN',
            warehouseId: draft.warehouseId, toWarehouseId: null, reason: rec.reason, fromDamaged: false, unitCostP: unitCostP,
            productId: l.productId, descriptionSnapshot: p.ur || p.en || '', descriptionEnSnapshot: p.en || '',
            brandSnapshot: p.brandEn || p.brand || '', categorySnapshot: p.cat || '', packageSnapshot: p.kg ? p.kg + ' KG' : 'Bag',
            skuSnapshot: p.sku || p.sourceFolio || p.id || '', unit: 'Bag', quantity: q, batchNo: '', notes: ''
          };
          if (type === 'RECEIVE') { sdItem.extraUnitP = extraNow; }   /* the office's receipt line keeps it too (StockDocs.save). No sellUnitP any more (§27, 2026-09-28) — selling price is set only on the product's Prices screen, never blended per row. */
          api.put('stockDocItems', sdItem);
          qty += q;
          if (type === 'RECEIVE' || deduct) {                     /* Inventory.apply */
            var r = row(l.productId, draft.warehouseId), delta = type === 'RECEIVE' ? q : -q;
            if (type === 'RECEIVE') {                              /* Inventory.apply: blend in the extra cost of the bags coming in */
              var exPrev = typeof r.avgExtraP === 'number' ? r.avgExtraP : extraNow;
              r.avgExtraP = r.qty > 0 ? Math.round((r.qty * exPrev + delta * extraNow) / (r.qty + delta)) : extraNow;
              /* §26, 2026-09-28: the office's Inventory.apply now blends avgCostP for a stock receipt too
                 (not just a purchase) — this warehouse-app mirror must match it (test-warehouse-server.mjs
                 is the drift guard), since unitCostP here already comes from the same costOf fallback. */
              r.avgCostP = r.qty > 0 && r.avgCostP > 0 ? Math.round((r.qty * r.avgCostP + delta * unitCostP) / (r.qty + delta)) : unitCostP;
            }
            r.qty = Math.round((r.qty + delta) * 1000) / 1000;
            api.put('inventory', r);
            api.put('stockMovements', {
              id: FDB.uid('mv'), createdAt: nowISO(), date: rec.docDate, productId: l.productId, warehouseId: draft.warehouseId,
              kind: type === 'RECEIVE' ? 'ADJUSTMENT_IN' : 'DISPATCH_OUT', qtyDelta: delta, bucket: 'stock', balanceAfter: r.qty,
              ref: number, refType: type === 'RECEIVE' ? 'STOCK_RECEIPT' : 'DISPATCH',
              note: type === 'RECEIVE' ? rec.reason : rec.customerSnapshot, unitCostP: type === 'RECEIVE' ? unitCostP : 0, userId: user
            });
          }
        });
        rec.totalQty = qty; rec.lineCount = lines.length;
        api.put('stockDocs', rec);
        if (type === 'DISPATCH' && inv) {                          /* the invoice knows its dispatch (same as the office's screen) */
          inv.dispatchNumber = number;
          if (inv.status === 'CONFIRMED') inv.status = 'DISPATCHED';
          inv.updatedAt = nowISO();
          api.put('invoices', inv);
        }
        var audit = { id: FDB.uid('aud'), createdAt: nowISO(), date: todayISO(), userId: user, action: def.title + ' posted', entity: 'StockDoc',
          entityId: rec.id, ref: number, oldValues: null, newValues: { type: type, lines: rec.lineCount, qty: qty, stockMoved: type === 'DISPATCH' ? deduct : true },
          reason: rec.reason, userName: user, userRole: (SD.user && SD.user.role) || '', source: 'Warehouse app' };   /* userName/userRole: what 22-users.js adds to every audit row */
        api.put('auditLog', audit);
        return { doc: rec, stockAfter: lines.map(function (l) { return { productId: l.productId, warehouseId: draft.warehouseId, qty: row(l.productId, draft.warehouseId).qty }; }) };
      });
    });
  }).then(function (r) { finish(); return r; }, function (e) { finish(); throw e; });
};

})(typeof window !== 'undefined' ? window : globalThis);
