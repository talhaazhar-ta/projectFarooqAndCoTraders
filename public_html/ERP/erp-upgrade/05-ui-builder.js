/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 5
   THE LINE EDITOR  ·  one screen, every transaction type
   Sales, purchases, orders, quotations, dispatch, transfers, receiving,
   adjustments and supplier returns all use this one editor: Add Item,
   edit, reorder, remove, a searchable picker showing warehouse stock, a
   sticky totals bar and drafts. (§2 §3 §4 §11 §37 §38 §39 §49)
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var ERP = global.ERP, M = global.Money, FDB = global.FDB;

var esc = function (s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
var I  = function (n) { return global.I ? global.I(n) : ''; };
var u  = function (t) { return global.u ? global.u(t) : esc(t); };
var say = function (m) { return global.say ? global.say(m) : null; };
function todayISO() { return global.FC_TODAY ? global.FC_TODAY() : new Date().toISOString().slice(0, 10); }
function fmtDate(iso) { return global.fmtDate ? global.fmtDate(iso) : iso; }
function firstWh() { return (WHS()[0] || {}).id || ''; }

/* The app declares its master data with top-level `let`, which is not a
   property of window; a bridge exposes it. If that bridge ever fails the
   lists would silently come back empty, so every read goes through these
   and falls back to the master-data file that is embedded in the page. */
function MASTER() { return global.FAROOQ_ERP_MASTER || {}; }
function PRODS()  { return global.PRODUCTS  || MASTER().products  || []; }
function CUSTS()  { return global.CUSTOMERS || MASTER().customers || []; }
function SUPS()   { return global.SUPPLIERS || MASTER().suppliers || []; }
function REGS()   { return (global.REGIONS   || MASTER().regions   || []).filter(function (r) { return !r.deleted; }); }
function WHS() {
  if (global.activeWh) { try { return global.activeWh() || []; } catch (e) {} }
  return (global.WAREHOUSES || MASTER().warehouses || []).filter(function (w) { return w.active !== false; });
}
/* The warehouses to offer, plus the one a saved document is already in even if
   it has since been switched off — otherwise the box would show some other
   warehouse while the document still points at the old one. */
function whWith(list, currentId) {
  if (!currentId || list.some(function (w) { return w.id === currentId; })) return list;
  var cur = (global.WAREHOUSES || []).find(function (w) { return w.id === currentId; });
  return cur ? list.concat([Object.assign({}, cur, { name: cur.name + ' (inactive)' })]) : list;
}
ERP.sources = { PRODS: PRODS, CUSTS: CUSTS, SUPS: SUPS, REGS: REGS, WHS: WHS };

/* ══ what each transaction type needs from the editor ══ */
var MODES = {
  sale: {
    title: 'New invoice', party: 'customer', rates: true, stockOut: true, drafts: true,
    cta: 'Save &amp; Generate Invoice', back: 'invoices', noun: 'invoice',
    save: function (d, asDraft) { return ERP.Invoices.save(d, { draft: asDraft }); },
    after: function (rec) { return ERP.DocModel.invoice(rec.id); }
  },
  purchase: {
    title: 'Receive stock from a mill', party: 'supplier', rates: true, received: true,
    cta: 'Save &amp; Receive Stock', back: 'purchases', noun: 'purchase',
    save: function (d) { return ERP.Purchases.save(d); },
    after: function (rec) { return ERP.DocModel.purchase(rec.id); }
  },
  order: {
    title: 'New sales order', party: 'customer', rates: true, drafts: true,
    cta: 'Save Order', back: 'orders', noun: 'order',
    save: function (d, asDraft) { return ERP.Orders.save(Object.assign({ kind: 'ORDER' }, d), { draft: asDraft }); },
    after: function (rec) { return ERP.DocModel.order(rec.id); }
  },
  quotation: {
    title: 'New quotation', party: 'customer', rates: true, drafts: true,
    cta: 'Save Quotation', back: 'orders', noun: 'quotation',
    save: function (d, asDraft) { return ERP.Orders.save(Object.assign({ kind: 'QUOTATION' }, d), { draft: asDraft }); },
    after: function (rec) { return ERP.DocModel.order(rec.id); }
  },
  dispatch: {
    title: 'Dispatch a load', party: 'customer', stockOut: true, vehicle: true,
    cta: 'Confirm Dispatch', back: 'dispatch', noun: 'dispatch',
    save: function (d) { return ERP.StockDocs.dispatch(d); },
    after: function (rec) { return ERP.DocModel.stockDoc(rec.id); }
  },
  transfer: {
    title: 'Transfer between warehouses', toWarehouse: true, stockOut: true,
    cta: 'Post Transfer', back: 'inventory', noun: 'transfer',
    save: function (d) { return ERP.StockDocs.transfer(d); },
    after: function (rec) { return ERP.DocModel.stockDoc(rec.id); }
  },
  receive: {
    title: 'Add stock', reason: true, cost: true,
    cta: 'Add to Stock', back: 'inventory', noun: 'stock receipt',
    /* an existing receipt comes here through its Edit button (09-paperwork.js ERP.editStockReceipt) */
    save: function (d) { return d.existing ? ERP.StockDocs.editReceive(d) : ERP.StockDocs.receive(d); },
    after: function (rec) { return ERP.DocModel.stockDoc(rec.id); }
  },
  adjust: {
    title: 'Stock adjustment', reason: true, direction: true, stockOut: true,
    cta: 'Post Adjustment', back: 'inventory', noun: 'adjustment',
    save: function (d) { return ERP.StockDocs.adjust(d); },
    after: function (rec) { return ERP.DocModel.stockDoc(rec.id); }
  },
  convert: {
    title: 'Convert brand', reason: true, convertTo: true, stockOut: true,
    cta: 'Convert Stock', back: 'inventory', noun: 'conversion',
    save: function (d) { return ERP.StockDocs.convert(d); },
    after: function (rec) { return ERP.DocModel.stockDoc(rec.id); }
  },
  supreturn: {
    title: 'Return to supplier', party: 'supplier', stockOut: true, rates: true, reason: true,
    cta: 'Post Supplier Return', back: 'suppliers', noun: 'supplier return',
    save: function (d) {
      return ERP.Returns.toSupplier(Object.assign({}, d, {
        items: d.items.map(function (i) {
          return { productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice,
                   fromDamaged: !!i.fromDamaged, purchaseItemId: i.purchaseItemId || null };
        })
      }));
    },
    after: function (rec) { return ERP.DocModel.supplierReturn(rec.id); }
  }
};

var B = ERP.Builder = {
  mode: 'sale', cfg: MODES.sale, draft: null, saving: false,
  pickerQuery: '', pickerOpen: false, regionFilter: 'all', editingId: null, dirty: false, errors: []
};

function blankDraft() {
  return {
    id: FDB.uid('tx'), clientOpId: null,
    customerId: '', supplierId: '', warehouseId: firstWh(), toWarehouseId: '', invoiceId: '',
    invoiceDate: todayISO(), purchaseDate: todayISO(), orderDate: todayISO(), date: todayISO(),
    dueDate: '', deliveryDate: '', validUntil: '',
    orderNumber: '', dispatchNumber: '', referenceNo: '', supplierInvoiceNo: '',
    vehicleNo: '', driver: '', deliveryRef: '', reason: '',
    salesperson: global.CURRENT_USER || 'Owner',
    paymentMethod: 'Cash', notes: '',
    invoiceDiscount: 0, freight: 0, loading: 0, otherCharges: 0, paidAmount: 0,
    /* §28, 2026-09-29: no more per-product extra-cost box on Purchases/Add stock — extra cost and the
       purchase price a sale is costed at are both chosen once, on the product's own Prices screen
       (kept as an empty object only so an old saved draft with the field does not break anything reading it). */
    perProduct: {},
    items: []
  };
}

B.start = function (mode, draft) {
  B.mode = MODES[mode] ? mode : 'sale';
  B.cfg = MODES[B.mode];
  B.draft = Object.assign(blankDraft(), draft || {});
  B.draft.clientOpId = B.draft.clientOpId || FDB.uid('op');
  B.editingId = draft && draft.existing ? draft.id : null;
  B.pickerQuery = ''; B.pickerOpen = false; B.dirty = false; B.saving = false; B.errors = [];
  global.go('invoiceBuilder');
};

/* ── product search: name, Urdu name, brand, category, SKU, bag size ── */
function searchProducts(q) {
  q = (q || '').toLowerCase().trim();
  var wid = B.draft.warehouseId;
  var list = PRODS().filter(function (p) { return p.active !== false; });
  if (q) {
    list = list.filter(function (p) {
      var hay = [p.en, p.ur, p.brand, p.brandEn, p.cat, p.sku, p.sourceFolio, p.id,
                 p.normalizedName, p.nameEn, p.kg ? p.kg + ' kg' : ''].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) > -1;
    });
  }
  return list.sort(function (a, b) {
    if (B.cfg.stockOut) {
      var sa = ERP.Inventory.available(a.id, wid) > 0, sb = ERP.Inventory.available(b.id, wid) > 0;
      if (sa !== sb) return sa ? -1 : 1;
    }
    return (a.en || '').localeCompare(b.en || '');
  }).slice(0, 40);
}

/* The last rate actually charged is offered as a starting point. The
   catalogue "Size !" figure is never used — the data import marked it
   unconfirmed, and it is not a price. */
function lastRate(pid) {
  var hit = null;
  /* Add stock (cfg.cost) is asked what the bags COST us. It used to fall into the sale branch below and open
     with the product's SELLING price — 2026-09-26: 6300 (the selling price) was kept as the stock cost, so a
     sale at 6300 showed a loss. The purchase price the owner saved (else the stock's own cost) is offered
     instead; with neither, the box stays empty ("Cost (optional)"). */
  if (B.cfg.cost && !B.cfg.rates && B.cfg.party !== 'supplier') {
    /* §28, 2026-09-29: the starting figure here is whatever a sale would be costed at right now —
       Inventory.saleBuyOf — the purchase price CHOSEN on the Prices screen if there is one, else the live
       bag-weighted average of the stock actually on hand, same as the Prices screen's own label. */
    var avgC = ERP.Inventory.saleBuyOf(pid, B.draft.warehouseId);
    return avgC > 0 ? avgC : null;
  }
  if (B.cfg.party === 'supplier') {
    ERP.S.purchaseItems.forEach(function (it) {
      if (it.productId !== pid) return;
      var pu = ERP.Purchases.byId(it.purchaseId); if (!pu) return;
      if (!hit || pu.purchaseDate > hit.date) hit = { date: pu.purchaseDate, rate: it.unitPrice };
    });
    return hit ? hit.rate : null;
  }
  if (B.mode === 'sale') {
    /* §28, 2026-09-29 (client: "no need of selling price [on the Prices screen] — it will be decided while
       selling"): the rate is typed fresh on every sale, but the box still opens filled in — with the rate
       this product last actually sold at on a live invoice, so it is never blank the second time a product
       is sold. Nothing here is read-only any more; the user can change it freely, including below cost. */
    var last = ERP.Inventory.lastSoldP(pid);
    return last > 0 ? last : null;
  }
  return hit ? hit.rate : null;
}

function addLine(pid) {
  if (!global.prodOf(pid)) return;
  var r = (B.cfg.rates || B.cfg.cost) ? lastRate(pid) : null;
  B.draft.items.push({
    lineId: FDB.uid('ln'), productId: pid, quantity: '',
    unitPrice: r === null ? '' : M.toR(r), discount: '', receivedQty: '',
    direction: 'IN', warehouseId: B.draft.warehouseId, fromDamaged: false, toProductId: '',
    batchNo: '', notes: '', unit: 'Bag'
  });
  B.dirty = true; B.pickerQuery = '';
  var input = global.document.getElementById('fcbPick');
  if (input) input.value = '';
  renderLines();
  if (B.mode === 'purchase' || B.mode === 'receive') renderCharges();
  renderResults();                      /* the list stays open for the next product */
  var rows = global.document.querySelectorAll('[data-fcline="qty"]');
  var last = rows[rows.length - 1];
  if (last) { last.focus(); if (last.select) last.select(); }
}

function totals() { return ERP.Calc.invoice(B.draft); }

/* ══ blocks ══ */
function partyBlock() {
  if (B.cfg.party === 'supplier') {
    var sups = SUPS().filter(function (s) { return s.active !== false; });
    var sup = B.draft.supplierId ? global.supOf(B.draft.supplierId) : null;
    /* a purchase being edited keeps its supplier on screen even if that mill
       has since been switched off — otherwise the box would look empty */
    if (sup && sup.active === false) sups = sups.concat([sup]);
    /* money paid against a posted purchase, or bags returned from it, belong to
       its supplier — the picker is locked then, and says why */
    var editing = B.mode === 'purchase' && B.editingId ? ERP.Purchases.byId(B.editingId) : null;
    var supLock = editing ? ERP.Purchases.supplierLockReason(editing.id) : '';
    return '<label class="f"><span>Supplier</span><select data-fcb="supplierId"' + (supLock ? ' disabled' : '') + '>' +
      '<option value="">— choose a supplier —</option>' +
      sups.map(function (s) {
        return '<option value="' + s.id + '"' + (B.draft.supplierId === s.id ? ' selected' : '') + '>' +
          esc(s.co) + (s.legacyCode ? ' · ' + esc(s.legacyCode) : '') + (s.active === false ? ' (inactive)' : '') + '</option>';
      }).join('') + '</select></label>' +
      (supLock ? '<p class="hint">' + esc(supLock) + '</p>' : '') +
      (sup ? '<div class="fcb-party"><div><i>Payable</i><b class="due">' +
        M.fmt(ERP.Ledger.supplierBalance(sup.id)) + '</b></div></div>' : '');
  }
  if (B.cfg.party !== 'customer') return '';
  var regions = REGS().filter(function (r) { return r.active !== false; });
  var custs = CUSTS().filter(function (c) {
    return B.regionFilter === 'all' || c.region === B.regionFilter;
  });
  var c = B.draft.customerId ? global.custBy(B.draft.customerId) : null;
  var bal = c ? ERP.Ledger.customerBalance(c.id) : 0;
  /* On a posted invoice the shop is fixed here: the receipts and account
     entries hang off it, so it moves through "Change shop", which takes them
     along. A draft has nothing posted yet and stays freely editable. */
  var posted = B.mode === 'sale' && B.editingId ? ERP.Invoices.byId(B.editingId) : null;
  var lockShop = !!(posted && posted.status !== 'DRAFT');
  var lock = lockShop ? ' disabled' : '';
  return '<div class="f2">' +
    '<label class="f"><span>Region</span><select data-fcb="regionFilter"' + lock + '>' +
      '<option value="all">All regions (' + CUSTS().length + ' shops)</option>' +
      regions.map(function (r) {
        var n = CUSTS().filter(function (x) { return x.region === r.id; }).length;
        return '<option value="' + r.id + '"' + (B.regionFilter === r.id ? ' selected' : '') + '>' +
          esc(r.en) + ' — ' + esc(r.ur) + ' (' + n + ')</option>';
      }).join('') + '</select></label>' +
    '<label class="f"><span>Shop</span><select data-fcb="customerId"' + lock + '>' +
      '<option value="">— choose a shop —</option>' +
      custs.map(function (x) {
        return '<option value="' + x.id + '"' + (B.draft.customerId === x.id ? ' selected' : '') + '>' +
          esc(x.sh) + (x.legacyCode ? ' · ' + esc(x.legacyCode) : '') + '</option>';
      }).join('') + '</select></label></div>' +
    (lockShop ? '<p class="hint">To bill a different shop, save or leave this edit and use <b>Change shop</b> ' +
      'on the invoice — its payments and the shop balances move with it.</p>' : '') +
    (c ? '<div class="fcb-party">' +
        '<div><i>Owner</i><b>' + esc(c.ow || '—') + '</b></div>' +
        '<div><i>Mobile</i><b>' + esc(c.ph || 'Not set') + '</b></div>' +
        '<div><i>Region</i><b>' + (global.regionLbl ? global.regionLbl(c.region) : '') + '</b></div>' +
        '<div><i>Current balance</i><b class="' + (bal > 0 ? 'due' : '') + '">' + M.fmt(bal) + '</b></div>' +
      '</div>' : '');
}

function headerBlock() { return headerBody(true); }
function headerBody(withCard) {
  var cfg = B.cfg, d = B.draft;
  var wh = WHS();
  var whSel = function (key, label) {
    return '<label class="f"><span>' + label + '</span><select data-fcb="' + key + '">' +
      (key === 'toWarehouseId' ? '<option value="">— choose —</option>' : '') +
      whWith(wh, d[key]).map(function (w) {
        return '<option value="' + w.id + '"' + (d[key] === w.id ? ' selected' : '') + '>' + esc(w.name) + '</option>';
      }).join('') + '</select></label>';
  };
  var dateKey = B.mode === 'sale' ? 'invoiceDate' : B.mode === 'purchase' ? 'purchaseDate'
              : (B.mode === 'order' || B.mode === 'quotation') ? 'orderDate' : 'date';
  var extra = '';
  if (B.mode === 'sale') {
    extra = '<div class="f2">' +
        '<label class="f"><span>Due date</span><input type="date" data-fcb="dueDate" value="' + esc(d.dueDate || '') + '"></label>' +
        '<label class="f"><span>Order number</span><input data-fcb="orderNumber" class="mono" value="' +
          esc(d.orderNumber || '') + '" placeholder="Optional"></label></div>';
  } else if (B.mode === 'purchase') {
    extra = '<div class="f2">' +
        '<label class="f"><span>Supplier invoice / bilty</span><input data-fcb="supplierInvoiceNo" class="mono" value="' +
          esc(d.supplierInvoiceNo || '') + '" placeholder="Optional"></label>' +
        '<label class="f"><span>Vehicle number</span><input data-fcb="vehicleNo" class="mono" value="' +
          esc(d.vehicleNo || '') + '" placeholder="Optional"></label></div>' +
      '<div class="banner info">' + I('box') + '<div><p>Leave <b>Received</b> blank if the whole line arrived. ' +
        'Enter a smaller figure for a part delivery — only those bags go into stock and the rest stays open.</p></div></div>';
  } else if (cfg.vehicle) {
    extra = '<div class="f2">' +
        '<label class="f"><span>Vehicle number</span><input data-fcb="vehicleNo" class="mono" value="' +
          esc(d.vehicleNo || '') + '" placeholder="Optional"></label>' +
        '<label class="f"><span>Driver</span><input data-fcb="driver" value="' + esc(d.driver || '') +
          '" placeholder="Optional"></label></div>' +
      '<label class="f"><span>Against invoice</span><select data-fcb="invoiceId">' +
        '<option value="">Not linked — this dispatch takes the bags out of stock</option>' +
        ERP.Invoices.all().filter(function (i) {
          return i.status !== 'DRAFT' && i.status !== 'CANCELLED' &&
                 (!d.customerId || i.customerId === d.customerId);
        }).slice(0, 200).map(function (i) {
          return '<option value="' + i.id + '"' + (d.invoiceId === i.id ? ' selected' : '') + '>' +
            esc(i.invoiceNumber) + ' · ' + esc(i.shopNameSnapshot) + '</option>';
        }).join('') + '</select>' +
        '<span class="hint">If the invoice already took the bags out of stock, this dispatch records the ' +
        'delivery only. Stock is never deducted twice.</span></label>';
  } else if (B.mode === 'order' || B.mode === 'quotation') {
    extra = '<div class="f2">' +
        '<label class="f"><span>' + (B.mode === 'quotation' ? 'Valid until' : 'Delivery date') + '</span>' +
        '<input type="date" data-fcb="' + (B.mode === 'quotation' ? 'validUntil' : 'deliveryDate') + '" value="' +
          esc(B.mode === 'quotation' ? (d.validUntil || '') : (d.deliveryDate || '')) + '"></label>' +
        '<label class="f"><span>Salesperson</span><input data-fcb="salesperson" value="' +
          esc(d.salesperson || '') + '"></label></div>';
  }
  if (cfg.convertTo) {
    extra += '<div class="banner info">' + I('box') + '<div><p>Each line takes bags out of one brand and puts the ' +
      '<b>same number of bags</b> into the brand you choose under <b>Convert to</b>, in the same warehouse. ' +
      'Both sides are saved together or not at all.</p></div></div>';
  }
  if (cfg.reason) {
    extra += '<label class="f"><span>' + (B.mode === 'convert' ? 'Reason (optional)' : 'Reason' + (B.mode === 'adjust' ? ' (required — it is audited)' : '')) + '</span>' +
      '<input data-fcb="reason" value="' + esc(d.reason || '') + '" placeholder="' +
      (B.mode === 'receive' ? 'e.g. opening stock count, own production'
        : B.mode === 'convert' ? 'e.g. bags re-printed for the new brand'
        : B.mode === 'supreturn' ? 'e.g. torn bags' : 'e.g. physical count correction') + '"></label>';
  }
  var nextNo = '';
  try {
    var seqKey = { sale: ERP.Settings.get().invoicePrefix || 'INV',
                   purchase: ERP.Settings.get().purchasePrefix || 'PUR',
                   order: ERP.Settings.get().orderPrefix || 'SO', quotation: 'QT', dispatch: 'DSP',
                   transfer: 'TRF', receive: 'RCV', adjust: 'ADJ', convert: 'CNV', supreturn: 'SR' }[B.mode];
    nextNo = FDB.peekNumber(seqKey, new Date().getFullYear(), ERP.S.sequences);
  } catch (e) {}

  var body = partyBlock() +
    '<div class="f2">' +
      whSel('warehouseId', cfg.toWarehouse ? 'From warehouse' : B.mode === 'purchase' ? 'Into warehouse' : 'Warehouse') +
      (cfg.toWarehouse ? whSel('toWarehouseId', 'To warehouse')
        : '<label class="f"><span>Date</span><input type="date" data-fcb="' + dateKey + '" value="' +
          esc(d[dateKey] || todayISO()) + '"></label>') +
    '</div>' +
    (cfg.toWarehouse ? '<label class="f"><span>Date</span><input type="date" data-fcb="date" value="' +
      esc(d.date || todayISO()) + '"></label>' : '') +
    extra;
  var card = '<div class="card fcb-card"><div class="card-h"><h3>' +
    esc(B.mode === 'purchase' && B.editingId ? 'Edit purchase'
        : B.mode === 'receive' && B.editingId ? 'Edit stock receipt' : cfg.title) + '</h3>' +
    '<span class="pill neu mono">' + (B.editingId
      ? 'Editing' + (B.mode === 'purchase' ? ' ' + esc((ERP.Purchases.byId(B.editingId) || {}).purchaseNumber || '')
                   : B.mode === 'receive' ? ' ' + esc((ERP.StockDocs.byId(B.editingId) || {}).docNumber || '') : '')
      : 'Next: ' + nextNo) + '</span>' +
    '</div><div class="card-b" id="fcbHead">' + body + '</div></div>';
  return withCard ? card : body;
}

function resultRow(p, wid) {
  var st = ERP.Inventory.available(p.id, wid);
  return '<button class="fcb-res" data-fcbadd="' + p.id + '">' +
    '<div class="fcb-res-n">' + u(p.ur || '') + ' <span class="rn">' + esc(p.en || '') + '</span></div>' +
    '<div class="fcb-res-m">' + esc(p.brandEn || p.brand || '') + (p.kg ? ' · ' + p.kg + ' KG' : '') +
      ' · ' + esc(p.cat || '') + '</div>' +
    '<div class="fcb-res-s ' + (st > 0 ? 'ok' : 'bad') + '">Available: ' +
      Number(st).toLocaleString('en-US') + ' Bags</div></button>';
}

function resultsHtml() {
  var wid = B.draft.warehouseId;
  var all = PRODS();
  if (!all.length) {
    return '<div class="fcb-none"><b>No products are loaded on this device.</b><br>' +
      'Open Settings and restore a backup, or reload the page.</div>';
  }
  var results = searchProducts(B.pickerQuery);
  if (!results.length) {
    return '<div class="fcb-none">Nothing matches “' + esc(B.pickerQuery) + '”.<br>' +
      'Try the Urdu name, the brand, or the bag size.</div>';
  }
  return results.map(function (p) { return resultRow(p, wid); }).join('');
}
function pickerBlock() {
  return '<div class="fcb-picker">' +
    '<div class="fcb-search">' + I('search') +
      '<input id="fcbPick" placeholder="Search product, brand, category, SKU or bag size…" ' +
        'autocomplete="off" value="' + esc(B.pickerQuery) + '">' +
      '<button class="btn pri" data-fcbact="openpicker">' + I('plus') + 'Add Item</button>' +
    '</div>' +
    (B.pickerOpen ? '<div class="fcb-results">' + resultsHtml() + '</div>' : '') +
    /* a plain list and button that work even where the search panel does not */
    '<div class="fcb-fallback"><select id="fcbPlain">' +
      PRODS().filter(function (p) { return p.active !== false; }).map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.en || p.ur || p.id) +
          (p.kg ? ' — ' + p.kg + ' KG' : '') + '</option>';
      }).join('') + '</select>' +
      '<button class="btn" data-fcbact="addplain">' + I('plus') + 'Add this product</button>' +
    '</div></div>';
}

/* the label for the price column, purchase and receive share the same "only the price you pay the supplier
   / mill for ONE bag" explanation behind an "i" (§26, 2026-09-28 — client: "rate doesn't convey proper
   meaning") — extra cost and selling price moved to their own per-product boxes below the table */
function priceColLabel() {
  var tip = ERP.info && ERP.info.pair ? ERP.info.pair(
    'Only the purchasing price of each bag — what the supplier or mill charges you. Extra cost and selling ' +
    'price are typed once per product, below the table.', 'What is Purchase price?') : null;
  return 'Purchase price' + (tip ? tip.btn + tip.box : '');
}
function columns() {
  var cfg = B.cfg;
  var isBuySide = B.mode === 'purchase' || B.mode === 'receive';
  var c = [{ k: 'sr', l: '#', cls: 'c' }, { k: 'prod', l: cfg.convertTo ? 'Convert from' : 'Product' }];
  if (!cfg.convertTo) c.push({ k: 'pack', l: 'Package', cls: 'c' });     /* a conversion names the kg in both brand names */
  c.push({ k: 'wh', l: 'Warehouse' });
  if (cfg.convertTo) c.push({ k: 'to', l: 'Convert to' });
  if (cfg.direction) c.push({ k: 'dir', l: 'In / out' });
  c.push({ k: 'qty', l: cfg.received ? 'Ordered' : 'Qty', cls: 'r' });
  if (cfg.received) c.push({ k: 'recv', l: 'Received', cls: 'r' });
  if (cfg.rates || cfg.cost) c.push({ k: 'rate', l: isBuySide ? priceColLabel() : 'Rate', cls: 'r' });
  /* a line Discount is gone from purchase and Add stock (§26) — the purchase price is exactly what is paid
     per bag; old purchases that still carry one keep it on the record, just not shown as a box any more */
  if (cfg.rates && B.mode !== 'supreturn' && !isBuySide) c.push({ k: 'disc', l: 'Discount', cls: 'r' });
  if (cfg.rates || cfg.cost) c.push({ k: 'amt', l: 'Amount', cls: 'r' });
  c.push({ k: 'act', l: '', cls: 'c' });
  return c;
}

function lineRows() {
  var cfg = B.cfg, cols = columns(), wid = B.draft.warehouseId;
  if (!B.draft.items.length) {
    return '<tr class="fcb-empty"><td colspan="' + cols.length + '">' +
      '<b>No items yet.</b> Search above and press <em>Add Item</em> — one ' + cfg.noun +
      ' can hold as many products as the load needs.</td></tr>';
  }
  return B.draft.items.map(function (it, ix) {
    var p = global.prodOf(it.productId) || {};
    var calc = ERP.Calc.line(it);
    var lw = it.warehouseId || wid;
    var have = it.fromDamaged ? ERP.Inventory.damaged(it.productId, lw) : ERP.Inventory.available(it.productId, lw);
    var isOut = cfg.stockOut && (!cfg.direction || it.direction === 'OUT');
    var over = isOut && calc.qty > have;
    var cell = function (k) {
      switch (k) {
        case 'sr': return '<td class="c num" data-label="Line">' + (ix + 1) + '</td>';
        case 'prod': return '<td class="fcb-prodcell" data-label="Product"><div class="fcb-pn">' + u(p.ur || '') + ' <span class="rn">' + esc(p.en || '') +
          '</span></div><div class="fcb-ps">' + esc(p.brandEn || p.brand || '—') + ' · ' + esc(p.cat || '') +
          (p.sourceFolio ? ' · ' + esc(p.sourceFolio) : '') + '</div></td>';
        case 'pack': return '<td class="c" data-label="Package">' + (p.kg ? p.kg + ' KG' : 'Bag') + '</td>';
        case 'wh': return '<td data-label="Warehouse"><select data-fcline="wh" data-ix="' + ix + '" class="fcb-mini">' +
          whWith(WHS(), lw).map(function (w) {
            return '<option value="' + w.id + '"' + (lw === w.id ? ' selected' : '') + '>' + esc(w.name) + '</option>';
          }).join('') + '</select><div class="fcb-avail ' + (over ? 'bad' : '') + '">' +
          Number(have).toLocaleString('en-US') + (it.fromDamaged ? ' damaged' : ' available') + '</div>' +
          (B.mode === 'supreturn' ? '<label class="fcb-chk"><input type="checkbox" data-fcline="damaged" data-ix="' +
            ix + '"' + (it.fromDamaged ? ' checked' : '') + '> from damaged stock</label>' : '') + '</td>';
        case 'to': return '<td data-label="Convert to"><select data-fcline="to" data-ix="' + ix + '" class="fcb-mini fcb-to">' +
          '<option value="">— choose brand —</option>' +
          PRODS().filter(function (x) { return x.active !== false && x.id !== it.productId; })
            .sort(function (a, b) { return (a.en || '').localeCompare(b.en || ''); })
            .map(function (x) {
              return '<option value="' + esc(x.id) + '"' + (it.toProductId === x.id ? ' selected' : '') + '>' +
                esc(x.en || x.ur || x.id) +
                /* the name usually already says the brand and the kg — only add what it does not */
                (x.brandEn && (x.en || '').toLowerCase().indexOf(String(x.brandEn).toLowerCase()) < 0 ? ' · ' + esc(x.brandEn) : '') +
                (x.kg && !/kg/i.test(x.en || '') ? ' — ' + x.kg + ' KG' : '') + '</option>';
            }).join('') + '</select>' +
          (it.toProductId ? '<div class="fcb-avail">Has ' + Number(ERP.Inventory.available(it.toProductId, lw)).toLocaleString('en-US') +
            ' now</div>' : '') + '</td>';
        case 'dir': return '<td data-label="In / out"><select data-fcline="dir" data-ix="' + ix + '" class="fcb-mini">' +
          '<option value="IN"' + (it.direction === 'IN' ? ' selected' : '') + '>Increase</option>' +
          '<option value="OUT"' + (it.direction === 'OUT' ? ' selected' : '') + '>Decrease</option></select></td>';
        case 'qty': return '<td class="r" data-label="' + (cfg.received ? 'Ordered' : 'Quantity') + '"><input class="fcb-in num" data-fcline="qty" data-ix="' + ix +
          '" inputmode="decimal" value="' + esc(it.quantity) + '" placeholder="0"></td>';
        case 'recv': return '<td class="r" data-label="Received"><input class="fcb-in num" data-fcline="recv" data-ix="' + ix +
          '" inputmode="decimal" value="' + esc(it.receivedQty) + '" placeholder="all"></td>';
        case 'rate': {
          if (B.mode === 'sale') {
            /* §28, 2026-09-29 (client: "the selling price can be low then purchase price, it is ok… remove all
               restrictions"): the rate is typed fresh on every sale, editable, no floor. The chosen purchase
               price (Inventory.saleBuyOf — the Prices screen's figure, or the live average when none was
               chosen) plus the extra cost are shown as a label underneath, purely informational; the Edit
               button opens the product's Prices screen to change either one. */
            var av = { cost: ERP.Inventory.saleBuyOf(it.productId, lw), extra: ERP.Inventory.extraFor(it.productId, lw) };
            var avCost = av.cost + av.extra;
            return '<td class="r" data-label="Rate"><input class="fcb-in num" data-fcline="rate" data-ix="' + ix +
              '" inputmode="decimal" value="' + esc(it.unitPrice) + '" placeholder="0">' +
              (avCost ? '<div class="fcb-costline hint">cost ' + M.fmtPlain(avCost) + (av.extra ? ' (' + M.fmtPlain(av.cost) + '+' + M.fmtPlain(av.extra) + ')' : '') + '</div>' : '') +
              '<button class="icon-btn sm" title="Open the product\'s Prices screen" data-fcpriceedit="' + esc(it.productId || '') + '">' + I('edit') + '</button></td>';
          }
          var rateLbl = (B.mode === 'purchase' || B.mode === 'receive') ? 'Purchase price' : (cfg.cost ? 'Cost' : 'Rate');
          return '<td class="r" data-label="' + rateLbl + '"><input class="fcb-in num" data-fcline="rate" data-ix="' + ix +
            '" inputmode="decimal" value="' + esc(it.unitPrice) + '" placeholder="0"></td>';
        }
        case 'disc': {
          if (B.mode === 'sale') {
            var dv = M.toP(it.discount);
            return '<td class="r" data-label="Discount"><span class="num" style="padding:0 4px">' + (dv ? M.fmtPlain(dv) : '—') + '</span></td>';
          }
          return '<td class="r" data-label="Discount"><input class="fcb-in num" data-fcline="disc" data-ix="' + ix +
            '" inputmode="decimal" value="' + esc(it.discount) + '" placeholder="0"></td>';
        }
        case 'amt': return '<td class="r num fcb-amtcell" data-label="Amount"><b data-fcamt="' + ix + '">' + M.fmtPlain(calc.lineTotal) + '</b></td>';
        default: return '<td class="c fcb-acts" data-label="">' +
          '<button class="icon-btn sm" data-fcmove="up" data-ix="' + ix + '" title="Move up"' +
            (ix === 0 ? ' disabled' : '') + '>' + I('up') + '</button>' +
          '<button class="icon-btn sm" data-fcmove="down" data-ix="' + ix + '" title="Move down"' +
            (ix === B.draft.items.length - 1 ? ' disabled' : '') + '>' + I('dn') + '</button>' +
          '<button class="icon-btn sm danger" data-fcdel="' + ix + '" title="Remove line">' + I('x') + '</button></td>';
      }
    };
    return '<tr' + (over ? ' class="over"' : '') + '>' +
      cols.map(function (c) { return cell(c.k); }).join('') + '</tr>';
  }).join('');
}

function totalsBar() {
  var t = totals(), cfg = B.cfg;
  var row = function (l, v, cls) { return '<div class="' + (cls || '') + '"><i>' + l + '</i><b>' + v + '</b></div>'; };
  if (!cfg.rates && !cfg.cost) {
    return row('Lines', String(B.draft.items.length)) +
      row('Total bags', Number(t.totalQty).toLocaleString('en-US'), 'grand');
  }
  /* §28, 2026-09-29: no more per-product extra-cost box on these two screens — just the purchase price on
     each line and the total. */
  if (B.mode === 'purchase' || B.mode === 'receive') {
    return row('Subtotal', M.fmt(t.subtotal)) +
      row('Bags', Number(t.totalQty).toLocaleString('en-US')) +
      row((B.mode === 'purchase' ? 'Purchase' : 'Stock') + ' total', M.fmt(t.grandTotal), 'grand');
  }
  var prev = cfg.party === 'customer' && B.draft.customerId ? ERP.Ledger.customerBalance(B.draft.customerId) : 0;
  return row('Subtotal', M.fmt(t.subtotal)) +
    row('Discount', '− ' + M.fmt(t.discountAmount)) +
    row('Charges', M.fmt(t.freightAmount + t.loadingAmount + t.otherCharges + t.taxAmount)) +
    row('Bags', Number(t.totalQty).toLocaleString('en-US')) +
    (cfg.party === 'customer' ? row('Paid now', M.fmt(t.paidAmount)) : '') +
    (cfg.party === 'customer' ? row('Previous balance', M.fmt(prev)) : '') +
    row('Grand total', M.fmt(t.grandTotal), 'grand');
}

/* What each bag on this purchase really costs, worked out live with the same rule the save uses (Cost.allocate):
   line price − its share of the overall discount + its share of the charges, per bag. Numbers only.
   (2026-09-28: this used to be declared twice — the second, cruder copy silently won and blended every product
   on the purchase into ONE average cost, which is wrong the moment a purchase has more than one product at a
   different price. There is now exactly one version, and it always matches ERP.Cost.allocate — the same function
   Purchases.save uses — so the preview can never diverge from what actually gets recorded.) */
function costPerBagHtml() {
  var t = totals();
  var lines = t.items.filter(function (i) { return i.productId && Number(i.quantity) > 0; });
  if (!lines.length) return '<span class="hint">Add a product to see what each bag will really cost you.</span>';
  var charges = t.freightAmount + t.loadingAmount + t.otherCharges;
  var alloc = ERP.Cost.allocate(lines.map(function (i, ix) {
    return { id: String(ix), productId: i.productId, quantity: i.quantity, receivedQty: i.receivedQty, lineTotal: i.lineTotal, unitPrice: i.unitPrice };
  }), charges, t.invoiceDiscount);
  var parts = lines.map(function (i, ix) {
    var a = alloc[ix], p = global.prodOf(i.productId) || {};
    var perBagCharge = a.qty ? Math.round(a.share / a.qty) : 0;
    var bits = ['<b>each bag costs</b> ' + M.fmt(a.landedUnit)];
    if (a.goodsUnit !== i.unitPrice) {
      bits.push('purchase price ' + M.fmt(i.unitPrice) + ' &minus; discount = <b>' + M.fmt(a.goodsUnit) + '</b> after discounts');
    }
    if (perBagCharge) {
      bits.push('+ charges ' + M.fmt(perBagCharge) +
        (lines.length === 1 ? ' (' + M.fmt(charges) + ' &divide; ' + Number(a.qty).toLocaleString('en-US') + ' bags)' : ''));
    }
    var label = lines.length > 1 ? '<b>' + esc(p.en || p.ur || i.productId) + '</b>: ' : '';
    return label + bits.join(' &nbsp;·&nbsp; ');
  });
  return parts.join('<br>');
}

function chargesBlock() {
  if (!B.cfg.rates && !B.cfg.cost) {
    return '<div class="card fcb-card"><div class="card-h"><h3>Notes</h3></div><div class="card-b">' +
      '<label class="f"><span>Notes</span><textarea data-fcb="notes" rows="2" placeholder="Optional">' +
      esc(B.draft.notes || '') + '</textarea></label></div></div>';
  }
  if (B.mode === 'supreturn') {
    return '<div class="card fcb-card"><div class="card-h"><h3>Notes</h3></div><div class="card-b">' +
      '<label class="f"><span>Notes</span><textarea data-fcb="notes" rows="2" placeholder="Optional">' +
      esc(B.draft.notes || '') + '</textarea></label></div></div>';
  }
  var t = totals();
  var f = function (key, label, hint) {
    var tip = hint && hint.trim() && ERP.info ? ERP.info.pair(hint) : null;
    return '<label class="f"><span>' + label + (tip ? tip.btn : '') + '</span><input class="num" data-fcb="' + key +
      '" inputmode="decimal" value="' + esc(B.draft[key] || '') + '" placeholder="0">' +
      (tip ? tip.box : (hint ? '<span class="hint">' + hint + '</span>' : '')) + '</label>';
  };
  var fText = function (key, label, hint, placeholder) {
    return '<label class="f"><span>' + label + '</span><input data-fcb="' + key +
      '" value="' + esc(B.draft[key] || '') + '"' + (placeholder ? ' placeholder="' + placeholder + '"' : '') + '>' +
      (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>';
  };

  /* ── Add-stock (receive) mode, simplified further (§28, 2026-09-29): just the purchase price on each
     line — no per-product extra cost box any more. Extra cost is chosen once, on the product's own Prices
     screen. ── */
  if (B.mode === 'receive') {
    return '<div class="card fcb-card"><div class="card-h"><h3>Notes</h3></div><div class="card-b">' +
      '<label class="f"><span>Internal note</span><textarea data-fcb="notes" rows="2" ' +
        'placeholder="Optional">' + esc(B.draft.notes || '') + '</textarea></label>' +
      '<div class="fcb-check">' + (t.grandTotal ? 'Stock total ' + M.fmt(t.grandTotal) :
        'Add a line to see the totals.') +
      '</div></div></div>';
  }

  /* ── Purchase screen, simplified further (§28, 2026-09-29): only the purchase price (on the line) — no
     per-product extra cost box any more (chosen once, on the product's own Prices screen). A purchase saved
     before this change keeps its old charges exactly as they were, shown read-only rather than as boxes, so
     nothing about its total silently moves. ── */
  if (B.mode === 'purchase') {
    var ip = ERP.info ? ERP.info.pair.bind(ERP.info) : function () { return { btn: '', box: '' }; };
    /* editing a purchase that already has money against it needs the ORIGINAL warning back (a plain
       "raising it records a voucher" is not enough once there is something to reverse — test U5) */
    var hPaid = ip(B.editingId
      ? 'What has been paid with this purchase so far. Raising it records another payment voucher for the difference; to lower it, reverse the voucher from Payments.'
      : '<b>Amount paid</b> = what you hand the supplier now for the whole purchase. Leave at 0 to pay later. Raising it records a new payment voucher.', 'What is Amount paid?');
    var oldChargesTotal = t.invoiceDiscount + t.freightAmount + t.loadingAmount + t.otherCharges;
    var oldChargesHtml = (B.editingId && oldChargesTotal) ?
      '<div class="banner info">' + I('box') + '<div><p>This purchase was saved with ' + M.fmt(oldChargesTotal) +
      ' of overall discount / delivery / loading / other charges from before this screen was simplified. ' +
      'It is kept exactly as it was, already inside the total below — there is nothing to change here.</p>' +
      '<div id="fcbCpb" class="fcb-cpb hint">' + costPerBagHtml() + '</div></div></div>' : '';
    return '<div class="card fcb-card"><div class="card-h"><h3>Payment</h3></div><div class="card-b">' +
      oldChargesHtml +
      '<div class="f2 fc-amtpaid">' +
        f('paidAmount', 'Amount paid' + hPaid.btn, null) + hPaid.box +
        '<label class="f"><span>Payment method</span><select data-fcb="paymentMethod">' +
          ERP.ENUM.methods.map(function (m) {
            return '<option' + (B.draft.paymentMethod === m ? ' selected' : '') + '>' + m + '</option>';
          }).join('') + '</select></label></div>' +
      fText('referenceNo', 'Reference / bilty no.', '', 'Cheque / transaction / bilty number') +
      '<label class="f"><span>Internal note</span><textarea data-fcb="notes" rows="2" ' +
        'placeholder="Optional">' + esc(B.draft.notes || '') + '</textarea></label>' +
      '<div class="fcb-check">' + (t.grandTotal ? 'Purchase total ' + M.fmt(t.grandTotal) :
        'Add a line to see the totals.') +
      '</div></div></div>';
  }

  /* ── Sale side: no charge inputs at all — just description, notes, payment ── */
  var isSaleSide = B.cfg.party === 'customer';
  if (isSaleSide) {
    var quoteLike = B.mode === 'order' || B.mode === 'quotation';
    return '<div class="card fcb-card"><div class="card-h"><h3>' +
      (quoteLike ? 'Notes' : 'Payment') + '</h3></div><div class="card-b">' +
      (quoteLike ? '' :
        '<div class="f2 fc-amtpaid">' + f('paidAmount', 'Amount Paid', 'Leave at 0 for a credit sale') +
        '<label class="f"><span>Payment method</span><select data-fcb="paymentMethod">' +
          ERP.ENUM.methods.map(function (m) {
            return '<option' + (B.draft.paymentMethod === m ? ' selected' : '') + '>' + m + '</option>';
          }).join('') + '</select></label></div>' +
        '<label class="f"><span>Reference number</span><input data-fcb="referenceNo" class="mono" value="' +
          esc(B.draft.referenceNo || '') + '" placeholder="Cheque / transaction / bilty number"></label>') +
      '<label class="f fc-desc"><span>Description / تفصیل</span><input data-fcb="description" ' +
        'maxlength="500" value="' + esc(B.draft.description || '') + '" ' +
        'placeholder="Appears on the account statement — English or Urdu"></label>' +
      '<label class="f"><span>Internal note</span><textarea data-fcb="notes" rows="2" ' +
        'placeholder="Anything that should appear on the document">' + esc(B.draft.notes || '') + '</textarea></label>' +
      '<div class="fcb-check">' + (t.grandTotal ? 'Grand total ' + M.fmt(t.grandTotal) +
        (t.paidAmount ? ' · balance after this payment ' + M.fmt(t.grandTotal - t.paidAmount) : '') :
        'Add a line to see the totals.') +
      '</div></div></div>';
  }

  /* ── All other modes (transfer, order, quotation, custreturn etc.) ── */
  var quoteLike2 = B.mode === 'order' || B.mode === 'quotation';
  var isPur = false;
  var hDisc = 'One amount off the whole invoice, taken after any discount on a line.';
  var hChg = 'Total for the whole invoice, added to the amount due.';
  var guideTip = null;
  return '<div class="card fcb-card"><div class="card-h"><h3>Charges' +
      (quoteLike2 ? '' : ' &amp; payment') + (guideTip ? guideTip.btn : '') +
      '</h3></div><div class="card-b">' + (guideTip ? guideTip.box : '') +
    '<div class="f2">' + f('invoiceDiscount', 'Overall discount', hDisc) + f('freight', 'Delivery / freight', hChg) + '</div>' +
    '<div class="f2">' + f('loading', 'Loading / unloading', hChg) + f('otherCharges', 'Other charges', hChg) + '</div>' +
    (quoteLike2 ? '' :
      '<div class="f2 fc-amtpaid">' + f('paidAmount', 'Amount Paid', '') +
        '<label class="f"><span>Payment method</span><select data-fcb="paymentMethod">' +
          ERP.ENUM.methods.map(function (m) {
            return '<option' + (B.draft.paymentMethod === m ? ' selected' : '') + '>' + m + '</option>';
          }).join('') + '</select></label></div>' +
      '<label class="f"><span>Reference number</span><input data-fcb="referenceNo" class="mono" value="' +
        esc(B.draft.referenceNo || '') + '" placeholder="Cheque / transaction / bilty number"></label>') +
    '<label class="f fc-desc"><span>Description / تفصیل</span><input data-fcb="description" ' +
      'maxlength="500" value="' + esc(B.draft.description || '') + '" ' +
      'placeholder="Appears on the account statement — English or Urdu"></label>' +
    '<label class="f"><span>Internal note</span><textarea data-fcb="notes" rows="2" ' +
      'placeholder="Anything that should appear on the document">' + esc(B.draft.notes || '') + '</textarea></label>' +
    '<div class="fcb-check">' + (t.grandTotal ? 'Grand total ' + M.fmt(t.grandTotal) +
      ' · balance after this payment ' + M.fmt(t.grandTotal - t.paidAmount) : 'Add a line to see the totals.') +
    '</div></div></div>';
}

global.PAGES = global.PAGES || {};
global.PAGES.invoiceBuilder = function () {
  if (!B.draft) B.start(B.mode);
  var cfg = B.cfg, t = totals(), cols = columns();
  return '<div id="fcbuilder" class="fcb">' +
    '<div id="fcbErr">' + errorBlock() + '</div>' +
    '<div class="fcb-grid"><div>' + headerBlock() +
      '<div class="card fcb-card"><div class="card-h"><h3>Items</h3>' +
        '<span class="pill ' + (t.lineCount ? 'ok' : 'neu') + '" id="fcbItemCount">' + t.lineCount +
        (t.lineCount === 1 ? ' line' : ' lines') + ' · ' +
        Number(t.totalQty).toLocaleString('en-US') + ' bags</span>' +
      '</div><div class="card-b">' + pickerBlock() +
        '<div class="tw fcb-tw"><table class="fcb-table"><thead><tr>' +
          cols.map(function (c) { return '<th class="' + (c.cls || '') + '">' + c.l + '</th>'; }).join('') +
        '</tr></thead><tbody id="fcbLines">' + lineRows() + '</tbody></table></div>' +
      '</div></div><div id="fcbCharges">' + chargesBlock() + '</div></div>' +
      '<div class="fcb-side">' +
        '<div class="card fcb-card"><div class="card-h"><h3>Summary</h3></div>' +
        '<div class="card-b fcb-sum" id="fcbSum">' + totalsBar() + '</div></div>' +
        '<div class="banner info">' + I('box') + '<div><p>' +
          (cfg.stockOut
            ? 'Every line is checked against warehouse stock before anything is written. If one line is short, nothing is posted.'
            : 'Each line writes its own stock movement, so the bag count always reconciles.') +
        '</p></div></div>' +
      '</div></div>' +
    '<div class="fcb-sticky"><div class="fcb-sticky-in">' +
      '<div class="fcb-stotals">' + totalsBar() + '</div>' +
      '<div class="fcb-btns">' +
        '<button class="btn" data-fcbact="cancel">Discard</button>' +
        (cfg.drafts ? '<button class="btn" data-fcbact="draft">' + I('doc') + 'Save Draft</button>' : '') +
        '<button class="btn pri lg" data-fcbact="save">' + I('check') +
          ((B.mode === 'purchase' || B.mode === 'receive') && B.editingId ? 'Save changes' : cfg.cta) + '</button>' +
      '</div></div></div></div>';
};

/* recalculating must not steal the caret */
/* ── partial rendering ───────────────────────────────────────────────────
   A full repaint rebuilds every control on the screen, which closes any
   open dropdown and throws away what is being typed. The builder therefore
   redraws only the piece that changed. ── */
function renderResults() {
  var wrap = global.document.querySelector('.fcb-picker');
  var box = global.document.querySelector('.fcb-results');
  if (!B.pickerOpen) { if (box) box.remove(); return; }
  if (box) { box.innerHTML = resultsHtml(); return; }
  if (wrap) {
    var search = wrap.querySelector('.fcb-search');
    var el = global.document.createElement('div');
    el.className = 'fcb-results';
    el.innerHTML = resultsHtml();
    if (search && search.nextSibling) wrap.insertBefore(el, search.nextSibling);
    else wrap.appendChild(el);
  }
}
function renderLines() {
  var tb = global.document.getElementById('fcbLines');
  if (!tb) { global.paint(); return; }
  tb.innerHTML = lineRows();
  var count = global.document.querySelector('#fcbItemCount');
  var t = totals();
  if (count) count.textContent = t.lineCount + (t.lineCount === 1 ? ' line' : ' lines') +
    ' · ' + Number(t.totalQty).toLocaleString('en-US') + ' bags';
  refreshTotals();
}
function renderHeader() {
  var host = global.document.getElementById('fcbHead');
  if (!host) { global.paint(); return; }
  host.innerHTML = headerBody();
}
/* the per-product Extra cost / Selling price boxes (purchase, receive) gain or lose a row as products are
   added or removed — a partial repaint of the whole charges card keeps it in step without losing focus
   elsewhere on the screen */
function renderCharges() {
  var host = global.document.getElementById('fcbCharges');
  if (!host) { global.paint(); return; }
  host.innerHTML = chargesBlock();
}
function renderErrors() {
  var host = global.document.getElementById('fcbErr');
  if (!host) { global.paint(); return; }
  host.innerHTML = errorBlock();
  var box = host.querySelector('.fcb-errs');
  if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
ERP.BuilderRender = { lines: renderLines, header: renderHeader, results: renderResults, errors: renderErrors, charges: renderCharges };

function refreshTotals() {
  var t = totals();
  var sum = global.document.getElementById('fcbSum');
  var sticky = global.document.querySelector('.fcb-stotals');
  if (sum) sum.innerHTML = totalsBar();
  if (sticky) sticky.innerHTML = totalsBar();
  var cfg = B.cfg;
  B.draft.items.forEach(function (it, ix) {
    var calc = ERP.Calc.line(it);
    var cell = global.document.querySelector('[data-fcamt="' + ix + '"]');
    if (cell) cell.textContent = M.fmtPlain(calc.lineTotal);
    /* the shortage warning has to appear as the quantity is typed, not
       after the next repaint */
    var input = global.document.querySelector('[data-fcline="qty"][data-ix="' + ix + '"]');
    var row = input && input.closest ? input.closest('tr') : null;
    if (!row) return;
    var lw = it.warehouseId || B.draft.warehouseId;
    var have = it.fromDamaged ? ERP.Inventory.damaged(it.productId, lw)
                              : ERP.Inventory.available(it.productId, lw);
    var isOut = cfg.stockOut && (!cfg.direction || it.direction === 'OUT');
    var over = isOut && calc.qty > have;
    row.classList.toggle('over', !!over);
    var avail = row.querySelector('.fcb-avail');
    if (avail) {
      avail.classList.toggle('bad', !!over);
      avail.textContent = Number(have).toLocaleString('en-US') +
        (it.fromDamaged ? ' damaged' : ' available') +
        (over ? ' · short by ' + Number(calc.qty - have).toLocaleString('en-US') : '');
    }
  });
  var cpb = global.document.getElementById('fcbCpb');
  if (cpb && B.mode === 'purchase') cpb.innerHTML = costPerBagHtml();
  /* mode-aware: this used to always write the sale's "Grand total … balance after this payment" wording,
     silently overwriting purchase's "Purchase total" / receive's "Stock total" the moment anything was typed
     (found 2026-09-28 while simplifying this screen) */
  var chk = global.document.querySelector('.fcb-check');
  if (chk) {
    if (B.mode === 'purchase' || B.mode === 'receive') {
      chk.textContent = t.grandTotal
        ? (B.mode === 'purchase' ? 'Purchase' : 'Stock') + ' total ' + M.fmt(t.grandTotal)
        : 'Add a line to see the totals.';
    } else {
      chk.textContent = t.grandTotal
        ? 'Grand total ' + M.fmt(t.grandTotal) + ' · balance after this payment ' + M.fmt(t.grandTotal - t.paidAmount)
        : 'Add a line to see the totals.';
    }
  }
}

/* Problems are held in state and rendered by the page itself, so a repaint
   — from a background save, another device, or the person switching a
   dropdown — can never wipe the explanation off the screen. */
function showErrors(list) {
  B.errors = list || [];
  renderErrors();
  if (!global.document.querySelector('.fcb-errs')) say(list[0]);
}
function errorBlock() {
  if (!B.errors || !B.errors.length) return '';
  return '<div class="banner err fcb-errs">' + I('alert') + '<div><b>This ' + B.cfg.noun +
    ' cannot be saved yet — nothing has been changed</b><ul>' +
    B.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') +
    '</ul></div></div>';
}
function setSaving(on, label) {
  B.saving = on;
  var btns = global.document.querySelectorAll('[data-fcbact="save"],[data-fcbact="draft"]');
  Array.prototype.forEach.call(btns, function (b) {
    b.disabled = on;
    if (on && b.dataset.fcbact === 'save') { b.dataset.prev = b.innerHTML; b.innerHTML = label || 'Saving…'; }
    else if (!on && b.dataset.prev) { b.innerHTML = b.dataset.prev; delete b.dataset.prev; }
  });
}

B.save = function (asDraft) {
  if (B.saving) return;                       /* double submission (§34) */
  B.errors = [];
  renderErrors();
  setSaving(true, asDraft ? 'Saving draft…' : 'Saving…');
  var cfg = B.cfg, mode = B.mode, orderId = B.draft.saleOrderId, wasEdit = !!B.editingId;

  /* §28, 2026-09-29: no more per-product extra-cost box on Purchases/Add stock — nothing to fold onto the
     lines any more, extra cost is chosen once on the product's own Prices screen. */
  var saveDraft = B.draft;
  if (mode === 'purchase' || mode === 'receive') {
    /* Purchase price is required at THIS screen (client — "Ordered ... compulsory ... only the purchasing
       price of each bag has to be written"); the service layer keeps it optional (falls to Inventory.costOf)
       since it is also every test's raw data-setup path. */
    var priceErrs = [];
    (saveDraft.items || []).forEach(function (it, ix) {
      if (it.productId && !(M.toP(it.unitPrice) > 0)) priceErrs.push('Line ' + (ix + 1) + ': enter the purchase price for one bag.');
    });
    if (priceErrs.length) { setSaving(false); showErrors(priceErrs); return; }
  }

  cfg.save(saveDraft, asDraft).then(function (rec) {
    setSaving(false); B.dirty = false;
    var no = rec.invoiceNumber || rec.purchaseNumber || rec.orderNumber ||
             rec.docNumber || rec.returnNumber || '';
    say(mode === 'purchase' && wasEdit ? 'Purchase ' + no + ' updated — stock and the supplier balance follow the change.'
        : mode === 'receive' && wasEdit ? 'Stock receipt ' + no + ' updated — stock follows the change.'
        : cfg.title.replace(/^New /, '') + ' saved' + (no ? ' — ' + no : '') + '.');
    if (mode === 'sale' && orderId) ERP.Orders.markInvoiced(orderId, rec);
    ERP.Notify.fire(mode === 'sale' ? 'INVOICE_CREATED' : 'TRANSACTION_SAVED', { id: rec.id, ref: no });

    B.draft = null;
    global.go(cfg.back);
    if (!asDraft && cfg.after) {
      setTimeout(function () {
        var model = cfg.after(rec);
        if (model) ERP.Viewer.open(model);
      }, 260);
    }
  }).catch(function (err) {
    setSaving(false);
    /* a warning the person may override: showing it once is enough, the next Save keeps what they typed */
    if (err && err.confirmable && err.validation) { B.draft.confirmCharges = true; showErrors(err.validation); return; }
    if (err && err.validation) { showErrors(err.validation); return; }
    /* an edit's save is keyed on the record's revision, so the same key again almost always means the record was
       already changed from another window or device (double clicks are stopped by B.saving) */
    if (err && err.duplicate && wasEdit && (mode === 'receive' || mode === 'purchase')) {
      showErrors(['This ' + cfg.noun + ' was already changed from another window or device, so this edit was not saved. ' +
        'Reload the page to see the latest version, then make the change again.']);
      return;
    }
    if (err && err.duplicate) {
      showErrors(['This ' + cfg.noun + ' has already been saved — the repeated submission was ignored, ' +
        'so nothing was duplicated.']);
      return;
    }
    showErrors(['It could not be written to the database: ' +
      (err && err.message ? err.message : 'unknown error') +
      '. Nothing was saved — no stock or balance has changed.']);
    try { global.console.error(err); } catch (e) {}
  });
};

/* ══════════════════════════════════════════════════════════════════════════
   INVOICE LIST (§37 §38 §39)
   ══════════════════════════════════════════════════════════════════════════ */
/* The search and filter rules live in 33-invoice-search.js (ERP.InvoiceSearch,
   loaded later — it is only ever called at paint time). This object is just
   the screen's remembered state; the keys are the ones ERP.InvoiceSearch.DEFAULTS
   lists, and every data-fcfil control writes straight into it. */
var LIST = ERP.InvoiceList = { q: '', scope: 'all', period: 'all', from: '', to: '', min: '', max: '',
                               status: 'all', region: 'all', wh: 'all', sort: 'newest', page: 1 };
var PAGE_SIZE = 50;

function matches(inv) { return ERP.InvoiceSearch.matcher(LIST)(inv); }
LIST.results = function () { return ERP.InvoiceSearch.results(LIST); };
LIST.reset = function () { ERP.InvoiceSearch.reset(LIST); };
LIST.pages = 1;
/* Prev / Next / First / Last, or a page number */
LIST.goPage = function (to) {
  var n = to === 'prev' ? LIST.page - 1 : to === 'next' ? LIST.page + 1
        : to === 'first' ? 1 : to === 'last' ? LIST.pages : Number(to);
  if (!isFinite(n)) return;
  LIST.page = Math.min(Math.max(1, Math.round(n)), LIST.pages);
  global.paint();
  var top = global.document.querySelector('.fcb-count');
  if (top && top.scrollIntoView) top.scrollIntoView({ block: 'nearest' });
};

global.PAGES.invoices = function () {
  var all = ERP.Invoices.all();
  var list = LIST.results();
  var live = list.filter(function (i) { return i.status !== 'CANCELLED' && i.status !== 'DRAFT'; });
  var revenue = live.reduce(function (a, i) { return a + i.grandTotal; }, 0);
  var received = live.reduce(function (a, i) { return a + ERP.Invoices.paidFor(i.id); }, 0);
  var outstanding = live.reduce(function (a, i) { return a + ERP.Invoices.outstanding(i); }, 0);

  /* Only one page of rows is drawn; the totals above still cover every
     invoice that passes the filters. A narrowed-down list can leave the
     remembered page past the end, so it is clamped rather than shown empty. */
  LIST.pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (LIST.page > LIST.pages) LIST.page = LIST.pages;
  if (!(LIST.page >= 1)) LIST.page = 1;
  var first = (LIST.page - 1) * PAGE_SIZE;
  var shown = list.slice(first, first + PAGE_SIZE);
  var info = ERP.InvoiceSearch.describe(LIST);
  var filtering = ERP.InvoiceSearch.active(LIST);
  var hitsOf = ERP.InvoiceSearch.hitsFor(LIST);

  var periods = [['all', 'All dates'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'],
                 ['month', 'This month'], ['lastmonth', 'Last month'], ['last30', 'Last 30 days'],
                 ['last90', 'Last 3 months'], ['year', 'This year'], ['lastyear', 'Last 12 months'],
                 ['custom', 'Custom range…']];
  var statuses = [['all', 'All statuses']].concat(ERP.ENUM.invoiceStatus.map(function (s) {
    return [s, ERP.STATUS_LABEL[s]];
  }));
  function options(pairs, cur) {
    return pairs.map(function (p) {
      return '<option value="' + esc(p[0]) + '"' + (cur === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
    }).join('');
  }

  var pager = LIST.pages > 1
    ? '<div class="fcb-pager">' +
        '<button class="btn sm" data-fcpage="first"' + (LIST.page <= 1 ? ' disabled' : '') + ' aria-label="First page">«</button>' +
        '<button class="btn sm" data-fcpage="prev"' + (LIST.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
        '<span class="pg">Page ' + LIST.page + ' of ' + LIST.pages + '</span>' +
        '<button class="btn sm" data-fcpage="next"' + (LIST.page >= LIST.pages ? ' disabled' : '') + '>Next ›</button>' +
        '<button class="btn sm" data-fcpage="last"' + (LIST.page >= LIST.pages ? ' disabled' : '') + ' aria-label="Last page">»</button>' +
      '</div>' : '';

  var rows = shown.map(function (i) {
    var paid = ERP.Invoices.paidFor(i.id), due = ERP.Invoices.outstanding(i);
    var hit = hitsOf(i);
    var cls = i.status === 'PAID' ? 'ok' : i.status === 'CANCELLED' ? 'neu'
            : i.status === 'DRAFT' ? 'neu' : i.status === 'PARTIALLY_PAID' ? 'low'
            : /RETURNED/.test(i.status) ? 'info' : 'bad';
    return '<tr data-row data-iso="' + i.invoiceDate + '" data-status="' + esc(ERP.STATUS_LABEL[i.status]) + '">' +
      '<td data-label="Invoice" class="fcb-key"><b class="mono">' + esc(i.invoiceNumber || 'Draft') + '</b>' +
        (i.orderNumber ? '<div class="sub mono">' + esc(i.orderNumber) + '</div>' : '') +
        (hit ? '<div class="fcb-hit">' + hit.lines.map(function (l) {
            return esc(l.name) + (l.qty ? ' × ' + esc(l.qty) : '');
          }).join(' · ') + (hit.more ? ' · +' + hit.more + ' more' : '') +
          (hit.pays && hit.pays.length
            ? (hit.lines.length ? ' · ' : '') + 'Paid by ' + hit.pays.map(esc).join(' · ') +
              (hit.morePays ? ' · +' + hit.morePays + ' more' : '')
            : '') + '</div>' : '') + '</td>' +
      '<td data-label="Date">' + esc(fmtDate(i.invoiceDate)) + '</td>' +
      '<td data-label="Shop"><button class="lnk" data-cust="' + i.customerId + '">' +
        esc(i.shopNameSnapshot || '—') + '</button>' +
        (i.customerNameSnapshot ? '<div class="sub">' + esc(i.customerNameSnapshot) + '</div>' : '') + '</td>' +
      '<td data-label="Region">' + (i.regionSnapshot ? esc(i.regionSnapshot) : '—') + '</td>' +
      '<td class="c num" data-label="Items">' + i.lineCount + '</td>' +
      '<td data-label="Warehouse">' + esc(i.warehouseSnapshot || '—') + '</td>' +
      '<td class="r num" data-label="Total">' + M.fmtPlain(i.grandTotal) + '</td>' +
      '<td class="r num" data-label="Paid">' + M.fmtPlain(paid) + '</td>' +
      '<td class="r num" data-label="Balance"><b>' + M.fmtPlain(due) + '</b></td>' +
      '<td data-label="Status">' + (global.pill ? global.pill(cls, ERP.STATUS_LABEL[i.status]) : ERP.STATUS_LABEL[i.status]) + '</td>' +
      '<td class="c fcb-rowacts">' +
        '<button class="btn sm" data-fcinv="view" data-id="' + i.id + '">View</button>' +
        '<button class="btn sm" data-fcinv="word" data-id="' + i.id + '">Word</button>' +
        (i.status !== 'CANCELLED' ? '<button class="btn sm" data-fcinv="edit" data-id="' + i.id + '">Edit</button>' : '') +
        (i.status !== 'CANCELLED' && i.status !== 'DRAFT' && (!ERP.Can || ERP.Can('TRANSACTION_CORRECT'))
          ? '<button class="btn sm" data-fcinv="changeshop" data-id="' + i.id + '">Change shop</button>' : '') +
        '<button class="btn sm" data-fcinv="dup" data-id="' + i.id + '">Duplicate</button>' +
        (i.status !== 'CANCELLED' && i.status !== 'DRAFT'
          ? '<button class="btn sm" data-fcinv="pay" data-id="' + i.id + '">Payment</button>' +
            '<button class="btn sm" data-fcinv="return" data-id="' + i.id + '">Return</button>' +
            /* money we owe the shop on this invoice (it paid, then returned goods): one button pays it back */
            (ERP.Invoices.refundDue(i) > 0 && (!ERP.Can || ERP.Can('PAYMENT_CREATE'))
              ? '<button class="btn sm pri" data-fcinv="payback" data-id="' + i.id + '">Pay back ' + M.fmtPlain(ERP.Invoices.refundDue(i)) + '</button>' : '') : '') +
      '</td></tr>';
  });

  return '<div class="ledger l4">' +
      '<div class="kpi"><div class="k">' + I('tag') + 'Invoices</div><div class="v">' + live.length + '</div>' +
        '<div class="d">' + all.filter(function (i) { return i.status === 'DRAFT'; }).length + ' drafts</div></div>' +
      '<div class="kpi"><div class="k">' + I('chart') + 'Invoiced</div><div class="v">' + M.fmt(revenue) + '</div>' +
        '<div class="d">In the current filter</div></div>' +
      '<div class="kpi"><div class="k">' + I('wallet') + 'Received</div><div class="v">' + M.fmt(received) + '</div>' +
        '<div class="d">Against these invoices</div></div>' +
      '<div class="kpi"><div class="k">' + I('alert') + 'Outstanding</div><div class="v">' + M.fmt(outstanding) + '</div>' +
        '<div class="d">Still to collect</div></div>' +
    '</div>' +
    '<div class="bar">' +
      '<div class="tsearch">' + I('search') +
        '<input placeholder="Find an invoice — number, shop, phone, product, date (12/09/2026), amount…" ' +
        'data-fcq value="' + esc(LIST.q) + '" autocomplete="off" spellcheck="false" ' +
        'aria-label="Search invoices"></div>' +
      '<label class="fld" title="Which part of an invoice the words are looked for in">' + I('filter') +
        '<select data-fcfil="scope" aria-label="Search in">' +
        options(ERP.InvoiceSearch.SCOPES.map(function (s) {
          return [s[0], s[0] === 'all' ? 'Search: everything' : 'Search: ' + s[1]];
        }), LIST.scope) + '</select></label>' +
      '<label class="fld" title="Order of the list">' + I('chart') +
        '<select data-fcfil="sort" aria-label="Sort by">' + options(ERP.InvoiceSearch.SORTS, LIST.sort) +
        '</select></label>' +
      '<div class="grow"></div>' +
      '<button class="btn" data-fcbact="exportcsv">' + I('sheet') + 'CSV</button>' +
      '<button class="btn" data-fcnew="order">' + I('doc') + 'New Order</button>' +
      '<button class="btn pri" data-fcnew="sale">' + I('plus') + 'New Invoice</button>' +
    '</div>' +
    '<div class="bar fcb-filters">' +
      '<label class="fld">' + I('cal') + '<select data-fcfil="period" aria-label="Date">' +
        options(periods, LIST.period) + '</select></label>' +
      (LIST.period === 'custom'
        ? '<label class="f"><span>From</span><input type="date" data-fcfil="from" value="' + esc(LIST.from) + '"></label>' +
          '<label class="f"><span>To</span><input type="date" data-fcfil="to" value="' + esc(LIST.to) + '"></label>'
        : '') +
      '<label class="fld">' + I('filter') + '<select data-fcfil="status" aria-label="Status">' +
        options(statuses, LIST.status) + '</select></label>' +
      '<label class="fld">' + I('pin') + '<select data-fcfil="region" aria-label="Region">' +
        '<option value="all">All regions</option>' +
        (global.REGIONS || []).map(function (r) {
          return '<option value="' + esc(r.id) + '"' + (LIST.region === r.id ? ' selected' : '') + '>' +
            esc(r.en) + (r.deleted ? ' (deleted)' : '') + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('box') + '<select data-fcfil="wh" aria-label="Warehouse">' +
        '<option value="all">All warehouses</option>' +
        (global.activeWh ? global.activeWh() : []).map(function (w) {
          return '<option value="' + esc(w.id) + '"' + (LIST.wh === w.id ? ' selected' : '') + '>' +
            esc(w.name) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="f"><span>Total from</span><input inputmode="decimal" data-fcfil="min" placeholder="0" value="' +
        esc(LIST.min) + '"></label>' +
      '<label class="f"><span>Total to</span><input inputmode="decimal" data-fcfil="max" placeholder="any" value="' +
        esc(LIST.max) + '"></label>' +
      (filtering ? '<button class="btn" data-fcbact="invclear">Clear filters</button>' : '') +
    '</div>' +
    info.problems.map(function (m) {
      return '<div class="fcb-note warn">' + I('alert') + '<span>' + esc(m) + '</span></div>';
    }).join('') +
    info.notes.map(function (m) {
      return '<div class="fcb-note">' + I('cal') + '<span>' + esc(m) + '</span></div>';
    }).join('') +
    (list.length
      ? '<div class="fcb-count"><span>' +
          (filtering ? '<b>' + list.length + '</b> of ' + all.length + ' invoices match' : '<b>' + all.length + '</b> invoices') +
          (LIST.pages > 1 ? ' · showing ' + (first + 1) + '–' + (first + shown.length) : '') + '</span>' + pager + '</div>' +
        '<div class="tw"><table class="fcb-list"><thead><tr>' +
        '<th>Invoice #</th><th>Date</th><th>Customer / shop</th><th>Region</th><th class="c">Items</th>' +
        '<th>Warehouse</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th>' +
        '<th>Status</th><th class="c">Actions</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
        (LIST.pages > 1 ? '<div class="fcb-count"><span></span>' + pager + '</div>' : '')
    : '<div class="empty"><div class="ei">' + I('tag') + '</div><b>No invoices match</b>' +
      (filtering
        ? '<p>Nothing on file fits these words and filters. Try fewer words, widen the dates, or search in “Everything”.</p>' +
          '<button class="btn pri" data-fcbact="invclear">Clear filters</button>'
        : '<p>Raise the first invoice for a shop.</p>' +
          '<button class="btn pri" data-fcnew="sale">' + I('plus') + 'New Invoice</button>') + '</div>');
};

LIST.exportCsv = function () {
  var rows = [['Invoice', 'Date', 'Shop', 'Owner', 'Region', 'Warehouse', 'Items', 'Bags', 'Subtotal',
               'Discount', 'Charges', 'Grand total', 'Paid', 'Balance', 'Status']];
  LIST.results().forEach(function (i) {
    rows.push([i.invoiceNumber || 'DRAFT', i.invoiceDate, i.shopNameSnapshot, i.customerNameSnapshot,
      i.regionSnapshot, i.warehouseSnapshot, i.lineCount, i.totalQty,
      M.toR(i.subtotal), M.toR(i.discountAmount),
      M.toR(i.freightAmount + i.loadingAmount + i.otherCharges + i.taxAmount),
      M.toR(i.grandTotal), M.toR(ERP.Invoices.paidFor(i.id)), M.toR(ERP.Invoices.outstanding(i)),
      ERP.STATUS_LABEL[i.status]]);
  });
  var csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c === undefined ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new global.Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  var a = global.document.createElement('a');
  a.href = global.URL.createObjectURL(blob);
  a.download = 'farooq-co-invoices-' + todayISO() + '.csv';
  global.document.body.appendChild(a); a.click();
  setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

ERP.BuilderUI = {
  addLine: addLine, refreshTotals: refreshTotals, searchProducts: searchProducts,
  resultRow: resultRow, matches: matches, LIST: LIST, MODES: MODES
};
})(typeof window !== 'undefined' ? window : globalThis);
