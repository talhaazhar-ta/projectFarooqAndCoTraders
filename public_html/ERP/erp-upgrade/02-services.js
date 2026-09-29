/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 2/5
   DOMAIN + SERVICES
   Invoices with unlimited line items, purchases, payments with allocation,
   customer/supplier returns, inventory with an audit trail, ledgers that
   are always derived from transactions, and a one-time migration of every
   record the ERP already held. (§12–§27 §41 §43 §44 §47)
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';

var FDB = global.FDB, M = global.Money;
var ERP = { version: global.FAROOQ_UPGRADE_VERSION };

/* ── in-memory working set (rendered synchronously, persisted atomically) ── */
var S = ERP.S = {
  invoices: [], invoiceItems: [],
  purchases: [], purchaseItems: [],
  payments: [], allocations: [],
  custReturns: [], custReturnItems: [],
  supReturns: [], supReturnItems: [],
  inventory: {},                 // key `${pid}|${wid}` → {qty, damagedQty, avgCostP}
  movements: [],
  audit: [],
  sequences: {},
  business: null,
  loaded: false
};

var ENUM = ERP.ENUM = {
  invoiceStatus: ['DRAFT', 'CONFIRMED', 'DISPATCHED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'RETURNED', 'PARTIALLY_RETURNED'],
  paymentStatus: ['UNPAID', 'PARTIAL', 'PAID'],
  movement: ['OPENING_STOCK', 'PURCHASE_IN', 'SALE_OUT', 'CUSTOMER_RETURN_IN', 'CUSTOMER_RETURN_DAMAGED_IN',
             'SUPPLIER_RETURN_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
             'SALE_REVERSAL_IN', 'PURCHASE_REVERSAL_OUT', 'REPLACEMENT_OUT', 'SUPPLIER_REPLACEMENT_IN',
             'STOCK_WRITE_OFF', 'DISPATCH_OUT',
             'MILL_ISSUE_OUT', 'MILL_RECEIPT_IN', 'MILL_ISSUE_REVERSAL_IN', 'MILL_RECEIPT_REVERSAL_OUT',
             'CONVERT_OUT', 'CONVERT_IN', 'RECEIPT_EDIT_OUT', 'REVALUE'],
  /* what physically happens to a returned bag */
  returnCondition: ['SELLABLE', 'DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'EXPIRED', 'OTHER'],
  /* what happens to the money */
  returnTreatment: ['ADJUST_OUTSTANDING_BALANCE', 'CUSTOMER_CREDIT', 'REFUND', 'REPLACEMENT'],
  returnAction: ['RESELLABLE', 'DAMAGED', 'BACK_TO_SUPPLIER', 'WRITE_OFF'],
  methods: ['Cash', 'Bank Transfer', 'JazzCash', 'Easypaisa', 'Cheque', 'Adjustment']
};

var STATUS_LABEL = ERP.STATUS_LABEL = {
  DRAFT: 'Draft', CONFIRMED: 'Confirmed', DISPATCHED: 'Dispatched',
  PARTIALLY_PAID: 'Partly paid', PAID: 'Paid', CANCELLED: 'Cancelled',
  RETURNED: 'Returned', PARTIALLY_RETURNED: 'Partly returned',
  UNPAID: 'Unpaid', PARTIAL: 'Partly paid'
};

function nowISO() { return new Date().toISOString(); }
/* The original build pinned a fixed TODAY_ISO. A live ledger has to be
   dated by the calendar, so transactions use the real system date; the
   older screens keep reading their own constant. */
function todayISO() {
  var d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
global.FC_TODAY = todayISO;
function currentUser() { return global.CURRENT_USER || 'Owner'; }
/* the calendar day before an ISO date, or null if it isn't a real date */
function dayBefore(iso) {
  var t = Date.parse(String(iso || '') + 'T00:00:00Z');
  return isNaN(t) ? null : new Date(t - 86400000).toISOString().slice(0, 10);
}
function ikey(pid, wid) { return pid + '|' + wid; }

/* ── a serialised queue so fire-and-forget writes from the older, purely
      synchronous screens (dispatch, transfer, stock edits) still land in
      the database in order and never interleave. ── */
var chain = Promise.resolve();
function queue(fn) {
  chain = chain.then(fn).catch(function (e) {
    ERP.lastWriteError = e && e.message || String(e);
    try { global.console.warn('[ERP] deferred write failed:', e); } catch (x) {}
  });
  return chain;
}
ERP.queue = queue;
ERP.flush = function () { return chain; };

/* ══════════════════════════════════════════════════════════════════════════
   AUDIT (§43)
   ══════════════════════════════════════════════════════════════════════════ */
var Audit = ERP.Audit = {
  build: function (o) {
    return {
      id: FDB.uid('aud'), createdAt: nowISO(), date: todayISO(),
      userId: currentUser(), action: o.action, entity: o.entity || '',
      entityId: o.entityId || '', ref: o.ref || '',
      oldValues: o.oldValues || null, newValues: o.newValues || null,
      reason: o.reason || ''
    };
  },
  write: function (api, o) {
    var rec = Audit.build(o);
    api.put('auditLog', rec);
    S.audit.unshift(rec);
    if (S.audit.length > 4000) S.audit.length = 4000;
    return rec;
  },
  detached: function (o) {
    var rec = Audit.build(o);
    S.audit.unshift(rec);
    queue(function () { return FDB.tx(['auditLog'], function (api) { api.put('auditLog', rec); }); });
    return rec;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   INVENTORY (§12 §14 §15)
   Stock is per product per warehouse and only ever changes through a
   movement, so the ledger of bags always reconciles with the quantity.
   ══════════════════════════════════════════════════════════════════════════ */
/* stock movements that bring NEW bags in (they carry the product's extra cost of that day) and the reversals that
   take such bags back out — see Inventory.rowExtraP. Returns, sale reversals and mill-issue reversals put bags back
   that already had a cost, so they are not in either list. Extra cost and selling price are blended the same
   way and follow the same two lists (§26). */
var EXTRA_FRESH_IN = { PURCHASE_IN: 1, MILL_RECEIPT_IN: 1, OPENING_STOCK: 1, ADJUSTMENT_IN: 1, SUPPLIER_REPLACEMENT_IN: 1 };
var EXTRA_UNDO_OUT = { PURCHASE_REVERSAL_OUT: 1, RECEIPT_EDIT_OUT: 1, MILL_RECEIPT_REVERSAL_OUT: 1 };
/* 2026-09-28: the purchase price itself now blends this way too, but ONLY for a stock receipt (Add stock) —
   a plain stock Adjustment is not a price event. PURCHASE_IN / MILL_RECEIPT_IN already blended before this
   change and still do, unconditionally. */
function isFreshCostIn(mv) {
  return mv.kind === 'PURCHASE_IN' || mv.kind === 'MILL_RECEIPT_IN' ||
    ((mv.kind === 'ADJUSTMENT_IN' || mv.kind === 'OPENING_STOCK') && mv.refType === 'STOCK_RECEIPT');
}
var COST_UNDO_OUT = { PURCHASE_REVERSAL_OUT: 1, RECEIPT_EDIT_OUT: 1, MILL_RECEIPT_REVERSAL_OUT: 1 };
var Inventory = ERP.Inventory = {
  row: function (pid, wid) {
    var k = ikey(pid, wid);
    if (!S.inventory[k]) S.inventory[k] = { id: k, productId: pid, warehouseId: wid, qty: 0, damagedQty: 0, avgCostP: 0 };
    return S.inventory[k];
  },
  available: function (pid, wid) { return Inventory.row(pid, wid).qty; },
  damaged: function (pid, wid) { return Inventory.row(pid, wid).damagedQty; },
  totalFor: function (pid) {
    return Object.keys(S.inventory).reduce(function (a, k) {
      return a + (S.inventory[k].productId === pid ? S.inventory[k].qty : 0);
    }, 0);
  },
  costOf: function (pid, wid) {
    /* with no warehouse given this is a product-level question: never create a stock row for it (a
       `<product>|undefined` row was created here and later saved to the server by Prices.set) */
    var r = wid ? Inventory.row(pid, wid) : { avgCostP: 0 };
    if (r.avgCostP) return r.avgCostP;
    /* this row's own carried cost outranks another warehouse's recorded average — the same
       priority Stock value uses for one row (37-stock-value.js costFor: recorded → carried →
       other → list) — so costing a sale in THIS warehouse cannot pick up a different warehouse's
       price just because this one was only ever stocked through Add stock. */
    if (wid) {
      var ownCarried = Inventory.carriedCost(pid, wid);
      if (ownCarried) return ownCarried;
    }
    var any = 0;
    Object.keys(S.inventory).forEach(function (k) {
      if (S.inventory[k].productId === pid && S.inventory[k].avgCostP) any = any || S.inventory[k].avgCostP;
    });
    if (any) return any;
    if (!wid) {                                   // product-level (no warehouse given): fall to a
      var carried = Inventory.carriedCost(pid, wid);   // product-wide carried cost before the list price
      if (carried) return carried;
    }
    var p = global.prodOf && global.prodOf(pid);
    return p && p.buy ? M.toP(p.buy) : 0;
  },
  /* The product's own "Extra cost per bag" (Product prices panel, 21-settings.js): transport, labour,
     loading WE pay to bring a bag in. Client, 2026-09-25: "purchase 3000, extra 200, total 3200 — and
     profit still showed 200 more" — a sale was costed at the stock cost alone. It is part of what a
     SALE costs (saleCostOf), not of the stock's own value, so avgCostP / Stock value never carry it.
     Not added under the "purchase price only" profit basis (Settings → profitCostBasis 'PURCHASE'). */
  extraOf: function (pid) {
    var basis = ERP.Settings && ERP.Settings.get ? ERP.Settings.get().profitCostBasis : null;
    if (basis === 'PURCHASE') return 0;
    return Inventory.rawExtraOf(pid);
  },
  /* the product's own extra cost figure, whatever the profit basis */
  rawExtraOf: function (pid) {
    var p = global.prodOf && global.prodOf(pid);
    if (!p) return 0;
    var x = p.extraP !== undefined && p.extraP !== null ? Number(p.extraP) : (p.extra ? M.toP(p.extra) : 0);
    return x > 0 ? x : 0;
  },
  /* 2026-09-26, client: "when the extra cost changes, the bags already in stock must keep the old one".
     The extra is no longer read off the product at sale time. Each stock row carries `avgExtraP`, the
     moving average of the extra cost of the bags on hand: bags coming in (a purchase, Add stock, opening
     stock, a mill receipt) bring the product's extra AS IT IS THAT DAY and blend in by quantity, exactly
     as avgCostP does for the price; a transfer / brand conversion carries the source row's figure.
     A row that has never been blended (`avgExtraP` unset — every row from before this change) follows the
     product's current extra, which is what it always did, until the extra is edited (Prices.set freezes it). */
  rowExtraP: function (pid, wid) {
    var r = wid ? S.inventory[ikey(pid, wid)] : null;
    return r && typeof r.avgExtraP === 'number' ? r.avgExtraP : Inventory.rawExtraOf(pid);
  },
  /* the extra a sale out of this warehouse carries (0 under the "purchase price only" profit basis).
     §28, 2026-09-29: ONE extra cost per product, typed on the Prices screen (client: no more per-row
     blending — a typed figure holds until it is changed). The row-level avgExtraP machinery (rowExtraP)
     is left in place for movement history/reversal bookkeeping but is no longer read for costing a sale. */
  extraFor: function (pid, wid) {
    var basis = ERP.Settings && ERP.Settings.get ? ERP.Settings.get().profitCostBasis : null;
    if (basis === 'PURCHASE') return 0;
    return Inventory.rawExtraOf(pid);
  },
  /* §28, 2026-09-29 (client: "no need of selling price — decided while selling"): the selling price is
     typed fresh on every sale line, so there is no stored product selling price to read here any more.
     Kept as a thin wrapper (returns 0) so any caller still expecting a function does not crash; the sale
     line now pre-fills from Inventory.lastSoldP instead (05-ui-builder.js lastRate). */
  rawSellOf: function (pid) { return 0; },
  sellOf: function (pid, wid) { return 0; },
  /* §28, 2026-09-29 (client: "write average of all purchase price of bags available in stock just as a
     label, then the user decides the new purchase price"): the chosen figure a sale is costed at.
     `p.costOverrideP` is set only on the Prices screen; while it is unset the live bag-weighted average
     (Inventory.averages(pid).cost) is used, so a fresh product with no chosen price still costs correctly.
     Once chosen, it holds even when new stock arrives at a different price — only editing it on the
     Prices screen changes it again. */
  saleBuyOf: function (pid, wid) {
    var p = global.prodOf && global.prodOf(pid);
    if (p && p.costOverrideP > 0) return p.costOverrideP;
    return Inventory.averages(pid).cost;
  },
  /* the bag-weighted purchase price of the stock actually on hand, across every warehouse — what the
     Prices screen shows as a read-only label. `extra` is the product's own single extra-cost figure
     (Inventory.rawExtraOf) — there is only ever one, typed on the Prices screen, default 0. `override` is
     the chosen purchase price if one has been set (0 if the price is still following the average). `bags`
     is 0 (and `cost` falls back to a carried/last-known figure) when nothing is in stock. */
  averages: function (pid) {
    var qty = 0, costV = 0;
    Object.keys(S.inventory).forEach(function (k) {
      var r = S.inventory[k];
      if (r.productId !== pid || !(r.qty > 0)) return;
      var c = r.avgCostP || Inventory.carriedCost(pid, r.warehouseId) || 0;
      qty += r.qty; costV += c * r.qty;
    });
    var p = global.prodOf && global.prodOf(pid);
    var override = p && p.costOverrideP > 0 ? p.costOverrideP : 0;
    if (!qty) {
      /* nothing on hand in ANY warehouse — a fully sold-out product used to show its cost as 0 here (the
         only fallback was the product's own p.buy, and nothing writes that any more since the Prices
         screen stopped revaluing cost/extra, §27 2026-09-28). Fall back to the last purchase/receipt this
         product ever had, so the read-only Prices screen still shows something real instead of "—". */
      var lastKnown = Inventory.lastKnownCost(pid);
      return { cost: lastKnown || (p && p.buy ? M.toP(p.buy) : 0), extra: Inventory.rawExtraOf(pid), override: override, bags: 0 };
    }
    return { cost: Math.round(costV / qty), extra: Inventory.rawExtraOf(pid), override: override, bags: qty };
  },
  /* the purchase price of the most recent purchase/receipt this product ever had, in ANY warehouse,
     regardless of whether any of those bags are still in stock — the fallback `averages()` uses once a
     product has fully sold out (a movement record never carries the extra cost, only unitCostP, so this
     covers cost only; extra falls back to the product's own rawExtraOf as it always did). */
  lastKnownCost: function (pid) {
    var best = null;
    (S.movements || []).forEach(function (mv) {
      if (mv.productId !== pid || mv.bucket === 'damaged' || !(mv.unitCostP > 0) || !(mv.qtyDelta > 0)) return;
      if (!isFreshCostIn(mv)) return;
      var stamp = (mv.date || '') + '|' + (mv.createdAt || '');
      if (!best || stamp >= best.stamp) best = { stamp: stamp, cost: mv.unitCostP };
    });
    return best ? best.cost : 0;
  },
  /* The rate this product last sold at on a live invoice — §28, 2026-09-29: offered as the starting figure
     for a NEW sale line (the selling price is typed fresh on every sale now, there is no stored product
     figure). Moved here from 21-settings.js so both the Prices screen and the Builder can share it. */
  lastSoldP: function (pid) {
    var best = null;
    (S.invoiceItems || []).forEach(function (it) {
      if (it.productId !== pid || !(it.unitPrice > 0)) return;
      var inv = ERP.Invoices && ERP.Invoices.byId ? ERP.Invoices.byId(it.invoiceId) : null;
      if (!inv || inv.status === 'CANCELLED' || inv.status === 'DRAFT') return;
      var stamp = (inv.invoiceDate || '') + '|' + (inv.createdAt || '');
      if (!best || stamp > best.stamp) best = { stamp: stamp, p: it.unitPrice };
    });
    return best ? best.p : 0;
  },
  /* what one bag of a sale is costed at: the chosen purchase price (Inventory.saleBuyOf — the Prices
     screen's figure, or the live average when none was chosen) plus the extra cost per bag. An unknown
     cost stays unknown (0) — the extra alone is not a cost price and would show a made-up profit.
     §28, 2026-09-29: this drives PROFIT ONLY — Stock value (37-stock-value.js) still reads the real
     document costs (Inventory.costOf/carriedCost), never the chosen override. */
  saleCostOf: function (pid, wid) {
    var base = Inventory.saleBuyOf(pid, wid);
    return base ? base + Inventory.extraFor(pid, wid) : 0;
  },
  /* the weighted cost of stock that came in without ever touching avgCostP — opening stock, "Add
     stock" with a cost typed, transfers, brand conversions. avgCostP only moves on PURCHASE_IN /
     MILL_RECEIPT_IN (see apply() below), so a product priced only through one of these ways used to
     cost 0 everywhere else — Prices.of then showed a false 100% margin, and a sale's profit was
     wrong. Mirrors the same "carried" cost Stock value already shows (37-stock-value.js) so the two
     agree. Scoped to one warehouse when given, else every warehouse the product is in. */
  carriedCost: function (pid, wid) {
    var CARRIED = { OPENING_STOCK: 1, ADJUSTMENT_IN: 1, TRANSFER_IN: 1, CONVERT_IN: 1 };
    var qty = 0, cost = 0;
    (S.movements || []).forEach(function (mv) {
      if (mv.productId !== pid || (wid && mv.warehouseId !== wid)) return;
      if (mv.bucket === 'damaged' || !(mv.unitCostP > 0)) return;
      /* an edited Add-stock receipt takes its old lines back out AT THEIR OLD COST (07-transactions.js
         StockDocs.editReceive), so the corrected cost replaces the old one instead of averaging with it */
      if (mv.kind === 'RECEIPT_EDIT_OUT' && mv.qtyDelta < 0) { qty += mv.qtyDelta; cost += mv.qtyDelta * mv.unitCostP; return; }
      if (!CARRIED[mv.kind] || !(mv.qtyDelta > 0)) return;
      qty += mv.qtyDelta; cost += mv.qtyDelta * mv.unitCostP;
    });
    return qty > 0 && cost > 0 ? Math.round(cost / qty) : 0;
  },
  /* Apply one movement inside a caller-owned transaction. */
  apply: function (api, mv) {
    var r = Inventory.row(mv.productId, mv.warehouseId);
    var delta = Number(mv.qtyDelta) || 0;
    if (mv.bucket === 'damaged') r.damagedQty = Math.round((r.damagedQty + delta) * 1000) / 1000;
    else r.qty = Math.round((r.qty + delta) * 1000) / 1000;

    if (mv.kind === 'REVALUE') {
      /* a stock-cost correction made by editing the SOURCE purchase/receipt (2026-09-28 — cost is fixed to the
         document, never revalued from this screen any more) — a direct SET, never a blend: qtyDelta is always
         0, so the ordinary moving-average formula would leave every figure unchanged (0 bags "coming in"
         contribute nothing to a weighted average). */
      if (typeof mv.unitCostP === 'number') r.avgCostP = mv.unitCostP;
      if (typeof mv.extraCostP === 'number') r.avgExtraP = mv.extraCostP;
      api.put('inventory', r);
      return applyRecord(api, mv, r, delta);
    }
    if (isFreshCostIn(mv) && mv.unitCostP) {  // moving average cost (§41), and Add stock since 2026-09-28 (§26)
      var before = r.qty - delta;
      /* a row that has never blended a recorded cost (all its stock came in through Add stock, before this
         change) follows its carried cost instead of an assumed 0 — otherwise the first purchase or receipt
         after this deploy would wrongly dilute the average toward zero for the bags already on hand */
      var prev = typeof r.avgCostP === 'number' && r.avgCostP > 0 ? r.avgCostP
        : Inventory.carriedCost(mv.productId, mv.warehouseId);
      r.avgCostP = before > 0 && prev > 0
        ? Math.round((before * prev + delta * mv.unitCostP) / (before + delta))
        : mv.unitCostP;
    } else if (delta < 0 && mv.kind && COST_UNDO_OUT[mv.kind] && typeof mv.unitCostP === 'number' &&
               mv.unitCostP > 0 && r.qty > 0 && typeof r.avgCostP === 'number' && r.avgCostP > 0) {
      /* a reversal / receipt edit takes bags back out at the cost they came in with, so re-posting them does
         not re-price the bags that were already there (mirrors the avgExtraP undo just below) */
      var outQ = -delta;
      r.avgCostP = Math.max(0, Math.round(((r.qty + outQ) * r.avgCostP - outQ * mv.unitCostP) / r.qty));
    } else if (mv.kind === 'CONVERT_IN' && mv.unitCostP > 0 && mv.bucket !== 'damaged') {
      /* a brand conversion brings bags in at the SOURCE's cost. Blend them into the target's average so the total value
         does not move; a target that has bags but no recorded average keeps none (Stock value carries the cost instead,
         37-stock-value.js CARRIED) rather than diluting bags of unknown cost to zero. */
      var had = r.qty - delta, avg0 = r.avgCostP || 0;
      if (had <= 0) r.avgCostP = mv.unitCostP;
      else if (avg0 > 0) r.avgCostP = Math.round((had * avg0 + delta * mv.unitCostP) / (had + delta));
    }
    /* the extra cost per bag on hand (see Inventory.rowExtraP). Only stock in the usable bucket. */
    if (mv.bucket !== 'damaged') {
      var exGiven = typeof mv.extraCostP === 'number' ? mv.extraCostP : null;
      if (delta > 0 && (exGiven !== null || EXTRA_FRESH_IN[mv.kind])) {
        var exIn = exGiven !== null ? exGiven : Inventory.rawExtraOf(mv.productId);
        var exHad = r.qty - delta;
        var exPrev = typeof r.avgExtraP === 'number' ? r.avgExtraP : Inventory.rawExtraOf(mv.productId);
        r.avgExtraP = exHad > 0 ? Math.round((exHad * exPrev + delta * exIn) / (exHad + delta)) : exIn;
      } else if (delta < 0 && exGiven !== null && EXTRA_UNDO_OUT[mv.kind] &&
                 r.qty > 0 && typeof r.avgExtraP === 'number') {
        /* a reversal takes bags back out at the extra they came in with, so re-posting them (a purchase or
           receipt edit) does not re-price the bags that were already there */
        var exOut = -delta;
        r.avgExtraP = Math.max(0, Math.round(((r.qty + exOut) * r.avgExtraP - exOut * exGiven) / r.qty));
      }
      /* no per-row selling price any more (2026-09-28) — there is one selling price per PRODUCT
         (Inventory.rawSellOf), set only on the product Prices screen; stock arriving never touches it. */
    }
    api.put('inventory', r);
    return applyRecord(api, mv, r, delta);
  }
};

/* the movement record + stock-map/history mirrors, shared by the ordinary path above and the REVALUE
   early-return (a direct set has nothing else to do first) */
function applyRecord(api, mv, r, delta) {
  var rec = {
    id: FDB.uid('mv'), createdAt: nowISO(), date: mv.date || todayISO(),
    productId: mv.productId, warehouseId: mv.warehouseId, kind: mv.kind,
    qtyDelta: delta, bucket: mv.bucket || 'stock', balanceAfter: (mv.bucket === 'damaged' ? r.damagedQty : r.qty),
    ref: mv.ref || '', refType: mv.refType || '', note: mv.note || '',
    unitCostP: mv.unitCostP || 0, userId: currentUser()
  };
  api.put('stockMovements', rec);
  S.movements.unshift(rec);
  if (S.movements.length > 8000) S.movements.length = 8000;

  /* keep the original screens' stock map and history in step */
  if (mv.bucket !== 'damaged' && global.STOCKMAP) {
    global.STOCKMAP[ikey(mv.productId, mv.warehouseId)] = r.qty;
  }
  if (global.MOVES) {
    global.MOVES.unshift({
      id: 'MV-' + rec.id.slice(-6).toUpperCase(), t: (global.stamp ? global.stamp() : ''),
      iso: rec.date, pid: mv.productId, wid: mv.warehouseId, delta: delta,
      kind: Movements.label(mv.kind), ref: mv.ref || '', note: mv.note || '', by: currentUser()
    });
    if (global.MOVES.length > 4000) global.MOVES.length = 4000;
  }
  return rec;
}

var Movements = ERP.Movements = {
  label: function (k) {
    return ({
      SALE_OUT: 'Sale', PURCHASE_IN: 'Purchase', CUSTOMER_RETURN_IN: 'Customer return',
      CUSTOMER_RETURN_DAMAGED_IN: 'Damaged return', DAMAGED_RETURN_IN: 'Damaged return',
      SUPPLIER_RETURN_OUT: 'Return to supplier', STOCK_WRITE_OFF: 'Write-off',
      TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out',
      ADJUSTMENT_IN: 'Adjustment in', ADJUSTMENT_OUT: 'Adjustment out', ADJUSTMENT: 'Adjustment',
      SALE_REVERSAL_IN: 'Sale reversal', PURCHASE_REVERSAL_OUT: 'Purchase reversal',
      REPLACEMENT_OUT: 'Replacement issued', SUPPLIER_REPLACEMENT_IN: 'Replacement from supplier',
      DISPATCH_OUT: 'Dispatch', OPENING_STOCK: 'Opening stock', OPENING: 'Opening stock',
      MILL_ISSUE_OUT: 'Issued for milling', MILL_RECEIPT_IN: 'Received from mill',
      MILL_ISSUE_REVERSAL_IN: 'Milling issue reversed', MILL_RECEIPT_REVERSAL_OUT: 'Milling receipt reversed',
      CONVERT_OUT: 'Converted to another brand', CONVERT_IN: 'Converted from another brand',
      RECEIPT_EDIT_OUT: 'Stock receipt edited (old lines reversed)', REVALUE: 'Prices revalued'
    })[k] || k;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   INVOICE TOTALS — the authoritative calculation (§4 §45)
   The screen shows the same numbers, but this function is what gets saved.
   Every figure is an integer paisa.
   ══════════════════════════════════════════════════════════════════════════ */
var Calc = ERP.Calc = {
  line: function (it) {
    var qty = M.qty(it.quantity);
    var unit = M.toP(it.unitPriceR !== undefined ? it.unitPriceR : it.unitPrice);
    var gross = M.mul(unit, qty);
    var disc = Math.min(M.toP(it.discountR !== undefined ? it.discountR : it.discount), gross);
    var taxable = gross - disc;
    var taxP = it.taxRate ? Math.round(taxable * Number(it.taxRate) / 100) : M.toP(it.taxR || it.tax);
    return { qty: qty, unitPrice: unit, gross: gross, discount: disc, tax: taxP, lineTotal: taxable + taxP };
  },
  invoice: function (draft) {
    var items = (draft.items || []).map(function (it) {
      var c = Calc.line(it);
      return Object.assign({}, it, {
        quantity: c.qty, unitPrice: c.unitPrice, discount: c.discount,
        tax: c.tax, lineTotal: c.lineTotal
      });
    });
    var subtotal      = M.sum(items.map(function (i) { return M.mul(i.unitPrice, i.quantity); }));
    var itemDiscounts = M.sum(items.map(function (i) { return i.discount; }));
    var itemTax       = M.sum(items.map(function (i) { return i.tax; }));
    var invDiscount   = Math.min(M.toP(draft.invoiceDiscountR !== undefined ? draft.invoiceDiscountR : draft.invoiceDiscount),
                                 Math.max(0, subtotal - itemDiscounts));
    var freight       = M.toP(draft.freightR !== undefined ? draft.freightR : draft.freight);
    var loading       = M.toP(draft.loadingR !== undefined ? draft.loadingR : draft.loading);
    var other         = M.toP(draft.otherChargesR !== undefined ? draft.otherChargesR : draft.otherCharges);
    var grand = subtotal - itemDiscounts - invDiscount + itemTax + freight + loading + other;
    var paid  = M.toP(draft.paidAmountR !== undefined ? draft.paidAmountR : draft.paidAmount);
    return {
      items: items,
      subtotal: subtotal, itemDiscounts: itemDiscounts, invoiceDiscount: invDiscount,
      discountAmount: itemDiscounts + invDiscount, taxAmount: itemTax,
      freightAmount: freight, loadingAmount: loading, otherCharges: other,
      grandTotal: grand, paidAmount: paid, balanceAmount: grand - paid,
      totalQty: items.reduce(function (a, i) { return a + i.quantity; }, 0),
      lineCount: items.length
    };
  },
  paymentStatus: function (grand, paid) {
    if (grand <= 0) return 'UNPAID';
    if (paid >= grand) return 'PAID';
    return paid > 0 ? 'PARTIAL' : 'UNPAID';
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   VALIDATION (§44) — rejected here, not only in the form
   ══════════════════════════════════════════════════════════════════════════ */
var Validate = ERP.Validate = {
  invoice: function (draft, opts) {
    opts = opts || {};
    var errs = [];
    var c = global.custBy && global.custBy(draft.customerId);
    if (!draft.customerId || !c) errs.push('Choose a shop to invoice.');
    if (!draft.warehouseId || !(global.WAREHOUSES || []).some(function (w) { return w.id === draft.warehouseId; }))
      errs.push('Choose the warehouse the bags leave from.');
    var items = (draft.items || []).filter(function (i) { return i.productId; });
    if (!items.length) errs.push('Add at least one product line.');
    items.forEach(function (it, i) {
      var p = global.prodOf && global.prodOf(it.productId);
      var n = 'Line ' + (i + 1);
      if (!p) { errs.push(n + ': that product no longer exists.'); return; }
      var q = M.qty(it.quantity);
      if (!(q > 0)) errs.push(n + ' (' + (p.en || p.ur) + '): quantity must be more than zero.');
      var rate = M.toP(it.unitPriceR !== undefined ? it.unitPriceR : it.unitPrice);
      if (rate < 0) errs.push(n + ': the rate cannot be negative.');
      if (!opts.allowZeroRate && rate === 0) errs.push(n + ' (' + (p.en || p.ur) + '): enter a rate per bag.');
      var disc = M.toP(it.discountR !== undefined ? it.discountR : it.discount);
      if (disc > M.mul(rate, q)) errs.push(n + ': the discount is larger than the line amount.');
      var wid = it.warehouseId || draft.warehouseId;
      if (!opts.skipStock && !Settings.allowNegativeStock()) {
        var have = Inventory.available(it.productId, wid);
        if (q > have) {
          errs.push('Only ' + have + ' bags of ' + (p.en || p.ur) + ' are available in ' +
                    (global.whName ? global.whName(wid) : wid) + '. Requested: ' + q + '.');
        }
      }
    });
    var t = Calc.invoice(Object.assign({}, draft, { items: items }));
    if (t.paidAmount < 0) errs.push('The amount paid cannot be negative.');
    if (t.paidAmount > t.grandTotal && !opts.allowOverpay)
      errs.push('The amount paid is more than the invoice total. Record the extra as a separate payment on account.');
    return errs;
  },
  purchase: function (draft) {
    var errs = [];
    if (!draft.supplierId || !(global.supOf && global.supOf(draft.supplierId))) errs.push('Choose a supplier.');
    if (!draft.warehouseId) errs.push('Choose the destination warehouse.');
    var items = (draft.items || []).filter(function (i) { return i.productId; });
    if (!items.length) errs.push('Add at least one product line.');
    items.forEach(function (it, i) {
      var q = M.qty(it.quantity);
      if (!(q > 0)) errs.push('Line ' + (i + 1) + ': quantity must be more than zero.');
      /* the purchase price is required at the SCREEN (05-ui-builder.js B.save checks it synchronously
         before Save is even pressed) — kept only non-negative here, since this function is also the
         data-setup path every test in the suite uses, many with no price at all */
      var rate = M.toP(it.unitPriceR !== undefined ? it.unitPriceR : it.unitPrice);
      if (rate < 0) errs.push('Line ' + (i + 1) + ': invalid purchase price.');
      if (it.receivedQty !== undefined && it.receivedQty !== '') {
        var recv = M.qty(it.receivedQty);
        if (recv < 0) errs.push('Line ' + (i + 1) + ': Received cannot be negative.');
        if (recv > q) errs.push('Line ' + (i + 1) + ': Received (' + recv + ') cannot be more than Ordered (' + q + ').');
      }
    });
    return errs;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   BUSINESS SETTINGS (§1 §33) — one record, no hard-coded details
   ══════════════════════════════════════════════════════════════════════════ */
var Settings = ERP.Settings = {
  defaults: function () {
    var B = global.BIZ || {};
    return {
      id: 'business', businessName: B.name || 'Farooq & Co Traders',
      legalName: '', tagline: 'Rice & Flour Traders & Distributors',
      taglineUr: 'ہول سیل ڈیلر اینڈ سپلائر',
      slogan: B.slogan || 'آپ کے اعتماد کا نام',
      logoText: 'F&C', logoDataUrl: '',
      address: B.addr || 'Main Bazar, Dir Bala — مین بازار، دیر بالا',
      city: 'Dir Bala, Khyber Pakhtunkhwa',
      phone: B.phone || '0321-9535252 / 0345-9535252',
      shopPhone: (B.shopPhones && B.shopPhones.join(' / ')) || '0944-881316 / 0944-880316',
      whatsapp: B.wa || '0321-9535252',
      email: B.email || '', website: '', ntn: B.ntn || '', registrationNo: '',
      proprietor: B.proprietor || 'Farooq Jameel — 0322-9535252',
      invoicePrefix: 'INV', purchasePrefix: 'PUR', receiptPrefix: 'REC',
      orderPrefix: 'SO', dispatchPrefix: 'DSP',
      currency: 'PKR', currencyLabel: 'PKR',
      taxEnabled: false, defaultTaxRate: 0,
      allowNegativeStock: false, defaultDueDays: 0,
      invoiceFooter: 'Thank you for your business.',
      terms: 'Goods once sold are the responsibility of the buyer. Please check every bag on delivery.',
      bankDetails: '', preparedByLabel: 'Prepared by', receivedByLabel: 'Received by',
      smsProvider: '', smsSenderId: '', whatsappProvider: '',
      updatedAt: nowISO()
    };
  },
  get: function () {
    if (!S.business) S.business = Settings.defaults();
    return S.business;
  },
  allowNegativeStock: function () { return !!Settings.get().allowNegativeStock; },
  save: function (patch) {
    var b = Object.assign(Settings.get(), patch || {}, { updatedAt: nowISO() });
    S.business = b;
    /* keep the original Settings screen and old templates in step */
    if (global.BIZ) {
      global.BIZ.name = b.businessName; global.BIZ.addr = b.address;
      global.BIZ.phone = b.phone; global.BIZ.wa = b.whatsapp; global.BIZ.email = b.email;
      global.BIZ.ntn = b.ntn; global.BIZ.footer = b.invoiceFooter;
    }
    return queue(function () {
      return FDB.tx(['business', 'auditLog'], function (api) {
        api.put('business', b);
        Audit.write(api, { action: 'Business settings updated', entity: 'BusinessSettings', entityId: 'business' });
      });
    }).then(function () { return b; });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   INVOICES (§2 §3 §18 §20 §26 §27 §36)
   ══════════════════════════════════════════════════════════════════════════ */
var Invoices = ERP.Invoices = {
  all: function () { return S.invoices; },
  byId: function (id) { return S.invoices.find(function (i) { return i.id === id; }) || null; },
  byNumber: function (no) { return S.invoices.find(function (i) { return i.invoiceNumber === no; }) || null; },
  items: function (id) { return S.invoiceItems.filter(function (i) { return i.invoiceId === id; })
                                              .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },
  live: function () { return S.invoices.filter(function (i) { return i.status !== 'CANCELLED' && i.status !== 'DRAFT'; }); },

  /* Snapshot of the product as it was on the day, so an old invoice keeps
     telling the truth after a rename or a price change (§18 §41).
     The figures arrive already normalised to paisa by Calc.invoice — they
     are used as they are, never converted a second time. */
  snapshotItem: function (it, draft, order) {
    var p = global.prodOf(it.productId);
    var wid = it.warehouseId || draft.warehouseId;
    return {
      id: it.id || FDB.uid('ii'), invoiceId: draft.id, sortOrder: order,
      productId: it.productId, productVariantId: it.productVariantId || null,
      descriptionSnapshot: p ? (p.ur || p.en || '') : (it.description || ''),
      descriptionEnSnapshot: p ? (p.en || '') : '',
      brandSnapshot: p ? (p.brandEn || p.brand || '') : (it.brand || ''),
      categorySnapshot: p ? (p.cat || '') : '',
      packageSnapshot: p && p.kg ? p.kg + ' KG' : (it.package || 'Bag'),
      skuSnapshot: p ? (p.sku || p.sourceFolio || p.id) : '',
      unit: it.unit || 'Bag',
      quantity: it.quantity, unitPrice: it.unitPrice, discount: it.discount,
      tax: it.tax, lineTotal: it.lineTotal,
      /* costSnapshot stays the sum of the two, for every existing report that already reads it; the split is
         new (§26, 2026-09-28) so Profit & margin can show the written sum the client asked for — Purchase
         price + Extra cost = Total — instead of only the total. §28, 2026-09-29: costBuySnapshot is now the
         CHOSEN purchase price (Inventory.saleBuyOf — the Prices screen's figure or the live average). */
      costBuySnapshot: Inventory.saleBuyOf(it.productId, wid),
      costExtraSnapshot: Inventory.extraFor(it.productId, wid),
      costSnapshot: Inventory.saleCostOf(it.productId, wid),
      warehouseId: wid, batchNo: it.batchNo || '', notes: it.notes || '',
      returnedQty: 0
    };
  },

  /* The shop's details as they are stamped onto an invoice. One place builds
     them, so a new invoice and an invoice moved to another shop
     (Invoices.changeCustomer) can never disagree about what a snapshot holds. */
  customerFields: function (c) {
    c = c || {};
    var region = global.regionOf && c.region ? global.regionOf(c.region) : null;
    return {
      customerCodeSnapshot: c.legacyCode || c.id || '',
      customerNameSnapshot: c.ow || c.sh || '',
      shopNameSnapshot: c.sh || '',
      contactPersonSnapshot: c.ow || '',
      mobileSnapshot: c.ph || '', whatsappSnapshot: c.wa || '',
      addressSnapshot: c.addr || '',
      regionId: c.region || '', regionSnapshot: region ? (region.ur + ' — ' + region.en) : '',
      marketSnapshot: c.area || c.route || ''
    };
  },

  buildRecord: function (draft, totals, number, status) {
    var c = global.custBy(draft.customerId) || {};
    return Object.assign({
      id: draft.id, invoiceNumber: number,
      clientOpId: draft.clientOpId || draft.id,      // idempotency for offline sync (§30)
      invoiceType: draft.invoiceType || 'SALE',
      saleOrderId: draft.saleOrderId || null,
      orderNumber: draft.orderNumber || '',
      dispatchNumber: draft.dispatchNumber || '',
      customerId: draft.customerId
    }, Invoices.customerFields(c), {
      warehouseId: draft.warehouseId,
      warehouseSnapshot: global.whName ? global.whName(draft.warehouseId) : '',
      salesperson: draft.salesperson || currentUser(),
      invoiceDate: draft.invoiceDate || todayISO(),
      dueDate: draft.dueDate || '',
      subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      itemDiscounts: totals.itemDiscounts, invoiceDiscount: totals.invoiceDiscount,
      taxAmount: totals.taxAmount, freightAmount: totals.freightAmount,
      loadingAmount: totals.loadingAmount, otherCharges: totals.otherCharges,
      grandTotal: totals.grandTotal, paidAmount: totals.paidAmount,
      balanceAmount: totals.grandTotal - totals.paidAmount,
      paymentStatus: Calc.paymentStatus(totals.grandTotal, totals.paidAmount),
      paymentMethod: draft.paymentMethod || 'Cash',
      referenceNo: draft.referenceNo || '',
      status: status,
      notes: draft.notes || '',
      totalQty: totals.totalQty, lineCount: totals.lineCount,
      previousBalance: draft.previousBalance || 0,
      revision: draft.revision || 0,
      createdBy: currentUser(), createdAt: draft.createdAt || nowISO(), updatedAt: nowISO(),
      confirmedAt: status !== 'DRAFT' ? nowISO() : null,
      cancelledAt: null, cancelReason: '',
      stockApplied: false
    });
  },

  /* ── Save. One transaction covers: number, invoice, items, stock,
        movements, payment, allocation, ledger effect and audit. If any
        step throws, IndexedDB rolls the whole thing back (§20). ── */
  save: function (draft, opts) {
    opts = opts || {};
    var asDraft = !!opts.draft;
    var errs = Validate.invoice(draft, { skipStock: asDraft, allowZeroRate: asDraft, allowOverpay: opts.allowOverpay });
    /* An ordinary edit only rewrites the invoice's own `customerId`; the
       receipts, allocations and returns that belong to the old shop would stay
       behind and the two shops' accounts would no longer add up. Moving a
       posted invoice to another shop goes through changeCustomer instead. */
    var prior = draft.id ? Invoices.byId(draft.id) : null;
    if (prior && prior.status !== 'DRAFT' && prior.customerId && draft.customerId &&
        draft.customerId !== prior.customerId) {
      errs.push('The shop on a posted invoice cannot be changed while editing it. ' +
                'Use "Change shop" on the invoice, which moves its payments with it.');
    }
    /* An edit deletes the invoice's lines and writes new ones under NEW ids. A customer return points at a line
       by its id, so after an edit the returned bags would no longer be found: the same bags could be returned a
       second time, the profit report would lose the cost of the returned bags, and the "returned" status is
       overwritten. Until lines keep their ids, an invoice with a live return is closed to editing. */
    if (prior && prior.status !== 'DRAFT' && Invoices.returnsOn(prior.id).length) {
      errs.push(prior.invoiceNumber + ' already has a return (' +
        Invoices.returnsOn(prior.id).map(function (r) { return r.returnNumber; }).join(', ') +
        '), which is tied to its lines — it can no longer be edited. Correct it with a further return, or make a new invoice.');
    }
    if (errs.length) return Promise.reject({ validation: errs });

    var totals = Calc.invoice(draft);
    draft.id = draft.id || FDB.uid('inv');
    var existing = Invoices.byId(draft.id);
    var stores = ['sequences', 'invoices', 'invoiceItems', 'inventory', 'stockMovements',
                  'payments', 'paymentAllocations', 'auditLog', 'documents', 'syncQueue', 'operations'];
    /* One save click = one revision = one claimable operation id (§34). A
       second identical submission claims the same id and is rejected before
       anything is written. */
    /* The key is the revision the client believes it is editing, so a
       double-clicked Save — which submits the same payload twice — claims
       the same id and is refused, while a genuine edit (loaded fresh, so
       carrying the new revision) goes through. */
    var clientRev = draft.revision === undefined || draft.revision === null ? 0 : draft.revision;
    var opId = (draft.clientOpId || draft.id) + '#' + clientRev;

    return FDB.tx(stores, function (api) {
      return FDB.claimOperation(api, opId, 'Invoice', { entityId: draft.id }).then(function () {
      var numberPromise;
      if (existing && existing.invoiceNumber) numberPromise = Promise.resolve(existing.invoiceNumber);
      else if (asDraft) numberPromise = Promise.resolve('');       // drafts take no number (§36)
      else numberPromise = FDB.nextNumber(api, Settings.get().invoicePrefix || 'INV');

      return numberPromise.then(function (number) {
        var status = asDraft ? 'DRAFT' : (Calc.paymentStatus(totals.grandTotal, totals.paidAmount) === 'PAID' ? 'PAID'
                    : totals.paidAmount > 0 ? 'PARTIALLY_PAID' : 'CONFIRMED');
        var prevBal = Ledger.customerBalance(draft.customerId);
        draft.previousBalance = existing ? existing.previousBalance : prevBal;
        var rec = Invoices.buildRecord(draft, totals, number, status);
        rec.revision = clientRev + 1;
        if (existing) {
          rec.createdAt = existing.createdAt; rec.createdBy = existing.createdBy;
          rec.stockApplied = existing.stockApplied;
        }

        /* line items — remove the old set, write the new one */
        var oldItems = Invoices.items(rec.id);
        /* an edit re-snapshots every line at TODAY's cost (found 2026-09-28 while adding the cost split
           above) — for a product+warehouse that was already on the invoice, keep the cost it was actually
           sold at instead, so editing a note or a payment on an old invoice never silently rewrites its
           profit just because the stock average has since moved. A genuinely new line still gets today's. */
        var oldCostByKey = {};
        oldItems.forEach(function (o) {
          var k = o.productId + '|' + o.warehouseId;
          if (!(k in oldCostByKey)) oldCostByKey[k] = o;
        });
        oldItems.forEach(function (o) { api.del('invoiceItems', o.id); });
        S.invoiceItems = S.invoiceItems.filter(function (i) { return i.invoiceId !== rec.id; });
        var itemRecs = totals.items.map(function (it, ix) {
          var r = Invoices.snapshotItem(Object.assign({}, it, { id: null }), { id: rec.id, warehouseId: rec.warehouseId }, ix);
          var kept = oldCostByKey[it.productId + '|' + r.warehouseId];
          if (kept) {
            r.costBuySnapshot = typeof kept.costBuySnapshot === 'number' ? kept.costBuySnapshot : kept.costSnapshot;
            r.costExtraSnapshot = typeof kept.costExtraSnapshot === 'number' ? kept.costExtraSnapshot : 0;
            r.costSnapshot = kept.costSnapshot;
            delete oldCostByKey[it.productId + '|' + r.warehouseId];   /* one old line's cost goes to one new line, never two */
          }
          api.put('invoiceItems', r); S.invoiceItems.push(r); return r;
        });

        /* stock: reverse any earlier deduction, then deduct for the new lines.
           Drafts never touch stock (§12). */
        if (existing && existing.stockApplied) {
          oldItems.forEach(function (o) {
            Inventory.apply(api, {
              productId: o.productId, warehouseId: o.warehouseId, qtyDelta: o.quantity,
              kind: 'SALE_REVERSAL_IN', ref: existing.invoiceNumber || existing.id, refType: 'INVOICE_EDIT',
              note: 'Reversed on invoice edit', date: rec.invoiceDate
            });
          });
          rec.stockApplied = false;
        }
        if (!asDraft) {
          itemRecs.forEach(function (it) {
            Inventory.apply(api, {
              productId: it.productId, warehouseId: it.warehouseId, qtyDelta: -it.quantity,
              kind: 'SALE_OUT', ref: rec.invoiceNumber, refType: 'INVOICE',
              note: rec.shopNameSnapshot, date: rec.invoiceDate
            });
          });
          rec.stockApplied = true;
        }

        api.put('invoices', rec);
        var ix = S.invoices.findIndex(function (i) { return i.id === rec.id; });
        if (ix > -1) S.invoices[ix] = rec; else S.invoices.unshift(rec);

        /* payment taken with the invoice → its own Payment + allocation (§16 §21) */
        var payPromise = Promise.resolve(null);
        if (!asDraft && totals.paidAmount > 0) {
          var already = Payments.forInvoice(rec.id).reduce(function (a, p) { return a + p.amount; }, 0);
          var delta = totals.paidAmount - already;
          if (delta > 0) {
            payPromise = Payments._writeIn(api, {
              partyId: rec.customerId, amountP: delta, method: rec.paymentMethod,
              reference: rec.referenceNo, date: rec.invoiceDate,
              note: 'Received with invoice ' + rec.invoiceNumber,
              allocations: [{ invoiceId: rec.id, amountP: delta }]
            });
          }
        }

        return payPromise.then(function () {
          Audit.write(api, {
            action: existing ? 'Invoice edited' : (asDraft ? 'Draft invoice saved' : 'Invoice created'),
            entity: 'Invoice', entityId: rec.id, ref: rec.invoiceNumber || 'draft',
            oldValues: existing ? { grandTotal: existing.grandTotal, lineCount: existing.lineCount, status: existing.status } : null,
            newValues: { grandTotal: rec.grandTotal, lineCount: rec.lineCount, status: rec.status },
            reason: opts.reason || ''
          });
          api.put('syncQueue', {
            opId: rec.clientOpId, entity: 'Invoice', entityId: rec.id,
            state: 'pending', createdAt: nowISO(), payload: { invoiceNumber: rec.invoiceNumber, revision: rec.revision }
          });
          return rec;
        });
      });
      });
    }).then(function (rec) {
      Mirror.refresh();
      return rec;
    });
  },

  confirm: function (id) {
    var inv = Invoices.byId(id);
    if (!inv) return Promise.reject(new Error('Invoice not found.'));
    if (inv.status !== 'DRAFT') return Promise.resolve(inv);
    var draft = Invoices.toDraft(inv);
    draft.id = inv.id;
    return Invoices.save(draft, { draft: false });
  },

  cancel: function (id, reason) {
    var inv = Invoices.byId(id);
    if (!inv) return Promise.reject(new Error('Invoice not found.'));
    if (inv.status === 'CANCELLED') return Promise.resolve(inv);
    return FDB.tx(['invoices', 'inventory', 'stockMovements', 'auditLog'], function (api) {
      var items = Invoices.items(id);
      if (inv.stockApplied) {
        items.forEach(function (it) {
          Inventory.apply(api, {
            productId: it.productId, warehouseId: it.warehouseId, qtyDelta: it.quantity,
            kind: 'SALE_REVERSAL_IN', ref: inv.invoiceNumber, refType: 'INVOICE_CANCEL',
            note: 'Invoice cancelled — ' + (reason || 'no reason given'), date: todayISO()
          });
        });
      }
      var old = { status: inv.status, grandTotal: inv.grandTotal };
      inv.status = 'CANCELLED'; inv.stockApplied = false;
      inv.cancelledAt = nowISO(); inv.cancelReason = reason || '';
      inv.updatedAt = nowISO();
      api.put('invoices', inv);
      Audit.write(api, {
        action: 'Invoice cancelled', entity: 'Invoice', entityId: inv.id, ref: inv.invoiceNumber,
        oldValues: old, newValues: { status: 'CANCELLED' }, reason: reason || ''
      });
      return inv;
    }).then(function (r) { Mirror.refresh(); return r; });
  },

  /* ── Move an invoice to a different shop — the shop and nothing else. ──
     A shop's account is derived from its invoices, so "the wrong shop was
     picked" is not a label fix: the invoice total, and any money taken with
     it, has to leave one shop's account and land on the other's. Lines,
     amounts, number, date and stock are deliberately untouched — no stock is
     re-validated or re-deducted, no new invoice number is spent.

     What follows the invoice: the receipts that belong wholly to it, and the
     dispatch notes written against it (both carry their own copy of the shop).
     What stops it, because the money cannot be split honestly: a receipt that
     was also applied to other invoices or left partly on account, and any
     customer return (its credit note or cash refund is a fact about the old
     shop). reassignCheck reports all of that without writing anything, so the
     screen can warn before the click and the service can enforce it. */
  reassignCheck: function (id, newCustomerId) {
    var errs = [], inv = Invoices.byId(id);
    if (!inv) return { errs: ['Invoice not found.'], inv: null, to: null, payments: [], dispatches: [] };
    var to = newCustomerId && global.custBy ? global.custBy(newCustomerId) : null;
    if (inv.status === 'CANCELLED') errs.push('A cancelled invoice cannot be moved to another shop.');
    if (newCustomerId !== undefined) {
      if (!to) errs.push('Choose the shop this invoice belongs to.');
      else if (to.id === inv.customerId) errs.push('That is already the shop on this invoice.');
    }

    var rets = S.custReturns.filter(function (r) { return r.invoiceId === inv.id && r.status !== 'CANCELLED'; });
    if (rets.length) {
      errs.push('A return has been posted against this invoice (' +
        rets.map(function (r) { return r.returnNumber; }).join(', ') +
        '). Its credit note and any refund belong to ' + (inv.shopNameSnapshot || 'the current shop') +
        ', so the invoice cannot be moved. Cancel the invoice and make a new one for the right shop instead.');
    }

    var payments = [], seen = {};
    S.allocations.forEach(function (a) {
      if (a.invoiceId !== inv.id || seen[a.paymentId]) return;
      seen[a.paymentId] = true;
      var p = Payments.byId(a.paymentId);
      if (!p || p.status === 'REVERSED') return;
      var all = S.allocations.filter(function (x) { return x.paymentId === p.id; });
      var wholly = all.every(function (x) { return x.invoiceId === inv.id; }) &&
                   all.reduce(function (s, x) { return s + x.amount; }, 0) === p.amount;
      if (wholly) payments.push(p);
      else errs.push('Receipt ' + p.receiptNumber + ' (' + M.fmt(p.amount) + ') was also applied to other invoices ' +
        'or left partly on account, so it belongs to the shop, not to this one invoice. Reverse that receipt first, ' +
        'move the invoice, then record the money again against the right shop.');
    });

    var dispatches = (S.stockDocs || []).filter(function (d) { return d.invoiceId === inv.id; });
    return { errs: errs, inv: inv, to: to, payments: payments, dispatches: dispatches };
  },

  changeCustomer: function (id, newCustomerId, opts) {
    opts = opts || {};
    var plan = Invoices.reassignCheck(id, newCustomerId || '');
    if (plan.errs.length) return Promise.reject({ validation: plan.errs });
    var inv = plan.inv, to = plan.to;
    var oldShop = inv.shopNameSnapshot || '', oldId = inv.customerId;

    /* the new shop's balance just before this invoice's date — what it owed
       before this sale, which is what "previous balance" on the paper means.
       Read before anything moves, while the invoice is still on the old shop. */
    function balanceBefore(iso) {
      var d = dayBefore(iso);
      return d ? Ledger.customer(to.id, null, d).closing : Ledger.customerBalance(to.id);
    }
    var prevBal = balanceBefore(inv.invoiceDate);

    var fields = Invoices.customerFields(to);
    var rec = Object.assign({}, inv, fields, { customerId: to.id, previousBalance: prevBal, updatedAt: nowISO() });
    /* A receipt carries the balance it was taken against, and the printed
       receipt shows it beside the shop's name — so it is recomputed for the new
       shop, the way it was worked out originally: the shop's balance on the
       day (this invoice included, earlier moved receipts not yet). */
    var movedSoFar = 0;
    var payRecs = plan.payments.slice().sort(function (a, b) {
      return a.paymentDate !== b.paymentDate ? (a.paymentDate < b.paymentDate ? -1 : 1)
           : ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1);
    }).map(function (p) {
      var before = balanceBefore(p.paymentDate) - movedSoFar +
                   (inv.status !== 'DRAFT' && inv.invoiceDate <= p.paymentDate ? inv.grandTotal : 0);
      movedSoFar += p.amount;
      return Object.assign({}, p, {
        partyId: to.id, partyNameSnapshot: to.sh || '', partyOwnerSnapshot: to.ow || '',
        regionSnapshot: fields.regionSnapshot,
        balanceBefore: before, balanceAfter: before - p.amount
      });
    });
    var docRecs = plan.dispatches.map(function (d) {
      return Object.assign({}, d, { customerId: to.id, customerSnapshot: to.sh || '',
                                    regionSnapshot: fields.regionSnapshot });
    });

    /* A hand-typed shop name, address or "previous balance" on the printed
       sheet would keep showing the old shop's details over the new snapshot.
       Those overrides are dropped — kept in the sheet's own history so the
       earlier wording can still be stepped back to. */
    var edit = ERP.Edits && ERP.Edits.get ? ERP.Edits.get(inv.id) : null;
    var editRec = null;
    if (edit) {
      var stale = ['shop', 'owner', 'code', 'contact', 'address', 'region', 'previousBalance']
        .filter(function (k) { return edit.fields && edit.fields[k] !== undefined; });
      if (stale.length) {
        editRec = JSON.parse(JSON.stringify(edit));
        editRec.revisions = editRec.revisions || [];
        editRec.revisions.unshift({ at: nowISO(), by: currentUser(), note: 'Before the shop was changed',
                                    state: ERP.Edits.snapshot(edit) });
        if (editRec.revisions.length > 15) editRec.revisions.length = 15;
        stale.forEach(function (k) { delete editRec.fields[k]; });
        editRec.lastSaved = ERP.Edits.snapshot(editRec);
        editRec.updatedAt = nowISO();
      }
    }

    return FDB.tx(['invoices', 'payments', 'stockDocs', 'documentEdits', 'auditLog'], function (api) {
      api.put('invoices', rec);
      payRecs.forEach(function (p) { api.put('payments', p); });
      docRecs.forEach(function (d) { api.put('stockDocs', d); });
      if (editRec) api.put('documentEdits', editRec);
      Audit.write(api, {
        action: 'Invoice moved to another shop', entity: 'Invoice', entityId: inv.id,
        ref: inv.invoiceNumber || 'draft',
        oldValues: { customerId: oldId, shop: oldShop },
        newValues: {
          customerId: to.id, shop: rec.shopNameSnapshot,
          receiptsMoved: payRecs.map(function (p) { return p.receiptNumber; }),
          dispatchNotesMoved: docRecs.map(function (d) { return d.docNumber; })
        },
        reason: opts.reason || ''
      });
      return rec;
    }).then(function () {
      /* the working set only changes once the database has accepted it all */
      var ix = S.invoices.findIndex(function (i) { return i.id === rec.id; });
      if (ix > -1) S.invoices[ix] = rec;
      payRecs.forEach(function (p) {
        var k = S.payments.findIndex(function (x) { return x.id === p.id; });
        if (k > -1) S.payments[k] = p;
      });
      docRecs.forEach(function (d) {
        var k = (S.stockDocs || []).findIndex(function (x) { return x.id === d.id; });
        if (k > -1) S.stockDocs[k] = d;
      });
      if (editRec) Object.assign(edit, editRec);
      Mirror.refresh();
      return rec;
    });
  },

  /* A duplicate is a fresh draft: no number, no date, no payments (§36). */
  toDraft: function (inv) {
    return {
      revision: inv.revision || 0, clientOpId: inv.clientOpId,
      customerId: inv.customerId, warehouseId: inv.warehouseId,
      invoiceDate: inv.invoiceDate, dueDate: inv.dueDate,
      orderNumber: inv.orderNumber, dispatchNumber: inv.dispatchNumber,
      referenceNo: inv.referenceNo, paymentMethod: inv.paymentMethod,
      notes: inv.notes, salesperson: inv.salesperson,
      invoiceDiscount: M.toR(inv.invoiceDiscount), freight: M.toR(inv.freightAmount),
      loading: M.toR(inv.loadingAmount), otherCharges: M.toR(inv.otherCharges),
      paidAmount: M.toR(inv.paidAmount),
      items: Invoices.items(inv.id).map(function (it) {
        return {
          productId: it.productId, quantity: it.quantity,
          unitPrice: M.toR(it.unitPrice), discount: M.toR(it.discount),
          warehouseId: it.warehouseId, batchNo: it.batchNo, notes: it.notes, unit: it.unit
        };
      })
    };
  },
  duplicate: function (id) {
    var inv = Invoices.byId(id);
    if (!inv) return null;
    var d = Invoices.toDraft(inv);
    d.id = FDB.uid('inv'); d.clientOpId = d.id;
    d.invoiceDate = todayISO(); d.dueDate = ''; d.paidAmount = 0; d.revision = 0;
    d.orderNumber = ''; d.dispatchNumber = ''; d.referenceNo = '';
    d.duplicatedFrom = inv.invoiceNumber;
    return d;
  },

  /* Cash already handed back to the shop FOR this invoice: vouchers made with the invoice's "Pay back" button, plus the
     cash a REFUND-treatment return paid out. (Older "Pay a shop" vouchers were not linked to any invoice.) */
  refundedFor: function (invoiceId) {
    var viaVoucher = S.payments.filter(function (p) {
      return p.direction === 'OUT' && p.partyType === 'CUSTOMER' && p.status !== 'REVERSED' && p.refundOfInvoiceId === invoiceId;
    }).reduce(function (a, p) { return a + p.amount; }, 0);
    var viaReturn = S.custReturns.filter(function (r) {
      return r.invoiceId === invoiceId && r.status !== 'CANCELLED' && r.treatment === 'REFUND';
    }).reduce(function (a, r) { return a + r.creditAmount; }, 0);
    return viaVoucher + viaReturn;
  },
  /* What we still owe the shop on this invoice, in paisa (0 = nothing): what the shop paid beyond what the invoice is
     worth after its returns, less what was already handed back — and never more than the shop's account actually holds
     as credit (so an older, unlinked "Pay a shop" voucher can never be paid twice). */
  refundDue: function (inv) {
    if (!inv || inv.status === 'DRAFT' || inv.status === 'CANCELLED') return 0;
    var credit = Invoices.returnsOn(inv.id).reduce(function (a, r) { return a + r.creditAmount; }, 0);
    var worth = Math.max(0, inv.grandTotal - credit);
    var over = Invoices.paidFor(inv.id) - worth - Invoices.refundedFor(inv.id);
    var held = Math.max(0, -Ledger.customerBalance(inv.customerId));
    return Math.max(0, Math.min(over, held));
  },
  /* the live (not cancelled) customer returns posted against an invoice */
  returnsOn: function (invoiceId) {
    return S.custReturns.filter(function (r) { return r.invoiceId === invoiceId && r.status !== 'CANCELLED'; });
  },
  returnedQty: function (invoiceId, itemId) {
    return S.custReturnItems.filter(function (r) {
      var ret = S.custReturns.find(function (x) { return x.id === r.returnId; });
      return ret && ret.invoiceId === invoiceId && ret.status !== 'CANCELLED' &&
             (!itemId || r.invoiceItemId === itemId);
    }).reduce(function (a, r) { return a + r.quantity; }, 0);
  },
  paidFor: function (invoiceId) {
    return S.allocations.filter(function (a) { return a.invoiceId === invoiceId; })
                        .reduce(function (a, x) { return a + x.amount; }, 0);
  },
  /* Balance after payments and credit notes — never stored twice (§21). */
  outstanding: function (inv) {
    var credit = S.custReturns.filter(function (r) { return r.invoiceId === inv.id && r.status !== 'CANCELLED'; })
                              .reduce(function (a, r) { return a + r.creditAmount; }, 0);
    /* Never below zero. Money the shop paid beyond what is left of this invoice (a return credited more than the invoice
       still owed) is held on the SHOP's account — Ledger.customer, where "Pay a shop" hands it back — not on the invoice.
       Cash paid back through "Pay a shop" is not linked to any invoice, so a negative figure here never went away:
       2026-09-26 a settled shop (account 0) showed −3,200 on its invoice and in the Sales "Outstanding" total. */
    return Math.max(0, inv.grandTotal - Invoices.paidFor(inv.id) - credit);
  },
  refreshPaymentState: function (api, invoiceId) {
    var inv = Invoices.byId(invoiceId);
    if (!inv) return;
    var paid = Invoices.paidFor(invoiceId);
    inv.paidAmount = paid;
    inv.balanceAmount = inv.grandTotal - paid;
    inv.paymentStatus = Calc.paymentStatus(inv.grandTotal, paid);
    if (inv.status !== 'CANCELLED' && inv.status !== 'DRAFT' &&
        inv.status !== 'RETURNED' && inv.status !== 'PARTIALLY_RETURNED') {
      inv.status = inv.paymentStatus === 'PAID' ? 'PAID'
                 : inv.paymentStatus === 'PARTIAL' ? 'PARTIALLY_PAID' : 'CONFIRMED';
    }
    inv.updatedAt = nowISO();
    api.put('invoices', inv);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   PURCHASES (§13) — same multi-line architecture
   ══════════════════════════════════════════════════════════════════════════ */
var Purchases = ERP.Purchases = {
  all: function () { return S.purchases; },
  byId: function (id) { return S.purchases.find(function (p) { return p.id === id; }) || null; },
  items: function (id) { return S.purchaseItems.filter(function (i) { return i.purchaseId === id; })
                                               .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },
  /* ── what an edit has to respect ─────────────────────────────────────────
     A posted purchase is the stock that came in, the supplier's bill, and any
     money paid with it. Editing it re-states all three, so the rules below
     stop an edit that would leave them disagreeing with each other. ── */
  paymentsFor: function (purchaseId) {
    var seen = {}, out = [];
    S.allocations.forEach(function (a) {
      if (a.purchaseId !== purchaseId || seen[a.paymentId]) return;
      var p = Payments.byId(a.paymentId);
      if (!p || p.status === 'REVERSED') return;
      seen[a.paymentId] = true; out.push(p);
    });
    return out;
  },
  /* money paid against this purchase — the allocations are the truth; the
     header's paidAmount is only a copy of it */
  paidFor: function (purchaseId) {
    return S.allocations.filter(function (a) {
      if (a.purchaseId !== purchaseId) return false;
      var p = Payments.byId(a.paymentId);
      return p && p.status !== 'REVERSED';
    }).reduce(function (s, a) { return s + a.amount; }, 0);
  },
  returnedQty: function (itemId) {
    return M.qty(S.supReturnItems.filter(function (r) {
      var ret = S.supReturns.find(function (x) { return x.id === r.returnId; });
      return r.purchaseItemId === itemId && ret && ret.status !== 'CANCELLED';
    }).reduce(function (a, r) { return a + r.quantity; }, 0));
  },
  /* landed-cost entries still standing that put a share on this line */
  landedOn: function (itemId) {
    return (S.inventoryCostAdjust || []).filter(function (a) {
      if (a.purchaseItemId !== itemId) return false;
      var lc = (S.landedCosts || []).find(function (l) { return l.id === a.landedCostId; });
      return !(lc && lc.status === 'CANCELLED');
    });
  },
  /* Why the supplier on this purchase may not be swapped, or '' if it may.
     The vouchers and returns written against it belong to that supplier. */
  supplierLockReason: function (purchaseId) {
    var pays = Purchases.paymentsFor(purchaseId);
    if (pays.length) {
      return 'Money has already been paid against this purchase (' +
        pays.map(function (p) { return p.receiptNumber; }).join(', ') + '), and it belongs to this supplier — ' +
        'so the supplier cannot be changed here. Reverse that payment voucher first.';
    }
    var itemIds = Purchases.items(purchaseId).map(function (i) { return i.id; });
    var rets = S.supReturns.filter(function (r) {
      if (r.status === 'CANCELLED') return false;
      return r.purchaseId === purchaseId || S.supReturnItems.some(function (ri) {
        return ri.returnId === r.id && itemIds.indexOf(ri.purchaseItemId) > -1;
      });
    });
    if (rets.length) {
      return 'A return to the supplier has been posted against this purchase (' +
        rets.map(function (r) { return r.returnNumber; }).join(', ') + '), so the supplier cannot be changed.';
    }
    return '';
  },
  /* how many bags of a line the warehouse actually took in */
  receivedOf: function (line, qty) {
    return line.receivedQty === undefined || line.receivedQty === null || line.receivedQty === ''
      ? M.qty(qty) : M.qty(line.receivedQty);
  },
  /* Every reason an edit of a posted purchase must be refused. Nothing is
     written if any is returned — same all-or-nothing rule as a new purchase. */
  editErrors: function (draft, existing, totals) {
    var errs = [];
    if (existing.status === 'CANCELLED') errs.push('A cancelled purchase cannot be edited.');
    var oldItems = Purchases.items(existing.id), byId = {};
    oldItems.forEach(function (o) { byId[o.id] = o; });
    var lines = (draft.items || []).filter(function (i) { return i.productId; });
    var kept = {};
    lines.forEach(function (l) { if (l.purchaseItemId && byId[l.purchaseItemId]) kept[l.purchaseItemId] = l; });
    var whOf = function (l) { return l.warehouseId || draft.warehouseId; };

    /* a line that has bags sent back to the supplier, or operational costs
       spread over it, is tied to that record: it can change in quantity and
       rate, but it cannot vanish or turn into a different product */
    oldItems.forEach(function (o) {
      var name = o.descriptionEnSnapshot || o.descriptionSnapshot || 'a line';
      var ret = Purchases.returnedQty(o.id), landed = Purchases.landedOn(o.id).length;
      if (!ret && !landed) return;
      var why = ret ? ret + ' bag' + (ret === 1 ? ' has' : 's have') + ' been returned to the supplier'
                    : 'landed costs have been spread over it';
      var l = kept[o.id];
      if (!l) { errs.push(name + ': ' + why + ', so this line cannot be removed. ' +
                          (ret ? 'It can be reduced, but not below the bags already returned.'
                               : 'Cancel the landed-cost entry first.')); return; }
      if (l.productId !== o.productId || whOf(l) !== o.warehouseId) {
        errs.push(name + ': ' + why + ', so its product and warehouse cannot be changed.');
      }
      if (ret && Purchases.receivedOf(l, l.quantity) < ret) {
        errs.push(name + ': ' + ret + ' bags were already returned to the supplier, so fewer than ' + ret +
                  ' cannot be shown as received.');
      }
    });

    if (draft.supplierId && draft.supplierId !== existing.supplierId) {
      var lock = Purchases.supplierLockReason(existing.id);
      if (lock) errs.push(lock);
    }

    var paidNow = Purchases.paidFor(existing.id);
    if (totals.paidAmount < paidNow) {
      errs.push(M.fmt(paidNow) + ' has already been paid against this purchase (' +
        Purchases.paymentsFor(existing.id).map(function (p) { return p.receiptNumber; }).join(', ') +
        '). The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.');
    }
    if (totals.paidAmount > totals.grandTotal) {
      errs.push('The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier.');
    }

    /* Stock is judged on what the edit CHANGES per product and warehouse: the
       old delivery comes out, the new one goes in, and the difference must
       fit in what is on the shelf now. An untouched line therefore never
       fails just because its bags have since been sold. */
    var net = {}, label = {};
    var bump = function (pid, wid, q) {
      var k = ikey(pid, wid); net[k] = (net[k] || 0) + q; label[k] = { pid: pid, wid: wid };
    };
    /* by what each line actually received — the header's stockApplied flag is
       not trusted: a later delivery (receiveMore) never set it */
    oldItems.forEach(function (o) {
      var was = o.receivedQty === undefined ? o.quantity : o.receivedQty;
      if (was > 0) bump(o.productId, o.warehouseId, -was);
    });
    totals.items.forEach(function (it) {
      var q = Purchases.receivedOf(it, it.quantity);
      if (q > 0) bump(it.productId, whOf(it), q);
    });
    if (!Settings.allowNegativeStock()) {
      Object.keys(net).forEach(function (k) {
        var d = M.qty(net[k]);
        if (d >= 0) return;
        var have = Inventory.available(label[k].pid, label[k].wid);
        if (have + d < 0) {
          var p = global.prodOf && global.prodOf(label[k].pid) || {};
          errs.push('Only ' + have + ' bags of ' + (p.en || p.ur || 'that product') + ' are in ' +
            (global.whName ? global.whName(label[k].wid) : label[k].wid) + ' now, but this edit takes ' +
            (-d) + ' fewer bags into stock than before. The rest of that delivery has already been sold or moved, ' +
            'so it cannot be reduced by that much.');
        }
      });
    }
    return errs;
  },

  /* Whoever may enter a purchase, or correct a posted transaction, may edit one. */
  canEdit: function (pu) {
    return !!pu && pu.status !== 'CANCELLED' &&
           (!ERP.Can || ERP.Can('PURCHASE_CREATE') || ERP.Can('TRANSACTION_CORRECT'));
  },

  /* The header's paid figure and status are a copy of the vouchers. Called when a
     voucher is reversed, so the list and the document stop saying "Paid". */
  refreshPaymentState: function (api, purchaseId) {
    var pu = Purchases.byId(purchaseId);
    if (!pu) return;
    var paid = Purchases.paidFor(purchaseId);
    pu.paidAmount = paid; pu.balanceAmount = pu.grandTotal - paid;
    pu.paymentStatus = Calc.paymentStatus(pu.grandTotal, paid);
    pu.updatedAt = nowISO();
    api.put('purchases', pu);
  },

  /* the form the edit screen starts from — the inverse of save() */
  toDraft: function (pu) {
    var items = Purchases.items(pu.id);
    var lineDisc = items.reduce(function (a, i) { return a + (i.discount || 0); }, 0);
    var pays = Purchases.paymentsFor(pu.id);
    return {
      revision: pu.revision || 0, clientOpId: pu.clientOpId,
      supplierId: pu.supplierId, warehouseId: pu.warehouseId, purchaseDate: pu.purchaseDate,
      supplierInvoiceNo: pu.supplierInvoiceNo, vehicleNo: pu.vehicleNo, driver: pu.driver,
      deliveryRef: pu.deliveryRef, notes: pu.notes, description: pu.description || '',
      paymentMethod: pays.length ? pays[pays.length - 1].method : 'Cash',
      /* the record keeps discounts as one figure; what is not on a line is the overall one */
      invoiceDiscount: M.toR(Math.max(0, (pu.discountAmount || 0) - lineDisc)),
      freight: M.toR(pu.freightAmount), loading: M.toR(pu.loadingAmount),
      otherCharges: M.toR(pu.otherCharges),
      paidAmount: M.toR(Purchases.paidFor(pu.id)),
      items: items.map(function (it) {
        var recv = it.receivedQty === undefined ? it.quantity : it.receivedQty;
        return {
          purchaseItemId: it.id, productId: it.productId, quantity: it.quantity,
          unitPrice: M.toR(it.unitPrice), discount: M.toR(it.discount), tax: M.toR(it.tax),
          /* blank means "the whole line arrived" — only a part delivery is spelled out */
          receivedQty: recv >= it.quantity ? '' : recv,
          warehouseId: it.warehouseId, batchNo: it.batchNo, notes: it.notes, unit: it.unit,
          extraPerBag: it.extraUnitP > 0 ? M.toR(it.extraUnitP) : ''
        };
      })
    };
  },

  /* '' when fine, else the sentence to show: freight / loading / other charges on this purchase AND a product on it that
     already has an "Extra cost per bag" saved (that box is for exactly these costs — transport, labour, loading). */
  doubleCostWarning: function (draft, totals) {
    var charges = (totals.freightAmount || 0) + (totals.loadingAmount || 0) + (totals.otherCharges || 0);
    if (!(charges > 0)) return '';
    var hit = (draft.items || []).filter(function (i) { return i.productId && Inventory.extraOf(i.productId) > 0; })[0];
    if (!hit) return '';
    var p = global.prodOf(hit.productId) || {};
    return (p.en || p.ur || hit.productId) + ' already has an Extra cost per bag of ' + M.fmt(Inventory.extraOf(hit.productId)) +
      ' saved on its prices. Adding ' + M.fmt(charges) + ' of freight / loading / other charges to this purchase counts the same transport twice: ' +
      'the profit on its sales would look too low, and the supplier would be shown as owed ' + M.fmt(charges) +
      ' more than the mill charges. Remove the charges from this purchase, or clear the product’s extra cost.';
  },

  save: function (draft) {
    var errs = Validate.purchase(draft);
    var totals = Calc.invoice(draft);
    var prior = draft.id ? Purchases.byId(draft.id) : null;
    if (prior && !errs.length) errs = Purchases.editErrors(draft, prior, totals);
    if (errs.length) return Promise.reject({ validation: errs });
    /* the same transport counted twice (2026-09-26: 1,000 typed as "Other charges" on a purchase of bags whose product
       already carried an Extra cost of 200 — the sale was costed at 6,400 instead of 6,200 and showed a loss) */
    var twice = Purchases.doubleCostWarning(draft, totals);
    if (twice && !draft.confirmCharges) {
      return Promise.reject({ validation: [twice, 'If you really want both, press Save again and it will be kept.'], confirmable: true });
    }
    draft.id = draft.id || FDB.uid('pur');
    var existing = Purchases.byId(draft.id);
    var revision = (draft.revision === undefined || draft.revision === null ? 0 : draft.revision);
    var opId = (draft.clientOpId || draft.id) + '#' + revision;
    return FDB.tx(['sequences', 'purchases', 'purchaseItems', 'inventory', 'stockMovements',
                   'payments', 'paymentAllocations', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'Purchase', { entityId: draft.id }).then(function () {
      return (existing && existing.purchaseNumber ? Promise.resolve(existing.purchaseNumber)
              : FDB.nextNumber(api, Settings.get().purchasePrefix || 'PUR')).then(function (number) {
        var sup = global.supOf(draft.supplierId) || {};
        var rec = {
          id: draft.id, purchaseNumber: number, clientOpId: draft.clientOpId || draft.id,
          supplierId: draft.supplierId, supplierNameSnapshot: sup.co || '',
          supplierInvoiceNo: draft.supplierInvoiceNo || '',
          warehouseId: draft.warehouseId,
          warehouseSnapshot: global.whName ? global.whName(draft.warehouseId) : '',
          purchaseDate: draft.purchaseDate || todayISO(),
          vehicleNo: (draft.vehicleNo || '').toUpperCase(), driver: draft.driver || '',
          deliveryRef: draft.deliveryRef || '',
          subtotal: totals.subtotal, discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount, freightAmount: totals.freightAmount,
          loadingAmount: totals.loadingAmount, otherCharges: totals.otherCharges,
          grandTotal: totals.grandTotal, paidAmount: totals.paidAmount,
          balanceAmount: totals.grandTotal - totals.paidAmount,
          paymentStatus: Calc.paymentStatus(totals.grandTotal, totals.paidAmount),
          status: 'RECEIVED', notes: draft.notes || '',
          totalQty: totals.totalQty, lineCount: totals.lineCount,
          createdBy: currentUser(), createdAt: nowISO(), updatedAt: nowISO(), stockApplied: false
        };
        if (existing) {
          /* an edit is the same purchase, not a new one: who made it and when,
             its description and its migration marker all stay */
          rec.createdBy = existing.createdBy; rec.createdAt = existing.createdAt;
          if (existing.migrated) rec.migrated = true;
          if (existing.description && (draft.description === undefined ||
              String(draft.description).trim() === existing.description)) rec.description = existing.description;
        }
        var oldItems = Purchases.items(rec.id);
        /* A line the edit keeps stays the SAME record (same id): supplier
           returns and landed-cost entries point at it. Only lines the edit
           drops are deleted; the rest are overwritten below. */
        var oldById = {}, keepIds = {};
        oldItems.forEach(function (o) { oldById[o.id] = o; });
        totals.items.forEach(function (it) { if (it.purchaseItemId && oldById[it.purchaseItemId]) keepIds[it.purchaseItemId] = true; });
        oldItems.forEach(function (o) { if (!keepIds[o.id]) api.del('purchaseItems', o.id); });
        S.purchaseItems = S.purchaseItems.filter(function (i) { return i.purchaseId !== rec.id; });

        /* the extra cost per bag each old line came in with (a line saved before this existed: what its row
           carries now), so an edit takes exactly that back out and puts the same back in */
        var oldExtra = {};
        oldItems.forEach(function (o) {
          oldExtra[o.id] = typeof o.extraUnitP === 'number' ? o.extraUnitP : Inventory.rowExtraP(o.productId, o.warehouseId);
        });
        if (existing) {
          /* what actually arrived comes back out — judged per line, because a later
             delivery (receiveMore) added bags without ever setting stockApplied.
             Dated as the ORIGINAL delivery, so it nets against it on that day and
             the new delivery lands on the (possibly corrected) date. */
          oldItems.forEach(function (o) {
            var was = o.receivedQty === undefined ? o.quantity : o.receivedQty;
            if (!(was > 0)) return;
            Inventory.apply(api, { productId: o.productId, warehouseId: o.warehouseId,
              qtyDelta: -was, extraCostP: oldExtra[o.id],
              /* the cost these bags actually blended into avgCostP with: the landed figure once charges were
                 allocated onto it (17-profit.js), else the raw purchase price */
              unitCostP: o.landedUnitCost || o.unitPrice,
              kind: 'PURCHASE_REVERSAL_OUT', ref: existing.purchaseNumber, refType: 'PURCHASE_EDIT',
              note: 'Reversed on purchase edit', date: existing.purchaseDate || rec.purchaseDate });
          });
        }
        totals.items.forEach(function (it, ix) {
          var p = global.prodOf(it.productId) || {};
          var src = (draft.items || [])[ix] || {};
          var receivedQty = src.receivedQty === undefined || src.receivedQty === ''
            ? it.quantity : M.qty(src.receivedQty);
          var old = keepIds[it.purchaseItemId] ? oldById[it.purchaseItemId] : null;
          if (old) delete keepIds[old.id];                 /* one old record per new line, never two */
          /* a line whose product has since vanished keeps the wording it was saved with */
          var gone = old && !global.prodOf(it.productId);
          var r = Object.assign({}, old || {}, {
            id: old ? old.id : FDB.uid('pi'), purchaseId: rec.id, sortOrder: ix, productId: it.productId,
            descriptionSnapshot: gone ? old.descriptionSnapshot : (p.ur || p.en || ''),
            descriptionEnSnapshot: gone ? old.descriptionEnSnapshot : (p.en || ''),
            brandSnapshot: gone ? old.brandSnapshot : (p.brandEn || p.brand || ''),
            packageSnapshot: gone ? old.packageSnapshot : (p.kg ? p.kg + ' KG' : 'Bag'),
            quantity: it.quantity, orderedQty: it.quantity, receivedQty: receivedQty,
            unit: it.unit || 'Bag', unitPrice: it.unitPrice,
            discount: it.discount, tax: it.tax, lineTotal: it.lineTotal,
            warehouseId: it.warehouseId || rec.warehouseId, batchNo: it.batchNo || '',
            returnedQty: old ? Purchases.returnedQty(old.id) : 0, notes: it.notes || ''
          });
          /* Extra cost per bag, typed once per PRODUCT on the purchase screen (§26, 2026-09-28): a figure typed
             this time wins; an edit that leaves a line's own value untouched keeps it; a brand-new line falls to
             the product's own saved figure. (No selling price here — only the product Prices screen sets it.) */
          var typedExtra = it.extraPerBag !== undefined && it.extraPerBag !== '' ? M.toP(it.extraPerBag) : null;
          var keptLine = old && old.productId === r.productId;
          r.extraUnitP = typedExtra !== null ? typedExtra
            : (keptLine ? oldExtra[old.id] : Inventory.rawExtraOf(r.productId));
          api.put('purchaseItems', r); S.purchaseItems.push(r);
          if (receivedQty > 0) {
            Inventory.apply(api, {
              productId: r.productId, warehouseId: r.warehouseId, qtyDelta: receivedQty,
              extraCostP: r.extraUnitP,
              kind: 'PURCHASE_IN', ref: rec.purchaseNumber, refType: 'PURCHASE',
              note: rec.supplierNameSnapshot, date: rec.purchaseDate, unitCostP: r.unitPrice
            });
          }
        });
        var pItems = Purchases.items(rec.id);
        var ordTot = pItems.reduce(function (a, i) { return a + i.orderedQty; }, 0);
        var recTot = pItems.reduce(function (a, i) { return a + i.receivedQty; }, 0);
        rec.orderedQty = ordTot; rec.receivedQty = recTot;
        rec.status = recTot >= ordTot ? 'RECEIVED' : recTot > 0 ? 'PARTIALLY_RECEIVED' : 'ORDERED';
        rec.revision = revision + 1;
        rec.stockApplied = recTot > 0;
        api.put('purchases', rec);
        var ix2 = S.purchases.findIndex(function (p) { return p.id === rec.id; });
        if (ix2 > -1) S.purchases[ix2] = rec; else S.purchases.unshift(rec);

        /* Money is only ever ADDED here: what was already paid against this
           purchase stays as it is, and only the extra gets a new voucher —
           saving an edit twice must not pay the supplier twice. */
        var payPromise = Promise.resolve();
        var already = existing ? Purchases.paidFor(rec.id) : 0;
        var extraPaid = totals.paidAmount - already;
        if (extraPaid > 0) {
          payPromise = Payments._writeOut(api, {
            partyId: rec.supplierId, amountP: extraPaid, method: draft.paymentMethod || 'Cash',
            reference: rec.supplierInvoiceNo, date: rec.purchaseDate,
            note: 'Paid with purchase ' + rec.purchaseNumber,
            allocations: [{ purchaseId: rec.id, amountP: extraPaid }]
          });
        }
        return payPromise.then(function () {
          Audit.write(api, { action: existing ? 'Purchase edited' : 'Purchase recorded', entity: 'Purchase',
            entityId: rec.id, ref: rec.purchaseNumber,
            oldValues: existing ? { grandTotal: existing.grandTotal, lineCount: existing.lineCount,
                                    supplier: existing.supplierNameSnapshot, received: existing.receivedQty } : null,
            newValues: { grandTotal: rec.grandTotal, lineCount: rec.lineCount,
                         supplier: rec.supplierNameSnapshot, received: rec.receivedQty } });
          return rec;
        });
      });
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },

  /* Partial receiving (§13). A line carries what was ordered and what has
     actually arrived; only the arrived bags reach the warehouse, and the
     remainder stays open until a later delivery. */
  receiveMore: function (purchaseId, lines) {
    var pu = Purchases.byId(purchaseId);
    if (!pu) return Promise.reject({ validation: ['Purchase not found.'] });
    var wanted = (lines || []).filter(function (l) { return M.qty(l.quantity) > 0; });
    if (!wanted.length) return Promise.reject({ validation: ['Enter how many bags arrived on at least one line.'] });
    var errs = [];
    wanted.forEach(function (l) {
      var it = S.purchaseItems.find(function (x) { return x.id === l.itemId; });
      if (!it) { errs.push('That line is not on this purchase.'); return; }
      var open = it.orderedQty - it.receivedQty;
      if (M.qty(l.quantity) > open) {
        errs.push('Only ' + open + ' bags of ' + (it.descriptionEnSnapshot || it.descriptionSnapshot) +
                  ' are still outstanding on ' + pu.purchaseNumber + '.');
      }
    });
    if (errs.length) return Promise.reject({ validation: errs });

    var opId = FDB.uid('rcv');
    return FDB.tx(['purchases', 'purchaseItems', 'inventory', 'stockMovements', 'auditLog', 'operations'],
      function (api) {
        return FDB.claimOperation(api, opId, 'PurchaseReceipt', { entityId: purchaseId }).then(function () {
          wanted.forEach(function (l) {
            var it = S.purchaseItems.find(function (x) { return x.id === l.itemId; });
            var q = M.qty(l.quantity);
            it.receivedQty = M.qty(it.receivedQty + q);
            if (typeof it.extraUnitP !== 'number') it.extraUnitP = Inventory.rawExtraOf(it.productId);
            api.put('purchaseItems', it);
            Inventory.apply(api, {
              productId: it.productId, warehouseId: it.warehouseId, qtyDelta: q,
              extraCostP: it.extraUnitP,
              kind: 'PURCHASE_IN', ref: pu.purchaseNumber, refType: 'PURCHASE',
              note: 'Later delivery', date: todayISO(), unitCostP: it.unitPrice
            });
          });
          var items = Purchases.items(purchaseId);
          var ordered = items.reduce(function (a, i) { return a + i.orderedQty; }, 0);
          var received = items.reduce(function (a, i) { return a + i.receivedQty; }, 0);
          pu.receivedQty = received; pu.stockApplied = received > 0;
          pu.status = received >= ordered ? 'RECEIVED' : received > 0 ? 'PARTIALLY_RECEIVED' : 'ORDERED';
          pu.updatedAt = nowISO();
          api.put('purchases', pu);
          Audit.write(api, { action: 'Purchase stock received', entity: 'Purchase', entityId: pu.id,
            ref: pu.purchaseNumber, newValues: { received: received, ordered: ordered } });
          return pu;
        });
      }).then(function (r) { Mirror.refresh(); return r; });
  },
  openLines: function (purchaseId) {
    return Purchases.items(purchaseId).filter(function (i) { return i.receivedQty < i.orderedQty; });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   PAYMENTS + ALLOCATION (§16 §21 §22)
   ══════════════════════════════════════════════════════════════════════════ */
var Payments = ERP.Payments = {
  all: function () { return S.payments; },
  byId: function (id) { return S.payments.find(function (p) { return p.id === id; }) || null; },
  incoming: function () { return S.payments.filter(function (p) { return p.direction === 'IN' && p.status !== 'REVERSED'; }); },
  outgoing: function () { return S.payments.filter(function (p) { return p.direction === 'OUT' && p.partyType !== 'CUSTOMER' && p.status !== 'REVERSED'; }); },
  refunds:  function () { return S.payments.filter(function (p) { return p.direction === 'OUT' && p.partyType === 'CUSTOMER' && p.status !== 'REVERSED'; }); },
  forParty: function (id) { return S.payments.filter(function (p) { return p.partyId === id && p.status !== 'REVERSED'; }); },
  forInvoice: function (invId) {
    return S.allocations.filter(function (a) { return a.invoiceId === invId; })
      .map(function (a) { return Object.assign({}, Payments.byId(a.paymentId) || {}, { amount: a.amount }); })
      .filter(function (p) { return p.id; });
  },

  _write: function (api, o, direction) {
    var prefix = Settings.get().receiptPrefix || 'REC';
    var kind = direction === 'IN' ? prefix : 'PV';
    return FDB.nextNumber(api, kind).then(function (number) {
      var partyType = o.partyType || (direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER');
      var party = partyType === 'CUSTOMER' ? (global.custBy(o.partyId) || {}) : (global.supOf(o.partyId) || {});
      var rec = {
        id: FDB.uid('pay'), receiptNumber: number, direction: direction,
        partyId: o.partyId, partyType: partyType, isRefund: partyType === 'CUSTOMER' && direction === 'OUT',
        partyNameSnapshot: partyType === 'CUSTOMER' ? (party.sh || '') : (party.co || ''),
        partyOwnerSnapshot: partyType === 'CUSTOMER' ? (party.ow || '') : (party.cp || ''),
        regionSnapshot: partyType === 'CUSTOMER' && party.region && global.regionOf
          ? (function (r) { return r ? r.ur + ' — ' + r.en : ''; })(global.regionOf(party.region)) : '',
        amount: o.amountP, method: o.method || 'Cash', reference: o.reference || '',
        paymentDate: o.date || todayISO(), note: o.note || '',
        receivedBy: currentUser(), status: 'POSTED',
        createdAt: nowISO(), createdBy: currentUser(),
        balanceBefore: partyType === 'CUSTOMER' ? Ledger.customerBalance(o.partyId) : Ledger.supplierBalance(o.partyId)
      };
      /* a voucher made from an invoice's "Pay back" button remembers which invoice it settles */
      if (o.refundOfInvoiceId) { rec.refundOfInvoiceId = o.refundOfInvoiceId; rec.refundOfInvoiceNumber = o.refundOfInvoiceNumber || ''; }
      /* A shop's balance is what it owes us: receiving money lowers it, PAYING a shop raises it.
         A supplier's is what we owe: paying it lowers it. (This used to subtract in every case,
         so the stored figure on a payment to a shop pointed the wrong way; nothing reads it back,
         but it is on the record.) */
      rec.balanceAfter = rec.balanceBefore + (rec.isRefund ? rec.amount : -rec.amount);
      api.put('payments', rec);
      S.payments.unshift(rec);

      (o.allocations || []).forEach(function (al) {
        if (!al.amountP) return;
        var a = {
          id: FDB.uid('alloc'), paymentId: rec.id,
          invoiceId: al.invoiceId || null, purchaseId: al.purchaseId || null,
          amount: al.amountP, createdAt: nowISO()
        };
        api.put('paymentAllocations', a); S.allocations.push(a);
        if (a.invoiceId) Invoices.refreshPaymentState(api, a.invoiceId);
      });
      Audit.write(api, {
        action: direction === 'IN' ? 'Payment received' : (partyType === 'CUSTOMER' ? 'Refund paid to shop' : 'Payment made to supplier'),
        entity: 'Payment', entityId: rec.id, ref: rec.receiptNumber,
        newValues: { amount: rec.amount, method: rec.method, party: rec.partyNameSnapshot }
      });
      return rec;
    });
  },
  _writeIn:  function (api, o) { return Payments._write(api, o, 'IN'); },
  _writeOut: function (api, o) { return Payments._write(api, o, 'OUT'); },

  /* Public entry: allocate across outstanding invoices, oldest first, or
     to the invoices the user chose. */
  receive: function (o) {
    var amountP = M.toP(o.amount);
    if (!(amountP > 0)) return Promise.reject({ validation: ['Enter an amount greater than zero.'] });
    if (!global.custBy(o.customerId)) return Promise.reject({ validation: ['Choose a shop.'] });
    var allocations = o.allocations && o.allocations.length
      ? o.allocations.map(function (a) { return { invoiceId: a.invoiceId, amountP: M.toP(a.amount) }; })
      : Payments.autoAllocate(o.customerId, amountP);
    return FDB.tx(['sequences', 'payments', 'paymentAllocations', 'invoices', 'auditLog'], function (api) {
      return Payments._writeIn(api, {
        partyId: o.customerId, amountP: amountP, method: o.method, reference: o.reference,
        date: o.date, note: o.note, description: o.description, allocations: allocations
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },
  pay: function (o) {
    var amountP = M.toP(o.amount);
    if (!(amountP > 0)) return Promise.reject({ validation: ['Enter an amount greater than zero.'] });
    if (!global.supOf(o.supplierId)) return Promise.reject({ validation: ['Choose a supplier.'] });
    return FDB.tx(['sequences', 'payments', 'paymentAllocations', 'auditLog'], function (api) {
      return Payments._writeOut(api, {
        partyId: o.supplierId, amountP: amountP, method: o.method, reference: o.reference,
        date: o.date, note: o.note, description: o.description, allocations: o.allocations || []
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },
  /* Money paid out to a shop that isn't tied to processing a return — a
     refund, an adjustment, closing out a credit balance. The engine has
     always supported this direction (a customer return with the REFUND
     treatment already posts one, via _write with partyType forced to
     CUSTOMER — see Returns.fromCustomer) but there was no way to do it on
     its own; this is that same write, exposed as a direct action. */
  refund: function (o) {
    var amountP = M.toP(o.amount);
    if (!(amountP > 0)) return Promise.reject({ validation: ['Enter an amount greater than zero.'] });
    if (!global.custBy(o.customerId)) return Promise.reject({ validation: ['Choose a shop.'] });
    /* paying back on ONE invoice: never more than the shop is owed on it */
    var inv = o.invoiceId ? Invoices.byId(o.invoiceId) : null;
    if (o.invoiceId) {
      if (!inv || inv.customerId !== o.customerId) return Promise.reject({ validation: ['That invoice does not belong to this shop.'] });
      var due = Invoices.refundDue(inv);
      if (amountP > due) {
        return Promise.reject({ validation: [due > 0
          ? 'You can pay back at most ' + M.fmt(due) + ' on ' + inv.invoiceNumber + ' — that is all the shop is owed on it.'
          : 'Nothing is owed to the shop on ' + inv.invoiceNumber + ', so there is nothing to pay back.'] });
      }
    }
    return FDB.tx(['sequences', 'payments', 'paymentAllocations', 'auditLog'], function (api) {
      return Payments._write(api, {
        partyId: o.customerId, partyType: 'CUSTOMER', amountP: amountP, method: o.method,
        reference: o.reference, date: o.date, note: o.note, description: o.description, allocations: [],
        refundOfInvoiceId: inv ? inv.id : null, refundOfInvoiceNumber: inv ? inv.invoiceNumber : ''
      }, 'OUT');
    }).then(function (r) { Mirror.refresh(); return r; });
  },
  autoAllocate: function (customerId, amountP) {
    var left = amountP, out = [];
    S.invoices.filter(function (i) {
      return i.customerId === customerId && i.status !== 'DRAFT' && i.status !== 'CANCELLED' &&
             Invoices.outstanding(i) > 0;
    }).sort(function (a, b) { return a.invoiceDate < b.invoiceDate ? -1 : 1; })
      .forEach(function (inv) {
        if (left <= 0) return;
        var due = Invoices.outstanding(inv), take = Math.min(due, left);
        if (take > 0) { out.push({ invoiceId: inv.id, amountP: take }); left -= take; }
      });
    return out;
  },
  reverse: function (id, reason) {
    var p = Payments.byId(id);
    if (!p) return Promise.reject(new Error('Payment not found.'));
    return FDB.tx(['payments', 'paymentAllocations', 'invoices', 'purchases', 'auditLog'], function (api) {
      p.status = 'REVERSED'; p.reversedAt = nowISO(); p.reverseReason = reason || '';
      api.put('payments', p);
      var affected = S.allocations.filter(function (a) { return a.paymentId === id; });
      affected.forEach(function (a) { api.del('paymentAllocations', a.id); });
      S.allocations = S.allocations.filter(function (a) { return a.paymentId !== id; });
      affected.forEach(function (a) { if (a.invoiceId) Invoices.refreshPaymentState(api, a.invoiceId); });
      var seenPur = {};
      affected.forEach(function (a) {
        if (a.purchaseId && !seenPur[a.purchaseId]) { seenPur[a.purchaseId] = true; Purchases.refreshPaymentState(api, a.purchaseId); }
      });
      Audit.write(api, { action: 'Payment reversed', entity: 'Payment', entityId: id,
        ref: p.receiptNumber, reason: reason || '', oldValues: { status: 'POSTED' }, newValues: { status: 'REVERSED' } });
      return p;
    }).then(function (r) { Mirror.refresh(); return r; });
  },
  /* Client request (2026-09-23): a wrong amount on a voucher paid to a shop
     needs a straight correction; extended the same day to a voucher paid to a
     SUPPLIER — same shape of problem, same fix. Ledger.customer/supplier both
     read p.amount live (never the balanceBefore/After stamped on the record),
     so changing it here is safe for either party's balance on its own — but
     two cases are refused because something ELSE would then disagree with it:
     a payment with allocations (a shop refund never has any, but a supplier
     voucher can be tied to a purchase — "Paid with purchase …" — whose paid
     total would then be wrong), and the cash side of a customer return's
     REFUND treatment (Returns.fromCustomer writes both a customerReturns.
     creditAmount and this same kind of payment for the same event; editing
     only the payment would silently unbalance the two ledger lines it
     produces — supplier returns have no such twin, Returns.toSupplier never
     writes a payment). Correct the return instead for that case — not built. */
  editAmountCheck: function (id) {
    var p = Payments.byId(id), errs = [];
    if (!p) { errs.push('Payment not found.'); return { p: p, errs: errs }; }
    if (p.status === 'REVERSED') errs.push('A reversed voucher cannot be edited.');
    else if (p.direction !== 'OUT' || (p.partyType !== 'CUSTOMER' && p.partyType !== 'SUPPLIER'))
      errs.push('Only a voucher paid to a shop or a supplier can have its amount corrected here.');
    else if (S.allocations.some(function (a) { return a.paymentId === id; }))
      errs.push('This payment is applied to an invoice or purchase; its amount can’t be changed here.');
    /* matched on both fields Returns.fromCustomer actually stamps (reference AND the note
       prefix) — reference alone would false-positive on a stand-alone voucher whose reference
       happens to be typed the same as some unrelated return's number */
    else if (p.partyType === 'CUSTOMER' && /^Refund against return /.test(p.note || '') &&
             S.custReturns.some(function (r) { return r.returnNumber === p.reference; }))
      errs.push('This voucher is the refund for a customer return — correct the return instead.');
    return { p: p, errs: errs };
  },
  editAmount: function (id, newAmount, reason) {
    var chk = Payments.editAmountCheck(id);
    if (chk.errs.length) return Promise.reject({ validation: chk.errs });
    var p = chk.p, amountP = M.toP(newAmount);
    if (!(amountP > 0)) return Promise.reject({ validation: ['Enter an amount greater than zero.'] });
    if (amountP === p.amount) return Promise.reject({ validation: ['That is already the recorded amount.'] });
    return FDB.tx(['payments', 'auditLog'], function (api) {
      var oldAmount = p.amount;
      p.amount = amountP;
      p.balanceAfter = p.balanceBefore + (p.isRefund ? p.amount : -p.amount);
      api.put('payments', p);
      Audit.write(api, {
        action: 'Payment amount corrected', entity: 'Payment', entityId: id, ref: p.receiptNumber,
        reason: reason || '', oldValues: { amount: oldAmount }, newValues: { amount: amountP }
      });
      return p;
    }).then(function (r) { Mirror.refresh(); return r; });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   RETURNS  (§15–§22)
   A return is one parent transaction with many lines. Each line carries its
   own condition, which decides whether the bags are sellable again, and the
   return as a whole carries a financial treatment, which decides what
   happens to the money. The original sale is never deleted.
   ══════════════════════════════════════════════════════════════════════════ */
var RETURN_IN_FLIGHT = {};       /* customer returns being posted right now, keyed by invoice + lines (see fromCustomer) */
var Returns = ERP.Returns = {
  customerAll: function () { return S.custReturns; },
  customerItems: function (id) { return S.custReturnItems.filter(function (i) { return i.returnId === id; })
                                                         .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },
  supplierAll: function () { return S.supReturns; },
  supplierItems: function (id) { return S.supReturnItems.filter(function (i) { return i.returnId === id; })
                                                        .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },

  sellable: function (condition) { return (condition || 'SELLABLE') === 'SELLABLE'; },
  conditionLabel: function (c) {
    return ({ SELLABLE: 'Good — sellable again', DAMAGED: 'Damaged', DEFECTIVE: 'Defective',
              WRONG_ITEM: 'Wrong item supplied', EXPIRED: 'Expired', OTHER: 'Other' })[c] || c;
  },
  treatmentLabel: function (t) {
    return ({ ADJUST_OUTSTANDING_BALANCE: 'Adjust outstanding balance', CUSTOMER_CREDIT: 'Customer credit',
              REFUND: 'Refund', REPLACEMENT: 'Replacement' })[t] || t;
  },

  /* how many more of an invoice line may still come back (§15) */
  returnableQty: function (invoiceItemId) {
    var it = S.invoiceItems.find(function (x) { return x.id === invoiceItemId; });
    if (!it) return 0;
    return M.qty(it.quantity - Invoices.returnedQty(it.invoiceId, it.id));
  },
  supplierReturnableQty: function (purchaseItemId) {
    var it = S.purchaseItems.find(function (x) { return x.id === purchaseItemId; });
    if (!it) return 0;
    var already = S.supReturnItems.filter(function (r) {
      var ret = S.supReturns.find(function (x) { return x.id === r.returnId; });
      return r.purchaseItemId === purchaseItemId && ret && ret.status !== 'CANCELLED';
    }).reduce(function (a, r) { return a + r.quantity; }, 0);
    return M.qty((it.receivedQty === undefined ? it.quantity : it.receivedQty) - already);
  },

  /* A REFUND pays cash OUT, and the credit note it comes with is cancelled by that payment, so the shop's balance
     does not move. That is only right for money the shop actually paid on THIS invoice — refunding an unpaid
     invoice would leave the shop owing the full sale while we hand back cash we never received (found 2026-09-26).
     Returns '' when the refund is fine, else the sentence to show. `lines` = [{invoiceItemId, quantity}]. */
  refundLimitError: function (inv, lines) {
    var want = 0;
    (lines || []).forEach(function (l) {
      var it = S.invoiceItems.find(function (x) { return x.id === l.invoiceItemId; });
      if (!it) return;
      var eff = it.quantity ? Math.round(it.lineTotal / it.quantity) : it.unitPrice;
      want += M.mul(eff, M.qty(l.quantity));
    });
    /* everything already handed back for this invoice: earlier REFUND returns AND "Pay back" vouchers */
    var already = Invoices.refundedFor(inv.id);
    var room = Math.max(0, Invoices.paidFor(inv.id) - already);
    if (want <= room) return '';
    return 'A refund can only give back money the shop has paid on this invoice. ' + inv.invoiceNumber + ' has ' +
      M.fmt(Invoices.paidFor(inv.id)) + ' paid' + (already ? ' (' + M.fmt(already) + ' already refunded)' : '') +
      ', so at most ' + M.fmt(room) + ' can be refunded, but this return is worth ' + M.fmt(want) +
      '. Choose “Reduce what the shop owes” instead.';
  },

  fromCustomer: function (o) {
    var inv = Invoices.byId(o.invoiceId);
    if (!inv) return Promise.reject({ validation: ['Choose the invoice being returned against.'] });
    if (inv.status === 'DRAFT' || inv.status === 'CANCELLED')
      return Promise.reject({ validation: ['That invoice is not a confirmed sale.'] });
    var treatment = o.treatment || 'ADJUST_OUTSTANDING_BALANCE';
    var lines = (o.items || []).filter(function (i) { return M.qty(i.quantity) > 0; });
    if (!lines.length) return Promise.reject({ validation: ['Enter the quantity coming back on at least one line.'] });

    /* every line is checked before anything is written (§8 §33) */
    var errs = [], wid = o.warehouseId || inv.warehouseId;
    lines.forEach(function (l, n) {
      var it = S.invoiceItems.find(function (x) { return x.id === l.invoiceItemId; });
      if (!it || it.invoiceId !== inv.id) { errs.push('Line ' + (n + 1) + ' is not on that invoice.'); return; }
      var q = M.qty(l.quantity);
      if (q <= 0) { errs.push('Line ' + (n + 1) + ': quantity must be more than zero.'); return; }
      var max = Returns.returnableQty(it.id);
      if (q > max) {
        errs.push('Cannot return ' + q + ' × ' + (it.descriptionEnSnapshot || it.descriptionSnapshot) +
                  ' — ' + it.quantity + ' were sold and ' + (it.quantity - max) +
                  ' already came back, so ' + max + ' is the most that can still be returned.');
      }
      if (treatment === 'REPLACEMENT') {
        var have = Inventory.available(it.productId, wid);
        if (q > have) {
          errs.push('Replacement cannot be issued: only ' + have + ' × ' +
                    (it.descriptionEnSnapshot || it.descriptionSnapshot) + ' in ' +
                    (global.whName ? global.whName(wid) : wid) + '.');
        }
      }
    });
    if (treatment === 'REFUND') {
      var refundErr = Returns.refundLimitError(inv, lines);
      if (refundErr) errs.push(refundErr);
    }
    if (errs.length) return Promise.reject({ validation: errs });

    /* The same return pressed twice (a double click on "Post return") used to run twice: each press got its own
       operation id, both passed the "how many can still come back" check before either had written anything, and
       the server refused the second — but the second had already put the bags and the credit into THIS page's
       memory, so stock read 10 instead of 5 and the shop had two credit notes until a reload (2026-09-26).
       A return that is still being posted is refused before it touches anything. */
    var flightKey = inv.id + '|' + lines.map(function (l) { return l.invoiceItemId + ':' + M.qty(l.quantity); }).sort().join(',');
    if (RETURN_IN_FLIGHT[flightKey]) {
      return Promise.reject({ validation: ['This return is already being posted — please wait a moment.'] });
    }
    RETURN_IN_FLIGHT[flightKey] = true;
    var opId = o.clientOpId || FDB.uid('cretop');
    return FDB.tx(['sequences', 'customerReturns', 'customerReturnItems', 'inventory', 'stockMovements',
                   'invoices', 'invoiceItems', 'payments', 'paymentAllocations', 'auditLog', 'operations'],
      function (api) {
      return FDB.claimOperation(api, opId, 'CustomerReturn', {}).then(function () {
      return FDB.nextNumber(api, 'CR').then(function (number) {
        var creditP = 0, qtyTotal = 0, replacedP = 0;
        var rec = {
          id: FDB.uid('cret'), returnNumber: number, clientOpId: opId,
          invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId,
          customerNameSnapshot: inv.shopNameSnapshot, regionSnapshot: inv.regionSnapshot,
          warehouseId: wid, warehouseSnapshot: global.whName ? global.whName(wid) : '',
          returnDate: o.date || todayISO(), reason: o.reason || '',
          treatment: treatment, condition: o.condition || '', notes: o.notes || '',
          description: (ERP.Desc ? ERP.Desc.clean(o.description) : (o.description || '')),
          creditAmount: 0, replacementValue: 0, totalQty: 0, lineCount: lines.length,
          status: 'POSTED', createdBy: currentUser(), createdAt: nowISO()
        };
        lines.forEach(function (l, ix) {
          var it = S.invoiceItems.find(function (x) { return x.id === l.invoiceItemId; });
          var q = M.qty(l.quantity);
          var condition = l.condition || o.condition || 'SELLABLE';
          /* valued at the rate actually charged on the original invoice (§20) */
          var effectiveUnit = it.quantity ? Math.round(it.lineTotal / it.quantity) : it.unitPrice;
          var value = M.mul(effectiveUnit, q);
          qtyTotal += q;
          if (treatment === 'REPLACEMENT') replacedP += value; else creditP += value;

          var r = {
            id: FDB.uid('cri'), returnId: rec.id, invoiceItemId: it.id, productId: it.productId,
            descriptionSnapshot: it.descriptionSnapshot, descriptionEnSnapshot: it.descriptionEnSnapshot,
            brandSnapshot: it.brandSnapshot, packageSnapshot: it.packageSnapshot,
            quantity: q, unit: it.unit || 'Bag', unitPrice: effectiveUnit, lineTotal: value,
            condition: condition, sellable: Returns.sellable(condition),
            reason: l.reason || rec.reason, warehouseId: wid, sortOrder: ix
          };
          api.put('customerReturnItems', r); S.custReturnItems.push(r);

          it.returnedQty = M.qty((it.returnedQty || 0) + q);
          api.put('invoiceItems', it);

          /* stock in: good bags become sellable again, anything else is held
             separately so it can never be sold by mistake (§17 §18) */
          Inventory.apply(api, {
            productId: r.productId, warehouseId: wid, qtyDelta: q,
            bucket: r.sellable ? 'stock' : 'damaged',
            kind: r.sellable ? 'CUSTOMER_RETURN_IN' : 'CUSTOMER_RETURN_DAMAGED_IN',
            ref: number, refType: 'CUSTOMER_RETURN',
            note: rec.customerNameSnapshot + ' — ' + Returns.conditionLabel(condition),
            date: rec.returnDate
          });

          /* a replacement is a second, opposite stock event (§22) */
          if (treatment === 'REPLACEMENT') {
            Inventory.apply(api, {
              productId: r.productId, warehouseId: wid, qtyDelta: -q, kind: 'REPLACEMENT_OUT',
              ref: number, refType: 'CUSTOMER_RETURN',
              note: 'Replacement issued to ' + rec.customerNameSnapshot, date: rec.returnDate
            });
          }
        });

        rec.creditAmount = creditP;
        rec.replacementValue = replacedP;
        rec.totalQty = qtyTotal;
        api.put('customerReturns', rec); S.custReturns.unshift(rec);

        var totalReturned = Invoices.returnedQty(inv.id);
        inv.status = totalReturned >= inv.totalQty ? 'RETURNED' : 'PARTIALLY_RETURNED';
        inv.updatedAt = nowISO();
        api.put('invoices', inv);

        Audit.write(api, {
          action: 'Customer return processed (' + Returns.treatmentLabel(treatment) + ')',
          entity: 'CustomerReturn', entityId: rec.id, ref: number,
          newValues: { invoice: inv.invoiceNumber, credit: creditP, replaced: replacedP,
                       qty: qtyTotal, lines: lines.length },
          reason: rec.reason
        });

        /* money back in cash is a real outgoing payment, not a negative
           invoice (§19) */
        if (treatment === 'REFUND' && creditP > 0) {
          return Payments._write(api, {
            partyId: inv.customerId, partyType: 'CUSTOMER', amountP: creditP,
            method: o.refundMethod || 'Cash', reference: number, date: rec.returnDate,
            note: 'Refund against return ' + number, allocations: []
          }, 'OUT').then(function () { return rec; });
        }
        return rec;
      });
      });
    }).then(function (r) { delete RETURN_IN_FLIGHT[flightKey]; Mirror.refresh(); return r; },
            function (e) { delete RETURN_IN_FLIGHT[flightKey]; throw e; });
  },

  toSupplier: function (o) {
    if (!o.supplierId) return Promise.reject({ validation: ['Choose the supplier.'] });
    if (!o.warehouseId) return Promise.reject({ validation: ['Choose the warehouse the bags leave from.'] });
    var lines = (o.items || []).filter(function (i) { return M.qty(i.quantity) > 0; });
    if (!lines.length) return Promise.reject({ validation: ['Enter at least one quantity to return.'] });
    var wid = o.warehouseId, errs = [];
    lines.forEach(function (l, n) {
      var q = M.qty(l.quantity);
      if (q <= 0) { errs.push('Line ' + (n + 1) + ': quantity must be more than zero.'); return; }
      if (l.purchaseItemId) {
        var max = Returns.supplierReturnableQty(l.purchaseItemId);
        if (q > max) {
          var it = S.purchaseItems.find(function (x) { return x.id === l.purchaseItemId; });
          errs.push('Only ' + max + ' × ' + ((it && (it.descriptionEnSnapshot || it.descriptionSnapshot)) || 'that line') +
                    ' may still be returned against that purchase.');
        }
      }
      var src = l.fromDamaged ? Inventory.damaged(l.productId, wid) : Inventory.available(l.productId, wid);
      if (q > src) {
        var p = global.prodOf(l.productId) || {};
        errs.push('Only ' + src + ' × ' + (p.en || p.ur || 'that product') + ' in ' +
                  (global.whName ? global.whName(wid) : wid) +
                  (l.fromDamaged ? ' (damaged stock)' : '') + '. Requested: ' + q + '.');
      }
    });
    if (errs.length) return Promise.reject({ validation: errs });

    var opId = o.clientOpId || FDB.uid('sretop');
    return FDB.tx(['sequences', 'supplierReturns', 'supplierReturnItems', 'purchaseItems',
                   'inventory', 'stockMovements', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'SupplierReturn', {}).then(function () {
      return FDB.nextNumber(api, 'SR').then(function (number) {
        var sup = global.supOf(o.supplierId) || {};
        var pu = o.purchaseId ? Purchases.byId(o.purchaseId) : null;
        var totalP = 0, qtyTotal = 0;
        var rec = {
          id: FDB.uid('sret'), returnNumber: number, clientOpId: opId, supplierId: o.supplierId,
          supplierNameSnapshot: sup.co || '', purchaseId: o.purchaseId || null,
          purchaseNumber: pu ? pu.purchaseNumber : (o.purchaseNumber || ''),
          warehouseId: wid, warehouseSnapshot: global.whName ? global.whName(wid) : '',
          returnDate: o.date || todayISO(), reason: o.reason || '', notes: o.notes || '',
          description: (ERP.Desc ? ERP.Desc.clean(o.description) : (o.description || '')),
          expectReplacement: !!o.expectReplacement,
          debitAmount: 0, totalQty: 0, lineCount: lines.length, status: 'POSTED',
          createdBy: currentUser(), createdAt: nowISO()
        };
        lines.forEach(function (l, ix) {
          var p = global.prodOf(l.productId) || {};
          var pit = l.purchaseItemId ? S.purchaseItems.find(function (x) { return x.id === l.purchaseItemId; }) : null;
          var q = M.qty(l.quantity);
          var unit = l.unitPrice !== undefined && l.unitPrice !== ''
            ? M.toP(l.unitPrice) : (pit ? pit.unitPrice : Inventory.costOf(l.productId, wid));
          var amt = M.mul(unit, q);
          totalP += amt; qtyTotal += q;
          var r = {
            id: FDB.uid('sri'), returnId: rec.id, productId: l.productId,
            purchaseItemId: l.purchaseItemId || null,
            descriptionSnapshot: pit ? pit.descriptionSnapshot : (p.ur || p.en || ''),
            descriptionEnSnapshot: pit ? pit.descriptionEnSnapshot : (p.en || ''),
            brandSnapshot: p.brandEn || p.brand || '',
            packageSnapshot: p.kg ? p.kg + ' KG' : 'Bag',
            quantity: q, unit: 'Bag', unitPrice: unit, lineTotal: amt,
            reason: l.reason || rec.reason, fromDamaged: !!l.fromDamaged,
            warehouseId: wid, sortOrder: ix
          };
          api.put('supplierReturnItems', r); S.supReturnItems.push(r);
          if (pit) { pit.returnedQty = M.qty((pit.returnedQty || 0) + q); api.put('purchaseItems', pit); }
          Inventory.apply(api, {
            productId: r.productId, warehouseId: wid, qtyDelta: -q,
            bucket: l.fromDamaged ? 'damaged' : 'stock',
            kind: 'SUPPLIER_RETURN_OUT', ref: number, refType: 'SUPPLIER_RETURN',
            note: rec.supplierNameSnapshot, date: rec.returnDate
          });
        });
        rec.debitAmount = totalP; rec.totalQty = qtyTotal;
        api.put('supplierReturns', rec); S.supReturns.unshift(rec);
        Audit.write(api, { action: 'Supplier return raised', entity: 'SupplierReturn', entityId: rec.id,
          ref: number, newValues: { supplier: rec.supplierNameSnapshot, debit: totalP,
                                    qty: qtyTotal, lines: lines.length }, reason: rec.reason });
        return rec;
      });
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },

  /* replacement bags arriving back from the mill (§22) */
  supplierReplacementIn: function (o) {
    var lines = (o.items || []).filter(function (i) { return M.qty(i.quantity) > 0; });
    if (!lines.length) return Promise.reject({ validation: ['Enter at least one quantity received.'] });
    if (!o.warehouseId) return Promise.reject({ validation: ['Choose the warehouse.'] });
    var opId = o.clientOpId || FDB.uid('srepop');
    return FDB.tx(['inventory', 'stockMovements', 'supplierReturns', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'SupplierReplacement', {}).then(function () {
        var ref = o.returnNumber || 'REPLACEMENT';
        lines.forEach(function (l) {
          Inventory.apply(api, {
            productId: l.productId, warehouseId: o.warehouseId, qtyDelta: M.qty(l.quantity),
            kind: 'SUPPLIER_REPLACEMENT_IN', ref: ref, refType: 'SUPPLIER_REPLACEMENT',
            note: o.note || 'Replacement received', date: o.date || todayISO(),
            unitCostP: l.unitPrice ? M.toP(l.unitPrice) : 0
          });
        });
        if (o.returnId) {
          var sr = S.supReturns.find(function (x) { return x.id === o.returnId; });
          if (sr) { sr.replacementReceived = true; sr.replacedAt = nowISO(); api.put('supplierReturns', sr); }
        }
        Audit.write(api, { action: 'Supplier replacement received', entity: 'SupplierReturn',
          entityId: o.returnId || '', ref: ref, newValues: { lines: lines.length } });
        return true;
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },

  writeOff: function (o) {
    var q = M.qty(o.quantity);
    if (!(q > 0)) return Promise.reject({ validation: ['Enter a quantity.'] });
    return FDB.tx(['inventory', 'stockMovements', 'auditLog'], function (api) {
      Inventory.apply(api, { productId: o.productId, warehouseId: o.warehouseId, qtyDelta: -q,
        bucket: o.fromDamaged ? 'damaged' : 'stock', kind: 'STOCK_WRITE_OFF',
        ref: o.reference || '', refType: 'WRITE_OFF', note: o.reason || '', date: o.date || todayISO() });
      Audit.write(api, { action: 'Stock written off', entity: 'Inventory',
        entityId: o.productId + '|' + o.warehouseId, reason: o.reason || '', newValues: { qty: -q } });
    }).then(function () { Mirror.refresh(); });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   LEDGERS (§21 §22) — one derivation, used by every screen
   ══════════════════════════════════════════════════════════════════════════ */
var Ledger = ERP.Ledger = {
  customer: function (customerId, fromISO, toISO) {
    var rows = [];
    S.invoices.filter(function (i) { return i.customerId === customerId && i.status !== 'DRAFT' && i.status !== 'CANCELLED'; })
      .forEach(function (i) {
        rows.push({ iso: i.invoiceDate, ref: i.invoiceNumber, what: 'Sales invoice',
                    dr: i.grandTotal, cr: 0, kind: 'INVOICE', id: i.id, createdAt: i.createdAt });
      });
    S.payments.filter(function (p) {
      return p.partyId === customerId && p.status !== 'REVERSED' &&
             (p.direction === 'IN' || p.partyType === 'CUSTOMER');
    }).forEach(function (p) {
      if (p.direction === 'IN') {
        rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: 'Payment received — ' + p.method,
                    dr: 0, cr: p.amount, kind: 'PAYMENT', id: p.id, createdAt: p.createdAt });
      } else {
        rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: 'Refund paid — ' + p.method,
                    dr: p.amount, cr: 0, kind: 'REFUND', id: p.id });
      }
    });
    S.custReturns.filter(function (r) { return r.customerId === customerId && r.status !== 'CANCELLED'; })
      .forEach(function (r) {
        rows.push({ iso: r.returnDate, ref: r.returnNumber, what: 'Credit note — return', dr: 0,
                    cr: r.creditAmount, kind: 'RETURN', id: r.id, createdAt: r.createdAt });
      });
    var c = global.custBy && global.custBy(customerId);
    if (c && c.openingBalanceP) {
      rows.push({ iso: c.openingBalanceDate || '2000-01-01', ref: 'OPENING', what: 'Opening balance',
                  dr: c.openingBalanceP, cr: 0, kind: 'OPENING', id: 'opening' });
    }
    return Ledger._roll(rows, fromISO, toISO);
  },
  supplier: function (supplierId, fromISO, toISO) {
    var rows = [];
    S.purchases.filter(function (p) { return p.supplierId === supplierId && p.status !== 'CANCELLED'; })
      .forEach(function (p) {
        rows.push({ iso: p.purchaseDate, ref: p.purchaseNumber, what: 'Purchase invoice',
                    dr: 0, cr: p.grandTotal, kind: 'PURCHASE', id: p.id, createdAt: p.createdAt });
      });
    S.payments.filter(function (p) { return p.direction === 'OUT' && p.partyType !== 'CUSTOMER' &&
                                             p.partyId === supplierId && p.status !== 'REVERSED'; })
      .forEach(function (p) {
        rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: 'Payment made — ' + p.method,
                    dr: p.amount, cr: 0, kind: 'PAYMENT', id: p.id });
      });
    S.supReturns.filter(function (r) { return r.supplierId === supplierId && r.status !== 'CANCELLED'; })
      .forEach(function (r) {
        rows.push({ iso: r.returnDate, ref: r.returnNumber, what: 'Return to supplier',
                    dr: r.debitAmount, cr: 0, kind: 'RETURN', id: r.id });
      });
    var s = global.supOf && global.supOf(supplierId);
    if (s && s.openingBalanceP) {
      rows.push({ iso: s.openingBalanceDate || '2000-01-01', ref: 'OPENING', what: 'Opening balance',
                  dr: 0, cr: s.openingBalanceP, kind: 'OPENING', id: 'opening' });
    }
    var L = Ledger._roll(rows, fromISO, toISO, true);
    return L;
  },
  _roll: function (rows, fromISO, toISO, credited) {
    /* business date first; for two entries on the same day, the order they
       were actually entered — so a running balance is reproducible */
    rows.sort(function (a, b) {
      if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
      return (a.createdAt || '') < (b.createdAt || '') ? -1
           : (a.createdAt || '') > (b.createdAt || '') ? 1 : 0;
    });
    var bal = 0, opening = 0, out = [];
    rows.forEach(function (r) {
      var delta = credited ? (r.cr - r.dr) : (r.dr - r.cr);
      /* anything after the period is simply not part of this statement —
         only what happened before it forms the opening balance */
      if (toISO && r.iso > toISO) return;
      if (fromISO && r.iso < fromISO) { bal += delta; opening = bal; return; }
      bal += delta; out.push(Object.assign({}, r, { balance: bal }));
    });
    return {
      opening: opening, rows: out, closing: bal,
      debit: out.reduce(function (a, r) { return a + r.dr; }, 0),
      credit: out.reduce(function (a, r) { return a + r.cr; }, 0)
    };
  },
  customerBalance: function (id) { return Ledger.customer(id).closing; },
  supplierBalance: function (id) { return Ledger.supplier(id).closing; },
  receivablesTotal: function () {
    return (global.CUSTOMERS || []).reduce(function (a, c) { return a + Math.max(0, Ledger.customerBalance(c.id)); }, 0);
  },
  payablesTotal: function () {
    return (global.SUPPLIERS || []).reduce(function (a, s) { return a + Math.max(0, Ledger.supplierBalance(s.id)); }, 0);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   REPORTING FEED (§40 §41)
   ══════════════════════════════════════════════════════════════════════════ */
var Reports = ERP.Reports = {
  range: function (key) {
    var t = todayISO(), d = new Date(t + 'T00:00:00');
    /* local calendar date — toISOString() is UTC, which moved every date built
       from a local-midnight Date back one day east of Greenwich (in Pakistan,
       "Yesterday" was two days ago and "Last month" ran Jul 31–Aug 30) */
    function iso(x) {
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' +
             String(x.getDate()).padStart(2, '0');
    }
    function shift(n) { var y = new Date(d); y.setDate(y.getDate() + n); return iso(y); }
    switch (key) {
      case 'today':     return [t, t];
      case 'yesterday': return [shift(-1), shift(-1)];
      case 'week':      return [shift(-(d.getDay() || 7) + 1), t];
      case 'month':     return [t.slice(0, 8) + '01', t];
      case 'lastmonth': var f = new Date(d.getFullYear(), d.getMonth() - 1, 1),
                            l = new Date(d.getFullYear(), d.getMonth(), 0);
                        return [iso(f), iso(l)];
      case 'year':      return [t.slice(0, 4) + '-01-01', t];
      default:          return [null, null];
    }
  },
  invoicesIn: function (from, to) {
    return Invoices.live().filter(function (i) {
      return (!from || i.invoiceDate >= from) && (!to || i.invoiceDate <= to);
    });
  },
  sales: function (from, to) {
    var list = Reports.invoicesIn(from, to);
    var revenue = list.reduce(function (a, i) { return a + i.grandTotal; }, 0);
    var cost = 0, qty = 0;
    list.forEach(function (i) {
      Invoices.items(i.id).forEach(function (it) {
        cost += M.mul(it.costSnapshot || 0, it.quantity); qty += it.quantity;
      });
    });
    var returns = S.custReturns.filter(function (r) {
      return (!from || r.returnDate >= from) && (!to || r.returnDate <= to) && r.status !== 'CANCELLED';
    }).reduce(function (a, r) { return a + r.creditAmount; }, 0);
    var collected = S.payments.filter(function (p) {
      return p.direction === 'IN' && p.status !== 'REVERSED' &&
             (!from || p.paymentDate >= from) && (!to || p.paymentDate <= to);
    }).reduce(function (a, p) { return a + p.amount; }, 0);
    /* profit after the returned bags are taken back out (Profit.returned, 17-profit.js) */
    var back = ERP.Profit && ERP.Profit.returned ? ERP.Profit.returned(from, to) : { revenue: 0, cost: 0 };
    var netProfit = (revenue - back.revenue) - (cost - back.cost);
    return {
      count: list.length, revenue: revenue, cost: cost, grossProfit: revenue - cost,
      margin: revenue ? Math.round((revenue - cost) / revenue * 1000) / 10 : 0,
      netProfit: netProfit,
      netMargin: revenue - back.revenue ? Math.round(netProfit / (revenue - back.revenue) * 1000) / 10 : 0,
      qty: qty, returns: returns, netRevenue: revenue - returns, collected: collected,
      invoices: list
    };
  },
  byProduct: function (from, to) {
    var map = {};
    Reports.invoicesIn(from, to).forEach(function (i) {
      Invoices.items(i.id).forEach(function (it) {
        var k = it.productId;
        if (!map[k]) map[k] = { productId: k, name: it.descriptionSnapshot, nameEn: it.descriptionEnSnapshot,
                                pack: it.packageSnapshot, qty: 0, revenue: 0, cost: 0 };
        map[k].qty += it.quantity; map[k].revenue += it.lineTotal;
        map[k].cost += M.mul(it.costSnapshot || 0, it.quantity);
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
                 .sort(function (a, b) { return b.revenue - a.revenue; });
  },
  byRegion: function (from, to) {
    var map = {};
    Reports.invoicesIn(from, to).forEach(function (i) {
      var k = i.regionId || 'none';
      /* the area's current name if it still exists (so a rename shows here),
         otherwise the name the invoice was made with */
      var live = i.regionId && global.regionOf ? global.regionOf(i.regionId) : null;
      if (!map[k]) map[k] = { regionId: k, count: 0, revenue: 0, qty: 0,
        label: (live && !live.deleted && (live.ur || live.en) ? (live.ur ? live.ur + ' — ' : '') + (live.en || '') : '') ||
               i.regionSnapshot || 'No region' };
      map[k].count++; map[k].revenue += i.grandTotal; map[k].qty += i.totalQty;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
                 .sort(function (a, b) { return b.revenue - a.revenue; });
  },
  byWarehouse: function (from, to) {
    var map = {};
    Reports.invoicesIn(from, to).forEach(function (i) {
      var k = i.warehouseId;
      if (!map[k]) map[k] = { warehouseId: k, label: i.warehouseSnapshot, count: 0, revenue: 0, qty: 0 };
      map[k].count++; map[k].revenue += i.grandTotal; map[k].qty += i.totalQty;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  },
  byCustomer: function (from, to) {
    var map = {};
    Reports.invoicesIn(from, to).forEach(function (i) {
      var k = i.customerId;
      if (!map[k]) map[k] = { customerId: k, label: i.shopNameSnapshot, region: i.regionSnapshot,
                              count: 0, revenue: 0, paid: 0 };
      map[k].count++; map[k].revenue += i.grandTotal; map[k].paid += Invoices.paidFor(i.id);
    });
    return Object.keys(map).map(function (k) {
      var r = map[k]; r.balance = Ledger.customerBalance(k); return r;
    }).sort(function (a, b) { return b.revenue - a.revenue; });
  },
  receivables: function () {
    return (global.CUSTOMERS || []).map(function (c) {
      var bal = Ledger.customerBalance(c.id);
      return { customerId: c.id, shop: c.sh, region: c.region, balance: bal };
    }).filter(function (r) { return r.balance !== 0; })
      .sort(function (a, b) { return b.balance - a.balance; });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   MIRROR — keeps the fourteen original screens working unchanged.
   The new stores are authoritative; these arrays are a projection of them.
   ══════════════════════════════════════════════════════════════════════════ */
var Mirror = ERP.Mirror = {
  refresh: function () {
    if (!global.SALES) return;
    var fmtDate = global.fmtDate || function (x) { return x; };

    global.SALES.length = 0;
    S.invoices.filter(function (i) { return i.status !== 'DRAFT' && i.status !== 'CANCELLED'; })
      .forEach(function (i) {
        var items = Invoices.items(i.id);
        var first = items[0] || {};
        global.SALES.push({
          id: i.invoiceNumber || i.id, invId: i.id, doc: i.invoiceNumber,
          cust: i.customerId, wid: i.warehouseId,
          pid: first.productId, qty: i.totalQty, lines: items.length,
          rate: first.unitPrice ? M.toR(first.unitPrice) : null,
          amt: M.toR(i.grandTotal), paid: M.toR(Invoices.paidFor(i.id)),
          pay: i.paymentStatus === 'PAID' ? 'Paid' : i.paymentStatus === 'PARTIAL' ? 'Partial' : 'Credit',
          method: i.paymentMethod, order: i.orderNumber,
          st: STATUS_LABEL[i.status] || i.status,
          date: fmtDate(i.invoiceDate), iso: i.invoiceDate
        });
      });
    global.SALES.sort(function (a, b) { return a.iso < b.iso ? 1 : -1; });

    global.PURCHASES.length = 0;
    S.purchases.forEach(function (p) {
      var items = Purchases.items(p.id), first = items[0] || {};
      global.PURCHASES.push({
        id: p.purchaseNumber || p.id, purId: p.id, doc: p.purchaseNumber,
        sup: p.supplierId, wid: p.warehouseId, pid: first.productId,
        qty: p.totalQty, lines: items.length,
        rate: first.unitPrice ? M.toR(first.unitPrice) : null,
        amt: M.toR(p.grandTotal), ref: p.supplierInvoiceNo, veh: p.vehicleNo,
        pay: p.paymentStatus === 'PAID' ? 'Paid' : p.paymentStatus === 'PARTIAL' ? 'Partial' : 'Unpaid',
        date: fmtDate(p.purchaseDate), iso: p.purchaseDate
      });
    });
    global.PURCHASES.sort(function (a, b) { return a.iso < b.iso ? 1 : -1; });

    global.CUSTPAY.length = 0;
    Payments.incoming().forEach(function (p) {
      global.CUSTPAY.push({ cust: p.partyId, amt: M.toR(p.amount), method: p.method, ref: p.reference,
        st: 'Received', doc: p.receiptNumber, date: fmtDate(p.paymentDate), iso: p.paymentDate });
    });
    global.SUPPAY.length = 0;
    Payments.outgoing().forEach(function (p) {
      global.SUPPAY.push({ sup: p.partyId, amt: M.toR(p.amount), method: p.method, ref: p.reference,
        st: 'Paid', doc: p.receiptNumber, date: fmtDate(p.paymentDate), iso: p.paymentDate });
    });
    if (global.CREDITS) {
      global.CREDITS.length = 0;
      S.custReturns.forEach(function (r) {
        global.CREDITS.push({ cust: r.customerId, amt: M.toR(r.creditAmount), reason: r.reason,
          doc: r.returnNumber, invoice: r.invoiceNumber, date: fmtDate(r.returnDate), iso: r.returnDate });
      });
    }
    /* stock map + per-customer roll-ups the old screens read directly */
    global.STOCKMAP = global.STOCKMAP || {};
    /* On the server the database is the only copy: the browser's old stock map and movement history (loaded from
       its localStorage record before the data arrived) must not survive, or stock deleted on the server still shows. */
    if (FDB.driver === 'server') {
      Object.keys(global.STOCKMAP).forEach(function (k) { if (!S.inventory[k]) delete global.STOCKMAP[k]; });
      if (global.MOVES) {
        global.MOVES.length = 0;
        S.movements.slice(0, 4000).forEach(function (rec) {
          var d = new Date(rec.createdAt || rec.date), h = d.getHours();
          global.MOVES.push({
            id: 'MV-' + String(rec.id || '').slice(-6).toUpperCase(),
            t: isNaN(h) ? '' : ((h % 12) || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'),
            iso: rec.date, pid: rec.productId, wid: rec.warehouseId, delta: rec.qtyDelta,
            kind: Movements.label(rec.kind), ref: rec.ref || '', note: rec.note || '', by: rec.userId || ''
          });
        });
      }
    }
    Object.keys(S.inventory).forEach(function (k) { global.STOCKMAP[k] = S.inventory[k].qty; });
    (global.CUSTOMERS || []).forEach(function (c) {
      c.bal = M.toR(Ledger.customerBalance(c.id));
      c.tot = M.toR(S.invoices.filter(function (i) { return i.customerId === c.id && i.status !== 'DRAFT' && i.status !== 'CANCELLED'; })
                              .reduce(function (a, i) { return a + i.grandTotal; }, 0));
    });
    (global.SUPPLIERS || []).forEach(function (s) {
      s.due = M.toR(Ledger.supplierBalance(s.id));
      s.paid = M.toR(Payments.outgoing().filter(function (p) { return p.partyId === s.id; })
                             .reduce(function (a, p) { return a + p.amount; }, 0));
    });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   BOOT — hydrate, then migrate anything the ERP already held (§47)
   ══════════════════════════════════════════════════════════════════════════ */
ERP.boot = function () {
  return FDB.open().then(FDB.hydrate).then(function (data) {
    var meta = {};
    (data.meta || []).forEach(function (m) { meta[m.k] = m.v; });
    (data.sequences || []).forEach(function (s) { S.sequences[s.k] = s; });

    S.invoices        = data.invoices || [];
    S.invoiceItems    = data.invoiceItems || [];
    S.purchases       = data.purchases || [];
    S.purchaseItems   = data.purchaseItems || [];
    S.payments        = data.payments || [];
    S.allocations     = data.paymentAllocations || [];
    S.custReturns     = data.customerReturns || [];
    S.custReturnItems = data.customerReturnItems || [];
    S.supReturns      = data.supplierReturns || [];
    S.supReturnItems  = data.supplierReturnItems || [];
    S.movements       = (data.stockMovements || []).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    S.audit           = (data.auditLog || []).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    S.business        = (data.business || [])[0] || null;
    S.inventory       = {};
    (data.inventory || []).forEach(function (r) { S.inventory[r.id] = r; });

    ERP.mergeMasterFromDb(data);

    S.loaded = true;
    var needMigration = !meta.migration || meta.migration !== '1';
    if (!needMigration) { Mirror.refresh(); return ERP; }
    return FDB.adoptLegacyDatabase().then(function (found) {
      if (found.kind === 'stores') return Migrate.adoptStores(found.records);
      return Migrate.run(data, found.kind === 'snapshot' ? found.snapshot : null);
    }).then(function () { Mirror.refresh(); return ERP; });
  }).catch(function (e) {
    ERP.bootError = e && e.message || String(e);
    S.loaded = true;
    try { global.console.error('[ERP] boot failed', e); } catch (x) {}
    return ERP;
  });
};

var Migrate = ERP.Migrate = {
  /* Records written by the earlier normalised build: copy them across as
     they are — they already have the right shape. */
  adoptStores: function (records) {
    return FDB.tx(FDB.STORE_NAMES, function (api) {
      FDB.STORE_NAMES.forEach(function (name) {
        (records[name] || []).forEach(function (rec) { api.put(name, rec); });
      });
      api.put('meta', { k: 'migration', v: '1' });
      api.put('meta', { k: 'migratedAt', v: nowISO() });
      api.put('meta', { k: 'adoptedFrom', v: 'previous-database' });
      Audit.write(api, {
        action: 'Adopted the records from the previous database', entity: 'System', entityId: 'adopt',
        newValues: { invoices: (records.invoices || []).length,
                     invoiceItems: (records.invoiceItems || []).length,
                     payments: (records.payments || []).length }
      });
    }).then(function () {
      return FDB.hydrate().then(function (d) {
        S.invoices = d.invoices || []; S.invoiceItems = d.invoiceItems || [];
        S.purchases = d.purchases || []; S.purchaseItems = d.purchaseItems || [];
        S.payments = d.payments || []; S.allocations = d.paymentAllocations || [];
        S.custReturns = d.customerReturns || []; S.custReturnItems = d.customerReturnItems || [];
        S.supReturns = d.supplierReturns || []; S.supReturnItems = d.supplierReturnItems || [];
        S.movements = d.stockMovements || []; S.audit = d.auditLog || [];
        S.business = (d.business || [])[0] || S.business;
        S.inventory = {}; (d.inventory || []).forEach(function (r) { S.inventory[r.id] = r; });
        (d.sequences || []).forEach(function (r) { S.sequences[r.k] = r; });
      });
    });
  },

  run: function (data, snapshot) {
    /* the in-house build wrote the same localStorage key and, when it could,
       a fuller snapshot in its own database — take whichever is newer */
    var blob = FDB.readLegacyBlob() || {};
    var legacy = blob;
    if (snapshot && (!blob.savedAt || (snapshot.savedAt || '') > (blob.savedAt || ''))) legacy = snapshot;
    var seededMaster = !(data.products || []).length;
    var fmtDate = global.fmtDate;
    var isoOf = global.isoOf || function () { return todayISO(); };

    return FDB.tx(FDB.STORE_NAMES, function (api) {
      /* 1. master data → its own stores */
      if (seededMaster) {
        (global.PRODUCTS   || []).forEach(function (p) { api.put('products', p); });
        (global.CUSTOMERS  || []).forEach(function (c) { api.put('customers', c); });
        (global.SUPPLIERS  || []).forEach(function (s) { api.put('suppliers', s); });
        (global.WAREHOUSES || []).forEach(function (w) { api.put('warehouses', w); });
        (global.REGIONS    || []).forEach(function (r) { api.put('regions', r); });
      }
      /* 2. business settings */
      if (!S.business) { S.business = Settings.defaults(); api.put('business', S.business); }

      /* 3. stock map → inventory + an opening movement per line */
      var sm = (legacy.stock && Object.keys(legacy.stock).length) ? legacy.stock : (global.STOCKMAP || {});
      if (!(data.inventory || []).length) {
        Object.keys(sm).forEach(function (k) {
          var parts = k.split('|'), qty = Number(sm[k]) || 0;
          if (!qty) return;
          var row = { id: k, productId: parts[0], warehouseId: parts[1], qty: qty, damagedQty: 0, avgCostP: 0 };
          S.inventory[k] = row; api.put('inventory', row);
          var mv = { id: FDB.uid('mv'), createdAt: nowISO(), date: todayISO(), productId: row.productId,
                     warehouseId: row.warehouseId, kind: 'OPENING_STOCK', qtyDelta: qty, bucket: 'stock',
                     balanceAfter: qty, ref: 'MIGRATION', refType: 'MIGRATION',
                     note: 'Carried in from the previous ERP record', unitCostP: 0, userId: 'system' };
          api.put('stockMovements', mv); S.movements.push(mv);
        });
      }
      /* 4. legacy single-product sales → real invoices with one line each */
      var chainP = Promise.resolve();
      if (!(data.invoices || []).length) {
        (legacy.sales || global.SALES || []).slice().reverse().forEach(function (s) {
          chainP = chainP.then(function () {
            return FDB.nextNumber(api, 'INV').then(function (number) {
              var c = global.custBy ? (global.custBy(s.cust) || {}) : {};
              var p = global.prodOf ? (global.prodOf(s.pid) || {}) : {};
              var iso = s.iso || todayISO();
              var grand = M.toP(s.amt), paid = M.toP(s.paid);
              var id = FDB.uid('inv');
              var region = c.region && global.regionOf ? global.regionOf(c.region) : null;
              var inv = {
                id: id, invoiceNumber: number, clientOpId: id, invoiceType: 'SALE',
                saleOrderId: null, orderNumber: s.order || '', dispatchNumber: '',
                customerId: s.cust, customerCodeSnapshot: c.legacyCode || '',
                customerNameSnapshot: c.ow || c.sh || '', shopNameSnapshot: c.sh || '',
                contactPersonSnapshot: c.ow || '', mobileSnapshot: c.ph || '', whatsappSnapshot: c.wa || '',
                addressSnapshot: c.addr || '', regionId: c.region || '',
                regionSnapshot: region ? region.ur + ' — ' + region.en : '',
                marketSnapshot: c.area || '', warehouseId: s.wid,
                warehouseSnapshot: global.whName ? global.whName(s.wid) : '',
                salesperson: 'Migrated', invoiceDate: iso, dueDate: '',
                subtotal: grand, discountAmount: 0, itemDiscounts: 0, invoiceDiscount: 0,
                taxAmount: 0, freightAmount: 0, loadingAmount: 0, otherCharges: 0,
                grandTotal: grand, paidAmount: paid, balanceAmount: grand - paid,
                paymentStatus: Calc.paymentStatus(grand, paid), paymentMethod: s.method || 'Cash',
                referenceNo: '', status: paid >= grand && grand > 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'CONFIRMED',
                notes: 'Migrated from the previous single-product sale record ' + (s.id || ''),
                totalQty: Number(s.qty) || 0, lineCount: 1, previousBalance: 0,
                createdBy: 'system', createdAt: nowISO(), updatedAt: nowISO(),
                confirmedAt: nowISO(), cancelledAt: null, cancelReason: '', stockApplied: true,
                migrated: true
              };
              /* the in-house build already stored real line items — keep every
                 one of them instead of collapsing the sale to one line */
              var srcLines = Array.isArray(s.items) && s.items.length
                ? s.items
                : [{ pid: s.pid, qty: s.qty, rate: s.rate, disc: 0, total: M.toR(grand) }];
              inv.lineCount = srcLines.length;
              inv.totalQty = srcLines.reduce(function (a, l) { return a + (Number(l.qty) || 0); }, 0);
              inv.subtotal = M.sum(srcLines.map(function (l) {
                return M.mul(M.toP(l.rate), Number(l.qty) || 0);
              }));
              inv.itemDiscounts = M.sum(srcLines.map(function (l) { return M.toP(l.disc); }));
              inv.invoiceDiscount = M.toP(s.invoiceDiscount);
              inv.discountAmount = inv.itemDiscounts + inv.invoiceDiscount;
              inv.taxAmount = M.toP(s.tax);
              inv.freightAmount = M.toP(s.freight);
              inv.loadingAmount = M.toP(s.loading);
              inv.otherCharges = M.toP(s.other);
              api.put('invoices', inv); S.invoices.push(inv);
              srcLines.forEach(function (l, li) {
                var lp = global.prodOf ? (global.prodOf(l.pid) || {}) : {};
                var qty = Number(l.qty) || 0;
                var unit = M.toP(l.rate);
                var disc = M.toP(l.disc);
                var item = {
                  id: FDB.uid('ii'), invoiceId: id, sortOrder: li, productId: l.pid,
                  descriptionSnapshot: l.ur || lp.ur || '',
                  descriptionEnSnapshot: l.en || lp.en || '',
                  brandSnapshot: l.brand || lp.brandEn || lp.brand || '',
                  categorySnapshot: l.cat || lp.cat || '',
                  packageSnapshot: l.bag || (lp.kg ? lp.kg + ' KG' : 'Bag'),
                  skuSnapshot: l.sku || lp.sourceFolio || lp.id || '',
                  unit: 'Bag', quantity: qty, unitPrice: unit, discount: disc, tax: 0,
                  lineTotal: l.total !== undefined ? M.toP(l.total) : Math.max(0, M.mul(unit, qty) - disc),
                  costSnapshot: l.cost != null ? M.toP(l.cost) : (lp.buy ? M.toP(lp.buy) : 0),
                  warehouseId: l.wid || s.wid, batchNo: l.batch || '', notes: l.note || '', returnedQty: 0
                };
                api.put('invoiceItems', item); S.invoiceItems.push(item);
              });
              if (paid > 0) {
                return Payments._writeIn(api, {
                  partyId: s.cust, amountP: paid, method: s.method || 'Cash', reference: '',
                  date: iso, note: 'Migrated payment against ' + number,
                  allocations: [{ invoiceId: id, amountP: paid }]
                });
              }
            });
          });
        });
      }
      /* 5. legacy purchases → multi-line purchase records */
      if (!(data.purchases || []).length) {
        (legacy.purchases || global.PURCHASES || []).slice().reverse().forEach(function (pu) {
          chainP = chainP.then(function () {
            return FDB.nextNumber(api, 'PUR').then(function (number) {
              var sup = global.supOf ? (global.supOf(pu.sup) || {}) : {};
              var p = global.prodOf ? (global.prodOf(pu.pid) || {}) : {};
              var iso = pu.iso || todayISO();
              var grand = M.toP(pu.amt), paid = pu.pay === 'Paid' ? grand : 0;
              var id = FDB.uid('pur');
              var rec = {
                id: id, purchaseNumber: number, clientOpId: id, supplierId: pu.sup,
                supplierNameSnapshot: sup.co || '', supplierInvoiceNo: pu.ref || '',
                warehouseId: pu.wid, warehouseSnapshot: global.whName ? global.whName(pu.wid) : '',
                purchaseDate: iso, vehicleNo: pu.veh || '', driver: '', deliveryRef: '',
                subtotal: grand, discountAmount: 0, taxAmount: 0, freightAmount: 0,
                loadingAmount: 0, otherCharges: 0, grandTotal: grand, paidAmount: paid,
                balanceAmount: grand - paid, paymentStatus: Calc.paymentStatus(grand, paid),
                status: 'RECEIVED', notes: 'Migrated from the previous purchase record ' + (pu.id || ''),
                totalQty: Number(pu.qty) || 0, lineCount: 1, createdBy: 'system',
                createdAt: nowISO(), updatedAt: nowISO(), stockApplied: true, migrated: true
              };
              var pLines = Array.isArray(pu.items) && pu.items.length
                ? pu.items
                : [{ pid: pu.pid, qty: pu.qty, rate: pu.rate, disc: 0, total: M.toR(grand) }];
              rec.lineCount = pLines.length;
              rec.totalQty = pLines.reduce(function (a, l) { return a + (Number(l.qty) || 0); }, 0);
              rec.orderedQty = rec.totalQty; rec.receivedQty = rec.totalQty;
              api.put('purchases', rec); S.purchases.push(rec);
              pLines.forEach(function (l, li) {
                var lp = global.prodOf ? (global.prodOf(l.pid) || {}) : {};
                var qty = Number(l.qty) || 0, unit = M.toP(l.rate), disc = M.toP(l.disc);
                var item = {
                  id: FDB.uid('pi'), purchaseId: id, sortOrder: li, productId: l.pid,
                  descriptionSnapshot: l.ur || lp.ur || '', descriptionEnSnapshot: l.en || lp.en || '',
                  brandSnapshot: l.brand || lp.brandEn || lp.brand || '',
                  packageSnapshot: l.bag || (lp.kg ? lp.kg + ' KG' : 'Bag'),
                  quantity: qty, orderedQty: qty, receivedQty: qty, unit: 'Bag',
                  unitPrice: unit, discount: disc, tax: 0,
                  lineTotal: l.total !== undefined ? M.toP(l.total) : Math.max(0, M.mul(unit, qty) - disc),
                  warehouseId: l.wid || pu.wid, batchNo: l.batch || '', returnedQty: 0, notes: ''
                };
                api.put('purchaseItems', item); S.purchaseItems.push(item);
              });
              if (paid > 0) {
                return Payments._writeOut(api, {
                  partyId: pu.sup, amountP: paid, method: 'Cash', reference: pu.ref || '',
                  date: iso, note: 'Migrated payment against ' + number,
                  allocations: [{ purchaseId: id, amountP: paid }]
                });
              }
            });
          });
        });
      }
      /* 6. standalone payments that were not tied to a sale or purchase */
      if (!(data.payments || []).length) {
        (legacy.custpay || []).forEach(function (p) {
          if (p.silent) return;
          chainP = chainP.then(function () {
            return Payments._writeIn(api, { partyId: p.cust, amountP: M.toP(p.amt), method: p.method || 'Cash',
              reference: p.ref || '', date: p.iso || todayISO(), note: 'Migrated receipt',
              allocations: Payments.autoAllocate(p.cust, M.toP(p.amt)) });
          });
        });
        (legacy.suppay || []).forEach(function (p) {
          if (p.silent) return;
          chainP = chainP.then(function () {
            return Payments._writeOut(api, { partyId: p.sup, amountP: M.toP(p.amt), method: p.method || 'Cash',
              reference: p.ref || '', date: p.iso || todayISO(), note: 'Migrated payment', allocations: [] });
          });
        });
      }
      /* 6b. damaged stock, transfers and adjustments recorded by the
             in-house build are carried across as movements so the bag
             count still reconciles */
      if (legacy.dmg && !(data.inventory || []).length) {
        Object.keys(legacy.dmg).forEach(function (k) {
          var qty = Number(legacy.dmg[k]) || 0;
          if (!qty) return;
          var parts = k.split('|');
          var row = Inventory.row(parts[0], parts[1]);
          row.damagedQty = qty;
          api.put('inventory', row);
        });
      }
      (legacy.transfers || []).forEach(function (t) {
        var rec = {
          id: FDB.uid('sd'), docNumber: t.id || t.no || ('TRF-' + FDB.uid('x').slice(-6)),
          type: 'TRANSFER', docDate: t.iso || todayISO(),
          warehouseId: t.from || t.wid, warehouseSnapshot: global.whName ? global.whName(t.from || t.wid) : '',
          toWarehouseId: t.to || null, toWarehouseSnapshot: t.to && global.whName ? global.whName(t.to) : '',
          totalQty: Number(t.qty) || 0, lineCount: (t.items || []).length || 1, status: 'POSTED',
          notes: 'Carried in from the previous build', createdBy: 'system', createdAt: nowISO(), migrated: true
        };
        api.put('stockDocs', rec);
        /* into memory as well, so a hydrate that lands while this
           transaction is still committing cannot miss it */
        (S.stockDocs = S.stockDocs || []).push(rec);
      });
      (legacy.adjustments || []).forEach(function (a) {
        var rec = {
          id: FDB.uid('sd'), docNumber: a.id || ('ADJ-' + FDB.uid('x').slice(-6)),
          type: 'ADJUST', docDate: a.iso || todayISO(),
          warehouseId: a.wid, warehouseSnapshot: global.whName ? global.whName(a.wid) : '',
          reason: a.reason || 'Carried in from the previous build',
          totalQty: Number(a.qty) || 0, lineCount: (a.items || []).length || 1, status: 'POSTED',
          createdBy: 'system', createdAt: nowISO(), migrated: true
        };
        api.put('stockDocs', rec);
        /* into memory as well, so a hydrate that lands while this
           transaction is still committing cannot miss it */
        (S.stockDocs = S.stockDocs || []).push(rec);
      });

      /* 7. documents already issued keep their numbers and snapshots */
      if (!(data.documents || []).length) {
        (legacy.docs || global.DOCS || []).forEach(function (d) {
          api.put('documents', Object.assign({}, d, { createdAt: d.createdAt || nowISO(), legacy: true }));
        });
      }
      /* 8. everything else the old blob carried, stored as-is so nothing is lost */
      ['orders', 'dispatch', 'activity', 'users', 'rules', 'log', 'wa', 'devices', 'seq', 'docseq']
        .forEach(function (k) {
          if (legacy[k] !== undefined) api.put('legacy', { k: k, v: legacy[k] });
        });

      return chainP.then(function () {
        api.put('meta', { k: 'migration', v: '1' });
        api.put('meta', { k: 'migratedAt', v: nowISO() });
        api.put('meta', { k: 'appVersion', v: ERP.version });
        Audit.write(api, {
          action: 'Database initialised and existing records migrated', entity: 'System', entityId: 'migration',
          newValues: { invoices: S.invoices.length, purchases: S.purchases.length,
                       payments: S.payments.length, inventoryRows: Object.keys(S.inventory).length }
        });
      });
    });
  }
};

/* The database is the master record. The app's own shared blob is only a
   bridge to the warehouse device, and reloading from it must never remove a
   product, shop, supplier, area or warehouse the database still holds. */
var serverIds = {};   /* per master list: the ids the server had at the last sync (server mode only) */
ERP.mergeMasterFromDb = function (data) {
  /* On the server the database is the only copy. The old screens' lists were first filled from this browser's
     localStorage record, so MERGING would keep anything deleted on the server (and the next save would write it
     back for everyone) — replace them instead. Browser mode keeps the merge. */
  var server = FDB.driver === 'server';
  ['products', 'customers', 'suppliers', 'warehouses', 'regions'].forEach(function (name) {
    var GLOBAL = { products: 'PRODUCTS', customers: 'CUSTOMERS', suppliers: 'SUPPLIERS',
                   warehouses: 'WAREHOUSES', regions: 'REGIONS' }[name];
    var rows = (data && data[name]) || [];
    if (!rows.length || !global[GLOBAL]) return;
    if (server) {
      /* a record added on this page since the last sync (its save may still be waiting) is kept; one that was on
         the server at the last sync and is gone now was deleted there, and anything from before the first sync
         (the old localStorage copy) is dropped */
      var list = global[GLOBAL], known = serverIds[name], onServer = {};
      rows.forEach(function (rec) { onServer[rec.id] = true; });
      var addedHere = known ? list.filter(function (r) { return r && !onServer[r.id] && !known[r.id]; }) : [];
      list.length = 0;
      rows.forEach(function (rec) { list.push(rec); });
      addedHere.forEach(function (rec) { list.push(rec); });
      serverIds[name] = onServer;
      return;
    }
    var byId = {};
    global[GLOBAL].forEach(function (r) { byId[r.id] = r; });
    rows.forEach(function (rec) {
      if (byId[rec.id]) Object.assign(byId[rec.id], rec);   /* user edits kept */
      else global[GLOBAL].push(rec);
    });
  });
  if (!server || !data) return;
  if (Array.isArray(data.documents) && global.DOCS) {
    var onServerDocs = {}, knownDocs = serverIds.documents;
    data.documents.forEach(function (d) { onServerDocs[d.no] = true; });
    var docsHere = knownDocs ? global.DOCS.filter(function (d) { return d && !onServerDocs[d.no] && !knownDocs[d.no]; }) : [];
    serverIds.documents = onServerDocs;
    var allDocs = data.documents.concat(docsHere);
    global.DOCS = allDocs.slice().sort(function (a, b) {
      return (b.iso || '') < (a.iso || '') ? -1 : (b.iso || '') > (a.iso || '') ? 1 : (b.no || '') < (a.no || '') ? -1 : 1;
    });
    /* the Documents page's own audit list and number counter live only in this browser: keep only entries for
       documents that still exist, and number the next document after the highest one there is */
    var docNos = {}, top = {};
    allDocs.forEach(function (d) {
      docNos[d.no] = true;
      var m = /^([A-Z]+)-\d{4}-(\d+)$/.exec(d.no || '');
      if (m) top[m[1]] = Math.max(top[m[1]] || 0, +m[2]);
    });
    if (Array.isArray(global.AUDIT)) global.AUDIT = global.AUDIT.filter(function (a) { return a && docNos[a.doc]; });
    if (global.DOCSEQ && typeof global.DOCSEQ === 'object') {
      Object.keys(global.DOCSEQ).forEach(function (k) { global.DOCSEQ[k] = top[k] || 0; });
      Object.keys(top).forEach(function (k) { global.DOCSEQ[k] = top[k]; });
    }
  }
  /* new shops are numbered from a counter in this browser (SEQ.cust): never hand out a number already used */
  if (global.SEQ && global.CUSTOMERS) {
    var maxCust = 0;
    global.CUSTOMERS.forEach(function (c) { var m = /^CUST-(\d+)$/.exec(c.id || ''); if (m) maxCust = Math.max(maxCust, +m[1]); });
    if (!(global.SEQ.cust > maxCust)) global.SEQ.cust = maxCust + 1;
  }
  var legacy = {};
  (data.legacy || []).forEach(function (r) { if (r && r.k) legacy[r.k] = r.v; });
  [['activity', 'ACTIVITY'], ['log', 'LOG']].forEach(function (p) {
    if (Array.isArray(legacy[p[0]]) && global[p[1]]) global[p[1]] = legacy[p[0]];
  });
};
ERP.refreshMasterFromDb = function () {
  /* wait for this page's own queued saves, so a record just added here is not replaced by a copy without it */
  return Promise.resolve(ERP.flush()).catch(function () {}).then(function () { return FDB.hydrate(); }).then(function (d) {
    ERP.mergeMasterFromDb(d);
    return d;
  }).catch(function () { return null; });
};

/* Persist master-data and legacy-blob edits made by the original screens.
   Called from the patched dbSave(). Master records are only rewritten when
   their fingerprint changes, so a repaint does not push 600 rows at the
   database every time the user clicks a tab. */
var masterFingerprint = null;
ERP.persistMasterAndLegacy = function () {
  var fp = ['PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'WAREHOUSES', 'REGIONS'].map(function (k) {
    var a = global[k] || [];
    return k + ':' + a.length + ':' + (a.length ? JSON.stringify(a[a.length - 1]).length + ':' +
           JSON.stringify(a[0]).length : '0');
  }).join('|');
  var masterChanged = fp !== masterFingerprint;
  masterFingerprint = fp;

  return queue(function () {
    return FDB.tx(['products', 'customers', 'suppliers', 'warehouses', 'regions', 'legacy', 'documents', 'meta'],
      function (api) {
        if (masterChanged) {
          (global.PRODUCTS   || []).forEach(function (p) { api.put('products', p); });
          (global.CUSTOMERS  || []).forEach(function (c) { api.put('customers', c); });
          (global.SUPPLIERS  || []).forEach(function (s) { api.put('suppliers', s); });
          (global.WAREHOUSES || []).forEach(function (w) { api.put('warehouses', w); });
          (global.REGIONS    || []).forEach(function (r) { api.put('regions', r); });
        }
        [['orders', global.ORDERS], ['dispatch', global.DISPATCH], ['activity', global.ACTIVITY],
         ['users', global.USERS], ['rules', global.RULES], ['log', global.LOG], ['wa', global.WA],
         ['devices', global.DEVICES], ['seq', global.SEQ], ['docseq', global.DOCSEQ]]
          .forEach(function (pair) { if (pair[1] !== undefined) api.put('legacy', { k: pair[0], v: pair[1] }); });
        (global.DOCS || []).slice(0, 500).forEach(function (d) { api.put('documents', d); });
        api.put('meta', { k: 'lastSaveAt', v: nowISO() });
      });
  });
};
/* A change made inside a record (a price, a phone number) is not visible to
   the fingerprint, so the master tables are flushed in full whenever the
   user saves something through a panel. */
ERP.markMasterDirty = function () { masterFingerprint = null; };

global.ERP = ERP;
})(typeof window !== 'undefined' ? window : globalThis);
