/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 21
   PRICES AND SETTINGS
   Rice and flour prices move with the market, so they belong in the hands of
   whoever is watching the market — not in the code. Every change is kept:
   what it was, what it became, who changed it and why. And the settings that
   used to be five stacked cards become one control panel.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var ERP = global.ERP, M = global.Money, FDB = global.FDB, D = global.document;
var S = ERP.S;
var I = function (n) { return global.I ? global.I(n) : ''; };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function u(t) { return global.u ? global.u(t) : esc(t); }
function say(m) { return global.say ? global.say(m) : null; }
function nowISO() { return new Date().toISOString(); }
function who() { return global.CURRENT_USER || 'Owner'; }
function role() { return ERP.RBAC ? ERP.RBAC.role() : 'OWNER'; }
function fmtDate(x) { return global.fmtDate ? global.fmtDate(x) : x; }
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var s = String(v).replace(/[^\d.\-]/g, '');
  /* nothing numeric left ("abc", "-", ".") is not a number — it used to read as 0,
     which silently cleared a price or cost the person meant to leave alone */
  if (!/\d/.test(s)) return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   1 · PRICES
   ══════════════════════════════════════════════════════════════════════════ */
var FIELDS = [
  { key: 'buy',        label: 'Purchase price',        money: true },
  { key: 'extra',      label: 'Extra cost per bag',    money: true },
  { key: 'sell',       label: 'Selling price',         money: true },
  { key: 'min',        label: 'Minimum selling price', money: true },
  { key: 'wholesale',  label: 'Wholesale price',       money: true },
  { key: 'retail',     label: 'Retail price',          money: true },
  { key: 'discountPct',label: 'Discount %',            money: false },
  { key: 'taxPct',     label: 'Tax %',                 money: false },
  { key: 'reorder',    label: 'Stock alert level',     money: false }
];
var FIELD_BY_KEY = {};
FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

/* What one bag costs us to have in the godown, and what a sale at `sellP` leaves.
   The purchase price is what the mill charges; the extra cost is what WE pay to
   get it here (transport, labour, loading) — it is not on the supplier's bill, so
   it never touches a supplier balance. Shared by the panel, its live line and
   Prices.of so they cannot disagree. All figures in paisa. */
function figures(buyP, extraP, sellP, chargeP) {
  var costP = (buyP || 0) + (chargeP || 0) + (extraP || 0);     /* chargeP: per-bag charges already typed on the purchase */
  var profit = (sellP || 0) - costP;
  return {
    cost: costP, profit: profit,
    margin: sellP ? Math.round(profit / sellP * 1000) / 10 : 0,
    markup: costP ? Math.round(profit / costP * 1000) / 10 : 0
  };
}

/* shared write path for Prices.setCost — a request goes through Prices.request instead when approval is
   required; otherwise applies immediately and records history + audit, same shape as Prices.set's own tx. */
function applySetCost(productId, p, changes, opts) {
  if (!opts.approving && ERP.Prices.approvalRequired()) return ERP.Prices.request(productId, changes, opts.reason);
  return FDB.tx(['products', 'priceHistory', 'auditLog'], function (api) {
    changes.forEach(function (c) {
      if (c.field === 'costOverride') p.costOverrideP = c.to > 0 ? c.to : null;
      else if (c.field === 'extra') { p.extraP = c.to; p.extra = M.toR(c.to); }
      var h = {
        id: FDB.uid('ph'), productId: productId, productName: p.en || p.ur || productId,
        field: c.field, fieldLabel: c.label, oldValue: c.from, newValue: c.to, money: c.money,
        reason: opts.reason || '', changedBy: opts.approvedFor || who(),
        changedByRole: opts.approvedForRole || role(),
        approvedBy: opts.approving ? who() : null, approvedByRole: opts.approving ? role() : null,
        changedAt: nowISO(), effectiveDate: opts.date || nowISO().slice(0, 10)
      };
      api.put('priceHistory', h);
      (S.priceHistory = S.priceHistory || []).unshift(h);
    });
    api.put('products', p);
    ERP.Audit.write(api, {
      action: 'Product cost updated', entity: 'Product', entityId: productId, ref: p.en || p.ur,
      oldValues: changes.reduce(function (a, c) { a[c.field] = c.money ? M.toR(c.from) : c.from; return a; }, {}),
      newValues: changes.reduce(function (a, c) { a[c.field] = c.money ? M.toR(c.to) : c.to; return a; }, {}),
      reason: opts.reason || ''
    });
  }).then(function () {
    if (ERP.markMasterDirty) ERP.markMasterDirty();
    try { global.dbSave(); } catch (e) {}
    return { changes: changes, applied: true };
  });
}

var Prices = ERP.Prices = {
  fields: FIELDS,
  history: function (productId) {
    return (S.priceHistory || []).filter(function (h) { return h.productId === productId; })
      .sort(function (a, b) { return a.changedAt < b.changedAt ? 1 : -1; });
  },
  pending: function (productId) {
    return (S.priceApprovals || []).filter(function (a) {
      return a.status === 'PENDING' && (!productId || a.productId === productId);
    });
  },
  approvalRequired: function () {
    var cfg = ERP.Settings.get();
    if (!cfg.priceApproval) return false;
    var role = ERP.RBAC ? ERP.RBAC.role() : 'OWNER';
    return role !== 'OWNER' && role !== 'MANAGER';
  },
  canApprove: function () {
    var role = ERP.RBAC ? ERP.RBAC.role() : 'OWNER';
    return role === 'OWNER' || role === 'MANAGER';
  },

  /* what a product currently costs and sells for, with everything derived */
  of: function (productId) {
    var p = global.prodOf ? global.prodOf(productId) : null;
    if (!p) return null;
    var ctx = ERP.Mapping && ERP.Mapping.context ? ERP.Mapping.context(productId) : {};
    var buyP = p.buyP !== undefined && p.buyP !== null ? p.buyP
      : (p.buy ? M.toP(p.buy) : (ctx.averageCost || 0));
    var sellP = p.sellP !== undefined && p.sellP !== null ? p.sellP : (p.sell ? M.toP(p.sell) : 0);
    var extraP = p.extraP !== undefined && p.extraP !== null ? p.extraP : (p.extra ? M.toP(p.extra) : 0);
    var fig = figures(buyP, extraP, sellP);
    return {
      product: p, buy: buyP, extra: extraP, totalCost: fig.cost, sell: sellP,
      min: p.minSellP || (p.min ? M.toP(p.min) : 0),
      wholesale: p.wholesaleP || 0, retail: p.retailP || 0,
      discountPct: p.discountPct || 0, taxPct: p.taxPct || 0,
      reorder: p.reorder || 0,
      averageCost: ctx.averageCost || 0, lastCost: ctx.lastCost || 0,
      lastSupplier: ctx.lastSupplier || '',
      profit: fig.profit, margin: fig.margin, markup: fig.markup
    };
  },

  /* What a set of already-validated figures would change on the product (empty = nothing to save).
     Shared by set() and the panel, which must know before it closes whether a Save will store anything. */
  diff: function (productId, values) {
    var current = Prices.of(productId) || {};
    var changes = [];
    Object.keys(values || {}).forEach(function (k) {
      var f = FIELD_BY_KEY[k];
      if (!f) return;
      var oldVal = f.money ? current[k] : (current[k] || 0);
      var newVal = f.money ? M.toP(values[k]) : values[k];
      if (oldVal !== newVal) changes.push({ field: k, label: f.label, money: f.money, from: oldVal, to: newVal });
    });
    return changes;
  },

  /* Validate a proposed set of prices without saving them. */
  validate: function (productId, values) {
    var errs = [];
    var v = {};
    /* A price is judged against what the product already holds, not only
       against the other boxes filled in at the same time — changing the
       selling price alone still has to respect the stored minimum. */
    var held = Prices.of(productId) || {};
    Object.keys(values || {}).forEach(function (k) {
      if (values[k] === '' || values[k] === undefined || values[k] === null) return;
      var n = num(values[k]);
      if (n === null) { errs.push(FIELD_BY_KEY[k] ? FIELD_BY_KEY[k].label + ' is not a number.' : k); return; }
      if (n < 0) errs.push((FIELD_BY_KEY[k] ? FIELD_BY_KEY[k].label : k) + ' cannot be negative.');
      if ((k === 'discountPct' || k === 'taxPct') && n > 100) {
        errs.push((FIELD_BY_KEY[k].label) + ' cannot be more than 100.');
      }
      v[k] = n;
    });
    var effSell = v.sell !== undefined ? M.toP(v.sell) : (held.sell || 0);
    var effMin  = v.min  !== undefined ? M.toP(v.min)  : (held.min || 0);
    var effBuy  = v.buy  !== undefined ? M.toP(v.buy)  : (held.buy || 0);
    var effExtra = v.extra !== undefined ? M.toP(v.extra) : (held.extra || 0);
    var effCost = effBuy + effExtra;
    if (effSell && effMin && effSell < effMin) {
      errs.push('The selling price ' + M.fmt(effSell) + ' is below the minimum of ' +
        M.fmt(effMin) + ' set for this product.');
    }
    if (effSell && effCost && effSell < effCost) {
      errs.push('warning:Selling below ' + (effExtra
        ? 'what a bag costs you (purchase ' + M.fmt(effBuy) + ' + extra ' + M.fmt(effExtra) + ')'
        : 'purchase price') + ' — every bag would lose ' + M.fmt(effCost - effSell) + '.');
    }
    return {
      errors: errs.filter(function (e) { return e.indexOf('warning:') !== 0; }),
      warnings: errs.filter(function (e) { return e.indexOf('warning:') === 0; })
        .map(function (e) { return e.slice(8); }),
      values: v
    };
  },

  /* Apply a price change. Old values are never overwritten in place — each
     one becomes a history row with the reason and the person behind it. */
  set: function (productId, values, opts) {
    opts = opts || {};
    var p = global.prodOf ? global.prodOf(productId) : null;
    if (!p) return Promise.reject({ validation: ['Product not found.'] });
    var v = Prices.validate(productId, values);
    if (v.errors.length) return Promise.reject({ validation: v.errors });
    /* A reason is welcome (it is kept in the history) but never required: a save that silently
       needed one looked like it had worked while nothing was stored. */
    var changes = Prices.diff(productId, v.values);
    if (!changes.length) return Promise.resolve({ changes: [], unchanged: true });

    /* someone without the authority raises a request instead */
    if (!opts.approving && Prices.approvalRequired()) {
      return Prices.request(productId, changes, opts.reason);
    }

    var stores = ['products', 'priceHistory', 'inventory', 'auditLog'];
    return FDB.tx(stores, function (api) {
      changes.forEach(function (c) {
        if (c.field === 'buy') { p.buyP = c.to; p.buy = M.toR(c.to); }
        else if (c.field === 'extra') {
          p.extraP = c.to; p.extra = M.toR(c.to);
          /* Bags already in stock keep the extra cost they came in with (Inventory.rowExtraP). A row that was
             still following the product's figure is pinned to the OLD one; and when there was no extra before,
             the first figure typed covers the bags already held (a row that never carried one). */
          Object.keys(S.inventory || {}).forEach(function (k) {
            var row = S.inventory[k];
            if (!row || row.productId !== productId || !row.warehouseId) return;   /* a row with no warehouse is not stock */
            var was = typeof row.avgExtraP === 'number' ? row.avgExtraP : null;
            var next = c.from > 0 ? (was === null ? c.from : was) : (was > 0 ? was : c.to);
            if (next !== was) { row.avgExtraP = next; api.put('inventory', row); }
          });
        }
        else if (c.field === 'sell') { p.sellP = c.to; p.sell = M.toR(c.to); }
        else if (c.field === 'min') { p.minSellP = c.to; p.min = M.toR(c.to); }
        else if (c.field === 'wholesale') { p.wholesaleP = c.to; }
        else if (c.field === 'retail') { p.retailP = c.to; }
        else p[c.field] = c.to;

        var h = {
          id: FDB.uid('ph'), productId: productId,
          productName: p.en || p.ur || productId,
          field: c.field, fieldLabel: c.label,
          oldValue: c.from, newValue: c.to, money: c.money,
          reason: opts.reason || '',
          changedBy: opts.approvedFor || who(),
          /* the role matters as much as the name: one person may sign in as
             the owner to approve what they raised as a salesman */
          changedByRole: opts.approvedForRole || role(),
          approvedBy: opts.approving ? who() : null,
          approvedByRole: opts.approving ? role() : null,
          changedAt: nowISO(), effectiveDate: opts.date || nowISO().slice(0, 10)
        };
        api.put('priceHistory', h);
        (S.priceHistory = S.priceHistory || []).unshift(h);
      });
      api.put('products', p);
      ERP.Audit.write(api, {
        action: 'Product prices updated', entity: 'Product', entityId: productId,
        ref: p.en || p.ur,
        oldValues: changes.reduce(function (a, c) { a[c.field] = c.money ? M.toR(c.from) : c.from; return a; }, {}),
        newValues: changes.reduce(function (a, c) { a[c.field] = c.money ? M.toR(c.to) : c.to; return a; }, {}),
        reason: opts.reason || ''
      });
    }).then(function () {
      if (ERP.markMasterDirty) ERP.markMasterDirty();
      try { global.dbSave(); } catch (e) {}
      return { changes: changes, applied: true, warnings: v.warnings };
    });
  },

  /* §28, 2026-09-29 (client: "write average of all purchase price of bags available in stock just as a
     label, then the user decides the new purchase price… when user changes it the new value will always be
     there even when new products are added… extra cost of the product will be decided [here]… no need of
     selling price here, it will be decided while selling"). Replaces `setSell` — this screen no longer
     touches a selling price at all. Two things are set here:
       - `costOverrideP` — the CHOSEN purchase price (Inventory.saleBuyOf reads it ahead of the live average;
         Stock value never does, §28 decision: the chosen figure drives sale profit only). Typing the SAME
         figure the label already shows changes nothing; typing anything else pins that figure until it is
         changed again here or cleared back to "follow the average" (opts.clearOverride).
       - `extraP`/`extra` — one extra-cost figure per product (no more per-warehouse-row blending, §28).
     No floor, no restriction of any kind (client: "remove all restrictions") — approval-gated like Prices.set
     when price-approval is switched on. */
  setCost: function (productId, values, opts) {
    opts = opts || {};
    values = values || {};
    var p = global.prodOf ? global.prodOf(productId) : null;
    if (!p) return Promise.reject({ validation: ['Product not found.'] });
    var cur = ERP.Inventory.averages(productId);
    var fromOverride = p.costOverrideP > 0 ? p.costOverrideP : 0;
    var fromExtra = p.extraP > 0 ? p.extraP : 0;

    if (opts.clearOverride) {
      /* un-pinning back to "follow the live average" sets nothing new — it never needs approval, even when
         price-approval is switched on for everyone else (opts.approving:true skips the request queue) */
      if (!fromOverride) return Promise.resolve({ changes: [], unchanged: true });
      return applySetCost(productId, p, [{ field: 'costOverride', label: 'Purchase price (chosen)',
        money: true, from: fromOverride, to: 0 }], Object.assign({}, opts, { approving: true }));
    }

    var displayedBuy = fromOverride || cur.cost;
    var buy = values.buy !== undefined && values.buy !== '' ? num(values.buy) : M.toR(displayedBuy);
    if (buy === null) return Promise.reject({ validation: ['Enter a number only for the purchase price.'] });
    if (buy < 0) return Promise.reject({ validation: ['A price cannot be negative.'] });
    var extra = values.extra !== undefined && values.extra !== '' ? num(values.extra) : M.toR(fromExtra);
    if (extra === null) return Promise.reject({ validation: ['Enter a number only for the extra cost.'] });
    if (extra < 0) return Promise.reject({ validation: ['An extra cost cannot be negative.'] });

    var buyP = M.toP(buy), extraP = M.toP(extra);
    var changes = [];
    /* whatever is typed becomes the pinned figure the moment it differs from what the box shows — the same
       number typed back (nothing actually changed) leaves the average following free, so opening and
       re-saving this screen without touching the box never locks a price by accident */
    if (buyP !== displayedBuy) {
      changes.push({ field: 'costOverride', label: 'Purchase price (chosen)', money: true, from: fromOverride, to: buyP });
    }
    if (extraP !== fromExtra) {
      changes.push({ field: 'extra', label: 'Extra cost per bag', money: true, from: fromExtra, to: extraP });
    }
    if (!changes.length) return Promise.resolve({ changes: [], unchanged: true });
    return applySetCost(productId, p, changes, opts);
  },

  /* the approval queue */
  request: function (productId, changes, reason) {
    var p = global.prodOf(productId) || {};
    var rec = {
      id: FDB.uid('pa'), productId: productId, productName: p.en || p.ur || productId,
      changes: changes, reason: reason || '', status: 'PENDING',
      requestedBy: who(), requestedByRole: role(), requestedAt: nowISO(),
      decidedBy: null, decidedAt: null, decision: null
    };
    return FDB.tx(['priceApprovals', 'auditLog'], function (api) {
      api.put('priceApprovals', rec);
      (S.priceApprovals = S.priceApprovals || []).unshift(rec);
      ERP.Audit.write(api, {
        action: 'Price change requested', entity: 'Product', entityId: productId,
        ref: rec.productName, reason: reason || '',
        newValues: changes.reduce(function (a, c) {
          a[c.field] = c.money ? M.toR(c.to) : c.to; return a;
        }, {})
      });
    }).then(function () { return { pending: true, request: rec, changes: changes }; });
  },
  approve: function (id) {
    var rec = (S.priceApprovals || []).filter(function (a) { return a.id === id; })[0];
    if (!rec || rec.status !== 'PENDING') return Promise.resolve(null);
    if (!Prices.canApprove()) return Promise.reject({ validation: ['Only the owner or a manager can approve a price.'] });
    var finish = function (r) {
      return FDB.tx(['priceApprovals', 'auditLog'], function (api) {
        rec.status = 'APPROVED'; rec.decidedBy = who(); rec.decidedAt = nowISO(); rec.decision = 'APPROVED';
        api.put('priceApprovals', rec);
        ERP.Audit.write(api, { action: 'Price change approved', entity: 'Product',
          entityId: rec.productId, ref: rec.productName, reason: rec.reason });
      }).then(function () { return r; });
    };
    /* §28, 2026-09-29: a request that touched the chosen purchase price (Prices.setCost) is re-applied
       through setCost, not the generic engine — no floor to re-check any more (client: "remove all
       restrictions"), it simply lands against whatever the live average is by the time it is approved. */
    var isCost = rec.changes.some(function (c) { return c.field === 'costOverride' || c.field === 'extra'; });
    if (isCost) {
      var patch = {};
      rec.changes.forEach(function (c) {
        if (c.field === 'costOverride') patch.buy = M.toR(c.to);
        else if (c.field === 'extra') patch.extra = M.toR(c.to);
      });
      return Prices.setCost(rec.productId, patch, {
        reason: rec.reason || 'Approved price change', approving: true,
        approvedFor: rec.requestedBy, approvedForRole: rec.requestedByRole
      }).then(finish);
    }
    var values = {};
    rec.changes.forEach(function (c) { values[c.field] = c.money ? M.toR(c.to) : c.to; });
    return Prices.set(rec.productId, values, {
      reason: rec.reason || 'Approved price change', approving: true,
      approvedFor: rec.requestedBy, approvedForRole: rec.requestedByRole
    }).then(finish);
  },
  reject: function (id, why) {
    var rec = (S.priceApprovals || []).filter(function (a) { return a.id === id; })[0];
    if (!rec || rec.status !== 'PENDING') return Promise.resolve(null);
    if (!Prices.canApprove()) return Promise.reject({ validation: ['Only the owner or a manager can decide this.'] });
    return FDB.tx(['priceApprovals', 'auditLog'], function (api) {
      rec.status = 'REJECTED'; rec.decidedBy = who(); rec.decidedAt = nowISO();
      rec.decision = 'REJECTED'; rec.rejectReason = why || '';
      api.put('priceApprovals', rec);
      ERP.Audit.write(api, { action: 'Price change rejected', entity: 'Product',
        entityId: rec.productId, ref: rec.productName, reason: why || '' });
    }).then(function () { return rec; });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   2 · THE LISTS THAT USED TO BE HARD-CODED
   ══════════════════════════════════════════════════════════════════════════ */
var Lists = ERP.Lists = {
  defaults: {
    categories: ['چاول', 'آٹا', 'وغیرہ', 'غیر متعین'],
    brands: [],
    units: ['Bag', 'KG', 'Ton', 'Piece'],
    paymentMethods: ['Cash', 'Bank Transfer', 'JazzCash', 'Easypaisa', 'Cheque', 'Adjustment'],
    expenseCategories: ['Freight', 'Loading / unloading', 'Fuel', 'Rent', 'Utilities',
                        'Salaries', 'Repairs', 'Office', 'Bank charges', 'Other']
  },
  get: function (name) {
    var cfg = ERP.Settings.get();
    if (cfg[name] && cfg[name].length) return cfg[name];
    if (name === 'categories') {
      var found = {};
      (global.PRODUCTS || []).forEach(function (p) { if (p.cat) found[p.cat] = 1; });
      var cats = Object.keys(found);
      if (cats.length) return cats;
    }
    if (name === 'brands') {
      var b = {};
      (global.PRODUCTS || []).forEach(function (p) {
        var v = p.brandEn || p.brand; if (v) b[v] = 1;
      });
      return Object.keys(b).sort();
    }
    return Lists.defaults[name] || [];
  },
  add: function (name, value) {
    value = String(value || '').trim();
    if (!value) return Promise.reject({ validation: ['Type a name first.'] });
    var list = Lists.get(name).slice();
    if (list.some(function (x) { return x.toLowerCase() === value.toLowerCase(); })) {
      return Promise.reject({ validation: ['That is already on the list.'] });
    }
    list.push(value);
    var patch = {}; patch[name] = list;
    return ERP.Settings.save(patch).then(function () {
      ERP.Audit.detached({ action: 'Added to ' + name, entity: 'Settings', entityId: name,
        newValues: { value: value } });
      return list;
    });
  },
  remove: function (name, value) {
    var inUse = 0;
    if (name === 'categories') {
      inUse = (global.PRODUCTS || []).filter(function (p) { return p.cat === value; }).length;
    } else if (name === 'brands') {
      inUse = (global.PRODUCTS || []).filter(function (p) { return (p.brandEn || p.brand) === value; }).length;
    }
    if (inUse) {
      return Promise.reject({ validation: [inUse + ' products still use “' + value +
        '”. Move them first — removing it here would leave them without one.'] });
    }
    var list = Lists.get(name).filter(function (x) { return x !== value; });
    var patch = {}; patch[name] = list;
    return ERP.Settings.save(patch).then(function () {
      ERP.Audit.detached({ action: 'Removed from ' + name, entity: 'Settings', entityId: name,
        oldValues: { value: value } });
      return list;
    });
  }
};

/* settings the rest of the app reads */
var origDefaults = ERP.Settings.defaults;
ERP.Settings.defaults = function () {
  return Object.assign(origDefaults.call(ERP.Settings), {
    /* pricing */
    priceApproval: false, lowMarginWarnPct: 8,
    allowSellBelowCost: true, showProfitToSales: false,
    /* inventory */
    lowStockAlerts: true, defaultReorderLevel: 50,
    adjustmentApproval: false, transferApproval: false,
    /* sales & purchases */
    defaultPaymentTermDays: 0, defaultCreditLimit: 0, maxDiscountPct: 100,
    supplierPaymentTermDays: 0, purchaseApproval: false,
    /* notifications */
    notifyLowStock: true, notifyPaymentReceived: true, notifyInvoiceCreated: false,
    notifyPaymentReminder: false, notifyReturnApproved: false,
    /* data */
    autoBackup: 'weekly', lastAutoBackupAt: null,
    /* lists */
    categories: null, brands: null, units: null
  });
};

/* the low-stock level a product falls under */
ERP.reorderLevelOf = function (productId) {
  var p = global.prodOf ? global.prodOf(productId) : null;
  if (p && p.reorder) return Number(p.reorder);
  return Number(ERP.Settings.get().defaultReorderLevel || 0);
};

/* ══════════════════════════════════════════════════════════════════════════
   3 · THE PRODUCT PRICE PANEL
   ══════════════════════════════════════════════════════════════════════════ */
var PRICE_FOR = null;
var PRICE_HELD = null;      /* Inventory.averages() for the product on show — see PANELS.prices.f */
ERP.openPriceEditor = function (productId) {
  PRICE_FOR = productId;
  global.openPanel('prices');
};

/* The line under the cost boxes. Numbers only, so nothing typed can reach the page as markup. */
function costLine(buyP, extraP, sellP, chargeP) {
  if (buyP < 0 || extraP < 0 || sellP < 0) return 'A price or cost cannot be negative.';
  var f = figures(buyP, extraP, sellP, chargeP);
  if (!f.cost) return 'Enter the purchase price and our extra cost to see what a bag costs us.';
  return 'Cost to us per bag <b>' + M.fmt(f.cost) + '</b>' +
    (chargeP ? ' (purchase ' + M.fmt(buyP) + ' + charges on the purchase ' + M.fmt(chargeP) + (extraP ? ' + extra ' + M.fmt(extraP) : '') + ')'
             : (extraP ? ' (purchase ' + M.fmt(buyP) + ' + extra ' + M.fmt(extraP) + ')' : '')) +
    (sellP ? ' · profit per bag <b>' + M.fmt(f.profit) + '</b> · margin <b>' + f.margin +
             '%</b>, markup <b>' + f.markup + '%</b>' : '');
}

/* §28, 2026-09-29: the sum written out the way the owner does it on paper — purchase + extra = cost. No
   selling price / profit here any more (the selling price is decided at the sale, not on this screen) and
   no "try N bags" box — the client asked to see just the per-bag figures. Numbers only, like costLine. */
function calcHtml(buyP, extraP) {
  if (buyP < 0 || extraP < 0) return { rows: '' };
  var cost = (buyP || 0) + (extraP || 0);
  var row = function (label, p, strong) {
    return '<div class="pz-cr' + (strong ? ' pz-cs' : '') + '"><span>' + label + '</span><b>' + M.fmt(p) + '</b></div>';
  };
  return { rows: row('Purchase price', buyP) + row('+ Extra cost', extraP) + row('= Total cost per bag', cost, true) };
}

/* True when transport/labour for this product was already put on a purchase through the Landed costs screen (or
   the purchase's own freight boxes): under the LANDED basis that is inside the stock cost, and the Extra cost per
   bag is added on top of the stock cost when a sale is costed (Inventory.saleCostOf) — so the same transport would
   count twice. The panel says so rather than guessing which one the owner meant. */
function landedAlready(pid) {
  if (ERP.Cost && ERP.Cost.basis && ERP.Cost.basis() !== 'LANDED') return false;
  return (S.purchaseItems || []).some(function (it) {
    if (it.productId !== pid) return false;
    var pu = ERP.Purchases && ERP.Purchases.byId ? ERP.Purchases.byId(it.purchaseId) : null;
    if (!pu || pu.status === 'CANCELLED') return false;
    return it.landedUnitCost > 0 && it.goodsUnitCost > 0 && it.landedUnitCost > it.goodsUnitCost;
  });
}
Prices.landedAlready = landedAlready;

/* The numbers behind landedAlready: on the product's latest purchase that carried charges, the supplier's price per bag and the
   charges per bag on top of it (both paisa), or null. The stock bought that way is already costed at goods + charges. */
function landedBreakdown(pid) {
  if (!landedAlready(pid)) return null;
  var best = null;
  (S.purchaseItems || []).forEach(function (it) {
    if (it.productId !== pid || !(it.landedUnitCost > it.goodsUnitCost && it.goodsUnitCost > 0)) return;
    var pu = ERP.Purchases && ERP.Purchases.byId ? ERP.Purchases.byId(it.purchaseId) : null;
    if (!pu || pu.status === 'CANCELLED') return;
    if (!best || (pu.purchaseDate || '') >= best.date) best = { date: pu.purchaseDate || '', goods: it.goodsUnitCost, charge: it.landedUnitCost - it.goodsUnitCost,
      purchaseId: pu.id, number: pu.purchaseNumber || '' };
  });
  return best;
}
Prices.landedBreakdown = landedBreakdown;
var PRICE_LANDED = null;     /* kept for landedAlready/landedBreakdown callers elsewhere; no longer read by this panel */

/* Every purchase and stock receipt that carries this product, newest first — the "come here again" list the
   client asked for: change the quantity, purchase price, extra cost or selling price by editing one of these,
   not on this screen (§26, 2026-09-28). */
function productTransactions(pid) {
  var rows = [];
  (S.purchaseItems || []).forEach(function (it) {
    if (it.productId !== pid) return;
    var pu = ERP.Purchases && ERP.Purchases.byId ? ERP.Purchases.byId(it.purchaseId) : null;
    if (!pu || pu.status === 'CANCELLED') return;
    var bags = it.receivedQty === undefined ? it.quantity : it.receivedQty;
    if (!(bags > 0)) return;
    rows.push({ date: pu.purchaseDate, number: pu.purchaseNumber, kind: 'purchase', id: pu.id, bags: bags,
      price: it.unitPrice, extra: typeof it.extraUnitP === 'number' ? it.extraUnitP : 0 });
  });
  (S.stockDocItems || []).forEach(function (it) {
    if (it.productId !== pid) return;
    var doc = ERP.StockDocs && ERP.StockDocs.byId ? ERP.StockDocs.byId(it.docId) : null;
    if (!doc || doc.type !== 'RECEIVE' || doc.status === 'CANCELLED') return;
    if (!(Number(it.quantity) > 0)) return;
    rows.push({ date: doc.docDate, number: doc.docNumber, kind: 'receive', id: doc.id, bags: it.quantity,
      price: it.unitCostP, extra: typeof it.extraUnitP === 'number' ? it.extraUnitP : 0 });
  });
  return rows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).slice(0, 20);
}

/* §28, 2026-09-29: is the buy/extra box on the panel showing something other than what is actually saved
   right now? Used to warn before the panel's own "Change"/"Edit" links leave for a purchase or receipt and
   would otherwise lose it — the same guard the old sell-only screen had, rebuilt for the two boxes here. */
function pricesDirty() {
  var held = PRICE_HELD;
  if (!held) return false;
  var buyEl = D.querySelector('#panel [data-f="buy"]'), extraEl = D.querySelector('#panel [data-f="extra"]');
  var displayedBuy = held.override || held.cost;
  if (buyEl) { var b = num(buyEl.value); if (b !== null && M.toP(b) !== displayedBuy) return true; }
  if (extraEl) { var x = num(extraEl.value); if (x !== null && M.toP(x) !== held.extra) return true; }
  return false;
}

global.PANELS.prices = {
  t: 'Product prices', s: 'Choose the purchase price and extra cost a sale is costed at', cta: 'Save prices',
  /* §28, 2026-09-29 (client: "write average of all purchase price of bags available in stock just a label,
     then the user decides the new purchase price… extra cost of the product will be decided [here]… no need
     of selling price here — it will be decided while selling"). The average purchase price is a read-only
     label; below it is the CHOSEN purchase price (defaults to the average, sticks once changed — Prices.setCost)
     and the extra cost (defaults to 0). No selling price on this screen at all any more. */
  f: function () {
    var pid = PRICE_FOR || ((global.PRODUCTS || [])[0] || {}).id;
    var p = global.prodOf ? global.prodOf(pid) : null;
    if (!p) return '<p class="hint">Product not found.</p>';
    var avg = PRICE_HELD = ERP.Inventory.averages(pid);
    var pend = Prices.pending(pid);
    var shownBuy = avg.override || avg.cost;
    var calc = calcHtml(shownBuy, avg.extra);
    var tx = productTransactions(pid);
    var hist = Prices.history(pid).slice(0, 6);
    var readonlyBox = function (label, hint, val) {
      var tip = hint && ERP.info ? ERP.info.pair(hint) : null;
      return '<label class="f"><span>' + label + (tip ? tip.btn : '') + '</span><p class="pz-ro">' +
        (val ? M.fmt(val) : '—') + '</p>' + (tip ? tip.box : (hint ? '<span class="hint">' + hint + '</span>' : '')) + '</label>';
    };
    var money = function (k, label, hint, val, notice) {
      var tip = hint && ERP.info ? ERP.info.pair(hint) : null;
      return '<label class="f"><span>' + label + (tip ? tip.btn : '') + '</span><input data-f="' + k +
        '" inputmode="decimal" value="' + esc(val ? M.toR(val) : '') + '">' +
        (notice ? '<span class="hint">' + notice + '</span>' : '') +
        (tip ? tip.box : (hint ? '<span class="hint">' + hint + '</span>' : '')) + '</label>';
    };
    return '<div class="banner info">' + I('tag') + '<div><p><b>' + u(p.ur || '') + ' ' + esc(p.en || '') + '</b></p>' +
        '<p class="pz-inline">' + (avg.bags
          ? Number(avg.bags).toLocaleString('en-US') + ' bags on hand, averaged across every warehouse'
          : 'Nothing in stock right now — these are the figures a new purchase or receipt will start from') +
        '</p></div></div>' +
      (pend.length ? '<div class="banner warn">' + I('clock') + '<div><p>' + pend.length +
        ' change is waiting for approval on this product.</p></div></div>' : '') +
      readonlyBox('Average purchase price (stock on hand)',
        'The bag-weighted average purchase price of the stock on hand right now, from every purchase and ' +
        'Add stock — for reference only. Type the box below to choose a different purchase price.', avg.cost) +
      '<div class="f2">' +
        money('buy', 'Purchase price', 'What a sale is costed at. Starts at the average above; once you change ' +
          'it, this figure stays — even when new stock comes in at a different price — until you change it ' +
          'again here.', shownBuy,
          avg.override ? 'Chosen here — the average right now is ' + M.fmt(avg.cost) + '.' : null) +
        money('extra', 'Extra cost per bag', 'What we pay ourselves on top of the purchase price — transport, ' +
          'labour, loading. Not on the supplier’s bill. Type 0 if none.', avg.extra) +
      '</div>' +
      (avg.override ? '<button type="button" class="pz-chg" data-pzuseavg="' + esc(pid) +
        '">Use the average (' + M.fmt(avg.cost) + ') instead</button>' : '') +
      '<div class="pz-calc"><div id="pzCalcRows">' + calc.rows + '</div></div>' +
      '<label class="f"><span>Reason for the change (optional)</span><input data-f="reason" ' +
        'placeholder="e.g. Market price increase"></label>' +
      (Prices.approvalRequired()
        ? '<div class="banner warn">' + I('lock') + '<div><p>Price changes need the owner’s approval. ' +
          'Yours will be held until it is approved.</p></div></div>' : '') +
      (hist.length ? '<div class="f"><span>Recent changes</span><div class="pz-hist">' +
        hist.map(function (h) {
          return '<div class="pz-h"><span>' + esc(fmtDate(h.changedAt.slice(0, 10))) + ' · ' +
            esc(h.fieldLabel) + '</span><b>' +
            (h.money ? M.fmtPlain(h.oldValue) + ' → ' + M.fmtPlain(h.newValue)
                     : h.oldValue + ' → ' + h.newValue) + '</b>' +
            '<i>' + esc(h.reason || '—') + ' · ' + esc(h.changedBy) +
            (h.changedByRole ? ' (' + esc(h.changedByRole.toLowerCase()) + ')' : '') +
            (h.approvedBy ? ' · approved by ' + esc(h.approvedBy) +
              (h.approvedByRole ? ' (' + esc(h.approvedByRole.toLowerCase()) + ')' : '') : '') +
            '</i></div>';
        }).join('') + '</div></div>' : '') +
      '<div class="f"><span>Purchases &amp; stock receipts</span>' +
      (tx.length ? '<div class="pz-hist">' +
        tx.map(function (r) {
          return '<div class="pz-h"><span>' + esc(fmtDate(r.date)) + ' · ' + esc(r.number) +
            ' (' + (r.kind === 'purchase' ? 'purchase' : 'stock receipt') + ')</span>' +
            '<b>' + Number(r.bags).toLocaleString('en-US') + ' bags @ ' + M.fmtPlain(r.price) +
            (r.extra ? ' + ' + M.fmtPlain(r.extra) + ' extra' : '') + '</b>' +
            '<button type="button" class="pz-chg" data-pztxedit="' + r.kind + '" data-id="' + esc(r.id) + '">Edit</button></div>';
        }).join('') + '</div>'
        : '<p class="hint">No purchase or stock receipt for this product yet — Purchases → Receive stock, ' +
          'or Inventory → Add stock.</p>') +
      '</div>';
  },
  save: function (v) {
    var pid = PRICE_FOR;
    var cur = ERP.Inventory.averages(pid);
    var displayedBuy = cur.override || cur.cost;
    var buy = v.buy !== undefined && v.buy !== '' ? num(v.buy) : M.toR(displayedBuy);
    if (buy === null) return 'Enter a number only for the purchase price.';
    if (buy < 0) return 'A price cannot be negative.';
    var extra = v.extra !== undefined && v.extra !== '' ? num(v.extra) : M.toR(cur.extra);
    if (extra === null) return 'Enter a number only for the extra cost.';
    if (extra < 0) return 'An extra cost cannot be negative.';
    /* Everything that can be refused is refused HERE, inside the panel: once this function returns without an
       error the panel closes and says "Saving…", so a refusal found afterwards looked like a save that worked. */
    if (M.toP(buy) === displayedBuy && M.toP(extra) === cur.extra) {
      return 'Nothing to save — those are the figures already in force. Type a new one and press Save.';
    }
    Prices.setCost(pid, { buy: buy, extra: extra }, { reason: v.reason }).then(function (r) {
      global.paint();
      if (r.unchanged) { say('Nothing changed.'); return; }
      if (r.pending) { say('Sent for approval — waiting on the owner.'); return; }
      say('Prices updated. The old figures are kept in the history.');
    }).catch(function (e) {
      say(e && e.validation ? 'NOT saved — ' + e.validation[0] : 'NOT saved — the price could not be stored. Reload and try again.');
    });
    return { msg: 'Saving…' };
  }
};

/* a way in from everywhere the brief asks for */
(function addPriceButtons() {
  var wrapPage = function (name, marker) {
    var orig = global.PAGES[name];
    if (!orig) return;
    global.PAGES[name] = function () {
      var html = orig.apply(global, arguments);
      return html.replace(marker.find, marker.add);
    };
  };
  /* inventory rows get a Prices button next to the product */
  var origInv = global.PAGES.inventory;
  if (origInv) {
    global.PAGES.inventory = function () {
      return '<div class="bar"><div class="grow"></div>' +
        '<button class="btn" data-go="settings" data-section="pricing">' + I('tag') +
        'Pricing settings</button></div>' + origInv.apply(global, arguments);
    };
  }
})();

/* ══════════════════════════════════════════════════════════════════════════
   4 · THE SETTINGS CONTROL PANEL
   ══════════════════════════════════════════════════════════════════════════ */
var SECTIONS = [
  { id: 'general',   label: 'General & business', icon: 'grid',   match: /business profile|company|general/i },
  { id: 'pricing',   label: 'Products & pricing', icon: 'tag',    match: /price|product|sales & profit|profit/i },
  { id: 'inventory', label: 'Inventory',          icon: 'box',    match: /stock|inventory|warehouse/i },
  { id: 'sales',     label: 'Sales',              icon: 'chart',  match: /before printing|invoice layout|sales/i },
  { id: 'purchase',  label: 'Purchases',          icon: 'truck',  match: /purchase|supplier|mill/i },
  { id: 'invoice',   label: 'Invoice & documents',icon: 'doc',    match: /invoice|document|template/i },
  { id: 'people',    label: 'Users & roles',      icon: 'users',  match: /role|user|permission|staff|salesm/i },
  { id: 'notify',    label: 'Notifications',      icon: 'sms',    match: /sms|whatsapp|notification|provider/i },
  { id: 'data',      label: 'Data & backup',      icon: 'layers', match: /database|backup|restore|health|bulk/i },
  { id: 'system',    label: 'System',             icon: 'refresh',match: /theme|appearance|system/i },
  { id: 'audit',     label: 'Audit log',          icon: 'clock',  match: /audit/i }
];
var SET = ERP.SettingsUI = { section: 'general', q: '' };

/* ── the small round "i" that opens a plain-English explanation under a field ───────────────────────────────────
   ERP.info.pair(html) → { btn, box }: put `btn` beside the label and `box` where the text should appear. The text is
   hidden until the i is pressed (again to hide). A button rather than a hover tip, so it works on a phone. Text only —
   callers pass already-escaped markup. Warnings that matter and live figures stay visible; only explanations go here. */
var INFO_SEQ = 0;
ERP.info = {
  pair: function (html, label) {
    var id = 'fcinfo' + (++INFO_SEQ), name = label || 'What is this?';
    return {
      btn: '<button type="button" class="fc-i" data-fcinfo="' + id + '" title="' + name + '" aria-label="' + name + '" aria-expanded="false" aria-controls="' + id + '"></button>',
      box: '<span class="hint fc-info" id="' + id + '" role="note">' + html + '</span>'
    };
  }
};
D.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('[data-fcinfo]') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  var box = D.getElementById(b.getAttribute('data-fcinfo'));
  if (!box) return;
  var on = !box.classList.contains('on');
  box.classList.toggle('on', on);
  b.setAttribute('aria-expanded', on ? 'true' : 'false');
}, true);

var CSS = `
.fc-i{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;margin:0 0 0 6px;padding:0;
  border-radius:50%;border:1.5px solid var(--line);background:var(--surface);color:var(--muted);
  font-size:11px;font-weight:600;line-height:1;font-family:inherit;cursor:pointer;vertical-align:middle}
.fc-i::before{content:"i"}
.fc-i:hover,.fc-i[aria-expanded="true"]{border-color:var(--violet);color:var(--violet);background:var(--surface-2)}
.fc-i:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.fc-info{display:none !important}
.fc-info.on{display:block !important;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);
  padding:8px 10px;margin:6px 0 2px;color:var(--ink-2);font-size:12.5px;line-height:1.5}
.st-shell{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;align-items:start}
.st-nav{position:sticky;top:12px;border:1px solid var(--line);border-radius:var(--r);
  background:var(--surface);overflow:hidden}
.st-nav button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 13px;
  border:none;background:none;font-size:14px;border-bottom:1px solid var(--line-2)}
.st-nav button:last-child{border-bottom:none}
.st-nav button:hover{background:var(--surface-2)}
.st-nav button.on{background:var(--violet-50);color:var(--violet-ink);font-weight:600;
  box-shadow:inset 3px 0 0 var(--violet)}
.st-nav svg{width:17px;height:17px;color:var(--muted);flex:none}
.st-nav button.on svg{color:var(--violet)}
.st-search{margin-bottom:12px}
.st-hit{display:block;width:100%;text-align:left;padding:9px 12px;border:1px solid var(--line);
  border-radius:var(--r-sm);background:var(--surface);margin-bottom:6px}
.st-hit:hover{border-color:var(--violet);background:var(--violet-50)}
.st-hit b{display:block}
.st-hit span{font-size:12.5px;color:var(--muted)}
.st-toggle{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;
  border-bottom:1px solid var(--line-2)}
.st-toggle:last-child{border-bottom:none}
.st-toggle .lbl b{display:block;font-size:14.5px}
.st-toggle .lbl span{display:block;font-size:12.5px;color:var(--muted)}
.st-sw{position:relative;width:46px;height:26px;border-radius:99px;background:var(--line);
  border:none;flex:none;cursor:pointer;transition:background .15s}
.st-sw::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:99px;
  background:#fff;transition:transform .15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.st-sw.on{background:var(--green)}
.st-sw.on::after{transform:translateX(20px)}
.st-chips{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0}
.st-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:99px;
  padding:5px 6px 5px 12px;font-size:13px;background:var(--surface)}
.st-chip button{border:none;background:none;color:var(--muted);border-radius:99px;padding:2px 6px;cursor:pointer}
.st-chip button:hover{background:var(--clay-50);color:var(--clay)}
.st-add{display:flex;gap:7px;margin-top:6px}
.st-add input{flex:1;padding:8px 10px;border:1.5px solid var(--line);border-radius:var(--r-sm)}
.banner p.pz-inline b{display:inline;margin:0}
.pz-ro{margin:0;padding:8px 10px;border:1.5px solid var(--line-2);border-radius:var(--r-sm);
  background:var(--surface-2);color:var(--ink);font-variant-numeric:tabular-nums}
.pz-live{border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2);
  padding:9px 12px;margin:0 0 12px;font-size:13px;line-height:1.5}
.pz-calc{border:1px solid var(--line);border-radius:var(--r-sm);padding:9px 12px;margin:0 0 12px;font-size:13px}
.pz-cr{display:flex;justify-content:space-between;gap:10px;padding:2px 0;font-variant-numeric:tabular-nums}
.pz-cs{border-top:1px solid var(--line-2);margin-top:2px;padding-top:4px;font-weight:600}
.pz-cr .pz-chg{margin-left:10px;padding:1px 9px;border:1px solid var(--line);border-radius:99px;background:var(--surface);
  color:var(--violet-ink);font-size:12px;cursor:pointer}
.pz-cr .pz-chg:hover{border-color:var(--violet);background:var(--violet-50)}
.pz-cr{align-items:baseline}
.pz-cr span{flex:1}
.pz-qty{display:flex;align-items:center;gap:8px;margin:8px 0 4px;color:var(--muted)}
.pz-qty input{width:72px;padding:5px 8px;border:1.5px solid var(--line);border-radius:var(--r-sm)}
.pz-ct{line-height:1.5;font-variant-numeric:tabular-nums}
.pz-hist{border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}
.pz-h{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:7px 10px;border-bottom:1px solid var(--line-2)}
.pz-h:last-child{border-bottom:none}
.pz-h b{font-variant-numeric:tabular-nums}
.pz-h i{grid-column:1/-1;font-style:normal;font-size:11.5px;color:var(--muted)}
@media(max-width:900px){
  .st-shell{grid-template-columns:1fr}
  .st-nav{position:static;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(140px,1fr);
    overflow-x:auto}
  .st-nav button{border-bottom:none;border-right:1px solid var(--line-2);white-space:nowrap}
  .st-nav button.on{box-shadow:inset 0 -3px 0 var(--violet)}
}`;
(function () { var s = D.createElement('style'); s.id = 'fc-settings-css'; s.textContent = CSS; D.head.appendChild(s); })();

function toggle(key, title, note) {
  var on = !!ERP.Settings.get()[key];
  return '<div class="st-toggle"><div class="lbl"><b>' + title + '</b>' +
    (note ? '<span>' + note + '</span>' : '') + '</div>' +
    '<button class="st-sw' + (on ? ' on' : '') + '" data-sttoggle="' + key + '" ' +
    'role="switch" aria-checked="' + on + '" aria-label="' + esc(title) + '"></button></div>';
}
function field(key, title, note, type) {
  var v = ERP.Settings.get()[key];
  return '<label class="f"><span>' + title + '</span><input data-stfield="' + key + '"' +
    (type ? ' inputmode="' + type + '"' : '') + ' value="' + esc(v === null || v === undefined ? '' : v) + '">' +
    (note ? '<span class="hint">' + note + '</span>' : '') + '</label>';
}
function listEditor(name, title, note) {
  var list = Lists.get(name);
  return '<div class="fce-sec"><h4>' + title + '</h4>' +
    (note ? '<p class="hint" style="margin:0 0 6px">' + note + '</p>' : '') +
    '<div class="st-chips">' + (list.length ? list.map(function (x) {
      return '<span class="st-chip">' + u(x) + '<button data-stlistdel="' + name + '" data-value="' +
        esc(x) + '" title="Remove">' + I('x') + '</button></span>';
    }).join('') : '<span class="hint">Nothing yet.</span>') + '</div>' +
    '<div class="st-add"><input data-stlistadd="' + name + '" placeholder="Add…">' +
    '<button class="btn" data-stlistgo="' + name + '">' + I('plus') + 'Add</button></div></div>';
}

function pricingSection() {
  var pend = Prices.pending();
  var recent = (S.priceHistory || []).slice(0, 12);
  return '<div class="card"><div class="card-h"><h3>Pricing rules</h3></div><div class="card-b">' +
      toggle('priceApproval', 'Price changes need approval',
        'Staff raise a change; the owner or a manager approves it before it takes effect') +
      /* "Allow selling below cost" and "Show profit to sales staff" used to sit
         here as toggles writing allowSellBelowCost / showProfitToSales — keys
         nothing ever read. The rules are actually enforced from
         allowSaleBelowCost / showProfitToStaff, which the Sales & profit card
         below already edits, so the dead duplicates are gone rather than
         leaving the owner two controls where only one works. */
      '<div class="f2" style="margin-top:10px">' +
        field('lowMarginWarnPct', 'Warn below this margin (%)', 'A rate under this shows a warning', 'decimal') +
        field('maxDiscountPct', 'Largest discount allowed (%)', '', 'decimal') +
      '</div></div></div>' +

    (pend.length ? '<div class="card"><div class="card-h"><h3>Price changes waiting</h3>' +
      '<span class="pill low">' + pend.length + '</span></div><div class="card-b">' +
      pend.map(function (a) {
        return '<div class="hz-row"><span><b>' + esc(a.productName) + '</b><br>' +
          a.changes.map(function (c) {
            return esc(c.label) + ' ' + (c.money ? M.fmtPlain(c.from) + ' → ' + M.fmtPlain(c.to)
                                                 : c.from + ' → ' + c.to);
          }).join(' · ') +
          '<br><span class="hint">' + esc(a.reason || 'no reason given') + ' · asked by ' +
          esc(a.requestedBy) + '</span></span>' +
          '<span>' + (Prices.canApprove()
            ? '<button class="btn sm pri" data-stapprove="' + a.id + '">Approve</button> ' +
              '<button class="btn sm" data-streject="' + a.id + '">Reject</button>'
            : '<span class="hint">Waiting for the owner</span>') + '</span></div>';
      }).join('') + '</div></div>' : '') +

    '<div class="card"><div class="card-h"><h3>Product lists</h3></div><div class="card-b">' +
      listEditor('categories', 'Categories', 'Used on every product and in the filters') +
      listEditor('brands', 'Brands') +
      listEditor('units', 'Units') +
    '</div></div>' +

    '<div class="card"><div class="card-h"><h3>Recent price changes</h3>' +
      '<span class="pill neu">' + (S.priceHistory || []).length + ' recorded</span></div>' +
      '<div class="card-b" style="padding:0">' + (recent.length
        ? '<div class="tw"><table class="fcb-list"><thead><tr><th>When</th><th>Product</th><th>What</th>' +
          '<th class="r">From</th><th class="r">To</th><th>Reason</th><th>By</th></tr></thead><tbody>' +
          recent.map(function (h) {
            return '<tr><td>' + esc(fmtDate(h.changedAt.slice(0, 10))) + '</td>' +
              '<td>' + esc(h.productName) + '</td><td>' + esc(h.fieldLabel) + '</td>' +
              '<td class="r num">' + (h.money ? M.fmtPlain(h.oldValue) : h.oldValue) + '</td>' +
              '<td class="r num"><b>' + (h.money ? M.fmtPlain(h.newValue) : h.newValue) + '</b></td>' +
              '<td>' + esc(h.reason || '—') + '</td><td>' + esc(h.changedBy) +
              (h.changedByRole ? '<div class="sub">' + esc(h.changedByRole.toLowerCase()) + '</div>' : '') +
              (h.approvedBy ? '<div class="sub">approved by ' + esc(h.approvedBy) + '</div>' : '') +
              '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="hint" style="padding:16px">No price has been changed yet.</p>') +
    '</div></div>';
}

function inventorySection() {
  return '<div class="card"><div class="card-h"><h3>Stock rules</h3></div><div class="card-b">' +
    toggle('allowNegativeStock', 'Allow selling below zero stock',
      'Off means a sale that would take stock negative is refused') +
    toggle('lowStockAlerts', 'Low stock alerts', 'Warn when a product falls under its alert level') +
    toggle('adjustmentApproval', 'Stock adjustments need approval') +
    toggle('transferApproval', 'Warehouse transfers need approval') +
    '<div class="f2" style="margin-top:10px">' +
      field('defaultReorderLevel', 'Default stock alert level (bags)',
        'Used when a product has none of its own', 'decimal') +
    '</div></div></div>';
}
function salesSection() {
  return '<div class="card"><div class="card-h"><h3>Sales rules</h3></div><div class="card-b">' +
    '<div class="f2">' +
      field('defaultPaymentTermDays', 'Payment terms (days)', 'Sets the due date on a new invoice', 'numeric') +
      field('defaultCreditLimit', 'Default credit limit for a new shop', '', 'decimal') +
    '</div>' +
    '<div class="f2">' +
      field('invoicePrefix', 'Invoice number prefix') +
      field('salesDocPrefix', 'Printed invoice prefix (InvNo)') +
    '</div></div></div>';
}
function purchaseSection() {
  return '<div class="card"><div class="card-h"><h3>Purchase rules</h3></div><div class="card-b">' +
    toggle('purchaseApproval', 'Purchases need approval before stock is received') +
    '<div class="f2" style="margin-top:10px">' +
      field('supplierPaymentTermDays', 'Supplier payment terms (days)', '', 'numeric') +
      field('purchasePrefix', 'Purchase number prefix') +
    '</div></div></div>';
}
function notifySection() {
  return '<div class="card"><div class="card-h"><h3>What to send</h3></div><div class="card-b">' +
    toggle('notifyInvoiceCreated', 'Invoice created', 'Send the shop its invoice as soon as it is raised') +
    toggle('notifyPaymentReceived', 'Payment received', 'Send a receipt when money is taken') +
    toggle('notifyPaymentReminder', 'Payment reminder', 'Remind a shop that owes money') +
    toggle('notifyLowStock', 'Low stock', 'Tell the office when a product runs down') +
    toggle('notifyReturnApproved', 'Return approved') +
    '<p class="hint" style="margin-top:10px">Providers are set up under the WhatsApp and SMS card below. ' +
    'Without one, messages open the phone’s own composer.</p></div></div>';
}
function dataSection() {
  return '<div class="card"><div class="card-h"><h3>Automatic backup</h3></div><div class="card-b">' +
    '<label class="f"><span>How often to remind you</span><select data-stfield="autoBackup">' +
      [['off', 'Never'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']]
        .map(function (o) {
          return '<option value="' + o[0] + '"' +
            (ERP.Settings.get().autoBackup === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select>' +
      '<span class="hint">A browser cannot write to your disk on its own, so the ERP asks you at the ' +
      'chosen interval and takes the backup in one click.</span></label>' +
      (ERP.Settings.get().lastAutoBackupAt
        ? '<p class="hint">Last taken ' + esc(fmtDate(ERP.Settings.get().lastAutoBackupAt.slice(0, 10))) + '.</p>'
        : '') +
    '</div></div>';
}
function systemSection() {
  return '<div class="card"><div class="card-h"><h3>Appearance and start-up</h3></div><div class="card-b">' +
    '<label class="f"><span>Screen the ERP opens on</span><select data-stfield="defaultPage">' +
      [['dashboard', 'Dashboard'], ['invoices', 'Sales & invoices'], ['inventory', 'Inventory'],
       ['collection', 'Collection round'], ['reports', 'Reports']].map(function (o) {
        return '<option value="' + o[0] + '"' +
          ((ERP.Settings.get().defaultPage || 'dashboard') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></label>' +
    '<div class="st-toggle"><div class="lbl"><b>Dark mode</b>' +
      '<span>Also on the moon button in the header</span></div>' +
      '<button class="st-sw' + (D.documentElement.getAttribute('data-theme') === 'dark' ? ' on' : '') +
      '" data-sttheme="1" role="switch"></button></div>' +
    '</div></div>';
}

/* Sections are filled with the cards the other modules already contribute:
   their HTML is produced once and each card is filed under the heading it
   matches, so nothing had to be rewritten to live in the new panel. */
var legacySettings = global.PAGES.settings;
global.PAGES.settings = function () {
  var role = ERP.RBAC ? ERP.RBAC.role() : 'OWNER';
  if (role !== 'OWNER' && role !== 'MANAGER' && role !== 'ACCOUNTANT') {
    return '<div class="empty"><div class="ei">' + I('lock') + '</div><b>Settings are not open to you</b>' +
      '<p>Ask the owner if something needs changing.</p></div>';
  }
  var q = SET.q.trim().toLowerCase();
  var mine = {
    pricing: pricingSection(), inventory: inventorySection(), sales: salesSection(),
    purchase: purchaseSection(), notify: notifySection(), data: dataSection(), system: systemSection()
  };
  var nav = SECTIONS.map(function (s) {
    return '<button data-stsection="' + s.id + '" class="' + (SET.section === s.id ? 'on' : '') + '">' +
      I(s.icon) + '<span>' + s.label + '</span></button>';
  }).join('');
  var current = SECTIONS.filter(function (s) { return s.id === SET.section; })[0] || SECTIONS[0];

  var body = q
    ? '<div class="card"><div class="card-h"><h3>Matching settings</h3></div><div class="card-b" id="stSearch">' +
      '<p class="hint">Looking for “' + esc(SET.q) + '”…</p></div></div>'
    : '<div id="stBody">' + (mine[current.id] || '') + '</div>';

  return '<div class="st-shell"><nav class="st-nav">' + nav + '</nav><div>' +
      '<div class="bar st-search"><div class="tsearch">' + I('search') +
        '<input placeholder="Search settings — price, backup, stock, invoice…" data-stq value="' +
        esc(SET.q) + '"></div>' +
        '<div class="grow"></div>' +
        '<span class="pill neu">' + esc(current.label) + '</span></div>' +
      body +
      '<div id="stLegacy" hidden>' + (legacySettings ? legacySettings() : '') + '</div>' +
    '</div></div>';
};

/* after each render, file the other modules' cards into the open section */
function distributeCards() {
  if (global.cur !== 'settings') return;
  var legacy = D.getElementById('stLegacy');
  if (!legacy) return;
  var host = D.getElementById('stBody') || D.getElementById('stSearch');
  if (!host) return;
  var q = SET.q.trim().toLowerCase();
  var current = SECTIONS.filter(function (s) { return s.id === SET.section; })[0] || SECTIONS[0];
  var cards = Array.prototype.slice.call(legacy.children).filter(function (el) {
    return el.classList && el.classList.contains('card');
  });
  var placed = 0;
  cards.forEach(function (card) {
    var h = card.querySelector('h3');
    var title = h ? h.textContent : '';
    if (q) {
      if (card.textContent.toLowerCase().indexOf(q) === -1) return;
      host.appendChild(card); placed++;
      return;
    }
    var section = SECTIONS.filter(function (s) { return s.match.test(title); })[0];
    if (!section) section = SECTIONS[0];
    if (section.id === current.id) { host.appendChild(card); placed++; }
  });
  if (q) {
    var mineHits = SECTIONS.filter(function (s) {
      return s.label.toLowerCase().indexOf(q) > -1;
    }).map(function (s) {
      return '<button class="st-hit" data-stsection="' + s.id + '"><b>' + esc(s.label) + '</b>' +
        '<span>Open this section</span></button>';
    }).join('');
    var note = D.querySelector('#stSearch .hint');
    if (note) {
      note.outerHTML = mineHits ||
        (placed ? '' : '<p class="hint">Nothing matches “' + esc(SET.q) + '”.</p>');
    }
  }
  legacy.remove();
}
var origPaint = global.paint;
global.paint = function () {
  origPaint.apply(global, arguments);
  try { distributeCards(); } catch (e) {}
};

/* ══════════════════════════════════════════════════════════════════════════
   5 · WIRING
   ══════════════════════════════════════════════════════════════════════════ */
D.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var t;
  if ((t = e.target.closest('[data-stsection]'))) {
    e.preventDefault(); SET.section = t.dataset.stsection; SET.q = ''; global.paint(); return;
  }
  if ((t = e.target.closest('[data-sttoggle]'))) {
    e.preventDefault();
    var key = t.dataset.sttoggle;
    var next = !ERP.Settings.get()[key];
    var patch = {}; patch[key] = next;
    ERP.Settings.save(patch).then(function () {
      ERP.Audit.detached({ action: 'Setting changed: ' + key, entity: 'Settings', entityId: key,
        oldValues: { value: !next }, newValues: { value: next } });
      global.paint();
    });
    return;
  }
  if ((t = e.target.closest('[data-sttheme]'))) {
    e.preventDefault();
    var btn = D.getElementById('themeBtn');
    if (btn) btn.click(); else {
      var dark = D.documentElement.getAttribute('data-theme') === 'dark';
      D.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    }
    global.paint();
    return;
  }
  if ((t = e.target.closest('[data-stlistgo]'))) {
    e.preventDefault();
    var name = t.dataset.stlistgo;
    var input = D.querySelector('[data-stlistadd="' + name + '"]');
    Lists.add(name, input ? input.value : '').then(function () {
      global.paint(); say('Added.');
    }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not add that.'); });
    return;
  }
  if ((t = e.target.closest('[data-stlistdel]'))) {
    e.preventDefault();
    Lists.remove(t.dataset.stlistdel, t.dataset.value).then(function () {
      global.paint(); say('Removed.');
    }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not remove that.'); });
    return;
  }
  if ((t = e.target.closest('[data-stapprove]'))) {
    e.preventDefault();
    Prices.approve(t.dataset.stapprove).then(function () { global.paint(); say('Price approved and applied.'); })
      .catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not approve.'); });
    return;
  }
  if ((t = e.target.closest('[data-streject]'))) {
    e.preventDefault();
    var rejId = t.dataset.streject;
    ERP.UI.prompt('Reject this price change?', {
      detail: 'The old prices stay in force, and the reason you give is recorded.',
      label: 'Reason', placeholder: 'Why is this price change being rejected?',
      okText: 'Reject', cancelText: 'Keep waiting', tone: 'danger'
    }).then(function (why) {
      if (why === null) return;
      return Prices.reject(rejId, why).then(function () { global.paint(); say('Rejected.'); });
    });
    return;
  }
  if ((t = e.target.closest('[data-pzedit]'))) {
    e.preventDefault(); e.stopPropagation();
    /* charges belong to the purchase they were typed on (the only "Change" button this panel still has):
       close this screen and open that purchase for editing */
    if (pricesDirty()) {
      say('You have typed prices here that are not saved yet — press Save first, then change the purchase (closing this screen would lose them).');
      return;
    }
    var pcl = D.querySelector('#panel [data-close]');
    if (pcl) pcl.click();
    if (ERP.actions && ERP.actions.editPurchase) ERP.actions.editPurchase(t.dataset.id);
    return;
  }
  if ((t = e.target.closest('[data-editprices]'))) {
    e.preventDefault(); ERP.openPriceEditor(t.dataset.editprices); return;
  }
  /* §28, 2026-09-29: forget the chosen purchase price and follow the live average again. */
  if ((t = e.target.closest('[data-pzuseavg]'))) {
    e.preventDefault(); e.stopPropagation();
    Prices.setCost(t.dataset.pzuseavg, {}, { clearOverride: true }).then(function (r) {
      global.paint();
      say(r.unchanged ? 'Already following the average.' : 'Now following the average purchase price again.');
    }).catch(function (e2) { say(e2 && e2.validation ? e2.validation[0] : 'Could not change that.'); });
    return;
  }
  /* Edit beside a purchase / stock receipt in the product Prices screen's own list (§26, 2026-09-28) —
     leaves the panel, so anything typed but not yet saved here is warned about first, same as the old
     "charges" Change button did. */
  if ((t = e.target.closest('[data-pztxedit]'))) {
    e.preventDefault(); e.stopPropagation();
    if (pricesDirty()) {
      say('You have typed prices here that are not saved yet — press Save first, then edit the ' +
        (t.dataset.pztxedit === 'receive' ? 'stock receipt' : 'purchase') + ' (closing this screen would lose them).');
      return;
    }
    var pclx = D.querySelector('#panel [data-close]');
    if (pclx) pclx.click();
    if (t.dataset.pztxedit === 'receive') { if (ERP.editStockReceipt) ERP.editStockReceipt(t.dataset.id); }
    else if (ERP.actions && ERP.actions.editPurchase) ERP.actions.editPurchase(t.dataset.id);
    return;
  }
}, true);

D.addEventListener('input', function (e) {
  if (!e.target.dataset) return;
  /* the price panel's "cost to us" line follows the purchase price and extra cost boxes as they are typed
     (§28, 2026-09-29 — both are editable here now, no selling price / qty box any more) */
  if (e.target.dataset.f === 'buy' || e.target.dataset.f === 'extra') {
    var held = PRICE_HELD;   /* Inventory.averages() of the product on show — see PANELS.prices.f */
    if (held) {
      var buyEl = D.querySelector('#panel [data-f="buy"]'), buyN = buyEl ? num(buyEl.value) : null;
      var buyBox = buyN === null ? (held.override || held.cost) : M.toP(buyN);
      var extraEl = D.querySelector('#panel [data-f="extra"]'), extraN = extraEl ? num(extraEl.value) : null;
      var extraBox = extraN === null ? held.extra : M.toP(extraN);
      var rowsEl = D.getElementById('pzCalcRows');
      if (rowsEl) rowsEl.innerHTML = calcHtml(buyBox, extraBox).rows;
    }
  }
  if (e.target.dataset.stq !== undefined) {
    SET.q = e.target.value;
    clearTimeout(SET._t);
    SET._t = setTimeout(function () {
      if (global.cur !== 'settings') return;
      var pos = e.target.selectionStart;
      global.paint();
      var back = D.querySelector('[data-stq]');
      if (back) { back.focus(); try { back.setSelectionRange(pos, pos); } catch (err) {} }
    }, 220);
  }
});
D.addEventListener('change', function (e) {
  if (!e.target.dataset || e.target.dataset.stfield === undefined) return;
  var key = e.target.dataset.stfield;
  var raw = e.target.value;
  var numeric = ['lowMarginWarnPct', 'maxDiscountPct', 'defaultReorderLevel',
                 'defaultPaymentTermDays', 'defaultCreditLimit', 'supplierPaymentTermDays'];
  var value = numeric.indexOf(key) > -1 ? (num(raw) || 0) : raw;
  var patch = {}; patch[key] = value;
  var before = ERP.Settings.get()[key];
  ERP.Settings.save(patch).then(function () {
    ERP.Audit.detached({ action: 'Setting changed: ' + key, entity: 'Settings', entityId: key,
      oldValues: { value: before }, newValues: { value: value } });
    say('Saved.');
  });
});

/* prices, history and approvals load with everything else */
(ERP.bootPromise || Promise.resolve()).then(function () {
  return FDB.hydrate().then(function (d) {
    S.priceHistory = (d.priceHistory || []).sort(function (a, b) {
      return a.changedAt < b.changedAt ? 1 : -1;
    });
    S.priceApprovals = (d.priceApprovals || []).sort(function (a, b) {
      return a.requestedAt < b.requestedAt ? 1 : -1;
    });
  });
}).catch(function () {
  S.priceHistory = S.priceHistory || []; S.priceApprovals = S.priceApprovals || [];
});
})(typeof window !== 'undefined' ? window : globalThis);
