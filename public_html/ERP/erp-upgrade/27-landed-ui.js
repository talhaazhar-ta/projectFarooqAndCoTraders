/* ══════════════════════════════════════════════════════════════════════════
   FINANCE — Landed Costs · Expenses · Profit Analysis

   The screens for the landed cost engine in module 26, plus the profit
   reporting the business asked for. Nothing here writes to a supplier.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var ERP = global.ERP; if (!ERP) return;
  var M = global.Money, S = ERP.S, D = global.document;
  if (!M || !S || !ERP.Landed) return;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function I(n) { return global.I ? global.I(n) : ''; }
  function say(m) { try { global.say(m); } catch (e) {} }
  function fmtDate(d) { return global.fmtDate ? global.fmtDate(d) : d; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function can(p) { return ERP.Can ? ERP.Can(p) : true; }

  /* ════════════════════════════════════════════════════════════════════════
     PERMISSIONS
     Posting a landed cost changes what every sale appears to earn, so it sits
     with the owner and the manager. The accountant can see it but not post.
     ════════════════════════════════════════════════════════════════════════ */
  try {
    var R = ERP.RBAC.roles;
    if (R.MANAGER && R.MANAGER.perms.indexOf('LANDED_COST_MANAGE') === -1) {
      R.MANAGER.perms.push('LANDED_COST_MANAGE', 'EXPENSE_MANAGE');
    }
    if (R.ACCOUNTANT && R.ACCOUNTANT.perms.indexOf('LANDED_COST_VIEW') === -1) {
      R.ACCOUNTANT.perms.push('LANDED_COST_VIEW', 'EXPENSE_MANAGE');
    }
  } catch (e) {}
  function canManage() { return can('LANDED_COST_MANAGE'); }
  function canView() { return canManage() || can('LANDED_COST_VIEW') || can('FINANCIAL_REPORT_VIEW'); }

  function locked(what) {
    return '<div class="empty"><div class="ei">' + I('lock') + '</div>' +
      '<b>' + esc(what) + ' is not open to you</b>' +
      '<p>Ask the owner or a manager.</p></div>';
  }

  /* ════════════════════════════════════════════════════════════════════════
     DRAFT STATE for the create form
     ════════════════════════════════════════════════════════════════════════ */
  var LC = {
    purchaseId: '', date: today(), notes: '', description: '',
    rows: [{ category: 'Transportation', amount: '', vendorName: '', description: '', paymentStatus: 'UNPAID' }],
    q: '', open: ''
  };
  function blankRow() {
    return { category: ERP.Landed.categories()[0], amount: '', vendorName: '',
             description: '', paymentStatus: 'UNPAID' };
  }
  function draftTotal() {
    return LC.rows.reduce(function (a, r) { return a + M.toP(r.amount || 0); }, 0);
  }

  /* ════════════════════════════════════════════════════════════════════════
     LANDED COSTS PAGE
     ════════════════════════════════════════════════════════════════════════ */
  function purchaseOptions() {
    var list = (S.purchases || []).filter(function (p) { return p.status !== 'CANCELLED'; })
      .sort(function (a, b) { return a.purchaseDate < b.purchaseDate ? 1 : -1; }).slice(0, 200);
    return '<option value="">Choose a purchase…</option>' + list.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (LC.purchaseId === p.id ? ' selected' : '') + '>' +
        esc(p.purchaseNumber) + ' — ' + esc(p.supplierNameSnapshot || '') + ' — ' +
        M.fmt(p.grandTotal) + ' — ' + esc(fmtDate(p.purchaseDate)) + '</option>';
    }).join('');
  }

  function expenseRows() {
    var cats = ERP.Landed.categories();
    return LC.rows.map(function (r, i) {
      return '<tr>' +
        '<td data-label="Category"><select data-lcr="category" data-i="' + i + '">' +
          cats.map(function (c) {
            return '<option' + (r.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') + '</select></td>' +
        '<td data-label="Description"><input data-lcr="description" data-i="' + i + '" value="' +
          esc(r.description) + '" placeholder="Optional"></td>' +
        '<td data-label="Paid to"><input data-lcr="vendorName" data-i="' + i + '" value="' +
          esc(r.vendorName) + '" placeholder="Who was paid"></td>' +
        '<td data-label="Status"><select data-lcr="paymentStatus" data-i="' + i + '">' +
          ['UNPAID', 'PAID'].map(function (p) {
            return '<option value="' + p + '"' + (r.paymentStatus === p ? ' selected' : '') + '>' +
              (p === 'PAID' ? 'Paid' : 'Unpaid') + '</option>';
          }).join('') + '</select></td>' +
        '<td data-label="Amount" class="r"><input class="lc-amt" data-lcr="amount" data-i="' + i +
          '" inputmode="decimal" value="' + esc(r.amount) + '" placeholder="0"></td>' +
        '<td class="r">' + (LC.rows.length > 1
          ? '<button class="ic" data-lcdel="' + i + '" title="Remove">' + I('x') + '</button>' : '') + '</td>' +
      '</tr>';
    }).join('');
  }

  /* the live sum, shown before anything is saved */
  function previewCard() {
    var pu = LC.purchaseId ? ERP.Purchases.byId(LC.purchaseId) : null;
    if (!pu) {
      return '<div class="card"><div class="card-b"><p class="hint">' +
        'Choose a purchase to see how the cost lands on each bag.</p></div></div>';
    }
    var b = ERP.Landed.breakdown(LC.purchaseId);
    var extra = draftTotal();
    var newTotal = b.totalInventoryCost + extra;
    var perUnit = b.quantity ? Math.round(newTotal / b.quantity) : 0;
    function line(l, v, cls) {
      return '<div class="lc-line' + (cls ? ' ' + cls : '') + '"><span>' + esc(l) + '</span><b>' + v + '</b></div>';
    }
    return '<div class="card lc-prev"><div class="card-h"><h3>What this does to the cost</h3>' +
        '<span class="pill neu">' + esc(b.quantity.toLocaleString('en-US')) + ' units</span></div>' +
      '<div class="card-b">' +
        line('Supplier cost (goods)', M.fmt(b.goodsValue)) +
        (b.supplierCharges ? line('Charges on the supplier bill', M.fmt(b.supplierCharges)) : '') +
        (b.operationalCost ? line('Operational cost already added', M.fmt(b.operationalCost)) : '') +
        line('Operational cost being added now', M.fmt(extra), 'lc-new') +
        line('Final inventory cost', M.fmt(newTotal), 'lc-tot') +
        line('Cost per unit', M.fmt(perUnit), 'lc-tot') +
        '<div class="lc-note">' + I('lock') +
          ' The supplier is owed <b>' + M.fmt(b.supplierPayable) + '</b> and that does not change.' +
        '</div>' +
      '</div></div>';
  }

  function historyRows() {
    var q = LC.q.trim().toLowerCase();
    var list = ERP.Landed.all().filter(function (r) {
      if (!q) return true;
      return (r.referenceNumber + ' ' + (r.purchaseNumber || '') + ' ' + (r.notes || ''))
        .toLowerCase().indexOf(q) > -1;
    });
    if (!list.length) return '<tr><td colspan="7" class="hint">No landed costs recorded yet.</td></tr>';
    return list.map(function (r) {
      var exp = ERP.Landed.expensesOf(r.id);
      var cancelled = r.status === 'CANCELLED';
      return '<tr class="' + (cancelled ? 'lc-cancelled' : '') + '">' +
        '<td data-label="Reference" class="mono">' + esc(r.referenceNumber) + '</td>' +
        '<td data-label="Date">' + esc(fmtDate(r.costDate)) + '</td>' +
        '<td data-label="Purchase" class="mono">' + esc(r.purchaseNumber || '—') + '</td>' +
        '<td data-label="Expenses">' + exp.length + ' — ' +
          esc(exp.map(function (e) { return e.category; }).filter(function (v, i, a) {
            return a.indexOf(v) === i; }).join(', ')) + '</td>' +
        '<td data-label="Total" class="r"><b>' + M.fmt(r.totalAmount) + '</b></td>' +
        '<td data-label="Status">' + (cancelled
          ? '<span class="pill bad">Cancelled</span>' : '<span class="pill ok">Posted</span>') + '</td>' +
        '<td class="r">' +
          '<button class="btn sm" data-lcview="' + esc(r.id) + '">View</button>' +
          (!cancelled && canManage()
            ? ' <button class="btn sm" data-lccancel="' + esc(r.id) + '">Cancel</button>' : '') +
        '</td></tr>';
    }).join('');
  }

  function detailCard() {
    var r = LC.open ? ERP.Landed.byId(LC.open) : null;
    if (!r) return '';
    var exp = ERP.Landed.expensesOf(r.id);
    var adjs = ERP.Landed.adjustmentsOf(r.id);
    return '<div class="card"><div class="card-h"><h3>' + esc(r.referenceNumber) + '</h3>' +
        '<button class="btn sm" data-lcclose>Close</button></div><div class="card-b">' +
      '<table class="tbl"><thead><tr><th>Category</th><th>Description</th><th>Paid to</th>' +
        '<th>Status</th><th class="r">Amount</th></tr></thead><tbody>' +
        exp.map(function (e) {
          return '<tr><td>' + esc(e.category) + '</td><td>' + esc(e.description || '—') + '</td>' +
            '<td>' + esc(e.vendorName || '—') + '</td>' +
            '<td>' + (e.paymentStatus === 'PAID' ? 'Paid' : 'Unpaid') + '</td>' +
            '<td class="r">' + M.fmt(e.amountP) + '</td></tr>';
        }).join('') +
        '<tr><td colspan="4"><b>Total</b></td><td class="r"><b>' + M.fmt(r.totalAmount) +
        '</b></td></tr></tbody></table>' +
      '<h4 class="st-h">How it landed on the stock</h4>' +
      '<table class="tbl"><thead><tr><th>Product</th><th class="r">Qty</th>' +
        '<th class="r">Purchase cost</th><th class="r">Added</th><th class="r">Landed cost</th>' +
        '</tr></thead><tbody>' +
        (adjs.length ? adjs.map(function (a) {
          var p = global.prodOf && global.prodOf(a.productId);
          return '<tr><td>' + esc(p ? (p.en || p.ur) : a.productId) + '</td>' +
            '<td class="r">' + Number(a.quantity).toLocaleString('en-US') + '</td>' +
            '<td class="r">' + M.fmt(a.purchaseCost) + '</td>' +
            '<td class="r">' + M.fmt(a.quantity ? Math.round(a.additionalCost / a.quantity) : 0) + '</td>' +
            '<td class="r"><b>' + M.fmt(a.landedCost) + '</b></td></tr>';
        }).join('') : '<tr><td colspan="5" class="hint">No allocation recorded.</td></tr>') +
      '</tbody></table>' +
      (r.notes ? '<p class="hint">' + esc(r.notes) + '</p>' : '') +
      (r.status === 'CANCELLED'
        ? '<p class="hint">Cancelled by ' + esc(r.cancelledBy || '') + ' — ' +
          esc(r.cancelReason || 'no reason given') + '</p>' : '') +
      '</div></div>';
  }

  global.PAGES.landed = function () {
    if (!canView()) return locked('Landed costs');
    var manage = canManage();
    return '<div class="lc-page">' +
      (manage ? '<div class="card"><div class="card-h"><h3>Add operational cost</h3>' +
        '<span class="pill neu">Never reaches the supplier</span></div><div class="card-b">' +
        '<div class="f2">' +
          '<label class="f"><span>Purchase</span><select data-lcf="purchaseId">' +
            purchaseOptions() + '</select></label>' +
          '<label class="f"><span>Date</span><input type="date" data-lcf="date" value="' +
            esc(LC.date) + '"></label>' +
        '</div>' +
        '<div class="lc-tablewrap"><table class="tbl lc-rows"><thead><tr>' +
          '<th>Category</th><th>Description</th><th>Paid to</th><th>Status</th>' +
          '<th class="r">Amount</th><th></th></tr></thead>' +
          '<tbody>' + expenseRows() + '</tbody>' +
          '<tfoot><tr><td colspan="4"><b>Total additional cost</b></td>' +
            '<td class="r"><b id="lcTotal">' + M.fmt(draftTotal()) + '</b></td><td></td></tr></tfoot>' +
        '</table></div>' +
        '<button class="btn" data-lcadd>' + I('plus') + 'Add another expense</button>' +
        '<label class="f"><span>Note</span><input data-lcf="notes" value="' + esc(LC.notes) +
          '" placeholder="Optional — why these costs were incurred"></label>' +
        '<div class="bar"><div class="grow"></div>' +
          '<button class="btn pri" data-lcsave>Post landed cost</button></div>' +
      '</div></div>' : '') +
      previewCard() +
      detailCard() +
      '<div class="card"><div class="card-h"><h3>Landed costs</h3>' +
        '<div class="tsearch">' + I('search') +
        '<input placeholder="Search reference or purchase…" data-lcq value="' + esc(LC.q) + '"></div>' +
      '</div><div class="card-b">' +
        '<table class="tbl"><thead><tr><th>Reference</th><th>Date</th><th>Purchase</th>' +
          '<th>Expenses</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>' +
          '<tbody>' + historyRows() + '</tbody></table>' +
      '</div></div>' +
    '</div>';
  };

  /* ════════════════════════════════════════════════════════════════════════
     PROFIT ANALYSIS
     ════════════════════════════════════════════════════════════════════════ */
  var PA = { from: '', to: '', tab: 'product' };

  /* Sold quantity and revenue come from invoice lines; cost comes from the
     snapshot taken at the time of sale, which is the landed figure. The
     purchase-cost column is the goods-only average, so the difference between
     the two columns is exactly what the operational expenses added. */
  function productProfit() {
    var from = PA.from, to = PA.to, map = {};
    (S.invoices || []).forEach(function (inv) {
      if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') return;
      if (from && inv.invoiceDate < from) return;
      if (to && inv.invoiceDate > to) return;
      ERP.Invoices.items(inv.id).forEach(function (it) {
        var k = it.productId;
        if (!map[k]) {
          var p = global.prodOf && global.prodOf(it.productId);
          map[k] = { productId: k, name: p ? (p.en || p.ur) : k,
                     qty: 0, revenue: 0, landedCost: 0, purchaseCost: 0, extraCost: 0 };
        }
        var r = map[k];
        r.qty += it.quantity;
        r.revenue += it.lineTotal || 0;
        r.landedCost += M.mul(it.costSnapshot || 0, it.quantity);
        /* "Purchase cost" / "Additional" here are the Landed-costs screen's own goods-vs-operational split
           (goodsAverage, unchanged) — a different axis from the client's product-level "Extra cost per bag"
           (§26), which is tracked separately below as extraCost so it can be shown without disturbing this
           existing, tested breakdown. */
        r.purchaseCost += M.mul(goodsAverage(it.productId, it.warehouseId), it.quantity);
        r.extraCost += M.mul(typeof it.costExtraSnapshot === 'number' ? it.costExtraSnapshot : 0, it.quantity);
      });
    });
    return Object.keys(map).map(function (k) {
      var r = map[k];
      r.additional = Math.max(0, r.landedCost - r.purchaseCost);
      r.profit = r.revenue - r.landedCost;
      r.perUnit = r.qty ? Math.round(r.profit / r.qty) : 0;
      r.costPerUnit = r.qty ? Math.round(r.landedCost / r.qty) : 0;
      r.purchasePerUnit = r.qty ? Math.round(r.purchaseCost / r.qty) : 0;
      r.extraPerUnit = r.qty ? Math.round(r.extraCost / r.qty) : 0;
      r.sellPerUnit = r.qty ? Math.round(r.revenue / r.qty) : 0;
      r.margin = r.revenue ? Math.round(r.profit / r.revenue * 1000) / 10 : 0;
      return r;
    }).sort(function (a, b) { return b.profit - a.profit; });
  }

  /* the goods-only average, for the comparison column */
  function goodsAverage(productId, warehouseId) {
    var qty = 0, value = 0;
    (S.purchaseItems || []).forEach(function (it) {
      if (it.productId !== productId) return;
      if (warehouseId && it.warehouseId !== warehouseId) return;
      var pu = ERP.Purchases.byId(it.purchaseId);
      if (!pu || pu.status === 'CANCELLED') return;
      var q = it.receivedQty === undefined ? it.quantity : it.receivedQty;
      if (!q) return;
      var unit = it.goodsUnitCost || (it.quantity ? Math.round(it.lineTotal / it.quantity) : it.unitPrice);
      qty += q; value += unit * q;
    });
    return qty ? Math.round(value / qty) : 0;
  }

  /* Shipment / area view: grouped by the warehouse the stock was sold from,
     which is how this business thinks about Chitral, Dir and the main godown. */
  function warehouseProfit() {
    var from = PA.from, to = PA.to, map = {};
    function row(wid) {
      if (!map[wid]) {
        var wh = (global.WAREHOUSES || []).filter(function (x) { return x.id === wid; })[0];
        map[wid] = { id: wid, name: wh ? (wh.en || wh.ur || wh.name || wid) : wid,
                     qty: 0, revenue: 0, cost: 0, purchaseValue: 0, operational: 0 };
      }
      return map[wid];
    }
    (S.invoices || []).forEach(function (inv) {
      if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') return;
      if (from && inv.invoiceDate < from) return;
      if (to && inv.invoiceDate > to) return;
      ERP.Invoices.items(inv.id).forEach(function (it) {
        var r = row(it.warehouseId || inv.warehouseId);
        r.qty += it.quantity;
        r.revenue += it.lineTotal || 0;
        r.cost += M.mul(it.costSnapshot || 0, it.quantity);
      });
    });
    /* what was bought into each warehouse, and what was spent moving it */
    (S.purchaseItems || []).forEach(function (it) {
      var pu = ERP.Purchases.byId(it.purchaseId);
      if (!pu || pu.status === 'CANCELLED') return;
      if (from && pu.purchaseDate < from) return;
      if (to && pu.purchaseDate > to) return;
      var r = row(it.warehouseId);
      r.purchaseValue += it.lineTotal || 0;
      r.operational += ERP.Landed.extraForItem(it.id);
    });
    return Object.keys(map).map(function (k) {
      var r = map[k];
      r.profit = r.revenue - r.cost;
      r.margin = r.revenue ? Math.round(r.profit / r.revenue * 1000) / 10 : 0;
      return r;
    }).sort(function (a, b) { return b.revenue - a.revenue; });
  }

  function money(p) { return M.fmt(p); }

  function productTable() {
    var rows = productProfit();
    if (!rows.length) return '<p class="hint">No sales in this period.</p>';
    var t = rows.reduce(function (a, r) {
      a.revenue += r.revenue; a.cost += r.landedCost; a.profit += r.profit;
      a.additional += r.additional; return a;
    }, { revenue: 0, cost: 0, profit: 0, additional: 0 });
    return '<div class="lc-tablewrap"><table class="tbl"><thead><tr>' +
      '<th>Product</th><th class="r">Qty sold</th><th class="r">Purchase cost</th>' +
      '<th class="r">Additional</th><th class="r">Landed cost</th><th class="r">Selling price</th>' +
      '<th class="r">Profit / unit</th><th class="r">Total profit</th><th class="r">Margin</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td data-label="Product">' + esc(r.name) + '</td>' +
          '<td data-label="Qty" class="r">' + r.qty.toLocaleString('en-US') + '</td>' +
          '<td data-label="Purchase cost" class="r">' + money(r.purchasePerUnit) + '</td>' +
          '<td data-label="Additional" class="r">' +
            money(r.qty ? Math.round(r.additional / r.qty) : 0) + '</td>' +
          /* §26, 2026-09-28: a hover title spells out the client's own written sum — purchase + extra =
             total — without disturbing this table's existing columns or their tested meaning */
          '<td data-label="Landed cost" class="r"' + (r.extraPerUnit ? ' title="Purchase ' + money(r.purchasePerUnit) +
            ' + extra ' + money(r.extraPerUnit) + ' = ' + money(r.costPerUnit) + '"' : '') + '><b>' + money(r.costPerUnit) + '</b></td>' +
          '<td data-label="Selling" class="r">' + money(r.sellPerUnit) + '</td>' +
          '<td data-label="Profit/unit" class="r">' + money(r.perUnit) + '</td>' +
          '<td data-label="Total profit" class="r ' + (r.profit < 0 ? 'lc-neg' : '') + '"><b>' +
            money(r.profit) + '</b></td>' +
          '<td data-label="Margin" class="r">' + r.margin + '%</td>' +
        '</tr>';
      }).join('') +
      '</tbody><tfoot><tr><td colspan="7"><b>Total</b></td>' +
        '<td class="r"><b>' + money(t.profit) + '</b></td><td class="r">' +
        (t.revenue ? Math.round(t.profit / t.revenue * 1000) / 10 : 0) + '%</td></tr></tfoot>' +
      '</table></div>';
  }

  function warehouseTable() {
    var rows = warehouseProfit();
    if (!rows.length) return '<p class="hint">Nothing to show for this period.</p>';
    return '<div class="lc-tablewrap"><table class="tbl"><thead><tr>' +
      '<th>Warehouse / area</th><th class="r">Purchase value</th><th class="r">Operational cost</th>' +
      '<th class="r">Qty sold</th><th class="r">Sales revenue</th><th class="r">Cost of sales</th>' +
      '<th class="r">Profit</th><th class="r">Margin</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td data-label="Warehouse">' + esc(r.name) + '</td>' +
          '<td data-label="Purchase value" class="r">' + money(r.purchaseValue) + '</td>' +
          '<td data-label="Operational" class="r">' + money(r.operational) + '</td>' +
          '<td data-label="Qty sold" class="r">' + r.qty.toLocaleString('en-US') + '</td>' +
          '<td data-label="Revenue" class="r">' + money(r.revenue) + '</td>' +
          '<td data-label="Cost of sales" class="r">' + money(r.cost) + '</td>' +
          '<td data-label="Profit" class="r ' + (r.profit < 0 ? 'lc-neg' : '') + '"><b>' +
            money(r.profit) + '</b></td>' +
          '<td data-label="Margin" class="r">' + r.margin + '%</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* A profit screen already exists and owns this route, including its own
     wording when a role may not see profit. This adds the landed-cost view
     underneath it rather than replacing it. */
  var origProfitPage = global.PAGES.profit;
  global.PAGES.profit = function () {
    var base = origProfitPage ? origProfitPage.apply(this, arguments) : '';
    if (!can('PROFIT_VIEW')) return base || locked('Profit analysis');
    return base + landedAnalysis();
  };

  function landedAnalysis() {
    var basis = ERP.Cost.basis();
    return '<div class="card"><div class="card-h"><h3>Profit analysis</h3>' +
        '<span class="pill ' + (basis === 'LANDED' ? 'ok' : 'neu') + '">' +
        (basis === 'LANDED' ? 'Costed at landed cost' : 'Costed at purchase price only') + '</span>' +
      '</div><div class="card-b">' +
        (basis === 'LANDED' ? '' :
          '<p class="hint">Profit is being measured against the purchase price, so operational ' +
          'expenses are not included. Change this in Settings → Sales &amp; profit.</p>') +
        '<div class="bar">' +
          '<label class="f"><span>From</span><input type="date" data-paf="from" value="' + esc(PA.from) + '"></label>' +
          '<label class="f"><span>To</span><input type="date" data-paf="to" value="' + esc(PA.to) + '"></label>' +
          '<div class="grow"></div>' +
          '<button class="btn' + (PA.tab === 'product' ? ' pri' : '') + '" data-patab="product">By product</button>' +
          '<button class="btn' + (PA.tab === 'area' ? ' pri' : '') + '" data-patab="area">By warehouse / area</button>' +
        '</div>' +
        (PA.tab === 'product' ? productTable() : warehouseTable()) +
      '</div></div>';
  }

  /* ════════════════════════════════════════════════════════════════════════
     EXPENSES PAGE — the existing service, given a screen of its own
     ════════════════════════════════════════════════════════════════════════ */
  var EX = { category: '', amount: '', paidTo: '', note: '', date: today() };

  global.PAGES.expenses = function () {
    if (!can('EXPENSE_MANAGE') && !can('FINANCIAL_REPORT_VIEW')) return locked('Expenses');
    var list = (S.expenses || []).slice().sort(function (a, b) {
      return a.expenseDate < b.expenseDate ? 1 : -1;
    }).slice(0, 200);
    var total = list.reduce(function (a, e) { return a + e.amount; }, 0);
    return '<div class="card"><div class="card-h"><h3>Record an expense</h3>' +
        '<span class="pill neu">General running costs</span></div><div class="card-b">' +
      '<p class="hint">These are the running costs of the business. To put a cost on the ' +
        'bags themselves — transport from the mill, loading — use Landed costs instead.</p>' +
      '<div class="f2">' +
        '<label class="f"><span>Category</span><select data-exf="category">' +
          ERP.Expenses.categories.map(function (c) {
            return '<option' + (EX.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="f"><span>Amount</span><input data-exf="amount" inputmode="decimal" value="' +
          esc(EX.amount) + '"></label>' +
      '</div><div class="f2">' +
        '<label class="f"><span>Paid to</span><input data-exf="paidTo" value="' + esc(EX.paidTo) + '"></label>' +
        '<label class="f"><span>Date</span><input type="date" data-exf="date" value="' + esc(EX.date) + '"></label>' +
      '</div>' +
      '<label class="f"><span>Note</span><input data-exf="note" value="' + esc(EX.note) + '"></label>' +
      '<div class="bar"><div class="grow"></div><button class="btn pri" data-exsave>Record expense</button></div>' +
    '</div></div>' +
    '<div class="card"><div class="card-h"><h3>Recent expenses</h3>' +
      '<span class="pill neu">' + M.fmt(total) + ' shown</span></div><div class="card-b">' +
      '<table class="tbl"><thead><tr><th>Date</th><th>Reference</th><th>Category</th>' +
        '<th>Paid to</th><th>Note</th><th class="r">Amount</th></tr></thead><tbody>' +
        (list.length ? list.map(function (e) {
          return '<tr><td data-label="Date">' + esc(fmtDate(e.expenseDate)) + '</td>' +
            '<td data-label="Reference" class="mono">' + esc(e.expenseNumber || '—') + '</td>' +
            '<td data-label="Category">' + esc(e.category) + '</td>' +
            '<td data-label="Paid to">' + esc(e.paidTo || '—') + '</td>' +
            '<td data-label="Note">' + esc(e.note || '—') + '</td>' +
            '<td data-label="Amount" class="r">' + M.fmt(e.amount) + '</td></tr>';
        }).join('') : '<tr><td colspan="6" class="hint">No expenses recorded yet.</td></tr>') +
      '</tbody></table></div></div>';
  };

  /* ════════════════════════════════════════════════════════════════════════
     NAVIGATION — three entries under the existing Finance group
     ════════════════════════════════════════════════════════════════════════ */
  try {
    var NAV = global.NAV, GROUPS = global.NAVGROUPS;
    function addNav(id, label, iconName) {
      if (NAV.some(function (n) { return n.id === id; })) return;
      var at = NAV.map(function (n) { return n.id; }).indexOf('reports');
      NAV.splice(at < 0 ? NAV.length : at, 0, { id: id, l: label, i: iconName });
    }
    addNav('landed', 'Landed costs', 'truck');
    addNav('expenses', 'Expenses', 'wallet');
    addNav('profit', 'Profit analysis', 'chart');
    GROUPS.forEach(function (g) {
      if (g[0] !== 'Finance') return;
      ['landed', 'expenses', 'profit'].forEach(function (id) {
        if (g[1].indexOf(id) === -1) g[1].splice(g[1].indexOf('reports'), 0, id);
      });
    });
    if (global.PAGEMETA) {
      global.PAGEMETA.landed = ['Landed costs',
        'Transport, loading and other costs that belong on the bags — never on the supplier.'];
      global.PAGEMETA.expenses = ['Expenses', 'General running costs of the business.'];
      global.PAGEMETA.profit = ['Profit analysis', 'True profit after the cost of getting the stock in.'];
    }
  } catch (e) {}

  /* ════════════════════════════════════════════════════════════════════════
     HANDLERS
     ════════════════════════════════════════════════════════════════════════ */
  D.addEventListener('input', function (e) {
    var el = e.target; if (!el.dataset) return;
    if (el.dataset.lcr !== undefined) {
      var i = Number(el.dataset.i);
      if (LC.rows[i]) LC.rows[i][el.dataset.lcr] = el.value;
      var t = D.getElementById('lcTotal');
      if (t) t.textContent = M.fmt(draftTotal());
      return;
    }
    if (el.dataset.lcf !== undefined && el.dataset.lcf !== 'purchaseId') {
      LC[el.dataset.lcf] = el.value; return;
    }
    if (el.dataset.lcq !== undefined) { LC.q = el.value; global.paint(); return; }
    if (el.dataset.exf !== undefined) { EX[el.dataset.exf] = el.value; return; }
  });

  D.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset) return;
    if (el.dataset.lcf === 'purchaseId') { LC.purchaseId = el.value; global.paint(); return; }
    if (el.dataset.lcf !== undefined) { LC[el.dataset.lcf] = el.value; return; }
    if (el.dataset.lcr !== undefined) {
      var i = Number(el.dataset.i);
      if (LC.rows[i]) LC.rows[i][el.dataset.lcr] = el.value;
      return;
    }
    if (el.dataset.paf !== undefined) { PA[el.dataset.paf] = el.value; global.paint(); return; }
    if (el.dataset.exf !== undefined) { EX[el.dataset.exf] = el.value; return; }
  });

  D.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var t;

    if ((t = e.target.closest('[data-lcadd]'))) {
      e.preventDefault(); LC.rows.push(blankRow()); global.paint(); return;
    }
    if ((t = e.target.closest('[data-lcdel]'))) {
      e.preventDefault();
      LC.rows.splice(Number(t.dataset.lcdel), 1);
      if (!LC.rows.length) LC.rows = [blankRow()];
      global.paint(); return;
    }
    if ((t = e.target.closest('[data-lcview]'))) {
      e.preventDefault(); LC.open = t.dataset.lcview; global.paint(); return;
    }
    if (e.target.closest('[data-lcclose]')) {
      e.preventDefault(); LC.open = ''; global.paint(); return;
    }
    if ((t = e.target.closest('[data-lccancel]'))) {
      e.preventDefault();
      var id = t.dataset.lccancel;
      ERP.UI.prompt('Cancel this landed cost?', {
        detail: 'The stock cost is put back the way it was. The reason is kept in the audit log.',
        label: 'Reason', placeholder: 'Why is this being cancelled?',
        okText: 'Cancel it', cancelText: 'Keep it', tone: 'danger'
      }).then(function (why) {
        if (why === null) return;
        return ERP.Landed.cancel(id, why || 'No reason given')
          .then(function () { say('Landed cost cancelled and the stock cost put back.'); })
          .catch(function (err) { say((err && err.validation && err.validation[0]) || 'Could not cancel that.'); });
      });
      return;
    }
    if ((t = e.target.closest('[data-patab]'))) {
      e.preventDefault(); PA.tab = t.dataset.patab; global.paint(); return;
    }
    if (e.target.closest('[data-lcsave]')) {
      e.preventDefault();
      if (!canManage()) { say('Only the owner or a manager can post a landed cost.'); return; }
      var btn = e.target.closest('[data-lcsave]');
      btn.disabled = true;
      ERP.Landed.create({
        purchaseId: LC.purchaseId, date: LC.date, notes: LC.notes,
        expenses: LC.rows.map(function (r) {
          return { category: r.category, amount: r.amount, vendorName: r.vendorName,
                   description: r.description, paymentStatus: r.paymentStatus, date: LC.date };
        })
      }).then(function (rec) {
        say('Posted ' + rec.referenceNumber + ' — ' + M.fmt(rec.totalAmount) + ' added to the stock.');
        LC.purchaseId = ''; LC.notes = ''; LC.rows = [blankRow()]; LC.open = rec.id;
        global.paint();
      }).catch(function (err) {
        btn.disabled = false;
        say((err && err.validation) ? err.validation[0] : 'Could not post that.');
      });
      return;
    }
    if (e.target.closest('[data-exsave]')) {
      e.preventDefault();
      ERP.Expenses.save({ category: EX.category || ERP.Expenses.categories[0], amount: EX.amount,
                          paidTo: EX.paidTo, note: EX.note, date: EX.date })
        .then(function () {
          say('Expense recorded.');
          EX.amount = ''; EX.paidTo = ''; EX.note = '';
          global.paint();
        })
        .catch(function (err) { say((err && err.validation) ? err.validation[0] : 'Could not record that.'); });
      return;
    }
  });

  /* ════════════════════════════════════════════════════════════════════════
     STYLES
     ════════════════════════════════════════════════════════════════════════ */
  var CSS =
    '.lc-line{display:flex;justify-content:space-between;gap:16px;padding:7px 0;' +
    'border-bottom:1px solid var(--line-2)}' +
    '.lc-line b{font-variant-numeric:tabular-nums}' +
    '.lc-line.lc-new b{color:var(--accent,#b45309)}' +
    '.lc-line.lc-tot{border-bottom:none;font-size:15px}' +
    '.lc-line.lc-tot b{font-size:17px}' +
    '.lc-note{margin-top:10px;padding:9px 11px;border-radius:8px;background:var(--surface-2,#f6f6f4);' +
    'font-size:12.5px;line-height:1.5;display:flex;gap:7px;align-items:flex-start}' +
    '.lc-rows .lc-amt{text-align:right;min-width:120px;min-height:44px;font-size:15px;' +
    'font-variant-numeric:tabular-nums}' +
    '.lc-rows td{vertical-align:middle}' +
    '.lc-rows input,.lc-rows select{min-height:42px}' +
    '.lc-tablewrap{overflow-x:auto}' +
    '.lc-cancelled{opacity:.55}' +
    '.lc-cancelled td{text-decoration:line-through}' +
    '.lc-neg{color:var(--bad,#b91c1c)}' +
    '@media(max-width:760px){.lc-rows,.lc-rows tbody,.lc-rows tr,.lc-rows td{display:block;width:100%}' +
    '.lc-rows thead,.lc-rows tfoot{display:none}' +
    '.lc-rows tr{border:1px solid var(--line);border-radius:10px;padding:8px;margin-bottom:10px}' +
    '.lc-rows td:before{content:attr(data-label);display:block;font-size:11px;opacity:.65;margin-bottom:3px}' +
    '.lc-rows .lc-amt{width:100%}}';
  try {
    var st = D.createElement('style');
    st.setAttribute('data-fc', 'landed-ui');
    st.textContent = CSS;
    D.head.appendChild(st);
  } catch (e) {}

  ERP.LandedUI = { version: '2026-09-14', productProfit: productProfit, warehouseProfit: warehouseProfit };

})(typeof window !== 'undefined' ? window : globalThis);
