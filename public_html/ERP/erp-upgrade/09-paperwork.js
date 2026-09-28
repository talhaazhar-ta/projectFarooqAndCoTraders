/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 9
   THE REST OF THE PAPERWORK
   Order confirmations, quotations, transfer notes, stock receipts,
   adjustment notes and dispatch notes — printable, downloadable and
   emailable like every other document. Plus the SMS provider settings the
   notification hooks read.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var ERP = global.ERP, M = global.Money, D = global.document;
var DocModel = ERP.DocModel, Viewer = ERP.Viewer, S = ERP.S;

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
var I = function (n) { return global.I ? global.I(n) : ''; };
function fmtDate(iso) { return global.fmtDate ? global.fmtDate(iso) : iso; }
function qtyFmt(q) { return Number(q || 0).toLocaleString('en-US'); }
function say(m) { return global.say ? global.say(m) : null; }

/* ── order / quotation ─────────────────────────────────────────────────── */
DocModel.order = function (orderId) {
  var o = ERP.Orders.byId(orderId);
  if (!o) return null;
  var items = ERP.Orders.items(orderId);
  var quote = o.kind === 'QUOTATION';
  var totals = [{ label: 'Subtotal', value: M.fmt(o.subtotal) }];
  if (o.discountAmount) totals.push({ label: 'Discount', value: '− ' + M.fmt(o.discountAmount) });
  if (o.freightAmount)  totals.push({ label: 'Delivery / freight', value: M.fmt(o.freightAmount) });
  if (o.loadingAmount)  totals.push({ label: 'Loading / unloading', value: M.fmt(o.loadingAmount) });
  if (o.otherCharges)   totals.push({ label: 'Other charges', value: M.fmt(o.otherCharges) });
  totals.push({ label: quote ? 'Quoted total' : 'Order total', value: M.fmt(o.grandTotal), big: true, rule: true });
  return {
    kind: quote ? 'QUOTATION' : 'ORDER', entityId: o.id, template: 'modern',
    title: quote ? 'QUOTATION' : 'SALES ORDER', number: o.orderNumber,
    status: ERP.STATUS_LABEL[o.status] || o.status,
    isDraft: o.status === 'DRAFT', date: fmtDate(o.orderDate), rawDate: o.orderDate,
    business: DocModel.business(),
    party: {
      label: quote ? 'QUOTED TO' : 'ORDER FOR', shop: o.shopNameSnapshot, owner: o.customerNameSnapshot,
      code: o.customerCodeSnapshot, contact: o.mobileSnapshot, region: o.regionSnapshot, id: o.customerId
    },
    metaLabel: quote ? 'QUOTATION DETAILS' : 'ORDER DETAILS',
    meta: [[quote ? 'Quotation No' : 'Order No', o.orderNumber, true],
           ['Date', fmtDate(o.orderDate)],
           [quote ? 'Valid until' : 'Delivery date', o.validUntil || o.deliveryDate ? fmtDate(o.validUntil || o.deliveryDate) : '—'],
           ['Warehouse', o.warehouseSnapshot], ['Salesperson', o.salesperson],
           ['Invoice raised', o.invoiceNumber || '—']],
    strip: [['Status', ERP.STATUS_LABEL[o.status] || o.status], ['Bags', qtyFmt(o.totalQty)],
            ['Lines', String(items.length)], ['Region', o.regionSnapshot || '—']],
    columns: [
      { key: 'sr', label: 'SR', align: 'center', width: 0.05 },
      { key: 'description', label: 'Description', width: 0.34 },
      { key: 'brand', label: 'Brand', width: 0.14 },
      { key: 'pack', label: 'Package', align: 'center', width: 0.10 },
      { key: 'qty', label: 'Qty', align: 'right', width: 0.10 },
      { key: 'rate', label: 'Rate', align: 'right', width: 0.12 },
      { key: 'amount', label: 'Amount', align: 'right', width: 0.15 }
    ],
    rows: items.map(function (it, i) {
      return { sr: i + 1, description: it.descriptionEnSnapshot, descriptionUr: it.descriptionSnapshot,
               brand: it.brandSnapshot || '—', pack: it.packageSnapshot, qty: qtyFmt(it.quantity),
               rate: M.fmtPlain(it.unitPrice), amount: M.fmtPlain(it.lineTotal) };
    }),
    itemsFooter: { description: 'Total — ' + items.length + ' lines', qty: qtyFmt(o.totalQty),
                   amount: M.fmtPlain(o.subtotal) },
    totals: totals, words: global.words ? global.words(Math.round(M.toR(o.grandTotal))) : '',
    notes: o.notes || '', ledger: [],
    signatures: quote ? ['Prepared by', 'Accepted by (customer)'] : ['Prepared by', 'Confirmed by (customer)'],
    footer: {
      thanks: quote ? 'This quotation is subject to stock and price at the time of delivery.'
                    : 'Goods will be dispatched against this order.',
      terms: ERP.Settings.get().terms || '', bank: ''
    },
    actions: { whatsapp: true, sms: true, email: true, invoice: !quote && o.status !== 'INVOICED' }
  };
};

/* ── transfer / receipt / adjustment / dispatch notes ──────────────────── */
var DOC_TITLE = {
  TRANSFER: 'WAREHOUSE TRANSFER NOTE', RECEIVE: 'STOCK RECEIPT NOTE',
  ADJUST: 'STOCK ADJUSTMENT NOTE', DISPATCH: 'DISPATCH NOTE', CONVERT: 'BRAND CONVERSION NOTE'
};
DocModel.stockDoc = function (docId) {
  var d = ERP.StockDocs.byId(docId);
  if (!d) return null;
  var items = ERP.StockDocs.items(docId);
  var isTransfer = d.type === 'TRANSFER', isAdjust = d.type === 'ADJUST', isConvert = d.type === 'CONVERT';
  return {
    kind: 'STOCK_' + d.type, entityId: d.id, template: 'modern',
    title: DOC_TITLE[d.type] || 'STOCK NOTE', number: d.docNumber,
    status: d.stockApplied === false ? 'Delivery record only' : 'Posted',
    date: fmtDate(d.docDate), rawDate: d.docDate,
    business: DocModel.business(),
    party: {
      label: isTransfer ? 'MOVED TO' : d.type === 'DISPATCH' ? 'DELIVER TO' : 'WAREHOUSE',
      shop: isTransfer ? d.toWarehouseSnapshot : (d.customerSnapshot || d.warehouseSnapshot),
      region: d.regionSnapshot || '', id: d.customerId || null
    },
    metaLabel: 'DOCUMENT DETAILS',
    meta: [['Number', d.docNumber, true], ['Date', fmtDate(d.docDate)],
           [isTransfer ? 'From warehouse' : 'Warehouse', d.warehouseSnapshot],
           isTransfer ? ['To warehouse', d.toWarehouseSnapshot] : ['Reason', d.reason || '—'],
           ['Vehicle', d.vehicleNo || ''], ['Driver', d.driver || ''],
           ['Against invoice', d.invoiceNumber || '']],
    strip: [['Bags', qtyFmt(d.totalQty)], ['Lines', String(items.length)],
            ['Stock moved', d.stockApplied === false ? 'No — already taken out on the invoice' : 'Yes'],
            ['Prepared by', d.createdBy || '—']],
    columns: [
      { key: 'sr', label: 'SR', align: 'center', width: 0.06 },
      { key: 'description', label: isConvert ? 'Converted from' : 'Description', width: isConvert ? 0.30 : 0.40 },
      { key: 'pack', label: 'Package', align: 'center', width: 0.14 },
      { key: 'brand', label: isAdjust ? 'In / out' : isConvert ? 'Converted to' : 'Warehouse', width: isConvert ? 0.30 : 0.20 },
      { key: 'qty', label: 'Qty', align: 'right', width: 0.20 }
    ],
    rows: items.map(function (it, i) {
      return {
        sr: i + 1, description: it.descriptionEnSnapshot, descriptionUr: it.descriptionSnapshot,
        pack: it.packageSnapshot,
        brand: isAdjust ? (it.direction === 'OUT' ? 'Decrease' : 'Increase')
             : isConvert ? (it.toDescriptionEnSnapshot || '')
                        : (global.whName ? global.whName(it.warehouseId) : ''),
        qty: qtyFmt(it.quantity) + (it.fromDamaged ? ' (damaged)' : '')
      };
    }),
    itemsFooter: { description: 'Total — ' + items.length + ' lines', qty: qtyFmt(d.totalQty) },
    totals: [], words: '', notes: d.notes || d.reason || '', ledger: [],
    signatures: isTransfer ? ['Sent by', 'Received by (destination)']
              : d.type === 'DISPATCH' ? ['Loaded by', 'Driver', 'Received by (shop)']
              : ['Counted by', 'Approved by'],
    footer: { thanks: '', terms: '', bank: '' },
    actions: { whatsapp: d.type === 'DISPATCH', email: true, edit: ERP.StockDocs.canEdit(d) }
  };
};

/* ── editing a posted "Add stock" receipt (07-transactions.js StockDocs.editReceive) ── */
ERP.editStockReceipt = function (id) {
  var d = ERP.StockDocs.byId(id);
  if (!d) { if (global.say) global.say('Stock receipt not found.'); return; }
  if (!ERP.StockDocs.canEdit(d)) { if (global.say) global.say('You are not allowed to edit this stock receipt.'); return; }
  ERP.UI.confirm('Edit stock receipt ' + d.docNumber + '?', {
    detail: 'Saving the change takes the old lines back out of stock and puts the corrected ones in, ' +
      'under the same number. The change is recorded in the audit log.',
    okText: 'Continue editing', cancelText: 'Cancel', tone: 'warn'
  }).then(function (ok) {
    if (ok) ERP.Builder.start('receive', ERP.StockDocs.toDraft(d));
  });
};
D.addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('[data-fcsdedit]') : null;
  if (!b) return;
  e.preventDefault();
  ERP.editStockReceipt(b.dataset.fcsdedit);
}, true);

/* every document number resolves to its document */
var origOpenDoc = global.openDoc;
global.openDoc = function (no) {
  var o = S.orders.find(function (x) { return x.orderNumber === no; });
  if (o) { Viewer.open(DocModel.order(o.id)); return; }
  var sd = S.stockDocs.find(function (x) { return x.docNumber === no; });
  if (sd) { Viewer.open(DocModel.stockDoc(sd.id)); return; }
  return origOpenDoc.call(global, no);
};

/* ── email + "raise invoice" on the viewer toolbar ─────────────────────── */
Viewer.email = function () {
  var m = Viewer.current; if (!m) return;
  var body = ERP.Paper.waText(m);
  var to = '';
  if (m.party && m.party.id && global.custBy) {
    var c = global.custBy(m.party.id);
    to = (c && c.email) || '';
  }
  var subject = m.business.name + ' — ' + m.title + ' ' + (m.number || '');
  ERP.Audit.detached({ action: 'Emailed', entity: m.kind, entityId: m.entityId, ref: m.number });
  try {
    global.open('mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) +
                '&body=' + encodeURIComponent(body), '_blank');
  } catch (e) {}
  say('Email opened. Attach the downloaded PDF or Word file before sending.');
};

/* the toolbar is built in module 4 — extend it rather than replace it */
var origOpen = Viewer.open;
Viewer.open = function (model, opts) {
  origOpen.call(Viewer, model, opts);
  if (!model || !model.actions) return;
  var bar = D.querySelector('#fcviewer .fcv-bar');
  if (!bar) return;
  var closeBtn = bar.querySelector('[data-fcv="close"]');
  function add(act, label, cls) {
    if (bar.querySelector('[data-fcv="' + act + '"]')) return;
    var b = D.createElement('button');
    b.className = 'fcv-btn ' + (cls || '');
    b.setAttribute('data-fcv', act);
    b.textContent = label;
    bar.insertBefore(b, closeBtn);
  }
  if (model.actions.email) add('email', 'Email');
  if (model.actions.invoice) add('toinvoice', 'Raise Invoice', 'pri');
};

D.addEventListener('click', function (e) {
  if (!e.target.closest) return;

  /* the Open buttons on the order and stock-document lists */
  var sd = e.target.closest('[data-fcdoc]');
  if (sd) {
    e.preventDefault();
    var model = sd.dataset.fcdoc === 'order' ? DocModel.order(sd.dataset.id)
                                             : DocModel.stockDoc(sd.dataset.id);
    if (model) Viewer.open(model); else say('That document could not be built.');
    return;
  }

  var t = e.target.closest('[data-fcv]');
  if (!t) return;
  var act = t.dataset.fcv;
  if (act === 'email') { e.preventDefault(); Viewer.email(); return; }
  if (act === 'toinvoice') {
    e.preventDefault();
    var m = Viewer.current; if (!m) return;
    Viewer.close();
    var draft = ERP.Orders.toInvoiceDraft(m.entityId);
    if (!draft) { say('That order could not be opened.'); return; }
    ERP.Builder.start('sale', draft);
    say('The order has been carried into a new invoice. Check the rates, then save.');
    return;
  }
}, true);

/* ── orders page: the real order records, with their documents ─────────── */
var origOrders = global.PAGES.orders;
global.PAGES.orders = function () {
  var list = ERP.Orders.all();
  var head = '<div class="bar">' +
    '<div class="grow"></div>' +
    '<button class="btn" data-fcnew="quotation">' + I('doc') + 'New Quotation</button>' +
    '<button class="btn pri" data-fcnew="order">' + I('plus') + 'New Order</button></div>';
  var table = list.length
    ? '<div class="card"><div class="card-h"><h3>Orders &amp; quotations</h3>' +
      '<span class="pill neu">' + list.length + '</span></div><div class="card-b">' +
      '<div class="tw"><table class="fcb-list"><thead><tr><th>Number</th><th>Date</th><th>Shop</th>' +
      '<th class="c">Items</th><th class="r">Bags</th><th class="r">Total</th><th>Status</th>' +
      '<th class="c">Actions</th></tr></thead><tbody>' +
      list.map(function (o) {
        return '<tr><td class="mono"><b>' + esc(o.orderNumber) + '</b></td>' +
          '<td>' + esc(fmtDate(o.orderDate)) + '</td>' +
          '<td>' + esc(o.shopNameSnapshot) + '</td>' +
          '<td class="c num">' + o.lineCount + '</td>' +
          '<td class="r num">' + qtyFmt(o.totalQty) + '</td>' +
          '<td class="r num">' + M.fmtPlain(o.grandTotal) + '</td>' +
          '<td>' + (global.pill ? global.pill(o.status === 'INVOICED' ? 'ok' : 'neu',
            ERP.STATUS_LABEL[o.status] || o.status) : o.status) + '</td>' +
          '<td class="c fcb-rowacts"><button class="btn sm" data-fcdoc="order" data-id="' + o.id + '">Open</button>' +
          (o.status !== 'INVOICED' ? '<button class="btn sm" data-fcorder="invoice" data-id="' + o.id +
            '">Invoice</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>'
    : '<div class="empty"><div class="ei">' + I('doc') + '</div><b>No orders yet</b>' +
      '<p>An order reserves nothing — it simply records what a shop has asked for.</p>' +
      '<button class="btn pri" data-fcnew="order">' + I('plus') + 'New Order</button></div>';
  return head + table;
};

/* ── dispatch and stock-document lists ─────────────────────────────────── */
/* "Taj Mahal Sella → Al Mamu Sella × 40" for a brand conversion (first line, then "+N more") */
function convertSummary(d) {
  var items = ERP.StockDocs.items(d.id);
  if (!items.length) return '';
  var f = items[0];
  return f.descriptionEnSnapshot + ' → ' + f.toDescriptionEnSnapshot + ' × ' + qtyFmt(f.quantity) +
    (items.length > 1 ? ' +' + (items.length - 1) + ' more' : '');
}
/* the product names on a stock document, for the search box and the row's data-row text (§26, 2026-09-28:
   client — "Stock receipts... a product can be searched and only those lists where that product is") */
function docProductNames(d) {
  return ERP.StockDocs.items(d.id).map(function (i) {
    return i.descriptionEnSnapshot || i.descriptionSnapshot || '';
  }).filter(Boolean).join(' ');
}
function docTable(type, title, empty) {
  var list = ERP.StockDocs.byType(type);
  if (!list.length) return '<div class="empty"><div class="ei">' + I('box') + '</div><b>' + empty + '</b></div>';
  /* a shared search box (module 42/base toolbar pattern): typing filters the [data-row] rows below by
     product name, document number, warehouse or reason — RECEIVE is the one this was asked for, but every
     stock-document list gets it, since they all share this one renderer */
  var boxId = 'fcdocq-' + type;
  return '<div class="card"><div class="card-h"><h3>' + title + '</h3>' +
    '<span class="pill neu">' + list.length + '</span></div><div class="card-b">' +
    '<div class="bar"><div class="tsearch">' + I('search') + '<input id="' + boxId + '" data-fcdocq="' + type +
      '" placeholder="Search by product, number, warehouse…" value=""></div></div>' +
    '<div class="tw"><table class="fcb-list"><thead><tr><th>Number</th><th>Date</th><th>Warehouse</th>' +
    '<th class="c">Lines</th><th class="r">Bags</th><th>Detail</th><th class="c">Document</th>' +
    '</tr></thead><tbody id="fcdoctb-' + type + '">' + docRows(list) + '</tbody></table></div></div></div>';
}
function docRows(list) {
  return list.map(function (d) {
    var hay = [d.docNumber, d.warehouseSnapshot, d.toWarehouseSnapshot, d.customerSnapshot, d.reason, docProductNames(d)]
      .filter(Boolean).join(' ');
    return '<tr data-row="' + esc(hay.toLowerCase()) + '"><td class="mono"><b>' + esc(d.docNumber) + '</b></td>' +
      '<td>' + esc(fmtDate(d.docDate)) + '</td>' +
      '<td>' + esc(d.warehouseSnapshot) + '</td>' +
      '<td class="c num">' + d.lineCount + '</td>' +
      '<td class="r num">' + qtyFmt(d.totalQty) + '</td>' +
      '<td>' + esc(d.toWarehouseSnapshot || d.customerSnapshot || (d.type === 'CONVERT' ? convertSummary(d) : '') || d.reason || '—') + '</td>' +
      '<td class="c"><button class="btn sm" data-fcdoc="stock" data-id="' + d.id + '">Open</button>' +
        (ERP.StockDocs.canEdit(d) ? ' <button class="btn sm" data-fcsdedit="' + d.id + '">Edit</button>' : '') + '</td></tr>';
  }).join('');
}
/* typing in a document list's own search box filters just that list's rows by their data-row text —
   independent of the page-level toolbar filter, which these lists don't have one of */
global.document.addEventListener('input', function (e) {
  if (!e.target || e.target.dataset.fcdocq === undefined) return;
  var type = e.target.dataset.fcdocq, q = e.target.value.toLowerCase().trim();
  var tb = global.document.getElementById('fcdoctb-' + type);
  if (!tb) return;
  Array.prototype.forEach.call(tb.querySelectorAll('tr[data-row]'), function (tr) {
    tr.style.display = !q || tr.dataset.row.indexOf(q) > -1 ? '' : 'none';
  });
});
/* a page can ask a stock-document list to open already filtered to one product (from the Prices screen) */
ERP.openReceiptsFor = function (pid) {
  var p = global.prodOf ? global.prodOf(pid) : null;
  var name = p ? (p.en || p.ur || '') : '';
  global.go('inventory');
  setTimeout(function () {
    var box = global.document.getElementById('fcdocq-RECEIVE');
    if (box) { box.value = name; box.dispatchEvent(new global.Event('input', { bubbles: true })); box.scrollIntoView({ block: 'center' }); }
  }, 60);
};
var origDispatch = global.PAGES.dispatch;
global.PAGES.dispatch = function () {
  return '<div class="bar"><div class="grow"></div>' +
    '<button class="btn pri" data-fcnew="dispatch">' + I('plus') + 'New Dispatch</button></div>' +
    docTable('DISPATCH', 'Dispatch notes', 'No dispatches yet');
};
var origInventory = global.PAGES.inventory;
global.PAGES.inventory = function () {
  var html = origInventory ? origInventory() : '';
  return '<div class="bar"><div class="grow"></div>' +
    '<button class="btn" data-fcnew="receive">' + I('plus') + 'Add Stock</button>' +
    '<button class="btn" data-fcnew="transfer">' + I('box') + 'Transfer</button>' +
    '<button class="btn" data-fcnew="convert">' + I('box') + 'Convert Brand</button>' +
    '<button class="btn" data-fcnew="adjust">' + I('edit') + 'Adjust</button></div>' + html +
    docTable('TRANSFER', 'Warehouse transfers', 'No transfers yet') +
    docTable('CONVERT', 'Brand conversions', 'No brand conversions yet') +
    docTable('RECEIVE', 'Stock receipts', 'No manual stock receipts yet') +
    docTable('ADJUST', 'Stock adjustments', 'No adjustments yet');
};

D.addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('[data-fcorder]') : null;
  if (!b) return;
  e.preventDefault();
  var draft = ERP.Orders.toInvoiceDraft(b.dataset.id);
  if (!draft) return;
  ERP.Builder.start('sale', draft);
}, true);

/* ── SMS / WhatsApp provider settings the hooks read (§32) ─────────────── */
global.PANELS.smsconnect = {
  t: 'SMS &amp; WhatsApp providers', s: 'Where reminders and confirmations are sent from',
  cta: 'Save provider settings',
  f: function () {
    var b = ERP.Settings.get();
    return '<div class="banner info">' + I('alert') + '<div><p>Credentials are stored on this device only ' +
      'and are never written into the invoice or the source code.</p></div></div>' +
      '<label class="f"><span>SMS provider</span><input data-f="smsProvider" value="' +
        esc(b.smsProvider || '') + '" placeholder="e.g. Telenor, Jazz, Twilio"></label>' +
      '<div class="f2">' +
        '<label class="f"><span>Sender ID / number</span><input data-f="smsSenderId" value="' +
          esc(b.smsSenderId || '') + '"></label>' +
        '<label class="f"><span>API key</span><input data-f="smsApiKey" type="password" value="' +
          esc(b.smsApiKey || '') + '"></label></div>' +
      '<label class="f"><span>WhatsApp Business provider</span><input data-f="whatsappProvider" value="' +
        esc(b.whatsappProvider || '') + '" placeholder="Leave blank to use wa.me links"></label>' +
      '<label class="f"><span>Send automatically for</span><select data-f="smsEvents" multiple size="6">' +
        ERP.Notify.events.map(function (ev) {
          var on = (b.smsEvents || []).indexOf(ev) > -1;
          return '<option value="' + ev + '"' + (on ? ' selected' : '') + '>' +
            ev.toLowerCase().replace(/_/g, ' ') + '</option>';
        }).join('') + '</select></label>';
  },
  save: function (v) {
    var sel = D.querySelector('[data-f="smsEvents"]');
    var events = sel ? Array.prototype.filter.call(sel.options, function (o) { return o.selected; })
      .map(function (o) { return o.value; }) : [];
    ERP.Settings.save({
      smsProvider: v.smsProvider, smsSenderId: v.smsSenderId, smsApiKey: v.smsApiKey,
      whatsappProvider: v.whatsappProvider, smsEvents: events
    }).then(function () { global.paint(); });
    return { msg: 'Provider settings saved.' };
  }
};
})(typeof window !== 'undefined' ? window : globalThis);
