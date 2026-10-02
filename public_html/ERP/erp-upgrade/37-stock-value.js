/* ═════════════════════════════════════════════════════════════════════════
   STOCK VALUE — how much money is sitting in the warehouses

   Client request (2026-09-20): "right now the goods we have in the
   warehouse, how much money's worth of it is lying there for us — so it can
   be known that this much money's worth of stock is lying there."

   The answer is what the goods COST, not what they might sell for: bags on
   hand x the average cost the ERP already keeps for each product in each
   warehouse (moving average, landed or goods-only according to the cost
   basis in Settings — module 17). Nothing new is stored and no figure is
   invented; if the cost of something is unknown it is said so and left out
   of the total instead of being counted as zero.

   Shown in three places: a card on the Dashboard, a strip on Inventory, and
   its own screen (Inventory & supply → Stock value) with the split by
   warehouse and by category, every product, Print/PDF and Excel.

   Rules, decided up front so the number can be trusted:
   - Cost per bag comes from the stock row itself (kept by purchases and
     milling receipts). Stock that came in another way — opening stock or
     "Add stock" with a cost typed, a transfer — never reaches that row's
     average (Inventory.apply only feeds it from purchases), but the cost IS
     written on the stock movement that brought it in, so the weighted average
     of those movements is used and labelled "carried in". Only if even that
     is missing is the same product's cost in another warehouse used (the rule
     Inventory.costOf applies when costing a sale), then the product's own
     purchase price; THAT last one is an estimate, flagged and totalled
     separately so the owner can see how much of the figure rests on it.
   - Damaged bags are NOT in the main figure — they are shown on their own.
   - Negative stock (only possible when the owner allows it) is left out and
     flagged: minus bags do not reduce what is on the shelf.
   - Selling-price value is secondary: the price the owner set for the
     product, else the last rate actually invoiced, else "not priced".
   - It is the position right now. There is no "as at last month" — the app
     keeps the running balance, not a per-day stock history.
   - Cost is sensitive, so it needs FINANCIAL_REPORT_VIEW (Owner, Manager,
     Accountant) — the same gate as the financial reports.
   ═════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var ERP = global.ERP; if (!ERP) return;
  var M = global.Money, S = ERP.S, D = global.document;
  if (!M || !S || !ERP.Inventory) return;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function I(n) { return global.I ? global.I(n) : ''; }
  function say(m) { try { global.say(m); } catch (e) {} }
  function can(p) { return ERP.Can ? ERP.Can(p) : true; }
  function fmtDate(d) { return global.fmtDate ? global.fmtDate(d) : d; }
  /* the LOCAL date — toISOString() is UTC, which in Pakistan is still
     "yesterday" until 05:00 (the same trap as Reports.range) */
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nf(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 }); }
  function norm(s) {
    s = String(s === null || s === undefined ? '' : s);
    try { if (ERP.Search && ERP.Search.normalize) return ERP.Search.normalize(s); } catch (e) {}
    return s.toLowerCase();
  }
  /* paisa → "60,000" or "60,000.50" (whole rupees drop the .00) */
  function num(p) {
    var r = M.toR(p), neg = r < 0; r = Math.abs(r);
    var whole = Math.floor(r), cents = Math.round((r - whole) * 100);
    if (cents === 100) { whole += 1; cents = 0; }
    return (neg ? '−' : '') + whole.toLocaleString('en-US') + (cents ? '.' + String(cents).padStart(2, '0') : '');
  }
  function rs(p) { return 'Rs. ' + num(p); }

  var PERM = 'FINANCIAL_REPORT_VIEW';
  var NONE = 'Uncategorised';

  /* ═════════════════════════════════════════════════════════════════════
     THE ENGINE
     ═════════════════════════════════════════════════════════════════════ */
  function costMap() {
    /* first known cost of each product across warehouses, for rows with none of their own */
    var m = {};
    Object.keys(S.inventory).forEach(function (k) {
      var r = S.inventory[k];
      if (r && r.avgCostP > 0 && !m[r.productId]) m[r.productId] = r.avgCostP;
    });
    return m;
  }

  /* the cost written on the movements that brought stock into a row without
     touching its average: weighted by bags. Only those kinds — a purchase's
     cost is already in the row, and sales/returns carry no cost of their own. */
  var CARRIED = { OPENING_STOCK: 1, ADJUSTMENT_IN: 1, TRANSFER_IN: 1, CONVERT_IN: 1 };
  function carriedMap() {
    var m = {};
    (S.movements || []).forEach(function (mv) {
      if (mv.bucket === 'damaged' || !(mv.unitCostP > 0)) return;
      /* an edited Add-stock receipt's old lines come back out at their old cost (StockDocs.editReceive) */
      var undo = mv.kind === 'RECEIPT_EDIT_OUT' && mv.qtyDelta < 0;
      if (!undo && (!CARRIED[mv.kind] || !(mv.qtyDelta > 0))) return;
      var k = mv.productId + '|' + mv.warehouseId, a = m[k] || (m[k] = { qty: 0, cost: 0 });
      a.qty += mv.qtyDelta; a.cost += mv.qtyDelta * mv.unitCostP;
    });
    Object.keys(m).forEach(function (k) { m[k] = m[k].qty > 0 && m[k].cost > 0 ? Math.round(m[k].cost / m[k].qty) : 0; });
    return m;
  }

  function costFor(row, ctx) {
    if (row.avgCostP > 0) return { p: row.avgCostP, src: 'recorded' };
    var carried = ctx.carried[row.productId + '|' + row.warehouseId];
    if (carried > 0) return { p: carried, src: 'carried' };
    if (ctx.other[row.productId]) return { p: ctx.other[row.productId], src: 'other' };
    var pr = global.prodOf ? global.prodOf(row.productId) : null;
    var list = pr ? (pr.buyP !== undefined && pr.buyP !== null ? pr.buyP : (pr.buy ? M.toP(pr.buy) : 0)) : 0;
    if (list > 0) return { p: list, src: 'list' };
    return { p: 0, src: 'none' };
  }

  function lastSales() {
    var status = {};
    S.invoices.forEach(function (i) { status[i.id] = i; });
    var last = {};
    S.invoiceItems.forEach(function (it) {
      var inv = status[it.invoiceId];
      if (!inv || inv.status === 'CANCELLED' || inv.status === 'DRAFT') return;
      if (!(it.unitPrice > 0)) return;
      var hit = last[it.productId];
      if (!hit || inv.invoiceDate > hit.date) last[it.productId] = { date: inv.invoiceDate, rate: it.unitPrice };
    });
    return last;
  }

  function sellFor(pid, ctx) {
    if (ctx.sell[pid]) return ctx.sell[pid];
    var out = { p: 0, src: 'none' };
    try {
      var pr = ERP.Prices && ERP.Prices.of ? ERP.Prices.of(pid) : null;
      if (pr && pr.sell > 0) out = { p: pr.sell, src: 'list' };
    } catch (e) {}
    if (!out.p) {
      if (!ctx.last) ctx.last = lastSales();
      if (ctx.last[pid]) out = { p: ctx.last[pid].rate, src: 'last' };
    }
    ctx.sell[pid] = out;
    return out;
  }

  var SV = ERP.StockValue = {
    permission: PERM,

    /* the cost per bag this screen uses for one product in one warehouse (recorded average → cost carried on the movements →
       another warehouse → list price), so a brand conversion (07-transactions.js) hands the new brand the very cost shown here.
       { p: paisa, src: 'recorded'|'carried'|'other'|'list'|'none' } */
    costOf: function (pid, wid) {
      var r = S.inventory[pid + '|' + wid];
      return r ? costFor(r, { other: costMap(), carried: carriedMap() }) : { p: 0, src: 'none' };
    },

    /* Goods lying at flour mills (32-milling.js) are on no warehouse shelf, so they are NOT in the stock figure and are never added
       to it — they are reported beside it (bags, kg, worth at the job's cost per bag). Only for the whole-company view: a warehouse,
       category or search filter is about shelves, so it shows none. Zeros when the milling module is absent. */
    atMills: function (o) {
      o = o || {};
      var out = { bags: 0, kg: 0, valueP: 0, products: 0, unvaluedBags: 0 };
      if (!ERP.Milling || typeof ERP.Milling.atMill !== 'function') return out;
      if (o.warehouseId || o.category || (o.q && String(o.q).trim())) return out;
      var seen = {};
      ERP.Milling.atMill().forEach(function (r) {
        if (!(r.qty > 0)) return;
        out.bags += r.qty; out.kg += r.kg; out.valueP += r.valueP; seen[r.productId] = 1;
        if (!r.costPerBagP) out.unvaluedBags += r.qty;
      });
      out.bags = Math.round(out.bags * 1000) / 1000; out.kg = Math.round(out.kg * 1000) / 1000;
      out.unvaluedBags = Math.round(out.unvaluedBags * 1000) / 1000; out.products = Object.keys(seen).length;
      return out;
    },

    /* o: { warehouseId, category, q, noSell } — all optional. noSell skips the
       selling-price work (price list, last invoiced rate) for callers that
       only need the cost figures, e.g. the dashboard card. */
    build: function (o) {
      o = o || {};
      var ctx = { other: costMap(), carried: carriedMap(), sell: {}, last: null };
      var query = norm(o.q).trim();
      var rows = [], negative = [], dmgQty = 0, dmgValue = 0, dmgUnvalued = 0;

      Object.keys(S.inventory).forEach(function (k) {
        var r = S.inventory[k]; if (!r) return;
        var pr = global.prodOf ? global.prodOf(r.productId) : null;
        var cat = (pr && pr.cat) || NONE;
        if (o.warehouseId && r.warehouseId !== o.warehouseId) return;
        if (o.category && cat !== o.category) return;
        var wname = global.whName ? global.whName(r.warehouseId) : '';
        if (!wname || wname === '\u2014') wname = 'Unknown warehouse (' + r.warehouseId + ')';   // a removed warehouse must not read as a dash
        var en = pr ? (pr.en || pr.nameEn || '') : '', ur = pr ? (pr.ur || '') : '';
        var name = en || ur || r.productId;
        if (query) {
          var hay = norm([ur, en, pr && pr.brandEn, cat, pr && pr.sku, r.productId, wname].join(' '));
          if (query.split(/\s+/).some(function (w) { return hay.indexOf(w) === -1; })) return;
        }
        var qty = Number(r.qty) || 0, dmg = Number(r.damagedQty) || 0;
        var c = costFor(r, ctx);
        /* §29 (client: carriage "is the cost of the product"): the carriage per bag on hand is part of what a bag cost.
           Only added once a cost is known — carriage alone is not a cost price. */
        var carP = c.src === 'none' ? 0 : (typeof r.avgCarriageP === 'number' && r.avgCarriageP > 0 ? r.avgCarriageP : 0);
        c = { p: c.p + carP, src: c.src, carriageP: carP };

        if (dmg > 0) {
          dmgQty += dmg;
          if (c.p) dmgValue += M.mul(c.p, dmg); else dmgUnvalued += dmg;
        }
        if (qty < 0) { negative.push({ productId: r.productId, name: name, warehouse: wname, qty: qty }); return; }
        if (qty === 0) return;

        var s = o.noSell ? { p: 0, src: 'none' } : sellFor(r.productId, ctx);
        rows.push({
          productId: r.productId, name: name, nameUr: ur, cat: cat, kg: pr ? pr.kg : null,
          warehouseId: r.warehouseId, warehouse: wname, qty: qty,
          costP: c.p, carriageP: c.carriageP, costSrc: c.src, valueP: c.p ? M.mul(c.p, qty) : 0,
          sellP: s.p, sellSrc: s.src, sellValueP: s.p ? M.mul(s.p, qty) : 0
        });
      });

      rows.sort(function (a, b) {
        return (b.valueP - a.valueP) || (b.qty - a.qty) || String(a.name).localeCompare(String(b.name));
      });

      var t = { bags: 0, valueP: 0, estimatedP: 0, estimatedRows: 0, unvaluedBags: 0, unvaluedRows: 0,
                sellValueP: 0, pricedBags: 0, unpricedBags: 0, unpricedRows: 0,
                damagedQty: Math.round(dmgQty * 1000) / 1000, damagedValueP: dmgValue, damagedUnvalued: dmgUnvalued,
                negativeRows: negative.length, rows: rows.length };
      var prods = {};
      rows.forEach(function (r) {
        t.bags += r.qty; prods[r.productId] = 1;
        if (r.costSrc === 'none') { t.unvaluedBags += r.qty; t.unvaluedRows++; }
        else { t.valueP += r.valueP; if (r.costSrc === 'list') { t.estimatedP += r.valueP; t.estimatedRows++; } }
        if (r.sellP) { t.sellValueP += r.sellValueP; t.pricedBags += r.qty; }
        else { t.unpricedBags += r.qty; t.unpricedRows++; }
      });
      t.bags = Math.round(t.bags * 1000) / 1000;
      t.unvaluedBags = Math.round(t.unvaluedBags * 1000) / 1000;
      t.pricedBags = Math.round(t.pricedBags * 1000) / 1000;
      t.unpricedBags = Math.round(t.unpricedBags * 1000) / 1000;
      t.products = Object.keys(prods).length;
      t.unvaluedProducts = Object.keys(rows.reduce(function (a, r) { if (r.costSrc === 'none') a[r.productId] = 1; return a; }, {})).length;

      function group(keyFn, labelFn, seed) {
        var g = {}, order = [];
        (seed || []).forEach(function (s) { g[s.key] = { key: s.key, label: s.label, inactive: s.inactive, bags: 0, valueP: 0, sellValueP: 0, products: {} }; order.push(s.key); });
        rows.forEach(function (r) {
          var key = keyFn(r);
          if (!g[key]) { g[key] = { key: key, label: labelFn(r), bags: 0, valueP: 0, sellValueP: 0, products: {} }; order.push(key); }
          g[key].bags += r.qty; g[key].valueP += r.valueP; g[key].sellValueP += r.sellValueP; g[key].products[r.productId] = 1;
        });
        return order.map(function (k) {
          var x = g[k];
          return { key: x.key, label: x.label, inactive: x.inactive, bags: Math.round(x.bags * 1000) / 1000,
                   valueP: x.valueP, sellValueP: x.sellValueP, products: Object.keys(x.products).length,
                   share: t.valueP ? Math.round(x.valueP / t.valueP * 1000) / 10 : 0 };
        }).sort(function (a, b) { return (b.valueP - a.valueP) || (b.bags - a.bags); });
      }
      var whSeed = (global.WAREHOUSES || []).filter(function (w) {
        return w.active !== false && (!o.warehouseId || w.id === o.warehouseId);
      }).map(function (w) { return { key: w.id, label: w.name }; });

      return {
        rows: rows, totals: t, negative: negative, atMills: SV.atMills(o),
        byWarehouse: group(function (r) { return r.warehouseId; }, function (r) {
          var w = (global.WAREHOUSES || []).filter(function (x) { return x.id === r.warehouseId; })[0];
          return r.warehouse + (w && w.active === false ? ' (inactive)' : '');
        }, whSeed),
        byCategory: group(function (r) { return r.cat; }, function (r) { return r.cat; }),
        asOf: today()
      };
    },

    /* headline numbers for the dashboard and the Inventory strip */
    total: function () { return SV.build({ noSell: true }); },
    today: today,

    /* the same figures as a printable document (Print, PDF, Word come free) */
    docModel: function (o) {
      var data = SV.build(o), t = data.totals;
      var rows = data.rows.map(function (r, i) {
        return {
          sr: String(i + 1),
          description: r.name + (r.nameUr && r.nameUr !== r.name ? '  ' + r.nameUr : ''),
          descriptionUr: r.nameUr,
          pack: r.warehouse,
          qty: nf(r.qty),
          rate: r.costSrc === 'none' ? 'no cost' : num(r.costP) + (r.costSrc === 'list' ? ' *' : ''),
          amount: r.costSrc === 'none' ? '—' : num(r.valueP)
        };
      });
      var totals = [{ label: 'Total bags in stock', value: nf(t.bags) }];
      if (t.sellValueP) totals.push({ label: 'Worth at selling price', value: M.fmt(t.sellValueP) });
      totals.push({ label: 'STOCK VALUE (at cost)', value: M.fmt(t.valueP), big: true, rule: true });
      if (data.atMills.bags) totals.push({ label: 'Lying at mills — not in the total above', value: nf(data.atMills.bags) + ' bags · ' + M.fmt(data.atMills.valueP), bold: true });

      var notes = ['Value = bags on hand × average cost per bag (purchase price + carriage), as of ' + fmtDate(today()) + '.'];
      if (t.estimatedRows) notes.push('* Rs. ' + num(t.estimatedP) + ' of the total uses an estimated cost — the product’s purchase price, as no purchase of it is recorded.');
      if (t.unvaluedRows) notes.push(t.unvaluedProducts + ' product(s), ' + nf(t.unvaluedBags) + ' bags, have no cost recorded and are NOT in the total.');
      if (t.damagedQty) notes.push('Damaged stock (' + nf(t.damagedQty) + ' bags, ' + M.fmt(t.damagedValueP) + ' at cost) is not included.');
      if (data.atMills.bags) notes.push(nf(data.atMills.bags) + ' bags (' + M.fmt(data.atMills.valueP) + ' at cost) are still lying at flour mills and have not reached a warehouse; they are shown separately and are NOT in the stock value.');

      var m = ERP.Analytics.docModel({
        id: 'stockvalue', title: 'Stock value', from: null, to: null,
        partyLabel: 'REPORT FOR', partyName: ERP.Settings.get().businessName,
        columns: [
          { key: 'sr', label: '#', width: 0.06 },
          { key: 'description', label: 'Product', width: 0.34 },
          { key: 'pack', label: 'Warehouse', width: 0.18 },
          { key: 'qty', label: 'Bags', align: 'right', width: 0.1 },
          { key: 'rate', label: 'Cost / bag', align: 'right', width: 0.14 },
          { key: 'amount', label: 'Value (at cost)', align: 'right', width: 0.18 }
        ],
        rows: rows,
        footer: { description: 'TOTAL', qty: nf(t.bags), amount: num(t.valueP) },
        meta: [['Products', String(t.products)], ['Warehouses', String(data.byWarehouse.length)]],
        totals: totals, summary: notes.join(' ')
      });
      /* a stock figure is a moment, not a period */
      m.meta = m.meta.map(function (x) { return x[0] === 'Period' ? ['As at', fmtDate(today())] : x; });
      return m;
    },

    /* the sheet, for Excel: a summary page and the product list */
    sheets: function (o) {
      var data = SV.build(o), t = data.totals;
      var sum = [['Stock value — ' + ERP.Settings.get().businessName], ['As at', fmtDate(today())], [],
        ['Total stock value (at cost)', M.toR(t.valueP)], ['Bags in stock', t.bags], ['Products', t.products],
        ['Worth at selling price (priced products only)', M.toR(t.sellValueP)],
        ['Of which estimated cost', M.toR(t.estimatedP)],
        ['Bags with no cost (not in total)', t.unvaluedBags],
        ['Damaged bags (not in total)', t.damagedQty], ['Damaged, at cost', M.toR(t.damagedValueP)],
        ['Lying at mills, bags (not in total)', data.atMills.bags], ['Lying at mills, at cost (not in total)', M.toR(data.atMills.valueP)],
        [], ['By warehouse'], ['Warehouse', 'Products', 'Bags', 'Value at cost', 'Share %']];
      data.byWarehouse.forEach(function (g) { sum.push([g.label, g.products, g.bags, M.toR(g.valueP), g.share]); });
      sum.push([], ['By category'], ['Category', 'Products', 'Bags', 'Value at cost', 'Share %']);
      data.byCategory.forEach(function (g) { sum.push([g.label, g.products, g.bags, M.toR(g.valueP), g.share]); });

      var prod = [['Product', 'Urdu name', 'Category', 'Warehouse', 'Bags', 'Cost per bag', 'Cost source',
                   'Value at cost', 'Selling price', 'Price source', 'Value at selling price']];
      var SRC = { recorded: 'recorded', carried: 'carried in (opening stock / transfer)', other: 'same product, other warehouse', list: 'estimated (purchase price)', none: 'no cost' };
      var PSRC = { list: 'price list', last: 'last sale', none: 'not priced' };
      data.rows.forEach(function (r) {
        prod.push([r.name, r.nameUr, r.cat, r.warehouse, r.qty, M.toR(r.costP), SRC[r.costSrc],
                   M.toR(r.valueP), M.toR(r.sellP), PSRC[r.sellSrc], M.toR(r.sellValueP)]);
      });
      prod.push([], ['TOTAL', '', '', '', t.bags, '', '', M.toR(t.valueP), '', '', M.toR(t.sellValueP)]);
      return [{ name: 'Summary', rows: sum }, { name: 'Products', rows: prod }];
    }
  };

  /* ═════════════════════════════════════════════════════════════════════
     THE SCREEN
     ═════════════════════════════════════════════════════════════════════ */
  var ST = { warehouseId: '', category: '', q: '' };
  var CAP = 300;

  function locked() {
    return '<div class="card"><div class="card-b"><div class="empty"><div class="ei">' + I('lock') + '</div>' +
      '<b>Stock value is not open to you</b><p>It shows what the goods cost, so it is kept to the owner, ' +
      'manager and accountant. Ask the owner if you need it.</p></div></div></div>';
  }

  function warehouseOptions() {
    return '<option value="">All warehouses</option>' +
      (global.WAREHOUSES || []).map(function (w) {
        return '<option value="' + esc(w.id) + '"' + (ST.warehouseId === w.id ? ' selected' : '') + '>' +
          esc(w.name) + (w.active === false ? ' (inactive)' : '') + '</option>';
      }).join('');
  }
  function categoryOptions() {
    var seen = {}, list = [];
    (global.PRODUCTS || []).forEach(function (p) { var c = p.cat || NONE; if (!seen[c]) { seen[c] = 1; list.push(c); } });
    list.sort();
    return '<option value="">All categories</option>' + list.map(function (c) {
      return '<option value="' + esc(c) + '"' + (ST.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }

  function kpis(t, am) {
    am = am || { bags: 0 };
    var sell = t.pricedBags
      ? '<div class="v">' + rs(t.sellValueP) + '</div><div class="d">' +
        (t.unpricedBags ? 'Priced bags only — ' + nf(t.unpricedBags) + ' bags have no selling price' : 'All bags priced') + '</div>'
      : '<div class="v">—</div><div class="d">No selling prices set yet</div>';
    return '<div class="ledger sv-kpis">' +
      '<div class="kpi sv-main"><div class="k">' + I('wallet') + 'Stock value (at cost)</div>' +
        '<div class="v">' + (t.valueP || !t.bags ? rs(t.valueP) : '\u2014') + '</div>' +
        '<div class="d">' + nf(t.bags) + ' bags \u00B7 ' + t.products + ' products' +
          (!t.valueP && t.bags ? ' \u2014 cost not recorded yet' : '') + '</div></div>' +
      '<div class="kpi"><div class="k">' + I('tag') + 'Worth at selling price</div>' + sell + '</div>' +
      '<div class="kpi ' + (t.damagedQty ? 'alert' : '') + '"><div class="k">' + I('alert') + 'Damaged stock (at cost)</div>' +
        '<div class="v">' + (t.damagedQty ? rs(t.damagedValueP) : '—') + '</div>' +
        '<div class="d">' + (t.damagedQty ? nf(t.damagedQty) + ' bags \u2014 not in the figure at left' +
          (t.damagedUnvalued ? ' \u00B7 ' + nf(t.damagedUnvalued) + ' have no cost' : '') : 'None recorded') + '</div></div>' +
      (am.bags
        ? '<div class="kpi sv-mills" data-go="millstock" role="link" tabindex="0" title="Open Stock at mills" aria-label="Goods lying at mills. Open Stock at mills">' +
          '<div class="k">' + I('mill') + 'Lying at mills (not yet here)</div>' +
          '<div class="v">' + (am.valueP ? rs(am.valueP) : '\u2014') + '</div>' +
          '<div class="d">' + nf(am.bags) + ' bags \u2014 not in the warehouse figure' + (am.unvaluedBags ? ' \u00B7 ' + nf(am.unvaluedBags) + ' have no cost' : '') +
            (am.valueP ? ' \u00B7 with them: ' + rs(t.valueP + am.valueP) : '') + '</div></div>'
        : '') +
    '</div>';
  }

  function warnings(data) {
    var t = data.totals, out = [];
    function banner(head, body) {
      return '<div class="banner warn sv-warn">' + I('alert') + '<div><b>' + head + '</b><p>' + body + '</p></div></div>';
    }
    if (t.unvaluedRows) out.push(banner(
      t.unvaluedProducts + ' product' + (t.unvaluedProducts === 1 ? '' : 's') + ' (' + nf(t.unvaluedBags) + ' bags) ' +
        (t.unvaluedProducts === 1 ? 'has' : 'have') + ' no cost recorded',
      'Not in the total above. Receive ' + (t.unvaluedProducts === 1 ? 'it' : 'them') +
        ' through a purchase, or set the product’s purchase price, to include ' + (t.unvaluedProducts === 1 ? 'it' : 'them') + '.'));
    if (t.estimatedRows) out.push(banner(
      rs(t.estimatedP) + ' of the total uses an estimated cost',
      'No purchase of those products is recorded, so the product’s own purchase price is used (marked <i>estimated</i> below).'));
    if (t.negativeRows) out.push(banner(
      t.negativeRows + ' stock line' + (t.negativeRows === 1 ? '' : 's') + ' show negative bags',
      data.negative.slice(0, 3).map(function (n) { return esc(n.name) + ' @ ' + esc(n.warehouse) + ': ' + nf(n.qty); }).join('; ') +
        (t.negativeRows > 3 ? '; …' : '') + '. Left out of the value — check the counts.'));
    return out.join('');
  }

  function breakdown(title, sub, list, withInactive) {
    if (!list.length) return '';
    return '<div class="card"><div class="card-h"><h3>' + esc(title) + '</h3><span class="pill neu">' + esc(sub) + '</span></div>' +
      '<div class="card-b"><div class="tw"><table class="tbl fcb-list sv-tbl"><thead><tr><th>' + esc(title.replace(/^By /, '').replace(/^./, function (c) { return c.toUpperCase(); })) +
      '</th><th class="r">Bags</th><th class="r">Value at cost</th><th class="r">Share</th></tr></thead><tbody>' +
      list.map(function (g) {
        return '<tr><td data-label="' + esc(title.replace(/^By /, '')) + '"><b>' + esc(g.label) + '</b></td>' +
          '<td data-label="Bags" class="r num">' + nf(g.bags) + '</td>' +
          '<td data-label="Value at cost" class="r num"><b>' + num(g.valueP) + '</b></td>' +
          '<td data-label="Share" class="r num">' + (g.valueP ? g.share + '%' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>';
  }

  function costCell(r) {
    if (r.costSrc === 'none') return '<span class="pill bad" title="No cost recorded for this product">no cost</span>';
    if (r.carriageP > 0) return num(r.costP) + ' <span class="pill neu" title="Purchase price ' + num(r.costP - r.carriageP) + ' + carriage ' + num(r.carriageP) + ' per bag">incl. carriage ' + num(r.carriageP) + '</span>';
    if (r.costSrc === 'carried') return num(r.costP) + ' <span class="pill neu" title="The cost recorded when this stock came in (opening stock, stock receipt or transfer)">carried in</span>';
    if (r.costSrc === 'other') return num(r.costP) + ' <span class="pill neu" title="This stock arrived by transfer or adjustment, so it carries the cost of the same product bought elsewhere">from other warehouse</span>';
    if (r.costSrc === 'list') return num(r.costP) + ' <span class="pill low" title="No purchase of this product is recorded — the product’s own purchase price is used">estimated</span>';
    return num(r.costP);
  }

  function productTable(data) {
    if (!data.rows.length) {
      return '<div class="empty"><div class="ei">' + I('box') + '</div><b>No stock on hand' +
        (ST.q || ST.warehouseId || ST.category ? ' for this filter' : '') + '</b>' +
        '<p>' + (ST.q || ST.warehouseId || ST.category ? 'Clear the filters to see everything.' :
          'Receive stock through a purchase and its value will appear here.') + '</p></div>';
    }
    var shown = data.rows.slice(0, CAP), priced = data.totals.pricedBags > 0;
    return '<div class="tw"><table class="tbl fcb-list sv-tbl"><thead><tr><th>Product</th><th>Warehouse</th>' +
      '<th class="r">Bags</th><th class="r">Cost / bag</th><th class="r">Value at cost</th>' +
      (priced ? '<th class="r">Sells at</th><th class="r">Value if sold</th>' : '') + '</tr></thead><tbody>' +
      shown.map(function (r) {
        return '<tr><td data-label="Product"><b>' + esc(r.name) + '</b>' +
            (r.nameUr && r.nameUr !== r.name ? ' <span class="sv-ur">' + esc(r.nameUr) + '</span>' : '') +
            '<div class="sv-sub">' + esc(r.cat) + (r.kg ? ' · ' + esc(r.kg) + ' kg bag' : '') + '</div></td>' +
          '<td data-label="Warehouse">' + esc(r.warehouse) + '</td>' +
          '<td data-label="Bags" class="r num">' + nf(r.qty) + '</td>' +
          '<td data-label="Cost / bag" class="r num">' + costCell(r) + '</td>' +
          '<td data-label="Value at cost" class="r num"><b>' + (r.costSrc === 'none' ? '—' : num(r.valueP)) + '</b></td>' +
          (priced ? '<td data-label="Sells at" class="r num">' + (r.sellP ? num(r.sellP) +
            (r.sellSrc === 'last' ? '<span class="pill neu" title="Last rate on an invoice — no price is set">last sale</span>' : '') : '—') + '</td>' +
          '<td data-label="Value if sold" class="r num">' + (r.sellP ? num(r.sellValueP) : '—') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="2"><b>Total</b></td><td class="r num"><b>' + nf(data.totals.bags) + '</b></td>' +
      '<td></td><td class="r num"><b>' + num(data.totals.valueP) + '</b></td>' +
      (priced ? '<td></td><td class="r num"><b>' + num(data.totals.sellValueP) + '</b></td>' : '') + '</tr></tfoot></table></div>' +
      (data.rows.length > CAP ? '<p class="hint">Showing the ' + CAP + ' highest-value lines of ' + data.rows.length +
        '. Print/PDF and Excel always include every line.</p>' : '');
  }

  function results() {
    var data = SV.build(ST);
    var showWh = !ST.warehouseId, showCat = !ST.category;
    return kpis(data.totals, data.atMills) + warnings(data) +
      '<div class="sv-two">' +
        (showWh ? breakdown('By warehouse', data.byWarehouse.length + ' warehouses', data.byWarehouse) : '') +
        (showCat ? breakdown('By category', data.byCategory.length + ' categories', data.byCategory) : '') +
      '</div>' +
      '<div class="card"><div class="card-h"><h3>Every product</h3><span class="pill neu">' + data.totals.rows +
        ' lines · biggest value first</span></div><div class="card-b">' + productTable(data) + '</div></div>';
  }

  /* a remembered filter must not outlive what it points at: a removed
     warehouse or a category no product has any more would leave the dropdown
     saying "All" while the list underneath stayed filtered to nothing */
  function sanitizeFilters() {
    if (ST.warehouseId && !(global.WAREHOUSES || []).some(function (w) { return w.id === ST.warehouseId; })) ST.warehouseId = '';
    if (ST.category && !(global.PRODUCTS || []).some(function (p) { return (p.cat || NONE) === ST.category; })) ST.category = '';
  }

  global.PAGES.stockvalue = function () {
    if (!can(PERM)) return locked();
    sanitizeFilters();
    return '<div class="card"><div class="card-b"><div class="bar sv-bar">' +
        '<label class="f"><span>Warehouse</span><select data-svf="warehouseId">' + warehouseOptions() + '</select></label>' +
        '<label class="f"><span>Category</span><select data-svf="category">' + categoryOptions() + '</select></label>' +
        '<label class="f sv-q"><span>Search</span><input type="search" data-svq value="' + esc(ST.q) + '" placeholder="Product, brand or warehouse…"></label>' +
        '<div class="grow"></div>' +
        '<button class="btn" data-svprint>' + I('print') + 'Print / PDF</button>' +
        '<button class="btn pri" data-svexcel>' + I('sheet') + 'Excel</button>' +
      '</div><p class="hint sv-asof">The position right now — ' + esc(fmtDate(today())) +
        '. Value = bags on hand × average cost per bag (purchase price + carriage).</p></div></div>' +
      '<div id="svResults">' + results() + '</div>';
  };

  /* ═════════════════════════════════════════════════════════════════════
     DASHBOARD CARD + INVENTORY STRIP
     ═════════════════════════════════════════════════════════════════════ */
  var origDash = global.PAGES.dashboard;
  global.PAGES.dashboard = function () {
    var html = origDash ? origDash.apply(global, arguments) : '';
    if (!can(PERM)) return html;
    var dd = SV.build({ noSell: true }), t = dd.totals, am = dd.atMills;
    var kpi = '<div class="kpi sv-dash" data-go="stockvalue" role="link" tabindex="0" title="Open the stock value report" aria-label="Stock value at cost. Open the report">' +
      '<div class="k">' + I('wallet') + 'Stock value (at cost)</div>' +
      '<div class="v">' + (t.valueP ? rs(t.valueP) : '\u2014') + '</div>' +
      '<div class="d">' + (t.bags ? nf(t.bags) + ' bags in the warehouses' + (t.unvaluedRows ? (t.valueP ? ' \u00B7 some without cost' : ' \u00B7 cost not recorded yet') : '') : 'No stock on hand') +
      (am.bags ? '<br>+ ' + (am.valueP ? rs(am.valueP) + ' (' + nf(am.bags) + ' bags)' : nf(am.bags) + ' bags') + ' lying at the mills' : '') + '</div></div>';
    var i = html.indexOf('All bags available');
    if (i > -1) {
      var e = html.indexOf('</div></div>', i);
      if (e > -1) { e += 12; return html.slice(0, e) + kpi + html.slice(e); }
    }
    return html.replace('<div class="ledger">', '<div class="ledger">' + kpi);
  };

  var origInv = global.PAGES.inventory;
  global.PAGES.inventory = function () {
    var html = origInv ? origInv.apply(global, arguments) : '';
    if (!can(PERM)) return html;
    var data = SV.build({ noSell: true }), t = data.totals;
    var strip = '<div class="card sv-strip"><div class="card-b"><div class="sv-strip-in">' +
      '<div class="sv-strip-main"><small>' + I('wallet') + 'Stock value at cost</small><b>' + (t.valueP ? rs(t.valueP) : '\u2014') + '</b>' +
        '<span>' + (t.bags ? nf(t.bags) + ' bags in stock' : 'No stock on hand') +
          (t.unvaluedRows ? ' · ' + nf(t.unvaluedBags) + ' bags have no cost yet' : '') +
          (data.atMills.bags ? ' · plus ' + nf(data.atMills.bags) + ' bags lying at mills' : '') + '</span></div>' +
      '<div class="sv-strip-wh">' + data.byWarehouse.map(function (g) {
        return '<div><small>' + esc(g.label) + '</small><b>' + (g.bags ? rs(g.valueP) : '—') + '</b></div>';
      }).join('') + '</div>' +
      '<button class="btn sm" data-go="stockvalue">' + I('chart') + 'Full stock value report</button>' +
    '</div></div></div>';
    var marker = '<div class="sec-t">Warehouse totals';
    return html.indexOf(marker) > -1 ? html.replace(marker, strip + marker) : strip + html;
  };

  /* ═════════════════════════════════════════════════════════════════════
     NAV
     ═════════════════════════════════════════════════════════════════════ */
  try {
    var NAV = global.NAV, GROUPS = global.NAVGROUPS;
    if (!NAV.some(function (n) { return n.id === 'stockvalue'; })) {
      var at = NAV.map(function (n) { return n.id; }).indexOf('inventory');
      NAV.splice(at < 0 ? NAV.length : at + 1, 0, { id: 'stockvalue', l: 'Stock value', i: 'wallet' });
    }
    GROUPS.forEach(function (g) {
      if (g[0] === 'Inventory & supply' && g[1].indexOf('stockvalue') === -1) {
        g[1].splice(g[1].indexOf('inventory') + 1, 0, 'stockvalue');
      }
    });
    if (global.PAGEMETA) {
      global.PAGEMETA.stockvalue = ['Stock value', 'How much money the goods in your warehouses are worth — at what you paid for them.'];
    }
  } catch (e) {}

  /* ═════════════════════════════════════════════════════════════════════
     HANDLERS
     ═════════════════════════════════════════════════════════════════════ */
  function refresh() {
    var el = D.getElementById('svResults');
    if (el) el.innerHTML = results();
  }
  D.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target && e.target.closest ? e.target.closest('.sv-dash') : null;
    if (!el) return;
    e.preventDefault();
    try { global.go('stockvalue'); } catch (err) {}
  });
  D.addEventListener('input', function (e) {
    var el = e.target; if (!el || !el.dataset || el.dataset.svq === undefined) return;
    ST.q = el.value; refresh();
  });
  D.addEventListener('change', function (e) {
    var el = e.target; if (!el || !el.dataset || el.dataset.svf === undefined) return;
    ST[el.dataset.svf] = el.value; refresh();
  });
  D.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-svprint]')) {
      e.preventDefault();
      if (!can(PERM)) return;
      ERP.Viewer.open(SV.docModel(ST));
      ERP.Audit.detached({ action: 'Stock value report opened for print', entity: 'Report', entityId: 'stockvalue' });
      return;
    }
    if (e.target.closest('[data-svexcel]')) {
      e.preventDefault();
      if (!can(PERM)) return;
      var name = 'Stock-value-' + today() + '.xlsx';
      try {
        var bytes = ERP.XLSX.build(SV.sheets(ST), { title: 'Stock value', author: ERP.Settings.get().businessName });
        var blob = new global.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var a = D.createElement('a');
        a.href = global.URL.createObjectURL(blob); a.download = name;
        D.body.appendChild(a); a.click();
        setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
        ERP.Audit.detached({ action: 'Stock value exported to Excel', entity: 'Report', entityId: 'stockvalue' });
        say('Excel file downloaded — ' + name);
      } catch (err) { say('Could not build the Excel file.'); }
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     STYLES
     ═════════════════════════════════════════════════════════════════════ */
  var CSS =
    '.sv-bar{flex-wrap:wrap;gap:10px;align-items:flex-end}' +
    '.sv-q{flex:1 1 220px;min-width:180px}.sv-q input{width:100%}' +
    '.sv-asof{margin:10px 0 0}' +
    '.sv-kpis{margin:16px 0}' +
    '.sv-mills{cursor:pointer}.sv-mills:hover{border-color:var(--violet)}' +
    '.sv-main .v{font-size:26px;color:var(--violet)}' +
    '.sv-dash{cursor:pointer}.sv-dash:hover{background:var(--surface-2,rgba(127,127,127,.06))}' +
    '.sv-dash:focus-visible{outline:2px solid var(--violet,#6d4aff);outline-offset:-2px}' +
    '.sv-warn{margin-bottom:12px}' +
    '.sv-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;margin:16px 0}' +
    '.sv-two:empty{display:none}' +
    'table.sv-tbl{min-width:0;width:100%}' +
    '.sv-tbl th,.sv-tbl td{white-space:nowrap}' +
    '.sv-tbl td[data-label="Product"]{white-space:normal;min-width:190px}' +
    '.sv-tbl .r{font-variant-numeric:tabular-nums}' +
    '.sv-tbl tfoot td{border-top:2px solid var(--line);padding-top:10px}' +
    '.sv-sub{font-size:11.5px;color:var(--muted);margin-top:2px}' +
    '.sv-ur{font-family:"Noto Nastaliq Urdu",serif;direction:rtl;unicode-bidi:isolate;opacity:.85}' +
    '.sv-tbl td .pill{display:table;margin:3px 0 0 auto;font-size:10.5px}' +
    '.sv-strip{margin-bottom:16px}' +
    '.sv-strip-in{display:flex;flex-wrap:wrap;align-items:center;gap:14px 28px}' +
    '.sv-strip small{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-weight:600}' +
    '.sv-strip small svg{width:14px;height:14px;color:var(--violet)}' +
    '.sv-strip b{display:block;font-size:17px;margin-top:2px;font-variant-numeric:tabular-nums}' +
    '.sv-strip-main b{font-size:24px;color:var(--violet)}' +
    '.sv-strip-main span{display:block;font-size:12px;color:var(--muted);margin-top:2px}' +
    '.sv-strip-wh{display:flex;flex-wrap:wrap;gap:8px 26px;flex:1 1 260px}' +
    '@media(max-width:760px){.sv-tbl th{display:none}.sv-tbl tfoot td[colspan]{display:block}' +
    '.sv-tbl td{white-space:normal}.sv-two{grid-template-columns:1fr}}';
  try {
    var st = D.createElement('style');
    st.setAttribute('data-fc', 'stockvalue');
    st.textContent = CSS;
    D.head.appendChild(st);
  } catch (e) {}

  ERP.StockValueUI = { version: '2026-09-20' };

})(typeof window !== 'undefined' ? window : globalThis);
