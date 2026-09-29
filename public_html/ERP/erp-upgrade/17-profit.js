/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 17
   COST, MARGIN AND PROFIT
   What a bag actually cost — including the freight and labour to get it into
   the godown — against what it actually sold for, once discounts are taken
   off. Cost is fixed onto the sale line the day it is made, so a later price
   rise can never rewrite last month's profit.
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
function nowISO() { return new Date().toISOString(); }
function today() { return global.FC_TODAY ? global.FC_TODAY() : new Date().toISOString().slice(0, 10); }
function fmtDate(x) { return global.fmtDate ? global.fmtDate(x) : x; }
function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

/* ══════════════════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════════════════ */
var origDefaults = ERP.Settings.defaults;
ERP.Settings.defaults = function () {
  return Object.assign(origDefaults.call(ERP.Settings), {
    costingMethod: 'WEIGHTED_AVERAGE',
    profitCostBasis: 'LANDED',        /* LANDED | PURCHASE */
    lowMarginWarnPct: 5,
    allowSaleBelowCost: true,
    warnBelowMinPrice: true,
    showProfitToStaff: false
  });
};
['costingMethod', 'profitCostBasis', 'lowMarginWarnPct', 'allowSaleBelowCost',
 'warnBelowMinPrice', 'showProfitToStaff'].forEach(function (k) {
  if (ERP.S.business && ERP.S.business[k] === undefined) {
    ERP.S.business[k] = ERP.Settings.defaults()[k];
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   LANDED COST
   Freight, loading and other purchase charges belong on the bags, not in a
   separate bucket. They are spread across the lines in proportion to value,
   so an expensive line carries more of the transport than a cheap one.
   ══════════════════════════════════════════════════════════════════════════ */
var Cost = ERP.Cost = {
  basis: function () { return ERP.Settings.get().profitCostBasis || 'LANDED'; },

  /* returns [{itemId, goodsUnit, landedUnit, share}] for a purchase draft or record */
  /* `overallDiscount` = the one amount taken off the WHOLE purchase after the line discounts. It lowers what is owed, so it
     must lower what the bags cost too: it is spread over the lines by value, the same way the charges are (2026-09-26 it was
     left out — the bill fell but every bag still cost the full price, so profit looked too low). */
  allocate: function (lines, charges, overallDiscount) {
    var goods = M.sum(lines.map(function (l) { return Math.max(0, l.lineTotal); }));
    var extra = Math.max(0, charges || 0);
    var off = Math.max(0, overallDiscount || 0);
    return lines.map(function (l) {
      var qty = Number(l.quantity) || 0;
      var received = l.receivedQty === undefined ? qty : Number(l.receivedQty) || 0;
      var basis = received || qty;
      var discShare = goods > 0 ? Math.round(off * Math.max(0, l.lineTotal) / goods) : 0;
      var goodsUnit = basis ? Math.max(0, Math.round((l.lineTotal - discShare) / basis)) : l.unitPrice;
      var share = goods > 0 ? Math.round(extra * l.lineTotal / goods) : (lines.length ? Math.round(extra / lines.length) : 0);
      var landedUnit = basis ? goodsUnit + Math.round(share / basis) : goodsUnit;
      return { itemId: l.id, productId: l.productId, qty: basis,
               goodsUnit: goodsUnit, share: share, landedUnit: landedUnit };
    });
  },

  /* the weighted average cost of everything bought into a warehouse */
  weightedAverage: function (productId, warehouseId) {
    var qty = 0, value = 0, landed = Cost.basis() === 'LANDED';
    S.purchaseItems.forEach(function (it) {
      if (it.productId !== productId || it.warehouseId !== warehouseId) return;
      var pu = ERP.Purchases.byId(it.purchaseId);
      if (!pu || pu.status === 'CANCELLED') return;
      var q = it.receivedQty === undefined ? it.quantity : it.receivedQty;
      if (!q) return;
      var unit = landed && it.landedUnitCost ? it.landedUnitCost
               : (it.goodsUnitCost || (it.quantity ? Math.round(it.lineTotal / it.quantity) : it.unitPrice));
      qty += q; value += unit * q;
    });
    return qty ? Math.round(value / qty) : 0;
  },

  chargesOf: function (rec) {
    return (rec.freightAmount || 0) + (rec.loadingAmount || 0) + (rec.otherCharges || 0);
  },

  /* the figure a sale should be costed at */
  forSale: function (productId, warehouseId) {
    return ERP.Inventory.saleCostOf(productId, warehouseId);   /* stock cost + the product's extra cost per bag */
  },

  history: function (productId) {
    return (S.costHistory || []).filter(function (h) { return h.productId === productId; })
      .sort(function (a, b) { return a.effectiveDate < b.effectiveDate ? 1 : -1; });
  },
  record: function (api, o) {
    var rec = {
      id: FDB.uid('ch'), kind: o.kind || 'PURCHASE', productId: o.productId,
      supplierId: o.supplierId || null, supplierName: o.supplierName || '',
      purchaseId: o.purchaseId || null, purchaseNumber: o.purchaseNumber || '',
      warehouseId: o.warehouseId || '', effectiveDate: o.date || today(),
      previousCost: o.previousCost || 0, newCost: o.newCost || 0,
      goodsCost: o.goodsCost || 0, landedCost: o.landedCost || 0,
      quantity: o.quantity || 0, note: o.note || '',
      userId: global.CURRENT_USER || 'Owner', createdAt: nowISO()
    };
    api.put('costHistory', rec);
    (S.costHistory = S.costHistory || []).unshift(rec);
    return rec;
  }
};

/* ── purchases now cost their lines with the charges included ─────────────
   The moving average is updated from the landed figure, so the next sale is
   costed against what the bag really cost to have in the godown. ── */
var origPurchaseSave = ERP.Purchases.save;
ERP.Purchases.save = function (draft) {
  /* When an edit takes a product out of a purchase (or moves it to another
     warehouse), that product's average must stop counting this purchase —
     the loop below only re-costs the lines that are still on it. Taken
     before the save, because the save replaces the lines. */
  var before = draft && draft.id ? ERP.Purchases.byId(draft.id) : null;
  var wasOn = before ? ERP.Purchases.items(before.id).map(function (i) {
    return { productId: i.productId, warehouseId: i.warehouseId };
  }) : [];
  return origPurchaseSave.call(ERP.Purchases, draft).then(function (rec) {
    var items = ERP.Purchases.items(rec.id);
    var charges = Cost.chargesOf(rec);
    /* the overall discount = what is left of the purchase's discount after the discounts already inside each line */
    var overall = Math.max(0, (rec.discountAmount || 0) - M.sum(items.map(function (i) { return i.discount || 0; })));
    var alloc = Cost.allocate(items, charges, overall);
    var stillOn = {};
    items.forEach(function (i) { stillOn[i.productId + '|' + i.warehouseId] = true; });
    var dropped = wasOn.filter(function (k) { return !stillOn[k.productId + '|' + k.warehouseId]; });
    return FDB.tx(['purchaseItems', 'inventory', 'costHistory', 'auditLog'], function (api) {
      dropped.forEach(function (k) {
        var avg = Cost.weightedAverage(k.productId, k.warehouseId);
        if (!avg) return;
        var row = ERP.Inventory.row(k.productId, k.warehouseId);
        row.avgCostP = avg;
        api.put('inventory', row);
      });
      alloc.forEach(function (a) {
        var it = items.filter(function (x) { return x.id === a.itemId; })[0];
        if (!it) return;
        it.goodsUnitCost = a.goodsUnit;
        it.chargeShare = a.share;
        it.landedUnitCost = a.landedUnit;
        api.put('purchaseItems', it);
        if (!a.qty) return;
        var row = ERP.Inventory.row(it.productId, it.warehouseId);
        var previous = row.avgCostP;
        var useUnit = Cost.basis() === 'LANDED' ? a.landedUnit : a.goodsUnit;
        row.lastCostP = useUnit;
        /* 2026-09-28: this used to recompute the average from EVERY purchase this product has ever had
           (Cost.weightedAverage), overwriting the moving average Inventory.apply just blended from the raw
           unitPrice for the bags on THIS purchase — ignoring Add stock, bags already sold since, and any
           revalue from the product Prices screen. New purchases carry no charges/discount at all (removed
           from the screen), so useUnit === it.unitPrice and nothing below runs; only an OLD purchase kept
           from before that change can still differ, and here that difference is nudged onto the average for
           exactly the bags this purchase just added, not recomputed from history. */
        if (useUnit !== it.unitPrice && a.qty > 0 && row.qty > 0) {
          var deltaTotal = (useUnit - it.unitPrice) * a.qty;
          row.avgCostP = Math.max(0, Math.round(row.avgCostP + deltaTotal / row.qty));
        }
        api.put('inventory', row);
        Cost.record(api, {
          kind: 'PURCHASE', productId: it.productId, supplierId: rec.supplierId,
          supplierName: rec.supplierNameSnapshot, purchaseId: rec.id,
          purchaseNumber: rec.purchaseNumber, warehouseId: it.warehouseId,
          date: rec.purchaseDate, previousCost: previous, newCost: row.avgCostP,
          goodsCost: a.goodsUnit, landedCost: a.landedUnit, quantity: a.qty,
          note: charges ? 'Includes ' + M.fmt(a.share) + ' of freight and charges' : ''
        });
      });
      if (charges) {
        ERP.Audit.write(api, {
          action: 'Landed cost applied to purchase', entity: 'Purchase', entityId: rec.id,
          ref: rec.purchaseNumber, newValues: { charges: charges, lines: alloc.length }
        });
      }
    }).then(function () { ERP.Mirror.refresh(); return rec; });
  });
};

/* ══════════════════════════════════════════════════════════════════════════
   THE PROFIT ENGINE — one calculation, used by every screen
   ══════════════════════════════════════════════════════════════════════════ */
var Profit = ERP.Profit = {
  line: function (item) {
    var revenue = item.lineTotal;                       /* after discount */
    var cost = M.mul(item.costSnapshot || 0, item.quantity);
    var profit = revenue - cost;
    return {
      quantity: item.quantity, revenue: revenue, cost: cost, profit: profit,
      margin: revenue ? profit / revenue * 100 : 0,     /* of the sale */
      markup: cost ? profit / cost * 100 : 0            /* on the cost */
    };
  },
  invoice: function (invoiceId) {
    var inv = ERP.Invoices.byId(invoiceId);
    if (!inv) return null;
    var lines = ERP.Invoices.items(invoiceId).map(function (it) {
      return Object.assign({ item: it }, Profit.line(it));
    });
    var revenue = M.sum(lines.map(function (l) { return l.revenue; }));
    var cost = M.sum(lines.map(function (l) { return l.cost; }));
    /* invoice-level discount and charges move the invoice's own profit */
    var netRevenue = inv.grandTotal;
    var profit = netRevenue - cost;
    return {
      lines: lines, quantity: inv.totalQty, revenue: revenue, netRevenue: netRevenue,
      cost: cost, profit: profit,
      margin: netRevenue ? profit / netRevenue * 100 : 0,
      markup: cost ? profit / cost * 100 : 0
    };
  },
  /* what a line would earn at a rate being typed in, before it is saved */
  preview: function (productId, warehouseId, qty, rateR, discR) {
    var cost = Cost.forSale(productId, warehouseId);
    var rate = M.toP(rateR), disc = M.toP(discR);
    var q = Number(qty) || 0;
    var revenue = Math.max(0, M.mul(rate, q) - disc);
    var totalCost = M.mul(cost, q);
    var profit = revenue - totalCost;
    var p = global.prodOf ? global.prodOf(productId) : null;
    var minP = p && p.minSellP ? p.minSellP : (p && p.min ? M.toP(p.min) : 0);
    return {
      cost: cost, extra: cost ? ERP.Inventory.extraFor(productId, warehouseId) : 0,
      unitRevenue: q ? Math.round(revenue / q) : rate,
      revenue: revenue, totalCost: totalCost, profit: profit,
      margin: revenue ? profit / revenue * 100 : 0,
      markup: totalCost ? profit / totalCost * 100 : 0,
      belowCost: totalCost > 0 && revenue < totalCost,
      belowMin: !!(minP && q && Math.round(revenue / q) < minP),
      minPrice: minP, known: cost > 0
    };
  },

  /* returns take the profit back out again */
  returned: function (from, to) {
    var out = { revenue: 0, cost: 0, qty: 0 };
    S.custReturns.forEach(function (r) {
      if (r.status === 'CANCELLED') return;
      if (from && r.returnDate < from) return;
      if (to && r.returnDate > to) return;
      ERP.Returns.customerItems(r.id).forEach(function (ri) {
        var src = S.invoiceItems.filter(function (x) { return x.id === ri.invoiceItemId; })[0];
        out.revenue += ri.lineTotal;
        out.cost += M.mul(src ? (src.costSnapshot || 0) : 0, ri.quantity);
        out.qty += ri.quantity;
      });
    });
    return out;
  },

  /* the whole picture for a period, grouped whichever way is asked for */
  report: function (from, to, f) {
    f = f || {};
    var invoices = S.invoices.filter(function (i) {
      if (i.status === 'DRAFT' || i.status === 'CANCELLED') return false;
      if (from && i.invoiceDate < from) return false;
      if (to && i.invoiceDate > to) return false;
      if (f.customerId && i.customerId !== f.customerId) return false;
      if (f.regionId && i.regionId !== f.regionId) return false;
      if (f.warehouseId && i.warehouseId !== f.warehouseId) return false;
      if (f.salesmanId && ERP.Staff && ERP.Staff.forCustomer(i.customerId) !== f.salesmanId) return false;
      return true;
    });
    var groups = {};
    var totals = { revenue: 0, cost: 0, qty: 0, lines: 0, invoices: invoices.length };
    var key = f.by || 'product';

    invoices.forEach(function (i) {
      ERP.Invoices.items(i.id).forEach(function (it) {
        var p = global.prodOf ? global.prodOf(it.productId) : null;
        if (f.productId && it.productId !== f.productId) return;
        if (f.category && (!p || p.cat !== f.category)) return;
        if (f.brand && (!p || (p.brandEn || p.brand) !== f.brand)) return;
        var supplierId = ERP.Mapping ? ERP.Mapping.supplierOf(it.productId) : null;
        if (f.supplierId && supplierId !== f.supplierId) return;

        var pr = Profit.line(it);
        totals.revenue += pr.revenue; totals.cost += pr.cost;
        totals.qty += pr.quantity; totals.lines++;

        var k, label, sub;
        if (key === 'product') { k = it.productId; label = it.descriptionEnSnapshot || it.descriptionSnapshot; sub = it.descriptionSnapshot; }
        else if (key === 'category') { k = (p && p.cat) || 'Uncategorised'; label = k; }
        else if (key === 'brand') { k = (p && (p.brandEn || p.brand)) || 'No brand'; label = k; }
        else if (key === 'supplier') {
          k = supplierId || 'none';
          label = supplierId && global.supOf(supplierId) ? global.supOf(supplierId).co : 'Not mapped to a mill';
        }
        else if (key === 'region') { k = i.regionId || 'none'; label = i.regionSnapshot || 'No region'; }
        else if (key === 'customer') { k = i.customerId; label = i.shopNameSnapshot; sub = i.regionSnapshot; }
        else if (key === 'salesman') {
          k = (ERP.Staff && ERP.Staff.forCustomer(i.customerId)) || 'none';
          label = k !== 'none' && ERP.Staff.byId(k) ? ERP.Staff.byId(k).name : 'No salesman assigned';
        }
        else if (key === 'warehouse') { k = i.warehouseId; label = i.warehouseSnapshot; }
        else { k = 'all'; label = 'All sales'; }

        var g = groups[k] = groups[k] || { key: k, label: label, sub: sub || '',
          qty: 0, revenue: 0, cost: 0, lines: 0, invoices: {} };
        g.qty += pr.quantity; g.revenue += pr.revenue; g.cost += pr.cost; g.lines++;
        g.invoices[i.id] = 1;
      });
    });

    var rows = Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.profit = g.revenue - g.cost;
      g.margin = g.revenue ? g.profit / g.revenue * 100 : 0;
      g.markup = g.cost ? g.profit / g.cost * 100 : 0;
      g.invoiceCount = Object.keys(g.invoices).length;
      delete g.invoices;
      return g;
    });
    var sort = f.sort || 'profit';
    rows.sort(function (a, b) {
      if (sort === 'margin') return b.margin - a.margin;
      if (sort === 'lowmargin') return a.margin - b.margin;
      if (sort === 'revenue') return b.revenue - a.revenue;
      if (sort === 'qty') return b.qty - a.qty;
      if (sort === 'lowprofit') return a.profit - b.profit;
      return b.profit - a.profit;
    });

    var ret = Profit.returned(from, to);
    totals.profit = totals.revenue - totals.cost;
    totals.margin = totals.revenue ? totals.profit / totals.revenue * 100 : 0;
    totals.markup = totals.cost ? totals.profit / totals.cost * 100 : 0;
    totals.returnedRevenue = ret.revenue; totals.returnedCost = ret.cost; totals.returnedQty = ret.qty;
    totals.netRevenue = totals.revenue - ret.revenue;
    totals.netCost = totals.cost - ret.cost;
    totals.netProfit = totals.netRevenue - totals.netCost;
    totals.netMargin = totals.netRevenue ? totals.netProfit / totals.netRevenue * 100 : 0;

    /* gross profit is not net profit — expenses come off separately */
    var expenses = (S.expenses || []).filter(function (e) {
      return (!from || e.expenseDate >= from) && (!to || e.expenseDate <= to);
    });
    totals.expenses = M.sum(expenses.map(function (e) { return e.amount; }));
    /* salaries handed out through Payroll (30) are a business cost too; counted on the day they were paid, like expenses.
       Staff are paid from Payroll, NOT entered again as an expense — that would count them twice. */
    totals.salaries = ERP.Payroll && ERP.Payroll.paidInRange ? ERP.Payroll.paidInRange(from, to) : 0;
    totals.netAfterExpenses = totals.netProfit - totals.expenses - totals.salaries;

    var purchases = S.purchases.filter(function (p) {
      return (!from || p.purchaseDate >= from) && (!to || p.purchaseDate <= to) &&
             (!f.supplierId || p.supplierId === f.supplierId);
    });
    totals.purchases = M.sum(purchases.map(function (p) { return p.grandTotal; }));

    return { from: from, to: to, by: key, rows: rows, totals: totals, invoices: invoices };
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   THE WARNING WHILE A RATE IS TYPED
   ══════════════════════════════════════════════════════════════════════════ */
var WARN_CSS = `
.fcp-warn{margin-top:6px;font-size:12px;border-radius:var(--r-sm);padding:5px 8px;line-height:1.4}
.fcp-warn.ok{background:var(--green-50);color:var(--green)}
.fcp-warn.low{background:var(--ochre-50);color:var(--ochre)}
.fcp-warn.bad{background:var(--clay-50);color:var(--clay)}
.fcp-warn b{font-weight:700}
.fcp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.fcp-card{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:12px 13px}
.fcp-card i{font-style:normal;display:block;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.fcp-card b{display:block;font-size:19px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}
.fcp-card.profit b{color:var(--green)} .fcp-card.loss b{color:var(--clay)}
.fcp-card .d{font-size:11.5px;color:var(--muted);margin-top:2px}
.fcp-locked{padding:26px;text-align:center;color:var(--muted)}
`;
(function () { var s = D.createElement('style'); s.id = 'fc-profit-css'; s.textContent = WARN_CSS; D.head.appendChild(s); })();

function marginNote(ix) {
  var B = ERP.Builder;
  if (!B || !B.draft || B.cfg.party !== 'customer' || !B.cfg.rates) return '';
  if (!ERP.Can || !ERP.Can('PROFIT_VIEW')) return '';
  var it = B.draft.items[ix];
  if (!it || !it.productId) return '';
  var wid = it.warehouseId || B.draft.warehouseId;
  var p = ERP.Profit.preview(it.productId, wid, it.quantity, it.unitPrice, it.discount);
  if (!p.known) return '<div class="fcp-warn low">No purchase cost recorded yet for this product — profit cannot be shown.</div>';
  if (!Number(it.quantity) || !M.toP(it.unitPrice)) return '';
  var warnPct = Number(ERP.Settings.get().lowMarginWarnPct || 5);
  var cls = p.belowCost ? 'bad' : (p.margin < warnPct ? 'low' : 'ok');
  var costTxt = M.fmt(p.cost) + (p.extra ? ' (stock ' + M.fmt(p.cost - p.extra) + ' + extra ' + M.fmt(p.extra) + ')' : '');
  var msg = 'Cost <b>' + costTxt + '</b>/bag · profit <b>' + M.fmt(p.profit) +
    '</b> · margin <b>' + pct(p.margin) + '</b> · markup ' + pct(p.markup);
  if (p.belowCost) {
    msg = '<b>Below cost.</b> Cost ' + costTxt + '/bag against ' + M.fmt(p.unitRevenue) +
      ' — a loss of ' + M.fmt(Math.abs(p.profit)) + ' on this line.';
  } else if (p.belowMin && ERP.Settings.get().warnBelowMinPrice) {
    msg = '<b>Below the minimum price</b> of ' + M.fmt(p.minPrice) + '/bag. ' + msg;
  } else if (p.margin < warnPct) {
    msg = '<b>Low margin.</b> ' + msg;
  }
  return '<div class="fcp-warn ' + cls + '">' + msg + '</div>';
}
ERP.marginNote = marginNote;

/* the note is drawn under the amount cell as the rate is typed */
var origRefresh = null;
function hookBuilder() {
  if (origRefresh || !ERP.BuilderUI) return;
  origRefresh = ERP.BuilderUI.refreshTotals;
  ERP.BuilderUI.refreshTotals = function () {
    origRefresh.apply(ERP.BuilderUI, arguments);
    try {
      var B = ERP.Builder;
      if (!B || !B.draft) return;
      B.draft.items.forEach(function (it, ix) {
        var cell = D.querySelector('[data-fcamt="' + ix + '"]');
        if (!cell || !cell.parentNode) return;
        var td = cell.parentNode;
        var old = td.querySelector('.fcp-warn');
        var html = marginNote(ix);
        if (old) old.remove();
        if (html) td.insertAdjacentHTML('beforeend', html);
      });
    } catch (e) {}
  };
}
hookBuilder();
var origPaint = global.paint;
global.paint = function () {
  origPaint.apply(global, arguments);
  try {
    hookBuilder();
    if (global.cur === 'invoiceBuilder' && ERP.BuilderUI) ERP.BuilderUI.refreshTotals();
  } catch (e) {}
};

/* ══════════════════════════════════════════════════════════════════════════
   SETTINGS PANEL
   ══════════════════════════════════════════════════════════════════════════ */
var origSettingsPage = global.PAGES.settings;
global.PAGES.settings = function () {
  var b = ERP.Settings.get();
  var sel = function (key, label, opts, hint) {
    return '<label class="f"><span>' + label + '</span><select data-fcprofit="' + key + '">' +
      opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (String(b[key]) === String(o[0]) ? ' selected' : '') +
          '>' + o[1] + '</option>';
      }).join('') + '</select>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>';
  };
  return origSettingsPage() +
    '<div class="card"><div class="card-h"><h3>Sales &amp; profit</h3>' +
      '<span class="pill neu">How cost and margin are worked out</span></div><div class="card-b">' +
      '<div class="fcset-grid">' +
        sel('costingMethod', 'Costing method', [['WEIGHTED_AVERAGE', 'Weighted average cost']],
            'Each warehouse keeps its own average as stock arrives.') +
        sel('profitCostBasis', 'Profit cost basis',
            [['LANDED', 'Landed cost — goods plus freight and labour'], ['PURCHASE', 'Purchase price only']],
            'Landed cost is the true cost of having the bag in the godown.') +
        '<label class="f"><span>Warn below this margin (%)</span>' +
          '<input data-fcprofit="lowMarginWarnPct" inputmode="decimal" value="' +
          esc(b.lowMarginWarnPct) + '"></label>' +
        sel('warnBelowMinPrice', 'Minimum price warning', [['true', 'Warn'], ['false', 'Do not warn']]) +
        sel('showProfitToStaff', 'Show profit to sales staff', [['false', 'No — owner and accounts only'], ['true', 'Yes']]) +
      '</div></div></div>';
};
D.addEventListener('change', function (e) {
  var el = e.target;
  if (!el.dataset || el.dataset.fcprofit === undefined) return;
  var k = el.dataset.fcprofit, v = el.value;
  if (v === 'true' || v === 'false') v = v === 'true';
  else if (k === 'lowMarginWarnPct') v = Number(String(v).replace(/[^\d.]/g, '')) || 0;
  var patch = {}; patch[k] = v;
  ERP.Settings.save(patch).then(function () { global.paint(); global.say && global.say('Saved.'); });
});
D.addEventListener('input', function (e) {
  var el = e.target;
  if (el.dataset && el.dataset.fcprofit === 'lowMarginWarnPct') {
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      ERP.Settings.save({ lowMarginWarnPct: Number(String(el.value).replace(/[^\d.]/g, '')) || 0 });
    }, 600);
  }
});

/* cost history loads with everything else */
(ERP.bootPromise || Promise.resolve()).then(function () {
  return FDB.hydrate().then(function (d) {
    S.costHistory = (d.costHistory || []).sort(function (a, b) {
      return a.effectiveDate < b.effectiveDate ? 1 : -1;
    });
  });
}).catch(function () { S.costHistory = S.costHistory || []; });

ERP.pctText = pct;
})(typeof window !== 'undefined' ? window : globalThis);
