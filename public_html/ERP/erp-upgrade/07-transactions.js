/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 7
   THE REMAINING TRANSACTION TYPES, ALL MULTI-LINE
   Sales orders, quotations, warehouse transfers, stock receiving, stock
   adjustments and dispatch. Each is one parent record with many line items,
   written in a single atomic transaction, with a stock movement for every
   line and nothing at all written if any line fails.
   (§1 §8 §9 §10 §14 §23 §24 §25 §26 §33 §34)
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var ERP = global.ERP, FDB = global.FDB, M = global.Money;
var S = ERP.S, Inventory = ERP.Inventory, Audit = ERP.Audit, Mirror = ERP.Mirror;

function nowISO() { return new Date().toISOString(); }
function todayISO() { return global.FC_TODAY ? global.FC_TODAY() : new Date().toISOString().slice(0, 10); }
function currentUser() { return global.CURRENT_USER || 'Owner'; }
function whName(id) { return global.whName ? global.whName(id) : id; }
function prodOf(id) { return (global.prodOf && global.prodOf(id)) || null; }

/* in-memory working set for the new parents */
S.orders = S.orders || [];
S.orderItems = S.orderItems || [];
S.stockDocs = S.stockDocs || [];
S.stockDocItems = S.stockDocItems || [];

/* ══════════════════════════════════════════════════════════════════════════
   SHARED LINE VALIDATION
   Every line is checked first and all problems are reported together, so a
   five-line load does not have to be fixed one refusal at a time. A single
   bad line rejects the whole transaction (§8).
   ══════════════════════════════════════════════════════════════════════════ */
function validateLines(lines, opts) {
  opts = opts || {};
  var errs = [];
  var clean = (lines || []).filter(function (l) { return l && l.productId; });
  if (!clean.length) { errs.push('Add at least one product line.'); return { errs: errs, lines: clean }; }

  /* several lines may name the same product out of the same warehouse —
     they have to be checked against the total, not one at a time */
  var demand = {};
  clean.forEach(function (l, n) {
    var p = prodOf(l.productId);
    var label = 'Line ' + (n + 1) + (p ? ' (' + (p.en || p.ur) + ')' : '');
    if (!p) { errs.push(label + ': that product no longer exists.'); return; }
    var q = M.qty(l.quantity);
    if (!(q > 0)) { errs.push(label + ': quantity must be more than zero.'); return; }
    if (opts.needRate) {
      var rate = M.toP(l.unitPrice);
      if (rate < 0) errs.push(label + ': the rate cannot be negative.');
      var disc = M.toP(l.discount);
      if (disc < 0) errs.push(label + ': the discount cannot be negative.');
      if (disc > M.mul(rate, q)) errs.push(label + ': the discount is larger than the line amount.');
    }
    if (opts.out) {
      var wid = l.warehouseId || opts.warehouseId;
      if (!wid) { errs.push(label + ': choose a warehouse.'); return; }
      var key = l.productId + '|' + wid + '|' + (l.fromDamaged ? 'd' : 's');
      demand[key] = (demand[key] || 0) + q;
    }
  });

  if (opts.out && !ERP.Settings.allowNegativeStock()) {
    Object.keys(demand).forEach(function (key) {
      var parts = key.split('|'), pid = parts[0], wid = parts[1], damaged = parts[2] === 'd';
      var have = damaged ? Inventory.damaged(pid, wid) : Inventory.available(pid, wid);
      var want = demand[key];
      if (want > have) {
        var p = prodOf(pid) || {};
        errs.push('Only ' + have + ' bags of ' + (p.en || p.ur || pid) + ' are available in ' +
                  whName(wid) + (damaged ? ' (damaged stock)' : '') + '. Requested: ' + want + '.');
      }
    });
  }
  return { errs: errs, lines: clean };
}
ERP.validateLines = validateLines;

function snapshot(l, extra) {
  var p = prodOf(l.productId) || {};
  return Object.assign({
    productId: l.productId,
    descriptionSnapshot: p.ur || p.en || '',
    descriptionEnSnapshot: p.en || '',
    brandSnapshot: p.brandEn || p.brand || '',
    categorySnapshot: p.cat || '',
    packageSnapshot: p.kg ? p.kg + ' KG' : 'Bag',
    skuSnapshot: p.sku || p.sourceFolio || p.id || '',
    unit: l.unit || 'Bag',
    quantity: M.qty(l.quantity),
    batchNo: l.batchNo || '',
    notes: l.notes || ''
  }, extra || {});
}

/* ══════════════════════════════════════════════════════════════════════════
   SALES ORDERS AND QUOTATIONS (§1)
   No stock effect. An order becomes an invoice when the load goes out.
   ══════════════════════════════════════════════════════════════════════════ */
var Orders = ERP.Orders = {
  all: function () { return S.orders; },
  byId: function (id) { return S.orders.find(function (o) { return o.id === id; }) || null; },
  items: function (id) { return S.orderItems.filter(function (i) { return i.orderId === id; })
                                            .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },
  quotations: function () { return S.orders.filter(function (o) { return o.kind === 'QUOTATION'; }); },
  salesOrders: function () { return S.orders.filter(function (o) { return o.kind === 'ORDER'; }); },

  save: function (draft, opts) {
    opts = opts || {};
    var kind = draft.kind || 'ORDER';
    var errs = [];
    if (!draft.customerId || !global.custBy(draft.customerId)) errs.push('Choose a shop.');
    if (!draft.warehouseId) errs.push('Choose the warehouse the load will come from.');
    var v = validateLines(draft.items, { needRate: kind === 'QUOTATION' || !opts.draft, warehouseId: draft.warehouseId });
    errs = errs.concat(v.errs);
    if (errs.length) return Promise.reject({ validation: errs });

    var totals = ERP.Calc.invoice(Object.assign({}, draft, { items: v.lines }));
    draft.id = draft.id || FDB.uid('ord');
    var existing = Orders.byId(draft.id);
    var revision = (draft.revision === undefined || draft.revision === null ? 0 : draft.revision);
    var opId = (draft.clientOpId || draft.id) + '#' + revision;

    return FDB.tx(['sequences', 'orders', 'orderItems', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, kind, { entityId: draft.id }).then(function () {
        return (existing && existing.orderNumber ? Promise.resolve(existing.orderNumber)
                : FDB.nextNumber(api, kind === 'QUOTATION' ? 'QT' : (ERP.Settings.get().orderPrefix || 'SO')))
          .then(function (number) {
            var c = global.custBy(draft.customerId) || {};
            var region = c.region && global.regionOf ? global.regionOf(c.region) : null;
            var rec = {
              id: draft.id, orderNumber: number, kind: kind, clientOpId: draft.clientOpId || draft.id,
              revision: revision + 1,
              customerId: draft.customerId, shopNameSnapshot: c.sh || '', customerNameSnapshot: c.ow || '',
              customerCodeSnapshot: c.legacyCode || '', mobileSnapshot: c.ph || '',
              regionId: c.region || '', regionSnapshot: region ? region.ur + ' — ' + region.en : '',
              warehouseId: draft.warehouseId, warehouseSnapshot: whName(draft.warehouseId),
              orderDate: draft.orderDate || todayISO(),
              deliveryDate: draft.deliveryDate || '', validUntil: draft.validUntil || '',
              salesperson: draft.salesperson || currentUser(),
              subtotal: totals.subtotal, discountAmount: totals.discountAmount,
              taxAmount: totals.taxAmount, freightAmount: totals.freightAmount,
              loadingAmount: totals.loadingAmount, otherCharges: totals.otherCharges,
              grandTotal: totals.grandTotal, totalQty: totals.totalQty, lineCount: totals.lineCount,
              status: opts.draft ? 'DRAFT' : (existing && existing.status === 'INVOICED' ? 'INVOICED' : 'CONFIRMED'),
              invoiceId: existing ? existing.invoiceId : null,
              invoiceNumber: existing ? existing.invoiceNumber : '',
              notes: draft.notes || '',
              createdBy: currentUser(), createdAt: existing ? existing.createdAt : nowISO(), updatedAt: nowISO()
            };
            Orders.items(rec.id).forEach(function (o) { api.del('orderItems', o.id); });
            S.orderItems = S.orderItems.filter(function (i) { return i.orderId !== rec.id; });
            totals.items.forEach(function (it, ix) {
              var r = snapshot(it, {
                id: FDB.uid('oi'), orderId: rec.id, sortOrder: ix,
                unitPrice: it.unitPrice, discount: it.discount, tax: it.tax, lineTotal: it.lineTotal,
                warehouseId: it.warehouseId || rec.warehouseId, deliveredQty: 0
              });
              api.put('orderItems', r); S.orderItems.push(r);
            });
            api.put('orders', rec);
            var ix2 = S.orders.findIndex(function (o) { return o.id === rec.id; });
            if (ix2 > -1) S.orders[ix2] = rec; else S.orders.unshift(rec);
            Audit.write(api, {
              action: (kind === 'QUOTATION' ? 'Quotation' : 'Sales order') + (existing ? ' edited' : ' created'),
              entity: kind, entityId: rec.id, ref: number,
              newValues: { total: rec.grandTotal, lines: rec.lineCount }
            });
            return rec;
          });
      });
    }).then(function (r) { Mirror.refresh(); return r; });
  },

  /* Turn an order into an invoice draft — same lines, same rates, one
     parent, so nothing has to be typed twice. */
  toInvoiceDraft: function (orderId) {
    var o = Orders.byId(orderId);
    if (!o) return null;
    return {
      id: FDB.uid('inv'), clientOpId: FDB.uid('op'),
      customerId: o.customerId, warehouseId: o.warehouseId,
      invoiceDate: todayISO(), dueDate: '', orderNumber: o.orderNumber, saleOrderId: o.id,
      salesperson: o.salesperson, notes: o.notes,
      invoiceDiscount: M.toR(o.discountAmount - Orders.items(orderId).reduce(function (a, i) { return a + i.discount; }, 0)),
      freight: M.toR(o.freightAmount), loading: M.toR(o.loadingAmount), otherCharges: M.toR(o.otherCharges),
      paidAmount: 0,
      items: Orders.items(orderId).map(function (i) {
        return { productId: i.productId, quantity: i.quantity, unitPrice: M.toR(i.unitPrice),
                 discount: M.toR(i.discount), warehouseId: i.warehouseId, unit: i.unit, notes: i.notes };
      })
    };
  },
  markInvoiced: function (orderId, invoice) {
    var o = Orders.byId(orderId);
    if (!o) return Promise.resolve();
    return FDB.tx(['orders', 'auditLog'], function (api) {
      o.status = 'INVOICED'; o.invoiceId = invoice.id; o.invoiceNumber = invoice.invoiceNumber;
      o.updatedAt = nowISO();
      api.put('orders', o);
      Audit.write(api, { action: 'Order invoiced', entity: 'Order', entityId: o.id,
        ref: o.orderNumber, newValues: { invoice: invoice.invoiceNumber } });
    });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   STOCK DOCUMENTS — transfers, receiving, adjustments, dispatch (§14 §23 §24)
   One shape for all four: a parent with lines, and a movement per line.
   ══════════════════════════════════════════════════════════════════════════ */
var TYPES = {
  TRANSFER: { seq: 'TRF', title: 'Warehouse transfer', out: true },
  RECEIVE:  { seq: 'RCV', title: 'Stock received',     out: false },
  ADJUST:   { seq: 'ADJ', title: 'Stock adjustment',   out: true },
  DISPATCH: { seq: 'DSP', title: 'Dispatch',           out: true },
  /* bags re-printed as another brand: each line takes bags out of one product and puts the same
     number into another, in the same warehouse, in one atomic save */
  CONVERT:  { seq: 'CNV', title: 'Brand conversion',   out: true }
};

/* what a converted bag is worth: the cost Stock value shows for the source row (recorded average, cost carried on the
   movements, or another warehouse's average). A catalogue list price is only an estimate, so it is NOT passed on as a cost
   (0 = unknown; the new brand is then valued the way it was before). */
function convertCost(pid, wid) {
  var sv = ERP.StockValue && ERP.StockValue.costOf ? ERP.StockValue.costOf(pid, wid) : null;
  if (sv) return sv.src === 'list' ? 0 : sv.p;
  return Inventory.row(pid, wid).avgCostP || 0;
}

var StockDocs = ERP.StockDocs = {
  TYPES: TYPES,
  all: function () { return S.stockDocs; },
  byId: function (id) { return S.stockDocs.find(function (d) { return d.id === id; }) || null; },
  byType: function (t) { return S.stockDocs.filter(function (d) { return d.type === t; }); },
  items: function (id) { return S.stockDocItems.filter(function (i) { return i.docId === id; })
                                               .sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },

  save: function (draft) {
    var type = draft.type;
    var def = TYPES[type];
    if (!def) return Promise.reject({ validation: ['Unknown stock document type.'] });

    var errs = [];
    if (!draft.warehouseId) errs.push('Choose a warehouse.');
    if (type === 'TRANSFER') {
      if (!draft.toWarehouseId) errs.push('Choose the destination warehouse.');
      if (draft.toWarehouseId && draft.toWarehouseId === draft.warehouseId)
        errs.push('The source and destination warehouse cannot be the same.');
    }
    if (type === 'DISPATCH' && !draft.customerId) errs.push('Choose the shop the load is going to.');
    if (type === 'ADJUST' && !draft.reason) errs.push('Give a reason — every manual stock change is audited.');
    if (type === 'RECEIVE' && !draft.reason) errs.push('Give a reason for adding this stock.');
    /* the purchase price is required at the SCREEN, not here — this function is also every test's
       data-setup path for "add stock", most with no price typed at all (falls back to Inventory.costOf) */
    if (type === 'CONVERT') {
      (draft.items || []).forEach(function (l, n) {
        if (!l || !l.productId) return;
        var label = 'Line ' + (n + 1);
        var to = l.toProductId ? prodOf(l.toProductId) : null;
        if (!l.toProductId) errs.push(label + ': choose the brand these bags are being converted to.');
        else if (l.toProductId === l.productId) errs.push(label + ': the two brands are the same — there is nothing to convert.');
        else if (!to) errs.push(label + ': the brand you are converting to no longer exists.');
        else if (to.active === false) errs.push(label + ': ' + (to.en || to.ur) + ' is switched off — pick another brand.');
      });
    }

    /* An adjustment can go either way, so only the decreasing lines are
       checked against stock. */
    var outLines = (draft.items || []).filter(function (l) {
      if (type === 'ADJUST') return (l.direction || 'IN') === 'OUT';
      return true;
    });
    var v = validateLines(draft.items, { out: false });
    errs = errs.concat(v.errs);
    if (def.out) {
      var vOut = validateLines(outLines, { out: true, warehouseId: draft.warehouseId });
      errs = errs.concat(vOut.errs.filter(function (e) { return e.indexOf('Add at least one') === -1; }));
    }

    /* A dispatch against an invoice that already moved the stock must not
       move it a second time (§10). */
    var linkedInvoice = draft.invoiceId ? ERP.Invoices.byId(draft.invoiceId) : null;
    var deduct = type !== 'DISPATCH' || !(linkedInvoice && linkedInvoice.stockApplied);
    if (type === 'DISPATCH' && !deduct) errs = errs.filter(function (e) { return e.indexOf('Only ') !== 0; });
    if (errs.length) return Promise.reject({ validation: errs });

    draft.id = draft.id || FDB.uid('sd');
    var opId = (draft.clientOpId || draft.id) + '#0';

    return FDB.tx(['sequences', 'stockDocs', 'stockDocItems', 'inventory', 'stockMovements',
                   'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'StockDoc:' + type, { entityId: draft.id }).then(function () {
        return FDB.nextNumber(api, def.seq).then(function (number) {
          var c = draft.customerId && global.custBy ? global.custBy(draft.customerId) : null;
          var rec = {
            id: draft.id, docNumber: number, type: type, clientOpId: draft.clientOpId || draft.id,
            docDate: draft.date || todayISO(),
            warehouseId: draft.warehouseId, warehouseSnapshot: whName(draft.warehouseId),
            toWarehouseId: draft.toWarehouseId || null,
            toWarehouseSnapshot: draft.toWarehouseId ? whName(draft.toWarehouseId) : '',
            customerId: draft.customerId || null,
            customerSnapshot: c ? c.sh : '',
            regionSnapshot: c && c.region && global.regionOf
              ? (function (r) { return r ? r.ur + ' — ' + r.en : ''; })(global.regionOf(c.region)) : '',
            invoiceId: draft.invoiceId || null,
            invoiceNumber: linkedInvoice ? linkedInvoice.invoiceNumber : '',
            stockApplied: deduct,
            vehicleNo: (draft.vehicleNo || '').toUpperCase(), driver: draft.driver || '',
            reason: draft.reason || (type === 'CONVERT' ? 'Brand conversion' : ''), notes: draft.notes || '',
            totalQty: 0, lineCount: 0, status: 'POSTED',
            createdBy: currentUser(), createdAt: nowISO()
          };
          var qty = 0;
          v.lines.forEach(function (l, ix) {
            var q = M.qty(l.quantity);
            var direction = type === 'ADJUST' ? (l.direction || 'IN') : (def.out ? 'OUT' : 'IN');
            var toProd = type === 'CONVERT' ? prodOf(l.toProductId) : null;
            var r = snapshot(l, {
              id: FDB.uid('sdi'), docId: rec.id, sortOrder: ix, direction: direction,
              warehouseId: l.warehouseId || rec.warehouseId,
              toWarehouseId: rec.toWarehouseId, reason: l.reason || rec.reason,
              fromDamaged: !!l.fromDamaged,
              unitCostP: l.unitPrice ? M.toP(l.unitPrice)
                       : type === 'CONVERT' ? convertCost(l.productId, l.warehouseId || rec.warehouseId)
                       : Inventory.costOf(l.productId, rec.warehouseId)
            });
            if (toProd) {
              r.toProductId = toProd.id;
              r.toDescriptionSnapshot = toProd.ur || toProd.en || '';
              r.toDescriptionEnSnapshot = toProd.en || '';
              r.toBrandSnapshot = toProd.brandEn || toProd.brand || '';
              r.toPackageSnapshot = toProd.kg ? toProd.kg + ' KG' : 'Bag';
            }
            /* Extra cost per bag, typed once per PRODUCT on the Add-stock screen (§26, 2026-09-28) — kept on
               the line (set BEFORE the put) so a later edit can see what it came in at. A figure typed this
               time wins; blank falls to the product's own saved figure. The selling price is NOT typed here
               any more (2026-09-28, client): it is set only on the product's Prices screen. */
            if (type === 'RECEIVE') {
              r.extraUnitP = l.extraPerBag !== undefined && l.extraPerBag !== '' ? M.toP(l.extraPerBag) : Inventory.rawExtraOf(r.productId);
            }
            api.put('stockDocItems', r); S.stockDocItems.push(r);
            qty += q;

            if (type === 'TRANSFER') {
              /* both sides of a transfer commit together, or neither does */
              Inventory.apply(api, { productId: r.productId, warehouseId: r.warehouseId, qtyDelta: -q,
                kind: 'TRANSFER_OUT', ref: number, refType: 'TRANSFER',
                note: 'To ' + rec.toWarehouseSnapshot, date: rec.docDate });
              Inventory.apply(api, { productId: r.productId, warehouseId: rec.toWarehouseId, qtyDelta: q,
                kind: 'TRANSFER_IN', ref: number, refType: 'TRANSFER',
                note: 'From ' + rec.warehouseSnapshot, date: rec.docDate, unitCostP: r.unitCostP,
                extraCostP: Inventory.rowExtraP(r.productId, r.warehouseId),   /* the bags keep the extra they had */
                carriageCostP: Inventory.rowCarriageP(r.productId, r.warehouseId) });   /* ...and their carriage (§29) */
            } else if (type === 'RECEIVE') {
              Inventory.apply(api, { productId: r.productId, warehouseId: r.warehouseId, qtyDelta: q,
                kind: draft.opening ? 'OPENING_STOCK' : 'ADJUSTMENT_IN', ref: number, refType: 'STOCK_RECEIPT',
                note: rec.reason, date: rec.docDate, unitCostP: r.unitCostP, extraCostP: r.extraUnitP });
            } else if (type === 'ADJUST') {
              Inventory.apply(api, {
                productId: r.productId, warehouseId: r.warehouseId,
                qtyDelta: direction === 'OUT' ? -q : q,
                bucket: r.fromDamaged ? 'damaged' : 'stock',
                kind: direction === 'OUT' ? 'ADJUSTMENT_OUT' : 'ADJUSTMENT_IN',
                ref: number, refType: 'ADJUSTMENT', note: r.reason, date: rec.docDate });
            } else if (type === 'CONVERT') {
              /* both sides commit together, or neither does; the new brand is carried at the old brand's cost
                 so the stock value does not jump just because the bag was re-printed */
              Inventory.apply(api, { productId: r.productId, warehouseId: r.warehouseId, qtyDelta: -q,
                kind: 'CONVERT_OUT', ref: number, refType: 'CONVERSION',
                note: 'Converted to ' + (r.toDescriptionEnSnapshot || r.toProductId), date: rec.docDate,
                unitCostP: r.unitCostP });
              Inventory.apply(api, { productId: r.toProductId, warehouseId: r.warehouseId, qtyDelta: q,
                kind: 'CONVERT_IN', ref: number, refType: 'CONVERSION',
                note: 'Converted from ' + (r.descriptionEnSnapshot || r.productId), date: rec.docDate,
                unitCostP: r.unitCostP, extraCostP: Inventory.rowExtraP(r.productId, r.warehouseId),
                carriageCostP: Inventory.rowCarriageP(r.productId, r.warehouseId) });
            } else if (type === 'DISPATCH' && deduct) {
              Inventory.apply(api, { productId: r.productId, warehouseId: r.warehouseId, qtyDelta: -q,
                kind: 'DISPATCH_OUT', ref: number, refType: 'DISPATCH',
                note: rec.customerSnapshot, date: rec.docDate });
            }
          });
          rec.totalQty = qty; rec.lineCount = v.lines.length;
          api.put('stockDocs', rec); S.stockDocs.unshift(rec);

          if (type === 'DISPATCH' && linkedInvoice) {
            linkedInvoice.dispatchNumber = number;
            linkedInvoice.status = linkedInvoice.status === 'CONFIRMED' ? 'DISPATCHED' : linkedInvoice.status;
            linkedInvoice.updatedAt = nowISO();
          }
          Audit.write(api, {
            action: def.title + ' posted', entity: 'StockDoc', entityId: rec.id, ref: number,
            newValues: Object.assign({ type: type, lines: rec.lineCount, qty: qty,
                         stockMoved: type === 'DISPATCH' ? deduct : true },
              type === 'CONVERT' ? { conversions: S.stockDocItems.filter(function (i) { return i.docId === rec.id; })
                .map(function (i) { return i.descriptionEnSnapshot + ' → ' + i.toDescriptionEnSnapshot + ' × ' + i.quantity; }) } : {}),
            reason: rec.reason
          });
          return rec;
        });
      });
    }).then(function (rec) {
      if (rec.type === 'DISPATCH' && rec.invoiceId) {
        return FDB.tx(['invoices'], function (api) {
          var inv = ERP.Invoices.byId(rec.invoiceId);
          if (inv) api.put('invoices', inv);
        }).then(function () { Mirror.refresh(); return rec; });
      }
      Mirror.refresh(); return rec;
    });
  },

  transfer: function (d) { return StockDocs.save(Object.assign({}, d, { type: 'TRANSFER' })); },
  receive:  function (d) { return StockDocs.save(Object.assign({}, d, { type: 'RECEIVE' })); },
  adjust:   function (d) { return StockDocs.save(Object.assign({}, d, { type: 'ADJUST' })); },
  convert:  function (d) { return StockDocs.save(Object.assign({}, d, { type: 'CONVERT' })); },
  dispatch: function (d) { return StockDocs.save(Object.assign({}, d, { type: 'DISPATCH' })); },

  /* ── editing a posted "Add stock" receipt (client request, 2026-09-25) ──
     Same shape as the purchase edit (02-services.js Purchases.save): the old
     lines come back OUT of stock, dated as the original receipt, and the
     corrected lines go IN again — one atomic save, same RCV number. The
     reversal is its own movement kind, RECEIPT_EDIT_OUT, carrying the old
     line's cost, so the carried cost (Inventory.carriedCost, Stock value)
     drops the old figure instead of averaging it with the corrected one.
     Only RECEIVE documents; transfers / adjustments / conversions / dispatches
     are not editable. */
  canEdit: function (d) {
    return !!d && d.type === 'RECEIVE' && d.status !== 'CANCELLED' &&
           (!ERP.Can || ERP.Can('STOCK_MANAGE') || ERP.Can('TRANSACTION_CORRECT'));
  },
  /* the form the edit screen starts from */
  toDraft: function (d) {
    return {
      id: d.id, existing: true, revision: d.revision || 0, clientOpId: d.clientOpId || d.id,
      warehouseId: d.warehouseId, date: d.docDate, reason: d.reason || '', notes: d.notes || '',
      items: StockDocs.items(d.id).map(function (it) {
        return {
          lineId: FDB.uid('ln'), productId: it.productId, quantity: it.quantity,
          unitPrice: it.unitCostP ? M.toR(it.unitCostP) : '', discount: '', receivedQty: '',
          direction: 'IN', warehouseId: it.warehouseId || d.warehouseId, fromDamaged: false,
          toProductId: '', batchNo: it.batchNo || '', notes: it.notes || '', unit: it.unit || 'Bag',
          extraPerBag: it.extraUnitP > 0 ? M.toR(it.extraUnitP) : ''
        };
      })
    };
  },
  editReceive: function (draft) {
    var prior = draft && draft.id ? StockDocs.byId(draft.id) : null;
    if (!prior || prior.type !== 'RECEIVE') return Promise.reject({ validation: ['Stock receipt not found.'] });
    if (!StockDocs.canEdit(prior)) return Promise.reject({ validation: ['You are not allowed to edit a stock receipt.'] });
    var errs = [];
    if (!draft.warehouseId) errs.push('Choose a warehouse.');
    if (!draft.reason) errs.push('Give a reason for adding this stock.');
    var v = validateLines(draft.items, { out: false });
    errs = errs.concat(v.errs);
    v.lines.forEach(function (l, n) {
      if (l.unitPrice && M.toP(l.unitPrice) < 0) errs.push('Line ' + (n + 1) + ': the cost cannot be negative.');
    });

    var oldItems = StockDocs.items(prior.id);
    /* the stock guard is on the NET change per product and warehouse: bags this
       receipt brought in may since have been sold or moved, and taking back
       more than is still there would push the stock below zero */
    if (!errs.length && !ERP.Settings.allowNegativeStock()) {
      var net = {}, label = {};
      var key = function (pid, wid) { var k = pid + '|' + wid; label[k] = { pid: pid, wid: wid }; return k; };
      oldItems.forEach(function (o) {
        var k = key(o.productId, o.warehouseId || prior.warehouseId);
        net[k] = (net[k] || 0) - (Number(o.quantity) || 0);
      });
      v.lines.forEach(function (l) {
        var k = key(l.productId, l.warehouseId || draft.warehouseId);
        net[k] = (net[k] || 0) + M.qty(l.quantity);
      });
      Object.keys(net).forEach(function (k) {
        var d = Math.round(net[k] * 1000) / 1000;
        if (d >= 0) return;
        var have = Inventory.available(label[k].pid, label[k].wid);
        if (have + d < 0) {
          var p = prodOf(label[k].pid) || {};
          errs.push('Only ' + have + ' bags of ' + (p.en || p.ur || 'that product') + ' are in ' +
            whName(label[k].wid) + ' now, but this edit takes ' + (-d) + ' bags back out of stock. ' +
            'The rest of that receipt has already been sold or moved, so it cannot be reduced by that much.');
        }
      });
    }
    if (errs.length) return Promise.reject({ validation: errs });

    var revision = prior.revision || 0;
    var opId = (prior.clientOpId || prior.id) + '#edit' + (revision + 1);
    var number = prior.docNumber;
    /* a receipt posted as opening stock is re-posted as opening stock */
    var wasOpening = (S.movements || []).some(function (mv) {
      return mv.ref === number && mv.refType === 'STOCK_RECEIPT' && mv.kind === 'OPENING_STOCK';
    });

    return FDB.tx(['stockDocs', 'stockDocItems', 'inventory', 'stockMovements', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'StockDocEdit:RECEIVE', { entityId: prior.id }).then(function () {
        var before = { warehouse: prior.warehouseSnapshot, date: prior.docDate, reason: prior.reason,
          qty: prior.totalQty, lines: oldItems.map(function (i) {
            return (i.descriptionEnSnapshot || i.productId) + ' × ' + i.quantity + (i.unitCostP ? ' @ ' + M.toR(i.unitCostP) : '');
          }) };
        /* the extra cost per bag the old lines came in with: an edit takes exactly that back out,
           and a line kept for the same product and warehouse goes back in with it (unless typed over below), so
           it does not re-price the bags around it */
        var oldExtra = {}, exKey = function (pid, wid) { return pid + '|' + wid; };
        oldItems.forEach(function (o) {
          var w = o.warehouseId || prior.warehouseId;
          var ex = typeof o.extraUnitP === 'number' ? o.extraUnitP : Inventory.rowExtraP(o.productId, w);
          if (oldExtra[exKey(o.productId, w)] === undefined) oldExtra[exKey(o.productId, w)] = ex;
          var q = Number(o.quantity) || 0;
          if (q > 0) {
            Inventory.apply(api, { productId: o.productId, warehouseId: w,
              qtyDelta: -q, kind: 'RECEIPT_EDIT_OUT', ref: number, refType: 'STOCK_RECEIPT_EDIT',
              note: 'Reversed on receipt edit', date: prior.docDate, unitCostP: o.unitCostP || 0, extraCostP: ex,
              carriageCostP: 0 });   /* an Add-stock receipt never had carriage: take its bags out at 0 so the re-post nets to nothing (§29) */
          }
          api.del('stockDocItems', o.id);
        });
        S.stockDocItems = S.stockDocItems.filter(function (i) { return i.docId !== prior.id; });

        var rec = Object.assign({}, prior, {
          docDate: draft.date || prior.docDate,
          warehouseId: draft.warehouseId, warehouseSnapshot: whName(draft.warehouseId),
          reason: draft.reason || '', notes: draft.notes || '',
          revision: revision + 1, updatedAt: nowISO(), updatedBy: currentUser()
        });
        var qty = 0;
        v.lines.forEach(function (l, ix) {
          var q = M.qty(l.quantity);
          var r = snapshot(l, {
            id: FDB.uid('sdi'), docId: rec.id, sortOrder: ix, direction: 'IN',
            warehouseId: l.warehouseId || rec.warehouseId, toWarehouseId: null,
            reason: l.reason || rec.reason, fromDamaged: false,
            unitCostP: l.unitPrice ? M.toP(l.unitPrice) : Inventory.costOf(l.productId, rec.warehouseId)
          });
          var exKept = oldExtra[exKey(r.productId, r.warehouseId)];
          r.extraUnitP = l.extraPerBag !== undefined && l.extraPerBag !== '' ? M.toP(l.extraPerBag)
            : (exKept !== undefined ? exKept : Inventory.rawExtraOf(r.productId));
          api.put('stockDocItems', r); S.stockDocItems.push(r);
          qty += q;
          Inventory.apply(api, { productId: r.productId, warehouseId: r.warehouseId, qtyDelta: q,
            kind: wasOpening ? 'OPENING_STOCK' : 'ADJUSTMENT_IN', ref: number, refType: 'STOCK_RECEIPT',
            note: rec.reason, date: rec.docDate, unitCostP: r.unitCostP, extraCostP: r.extraUnitP });
        });
        rec.totalQty = qty; rec.lineCount = v.lines.length;
        api.put('stockDocs', rec);
        var ix2 = S.stockDocs.findIndex(function (d) { return d.id === rec.id; });
        if (ix2 > -1) S.stockDocs[ix2] = rec; else S.stockDocs.unshift(rec);

        Audit.write(api, {
          action: 'Stock receipt edited', entity: 'StockDoc', entityId: rec.id, ref: number,
          oldValues: before,
          newValues: { warehouse: rec.warehouseSnapshot, date: rec.docDate, reason: rec.reason, qty: qty,
            lines: S.stockDocItems.filter(function (i) { return i.docId === rec.id; }).map(function (i) {
              return (i.descriptionEnSnapshot || i.productId) + ' × ' + i.quantity + (i.unitCostP ? ' @ ' + M.toR(i.unitCostP) : '');
            }) },
          reason: rec.reason
        });
        return rec;
      });
    }).then(function (rec) { Mirror.refresh(); return rec; });
  }
};

/* ── load the new parents at boot and keep the old screens fed ── */
var origBoot = ERP.boot;
ERP.boot = function () {
  return origBoot.call(ERP).then(function (r) {
    return FDB.hydrate().then(function (data) {
      /* merge rather than replace: the migration may have put rows in memory
         that this read is a moment too early to see */
      function merge(existing, loaded, key) {
        var seen = {};
        (loaded || []).forEach(function (r) { seen[r[key]] = r; });
        (existing || []).forEach(function (r) { if (!seen[r[key]]) seen[r[key]] = r; });
        return Object.keys(seen).map(function (k) { return seen[k]; });
      }
      S.orders        = merge(S.orders, data.orders, 'id');
      S.orderItems    = merge(S.orderItems, data.orderItems, 'id');
      S.stockDocs     = merge(S.stockDocs, data.stockDocs, 'id')
                          .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
      S.stockDocItems = merge(S.stockDocItems, data.stockDocItems, 'id');
      MirrorExtra();
      return r;
    }).catch(function () { return r; });
  });
};

/* the original Orders and Dispatch screens read these arrays */
function MirrorExtra() {
  var fmtDate = global.fmtDate || function (x) { return x; };
  if (global.ORDERS) {
    global.ORDERS.length = 0;
    S.orders.forEach(function (o) {
      var items = Orders.items(o.id), first = items[0] || {};
      global.ORDERS.push({
        id: o.orderNumber, ordId: o.id, cust: o.customerId, wid: o.warehouseId,
        pid: first.productId, qty: o.totalQty, lines: items.length,
        amt: M.toR(o.grandTotal), st: o.status === 'INVOICED' ? 'Invoiced'
          : o.status === 'DRAFT' ? 'Draft' : o.kind === 'QUOTATION' ? 'Quotation' : 'Confirmed',
        date: fmtDate(o.orderDate), iso: o.orderDate
      });
    });
  }
  if (global.DISPATCH) {
    global.DISPATCH.length = 0;
    StockDocs.byType('DISPATCH').forEach(function (d) {
      var items = StockDocs.items(d.id), first = items[0] || {};
      global.DISPATCH.push({
        id: d.docNumber, docId: d.id, cust: d.customerId, wid: d.warehouseId,
        pid: first.productId, qty: d.totalQty, lines: items.length,
        veh: d.vehicleNo, driver: d.driver, st: 'Dispatched',
        date: fmtDate(d.docDate), iso: d.docDate
      });
    });
  }
}
var origRefresh = Mirror.refresh;
Mirror.refresh = function () { origRefresh.call(Mirror); try { MirrorExtra(); } catch (e) {} };
ERP.MirrorExtra = MirrorExtra;

/* Reports that count parents once and lines individually (§28 §37) */
ERP.Reports.transfers = function (from, to) {
  return StockDocs.byType('TRANSFER').filter(function (d) {
    return (!from || d.docDate >= from) && (!to || d.docDate <= to);
  });
};
ERP.Reports.stockDocs = function (type, from, to) {
  return StockDocs.byType(type).filter(function (d) {
    return (!from || d.docDate >= from) && (!to || d.docDate <= to);
  });
};
})(typeof window !== 'undefined' ? window : globalThis);
