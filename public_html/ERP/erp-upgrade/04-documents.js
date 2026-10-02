/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 4/5
   DOCUMENT SERVICE  ·  one model, four outputs
   Every document is built once from the database (never from the screen's
   numbers) and then rendered as: an A4 preview, a print/PDF page, an
   editable Word file, and a WhatsApp/SMS message. (§1 §8 §9 §31 §32 §34
   §35 §50 §51)
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';

var ERP = global.ERP, FDB = global.FDB, M = global.Money, DOCX = global.DOCX;
var S = ERP.S;

function fmtDate(iso) {
  if (!iso) return '';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return String(d.getDate()).padStart(2, '0') + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isUrdu(s) { return /[\u0600-\u06FF]/.test(String(s || '')); }
function ur(s) { return s ? '<span lang="ur" dir="rtl" class="fc-ur">' + esc(s) + '</span>' : ''; }
function words(n) { return global.words ? global.words(Math.round(M.toR(n))) : ''; }
function qtyFmt(q) { return Number(q).toLocaleString('en-US'); }

/* ══════════════════════════════════════════════════════════════════════════
   DOCUMENT MODELS — read from the store, never from the form
   ══════════════════════════════════════════════════════════════════════════ */
var DocModel = {
  business: function () {
    var b = ERP.Settings.get();
    return {
      name: b.businessName, legalName: b.legalName, tagline: b.tagline, taglineUr: b.taglineUr,
      slogan: b.slogan, logoText: b.logoText || 'F&C', logoDataUrl: b.logoDataUrl || '',
      address: b.address, city: b.city, phone: b.phone, shopPhone: b.shopPhone,
      whatsapp: b.whatsapp, email: b.email, website: b.website,
      ntn: b.ntn, registrationNo: b.registrationNo, proprietor: b.proprietor,
      currency: b.currencyLabel || 'PKR'
    };
  },

  invoice: function (invoiceId) {
    var inv = ERP.Invoices.byId(invoiceId);
    if (!inv) return null;
    var items = ERP.Invoices.items(invoiceId);
    var pays = ERP.Payments.forInvoice(invoiceId);
    var b = DocModel.business();
    var totals = [];
    totals.push({ label: 'Subtotal', value: M.fmt(inv.subtotal) });
    if (inv.itemDiscounts)  totals.push({ label: 'Item discounts', value: '− ' + M.fmt(inv.itemDiscounts) });
    if (inv.invoiceDiscount) totals.push({ label: 'Invoice discount', value: '− ' + M.fmt(inv.invoiceDiscount) });
    if (inv.taxAmount)      totals.push({ label: 'Tax', value: M.fmt(inv.taxAmount) });
    if (inv.freightAmount)  totals.push({ label: 'Delivery / freight', value: M.fmt(inv.freightAmount) });
    if (inv.loadingAmount)  totals.push({ label: 'Loading / unloading', value: M.fmt(inv.loadingAmount) });
    if (inv.otherCharges)   totals.push({ label: 'Other charges', value: M.fmt(inv.otherCharges) });
    totals.push({ label: 'Grand total', labelUr: 'ٹوٹل بل رقم', value: M.fmt(inv.grandTotal), big: true, rule: true });
    var paid = ERP.Invoices.paidFor(invoiceId);
    totals.push({ label: 'Amount Paid', labelUr: 'نقد وصول', value: M.fmt(paid) });
    totals.push({ label: 'Balance on this invoice', labelUr: 'بقایا رقم', value: M.fmt(inv.grandTotal - paid), bold: true });

    var closing = ERP.Ledger.customerBalance(inv.customerId);
    return {
      kind: 'INVOICE', entityId: inv.id, title: 'INVOICE', number: inv.invoiceNumber || 'DRAFT',
      status: ERP.STATUS_LABEL[inv.status] || inv.status,
      statusKey: inv.status, isDraft: inv.status === 'DRAFT', cancelled: inv.status === 'CANCELLED',
      date: fmtDate(inv.invoiceDate), rawDate: inv.invoiceDate,
      business: b,
      party: {
        label: 'BILL TO', labelUr: 'بنام', shop: inv.shopNameSnapshot, owner: inv.customerNameSnapshot,
        code: inv.customerCodeSnapshot, contact: inv.mobileSnapshot, whatsapp: inv.whatsappSnapshot,
        address: inv.addressSnapshot, region: inv.regionSnapshot, market: inv.marketSnapshot,
        id: inv.customerId
      },
      metaLabel: 'INVOICE DETAILS',
      meta: [
        ['Invoice No', inv.invoiceNumber || 'Not issued (draft)', true],
        ['Invoice type', inv.invoiceType === 'SALE' ? 'Sales invoice' : inv.invoiceType],
        ['Invoice date', fmtDate(inv.invoiceDate)],
        ['Due date', inv.dueDate ? fmtDate(inv.dueDate) : '—'],
        ['Order No', inv.orderNumber || '—'],
        ['Dispatch No', inv.dispatchNumber || ''],
        ['Warehouse', inv.warehouseSnapshot],
        ['Payment status', ERP.STATUS_LABEL[inv.paymentStatus] || inv.paymentStatus],
        ['Salesperson', inv.salesperson]
      ],
      strip: [
        ['Payment method', inv.paymentMethod || '—'],
        ['Reference', inv.referenceNo || '—'],
        ['Region', inv.regionSnapshot || '—'],
        ['Items', String(items.length)]
      ],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.05 },
        { key: 'description', label: 'Description', width: 0.30 },
        { key: 'brand', label: 'Brand', width: 0.13 },
        { key: 'pack', label: 'Package', align: 'center', width: 0.09 },
        { key: 'qty', label: 'Qty', align: 'right', width: 0.08 },
        { key: 'rate', label: 'Rate', align: 'right', width: 0.11 },
        { key: 'discount', label: 'Discount', align: 'right', width: 0.11 },
        { key: 'amount', label: 'Amount', align: 'right', width: 0.13 }
      ],
      rows: items.map(function (it, i) {
        return {
          sr: i + 1,
          description: it.descriptionEnSnapshot || '',
          descriptionUr: it.descriptionSnapshot || '',
          brand: it.brandSnapshot || '—',
          pack: it.packageSnapshot || 'Bag',
          qty: qtyFmt(it.quantity) + ' ' + (it.unit || 'Bag') + (it.quantity === 1 ? '' : 's'),
          rate: M.fmtPlain(it.unitPrice),
          discount: it.discount ? M.fmtPlain(it.discount) : '—',
          amount: M.fmtPlain(it.lineTotal),
          returned: it.returnedQty || 0,
          batch: it.batchNo || ''
        };
      }),
      itemsFooter: {
        description: 'Total — ' + items.length + (items.length === 1 ? ' line' : ' lines'),
        qty: qtyFmt(inv.totalQty) + ' Bags',
        amount: M.fmtPlain(inv.subtotal - inv.itemDiscounts)
      },
      totals: totals,
      words: words(inv.grandTotal),
      paymentsList: pays.map(function (p) {
        return { date: fmtDate(p.paymentDate), method: p.method, ref: p.reference || '', amount: M.fmt(p.amount) };
      }),
      notes: inv.notes || '',
      ledger: [
        ['Previous balance', M.fmt(inv.previousBalance || 0), 'سابقہ بقایا رقم'],
        ['This invoice', '+ ' + M.fmt(inv.grandTotal), ''],
        ['Payment received', '− ' + M.fmt(paid), ''],
        ['Current outstanding balance', M.fmt(closing), 'بقایا رقم']
      ],
      signatures: ['Prepared by', 'Received by (shopkeeper)', 'Authorised signature'],
      footer: {
        thanks: ERP.Settings.get().invoiceFooter || 'Thank you for your business.',
        terms: ERP.Settings.get().terms || '',
        bank: ERP.Settings.get().bankDetails || ''
      },
      actions: { edit: true, duplicate: true, cancel: true, payment: true, ret: true, whatsapp: true, sms: true,
                 /* a draft has no account entry to move (edit it instead); a cancelled one has none left */
                 changeShop: inv.status !== 'DRAFT' && inv.status !== 'CANCELLED' &&
                             (!ERP.Can || ERP.Can('TRANSACTION_CORRECT')) }
    };
  },

  receipt: function (paymentId) {
    var p = ERP.Payments.byId(paymentId);
    if (!p) return null;
    var incoming = p.direction === 'IN';
    var isCustParty = p.partyType === 'CUSTOMER';
    var allocs = S.allocations.filter(function (a) { return a.paymentId === p.id; });
    /* the balance to show is which party this payment is against — a
       customer refund (direction OUT, partyType CUSTOMER) still needs the
       shop's own balance, not the supplier ledger the direction alone
       would suggest */
    var closing = isCustParty ? ERP.Ledger.customerBalance(p.partyId) : ERP.Ledger.supplierBalance(p.partyId);
    return {
      kind: incoming ? 'RECEIPT' : 'VOUCHER', entityId: p.id,
      title: incoming ? 'PAYMENT RECEIPT' : 'PAYMENT VOUCHER',
      number: p.receiptNumber, status: p.status === 'REVERSED' ? 'Reversed' : 'Posted',
      cancelled: p.status === 'REVERSED',
      date: fmtDate(p.paymentDate), rawDate: p.paymentDate,
      business: DocModel.business(),
      party: {
        label: incoming ? 'RECEIVED FROM' : 'PAID TO', shop: p.partyNameSnapshot,
        owner: p.partyOwnerSnapshot, region: p.regionSnapshot, id: p.partyId,
        contact: isCustParty ? ((global.custBy(p.partyId) || {}).ph || '') : ''
      },
      metaLabel: 'RECEIPT DETAILS',
      meta: [
        ['Receipt No', p.receiptNumber, true],
        ['Date', fmtDate(p.paymentDate)],
        ['Method', p.method],
        ['Reference', p.reference || '—'],
        ['Received by', p.receivedBy]
      ],
      strip: [
        ['Amount', M.fmt(p.amount)],
        ['Method', p.method],
        ['Applied to', allocs.length ? allocs.length + ' invoice' + (allocs.length === 1 ? '' : 's') : 'On account'],
        ['Status', p.status === 'REVERSED' ? 'Reversed' : 'Posted']
      ],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.07 },
        { key: 'description', label: 'Applied to invoice', width: 0.43 },
        { key: 'pack', label: 'Invoice date', align: 'center', width: 0.20 },
        { key: 'amount', label: 'Amount applied', align: 'right', width: 0.30 }
      ],
      rows: allocs.map(function (a, i) {
        var inv = a.invoiceId ? ERP.Invoices.byId(a.invoiceId) : null;
        var pur = a.purchaseId ? ERP.Purchases.byId(a.purchaseId) : null;
        return {
          sr: i + 1,
          description: inv ? inv.invoiceNumber : pur ? pur.purchaseNumber : 'On account',
          descriptionUr: '',
          pack: inv ? fmtDate(inv.invoiceDate) : pur ? fmtDate(pur.purchaseDate) : '—',
          amount: M.fmtPlain(a.amount)
        };
      }),
      itemsFooter: allocs.length ? { description: 'Total applied', amount: M.fmtPlain(
        allocs.reduce(function (x, a) { return x + a.amount; }, 0)) } : null,
      totals: [
        { label: incoming ? 'Amount received' : 'Amount paid',
          labelUr: incoming ? 'وصول رقم' : 'ادا شدہ رقم', value: M.fmt(p.amount), big: true, rule: true },
        { label: 'Previous balance', value: M.fmt(p.balanceBefore) },
        { label: 'Remaining balance', labelUr: 'بقایا رقم', value: M.fmt(closing), bold: true }
      ],
      words: words(p.amount),
      notes: p.note || '',
      ledger: [],
      signatures: ['Received by', 'Authorised signature'],
      footer: {
        thanks: 'Thank you for your payment.',
        terms: 'This receipt is valid subject to realisation of the instrument where applicable.',
        bank: ERP.Settings.get().bankDetails || ''
      },
      actions: { whatsapp: incoming, sms: incoming, reverse: true }
    };
  },

  purchase: function (purchaseId) {
    var pu = ERP.Purchases.byId(purchaseId);
    if (!pu) return null;
    var items = ERP.Purchases.items(purchaseId);
    var totals = [{ label: 'Subtotal', value: M.fmt(pu.subtotal) }];
    if (pu.discountAmount) totals.push({ label: 'Discounts', value: '− ' + M.fmt(pu.discountAmount) });
    if (pu.freightAmount)  totals.push({ label: 'Freight', value: M.fmt(pu.freightAmount) });
    if (pu.loadingAmount)  totals.push({ label: 'Loading / unloading', value: M.fmt(pu.loadingAmount) });
    if (pu.otherCharges)   totals.push({ label: 'Other charges', value: M.fmt(pu.otherCharges) });
    totals.push({ label: 'Grand total', value: M.fmt(pu.grandTotal), big: true, rule: true });
    totals.push({ label: 'Paid', value: M.fmt(pu.paidAmount) });
    totals.push({ label: 'Payable to supplier', value: M.fmt(pu.grandTotal - pu.paidAmount), bold: true });
    /* §29: carriage is an information line only — it raises the cost of the bags, not the supplier's bill */
    if (pu.carriageAmount > 0) totals.push({ label: 'Carriage / transport (paid separately, not in the total)', value: M.fmt(pu.carriageAmount) });
    return {
      kind: 'PURCHASE', entityId: pu.id, title: 'PURCHASE INVOICE', number: pu.purchaseNumber,
      status: ERP.STATUS_LABEL[pu.paymentStatus] || pu.paymentStatus,
      date: fmtDate(pu.purchaseDate), rawDate: pu.purchaseDate,
      business: DocModel.business(),
      party: { label: 'SUPPLIER', shop: pu.supplierNameSnapshot, id: pu.supplierId },
      metaLabel: 'PURCHASE DETAILS',
      meta: [
        ['Purchase No', pu.purchaseNumber, true],
        ['Supplier invoice', pu.supplierInvoiceNo || '—'],
        ['Date', fmtDate(pu.purchaseDate)],
        ['Warehouse', pu.warehouseSnapshot],
        ['Vehicle', pu.vehicleNo || '—'],
        ['Driver', pu.driver || '']
      ],
      strip: [['Payment status', ERP.STATUS_LABEL[pu.paymentStatus] || pu.paymentStatus],
              ['Bags received', qtyFmt(pu.totalQty)], ['Lines', String(items.length)],
              ['Delivery ref', pu.deliveryRef || '—']],
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
                 brand: it.brandSnapshot || '—', pack: it.packageSnapshot,
                 qty: qtyFmt(it.quantity), rate: M.fmtPlain(it.unitPrice), amount: M.fmtPlain(it.lineTotal) };
      }),
      itemsFooter: { description: 'Total — ' + items.length + ' lines', qty: qtyFmt(pu.totalQty),
                     amount: M.fmtPlain(pu.subtotal) },
      totals: totals, words: words(pu.grandTotal), notes: pu.notes || '', ledger: [],
      signatures: ['Received by', 'Store keeper', 'Authorised signature'],
      footer: { thanks: 'Goods received in good condition unless noted.', terms: '', bank: '' },
      actions: { edit: ERP.Purchases.canEdit(pu) }
    };
  },

  customerReturn: function (returnId) {
    var r = S.custReturns.find(function (x) { return x.id === returnId; });
    if (!r) return null;
    var items = ERP.Returns.customerItems(returnId);
    var ACTION = { RESELLABLE: 'Back to sellable stock', DAMAGED: 'Held as damaged',
                   BACK_TO_SUPPLIER: 'To be returned to supplier', WRITE_OFF: 'Written off' };
    return {
      kind: 'CUSTOMER_RETURN', entityId: r.id, title: 'CREDIT NOTE / RETURN', number: r.returnNumber,
      status: 'Posted', date: fmtDate(r.returnDate), rawDate: r.returnDate,
      business: DocModel.business(),
      party: { label: 'RETURNED BY', shop: r.customerNameSnapshot, region: r.regionSnapshot, id: r.customerId },
      metaLabel: 'RETURN DETAILS',
      meta: [['Return No', r.returnNumber, true], ['Against invoice', r.invoiceNumber],
             ['Return date', fmtDate(r.returnDate)], ['Warehouse', r.warehouseSnapshot],
             ['Reason', r.reason || '—'], ['Condition', r.condition || '—']],
      strip: [['Credit amount', M.fmt(r.creditAmount)], ['Bags returned', qtyFmt(r.totalQty)],
              ['Action', ACTION[r.action] || r.action], ['Invoice', r.invoiceNumber]],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.06 },
        { key: 'description', label: 'Description', width: 0.34 },
        { key: 'pack', label: 'Package', align: 'center', width: 0.11 },
        { key: 'qty', label: 'Qty returned', align: 'right', width: 0.13 },
        { key: 'rate', label: 'Rate', align: 'right', width: 0.15 },
        { key: 'amount', label: 'Credit', align: 'right', width: 0.21 }
      ],
      rows: items.map(function (it, i) {
        return { sr: i + 1, description: it.descriptionEnSnapshot, descriptionUr: it.descriptionSnapshot,
                 pack: it.packageSnapshot, qty: qtyFmt(it.quantity),
                 rate: M.fmtPlain(it.unitPrice), amount: M.fmtPlain(it.lineTotal) };
      }),
      itemsFooter: { description: 'Total credit', qty: qtyFmt(r.totalQty), amount: M.fmtPlain(r.creditAmount) },
      totals: [{ label: 'Credit to customer account', value: M.fmt(r.creditAmount), big: true, rule: true },
               { label: 'Balance after credit', value: M.fmt(ERP.Ledger.customerBalance(r.customerId)), bold: true }],
      words: words(r.creditAmount), notes: r.notes || '', ledger: [],
      signatures: ['Received by', 'Approved by'],
      footer: { thanks: 'The original invoice remains on record; this credit note adjusts the account.',
                terms: '', bank: '' },
      actions: { whatsapp: true }
    };
  },

  supplierReturn: function (returnId) {
    var r = S.supReturns.find(function (x) { return x.id === returnId; });
    if (!r) return null;
    var items = ERP.Returns.supplierItems(returnId);
    return {
      kind: 'SUPPLIER_RETURN', entityId: r.id, title: 'SUPPLIER RETURN NOTE', number: r.returnNumber,
      status: 'Posted', date: fmtDate(r.returnDate), rawDate: r.returnDate,
      business: DocModel.business(),
      party: { label: 'RETURNED TO', shop: r.supplierNameSnapshot, id: r.supplierId },
      metaLabel: 'RETURN DETAILS',
      meta: [['Return No', r.returnNumber, true], ['Against purchase', r.purchaseNumber || '—'],
             ['Date', fmtDate(r.returnDate)], ['Warehouse', r.warehouseSnapshot], ['Reason', r.reason || '—']],
      strip: [['Debit to supplier', M.fmt(r.debitAmount)], ['Bags returned', qtyFmt(r.totalQty)],
              ['Warehouse', r.warehouseSnapshot], ['Status', 'Posted']],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.06 },
        { key: 'description', label: 'Description', width: 0.38 },
        { key: 'pack', label: 'Package', align: 'center', width: 0.12 },
        { key: 'qty', label: 'Qty', align: 'right', width: 0.13 },
        { key: 'rate', label: 'Rate', align: 'right', width: 0.14 },
        { key: 'amount', label: 'Amount', align: 'right', width: 0.17 }
      ],
      rows: items.map(function (it, i) {
        return { sr: i + 1, description: it.descriptionEnSnapshot, descriptionUr: it.descriptionSnapshot,
                 pack: it.packageSnapshot, qty: qtyFmt(it.quantity) + (it.fromDamaged ? ' (damaged)' : ''),
                 rate: M.fmtPlain(it.unitPrice), amount: M.fmtPlain(it.lineTotal) };
      }),
      itemsFooter: { description: 'Total', qty: qtyFmt(r.totalQty), amount: M.fmtPlain(r.debitAmount) },
      totals: [{ label: 'Debit to supplier account', value: M.fmt(r.debitAmount), big: true, rule: true },
               { label: 'Payable after adjustment', value: M.fmt(ERP.Ledger.supplierBalance(r.supplierId)), bold: true }],
      words: words(r.debitAmount), notes: r.notes || '', ledger: [],
      signatures: ['Handed over by', 'Received by (supplier)'],
      footer: { thanks: '', terms: '', bank: '' },
      actions: {}
    };
  },

  /* Milling job — wheat issued to a mill, flour/chokar received back, the
     process loss shown and the net settlement against the mill's own
     account. Added by 32-milling.js; ERP.Milling is guarded so this model
     simply returns null if that module never loaded. */
  millingJob: function (jobId) {
    if (!ERP.Milling) return null;
    var job = ERP.Milling.byId(jobId);
    if (!job) return null;
    var items = ERP.Milling.items(jobId);
    var mill = (global.supOf && global.supOf(job.millId)) || {};
    var totals = [];
    if (job.settle !== 'FEE_ONLY') {
      totals.push({ label: 'Wheat issued', value: M.fmt(job.issuedValue) });
      totals.push({ label: 'Received back', value: M.fmt(job.receivedValue) });
    }
    if (job.feeAmount) totals.push({ label: 'Milling fee', value: M.fmt(job.feeAmount) });
    totals.push({
      label: job.netAmount >= 0 ? 'Net payable to mill' : 'Net receivable from mill',
      labelUr: job.netAmount >= 0 ? 'بقایا رقم' : '',
      value: M.fmt(Math.abs(job.netAmount)), big: true, rule: true
    });
    totals.push({ label: 'Payable after this job', value: M.fmt(ERP.Ledger.supplierBalance(job.millId)), bold: true });
    return {
      kind: 'MILLING', entityId: job.id, title: 'MILLING JOB', number: job.jobNumber,
      status: job.status === 'CANCELLED' ? 'Cancelled' : 'Posted', cancelled: job.status === 'CANCELLED',
      date: fmtDate(job.jobDate), rawDate: job.jobDate,
      business: DocModel.business(),
      party: { label: 'MILL', shop: job.millSnapshot, owner: mill.cp || '', contact: mill.ph || '', id: job.millId },
      metaLabel: 'MILLING DETAILS',
      meta: [
        ['Job No', job.jobNumber, true],
        ['Date', fmtDate(job.jobDate)],
        ['Warehouse', job.warehouseSnapshot],
        ['Settlement', job.settle === 'FEE_ONLY' ? 'Grinding fee only' : 'Net off against account'],
        ['Finished goods', ERP.Milling.receiveMode(job) === 'AT_MILL' ? 'Lying at the mill until they arrive' : 'Added to our warehouse']
      ],
      strip: [['Weight issued', job.inWeightKg + ' kg'], ['Weight received', job.outWeightKg + ' kg'],
              ['Process loss', job.lossKg + ' kg (' + job.lossPct + '%)'], ['Net', M.fmt(job.netAmount)]],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.05 },
        { key: 'side', label: 'Side', align: 'center', width: 0.11 },
        { key: 'description', label: 'Description / تفصیل', width: 0.29 },
        { key: 'qty', label: 'تعداد', align: 'right', width: 0.12 },
        { key: 'pack', label: 'وزن (kg)', align: 'right', width: 0.13 },
        { key: 'rate', label: 'ریٹ', align: 'right', width: 0.13 },
        { key: 'amount', label: 'رقم', align: 'right', width: 0.17 }
      ],
      rows: items.map(function (it, i) {
        return {
          sr: i + 1, side: it.side === 'ISSUE' ? 'Issued' : (ERP.Milling.receiveMode(job) === 'AT_MILL' ? 'Made' : 'Received'),
          description: it.productSnapshot, descriptionUr: it.productUrSnapshot,
          qty: qtyFmt(it.quantity), pack: qtyFmt(it.weightKg),
          rate: M.fmtPlain(it.unitRate) + '/' + (it.rateBasis === 'KG' ? 'kg' : 'bag'),
          amount: M.fmtPlain(it.lineTotal)
        };
      }),
      itemsFooter: null,
      totals: totals,
      words: words(Math.abs(job.netAmount)), notes: job.notes || '', ledger: [],
      signatures: ['Handed over by', 'Received by (mill)'],
      footer: { thanks: '', terms: '', bank: '' },
      actions: {}
    };
  },

  /* Goods arrived from a mill — one load of finished goods reaching one of our warehouses. Added by
     32-milling.js; null if that module never loaded. Bags and weight only: no money moves on an arrival. */
  millingArrival: function (arrivalId) {
    if (!ERP.Milling) return null;
    var a = ERP.Milling.arrivalById(arrivalId);
    if (!a) return null;
    var mill = (global.supOf && global.supOf(a.millId)) || {};
    var left = ERP.Milling.atMillTotals(a.millId);
    return {
      kind: 'MILLING_ARRIVAL', entityId: a.id, title: 'GOODS RECEIVED FROM MILL', number: a.arrivalNumber,
      status: a.status === 'CANCELLED' ? 'Cancelled' : 'Received', cancelled: a.status === 'CANCELLED',
      date: fmtDate(a.arrivalDate), rawDate: a.arrivalDate,
      business: DocModel.business(),
      party: { label: 'MILL', shop: a.millSnapshot, owner: mill.cp || '', contact: mill.ph || '', id: a.millId },
      metaLabel: 'ARRIVAL DETAILS',
      meta: [
        ['Arrival No', a.arrivalNumber, true],
        ['Date', fmtDate(a.arrivalDate)],
        ['Into warehouse', a.warehouseSnapshot],
        ['Vehicle / bilti', a.vehicle || '—']
      ],
      strip: [['Bags received', qtyFmt(a.totalQty)], ['Weight', qtyFmt(a.totalKg) + ' kg'],
              ['Still at the mill (now)', qtyFmt(left.qty) + ' bags']],
      columns: [
        { key: 'sr', label: 'SR', align: 'center', width: 0.06 },
        { key: 'description', label: 'Description / تفصیل', width: 0.5 },
        { key: 'qty', label: 'تعداد', align: 'right', width: 0.22 },
        { key: 'pack', label: 'وزن (kg)', align: 'right', width: 0.22 }
      ],
      rows: (a.lines || []).map(function (l, i) {
        return { sr: i + 1, description: l.productSnapshot, descriptionUr: l.productUrSnapshot,
          qty: qtyFmt(l.quantity), pack: qtyFmt(l.weightKg) };
      }),
      itemsFooter: null,
      totals: [{ label: 'Total bags', value: qtyFmt(a.totalQty), big: true, rule: true },
               { label: 'Still lying at the mill (now)', value: qtyFmt(left.qty) + ' bags', bold: true }],
      words: '', notes: a.notes || '', ledger: [],
      signatures: ['Sent by (mill)', 'Received by (warehouse)'],
      footer: { thanks: '', terms: '', bank: '' },
      actions: {}
    };
  },

  statement: function (partyId, type, fromISO, toISO) {
    var isCust = type !== 'SUPPLIER';
    var L = isCust ? ERP.Ledger.customer(partyId, fromISO, toISO) : ERP.Ledger.supplier(partyId, fromISO, toISO);
    var party = isCust ? (global.custBy(partyId) || {}) : (global.supOf(partyId) || {});
    var region = isCust && party.region && global.regionOf ? global.regionOf(party.region) : null;
    return {
      kind: 'STATEMENT', entityId: partyId,
      title: isCust ? 'ACCOUNT STATEMENT' : 'SUPPLIER STATEMENT',
      number: (isCust ? 'CST-' : 'SST-') + (party.legacyCode || partyId),
      status: 'Statement', date: fmtDate(toISO || (global.FC_TODAY ? global.FC_TODAY() : '')),
      business: DocModel.business(),
      party: { label: isCust ? 'ACCOUNT OF' : 'SUPPLIER', shop: isCust ? party.sh : party.co,
               owner: isCust ? party.ow : party.cp, code: party.legacyCode || '',
               contact: party.ph || '', region: region ? region.ur + ' — ' + region.en : '', id: partyId },
      metaLabel: 'PERIOD',
      meta: [['From', fromISO ? fmtDate(fromISO) : 'Beginning'], ['To', toISO ? fmtDate(toISO) : 'Today'],
             ['Opening balance', M.fmt(L.opening)], ['Closing balance', M.fmt(L.closing), true]],
      strip: [['Opening', M.fmt(L.opening)], ['Debit', M.fmt(L.debit)],
              ['Credit', M.fmt(L.credit)], ['Closing', M.fmt(L.closing)]],
      columns: [
        { key: 'sr', label: 'Date', width: 0.11 },
        { key: 'pack', label: 'Folio / Reference #', align: 'center', width: 0.14 },
        { key: 'description', label: 'Description / \u062a\u0641\u0635\u06cc\u0644', width: 0.30 },
        { key: 'brand', label: 'Qty', align: 'right', width: 0.09 },
        { key: 'rate', label: 'Debit / \u0628\u0646\u0627\u0645', align: 'right', width: 0.11 },
        { key: 'discount', label: 'Credit / \u062c\u0645\u0639', align: 'right', width: 0.11 },
        { key: 'amount', label: 'Balance / \u0628\u0642\u0627\u06cc\u0627', align: 'right', width: 0.14 }
      ],
      rows: L.rows.map(function (r) {
        return { sr: fmtDate(r.iso),
                 description: r.description || r.what, descriptionUr: '', pack: r.ref,
                 brand: (ERP.Desc && ERP.Desc.qtyLabel) ? ERP.Desc.qtyLabel(r) : '\u2014',
                 rate: r.dr ? M.fmtPlain(r.dr) : '\u2014', discount: r.cr ? M.fmtPlain(r.cr) : '\u2014',
                 amount: M.fmtPlain(r.balance) };
      }),
      itemsFooter: { description: 'Totals', rate: M.fmtPlain(L.debit), discount: M.fmtPlain(L.credit),
                     amount: M.fmtPlain(L.closing) },
      totals: [{ label: 'Opening balance', value: M.fmt(L.opening) },
               { label: isCust ? 'Total invoiced' : 'Total purchased', value: M.fmt(isCust ? L.debit : L.credit) },
               { label: isCust ? 'Total received' : 'Total paid', value: M.fmt(isCust ? L.credit : L.debit) },
               { label: 'Closing balance', labelUr: 'بقایا رقم', value: M.fmt(L.closing), big: true, rule: true }],
      words: words(L.closing), notes: '', ledger: [],
      signatures: ['Accountant', 'Authorised signature'],
      footer: { thanks: 'Please confirm the closing balance at your earliest convenience.', terms: '', bank: '' },
      actions: { whatsapp: isCust }
    };
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   A4 PREVIEW  ·  the same model rendered as HTML (§35)
   ══════════════════════════════════════════════════════════════════════════ */
var PAPER_CSS = `
.fcdoc{--doc-ink:#16161F;--doc-mute:#63636F;--doc-line:#D8D8E0;--doc-accent:#5B21B6;--doc-soft:#F3F0FC;
  background:#fff;color:var(--doc-ink);font-family:"Segoe UI",Manrope,-apple-system,system-ui,sans-serif;
  font-size:11px;line-height:1.45;width:210mm;min-height:296mm;padding:13mm 13mm 12mm;margin:0 auto;
  box-sizing:border-box;position:relative}
.fcdoc *{box-sizing:border-box}
.fcdoc .fc-ur{font-family:"Noto Nastaliq Urdu","Jameel Noori Nastaleeq",serif;line-height:2;font-size:.96em}
.fcdoc .fc-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.fcdoc .fc-logo{font-size:26px;font-weight:800;color:var(--doc-accent);letter-spacing:-.5px;line-height:1}
.fcdoc .fc-logo img{max-height:46px;max-width:150px;display:block}
.fcdoc .fc-name{font-size:17px;font-weight:800;margin-top:6px;letter-spacing:-.2px}
.fcdoc .fc-tag{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:var(--doc-mute);margin-top:2px}
.fcdoc .fc-slogan{color:var(--doc-accent);margin-top:1px}
.fcdoc .fc-contact{text-align:right;font-size:9.5px;color:var(--doc-mute);line-height:1.65}
.fcdoc .fc-title{text-align:center;font-size:25px;font-weight:800;letter-spacing:7px;margin:14px 0 8px;
  padding-bottom:7px;border-bottom:2px solid var(--doc-accent)}
.fcdoc .fc-ribbon{position:absolute;top:34mm;right:14mm;transform:rotate(-14deg);border:3px solid #A32E2E;
  color:#A32E2E;font-weight:800;letter-spacing:3px;padding:4px 14px;font-size:16px;opacity:.5;border-radius:4px}
.fcdoc .fc-parties{display:grid;grid-template-columns:1.15fr 1fr;gap:20px;margin-top:12px}
.fcdoc .fc-lbl{font-size:8.5px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:var(--doc-accent);margin-bottom:5px}
.fcdoc .fc-shop{font-size:14px;font-weight:700;margin-bottom:4px}
.fcdoc .fc-kv{display:flex;gap:6px;margin-bottom:2px}
.fcdoc .fc-kv span{color:var(--doc-mute);min-width:78px}
.fcdoc .fc-meta{width:100%;border-collapse:collapse}
.fcdoc .fc-meta td{padding:2.5px 0;vertical-align:top}
.fcdoc .fc-meta td:first-child{color:var(--doc-mute)}
.fcdoc .fc-meta td:last-child{text-align:right;font-weight:600}
.fcdoc .fc-strip{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid var(--doc-line);
  border-radius:5px;overflow:hidden;margin:12px 0 0;background:#FAFAFC}
.fcdoc .fc-strip>div{padding:6px 9px;border-right:1px solid var(--doc-line)}
.fcdoc .fc-strip>div:last-child{border-right:none}
.fcdoc .fc-strip b{display:block;font-size:11.5px;margin-top:1px}
.fcdoc .fc-strip i{font-style:normal;font-size:8px;letter-spacing:1.1px;text-transform:uppercase;color:var(--doc-mute)}
.fcdoc table.fc-items{width:100%;border-collapse:collapse;margin-top:12px;font-size:10.5px}
.fcdoc table.fc-items th{background:var(--doc-soft);text-align:left;font-size:8.5px;letter-spacing:1.1px;
  text-transform:uppercase;padding:7px 7px;border:1px solid var(--doc-line);font-weight:700}
.fcdoc table.fc-items td{padding:6px 7px;border:1px solid var(--doc-line);vertical-align:middle}
.fcdoc table.fc-items tbody tr:nth-child(even) td{background:#FAFAFC}
.fcdoc table.fc-items tfoot td{background:#F1EEFB;font-weight:700;border:1px solid var(--doc-line)}
.fcdoc .r{text-align:right}.fcdoc .c{text-align:center}
.fcdoc .fc-sub{font-size:9px;color:var(--doc-mute);display:block}
.fcdoc .fc-bottom{display:grid;grid-template-columns:1.1fr .9fr;gap:20px;margin-top:14px}
.fcdoc .fc-tot{width:100%;border-collapse:collapse}
.fcdoc .fc-tot td{padding:4.5px 8px;border-bottom:1px solid #EDEDF2}
.fcdoc .fc-tot td:last-child{text-align:right;font-weight:600}
.fcdoc .fc-tot tr.big td{background:#F1EEFB;font-size:14px;font-weight:800;padding:9px 8px;border-top:1.5px solid var(--doc-accent)}
.fcdoc .fc-tot tr.bold td{font-weight:800}
.fcdoc .fc-words{background:#FAFAFC;border-left:2.5px solid var(--doc-accent);padding:7px 10px;border-radius:0 4px 4px 0}
.fcdoc .fc-ledger{margin-top:14px;border:1px solid var(--doc-line);border-radius:5px;overflow:hidden}
.fcdoc .fc-ledger div{display:flex;justify-content:space-between;padding:5px 10px;border-bottom:1px solid #EDEDF2}
.fcdoc .fc-ledger div:last-child{border-bottom:none;background:#F6F3FE;font-weight:800}
.fcdoc .fc-sigs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:24px;margin-top:26px}
.fcdoc .fc-sigs div{border-top:1px solid #8C8C99;padding-top:5px;font-size:8.5px;letter-spacing:1.1px;
  text-transform:uppercase;color:var(--doc-mute)}
.fcdoc .fc-foot{margin-top:16px;padding-top:9px;border-top:1px solid var(--doc-line);text-align:center;color:var(--doc-mute);font-size:9.5px}
.fcdoc .fc-foot b{display:block;color:var(--doc-ink);font-size:11.5px;margin-bottom:2px}
.fcdoc .fc-pagefoot{display:none}
@media print{
  html,body{background:#fff !important}
  body.fc-printing .app,body.fc-printing .tabbar,body.fc-printing #panel,body.fc-printing #scrim,
  body.fc-printing .toast,body.fc-printing .fcv-bar,body.fc-printing #fcbuilder{display:none !important}
  body.fc-printing #fcviewer{position:static !important;display:block !important;background:#fff !important;
    inset:auto !important;padding:0 !important;overflow:visible !important;backdrop-filter:none !important}
  body.fc-printing #fcviewer .fcv-scroll{overflow:visible !important;padding:0 !important;display:block !important}
  body.fc-printing #fcviewer .fcv-page{transform:none !important;box-shadow:none !important;margin:0 !important}
  body.fc-printing .fcdoc{width:auto !important;min-height:auto !important;padding:0 !important;box-shadow:none !important}
  .fcdoc table.fc-items thead{display:table-header-group}
  .fcdoc table.fc-items tfoot{display:table-row-group}
  .fcdoc table.fc-items tr{break-inside:avoid;page-break-inside:avoid}
  .fcdoc .fc-bottom,.fcdoc .fc-ledger,.fcdoc .fc-sigs{break-inside:avoid;page-break-inside:avoid}
  .fcdoc .fc-pagefoot{display:block;position:fixed;bottom:4mm;left:0;right:0;text-align:center;
    font-size:8px;color:#8C8C99}
  @page{size:A4;margin:12mm 12mm 14mm}
}`;

var Paper = {
  css: PAPER_CSS,
  html: function (m) {
    if (!m) return '<p>Document not found.</p>';
    var b = m.business;
    var contact = [b.address, b.city, b.phone && 'Mobile: ' + b.phone, b.shopPhone && 'Shop: ' + b.shopPhone,
      b.whatsapp && 'WhatsApp: ' + b.whatsapp, b.email, b.website, b.ntn && 'NTN: ' + b.ntn,
      b.registrationNo && 'Reg: ' + b.registrationNo].filter(Boolean)
      .map(function (l) { return isUrdu(l) ? ur(l) : esc(l); }).join('<br>');

    var codeLabel = (m.party && m.party.label === 'SUPPLIER') ? 'Supplier code' : 'Customer code';
    var partyRows = [['Owner', m.party.owner], [codeLabel, m.party.code], ['Mobile', m.party.contact],
      ['WhatsApp', m.party.whatsapp], ['Address', m.party.address], ['Region', m.party.region],
      ['Market / route', m.party.market]]
      .filter(function (r) { return r[1]; })
      .map(function (r) {
        return '<div class="fc-kv"><span>' + esc(r[0]) + '</span><b>' +
               (isUrdu(r[1]) ? ur(r[1]) : esc(r[1])) + '</b></div>';
      }).join('');

    var metaRows = m.meta.filter(function (r) { return r[1]; }).map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + (isUrdu(r[1]) ? ur(r[1]) : esc(r[1])) + '</td></tr>';
    }).join('');

    var strip = (m.strip || []).map(function (s) {
      return '<div><i>' + esc(s[0]) + '</i><b>' + (isUrdu(s[1]) ? ur(s[1]) : esc(s[1])) + '</b></div>';
    }).join('');

    var thead = '<tr>' + m.columns.map(function (c) {
      return '<th class="' + (c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '') + '" style="width:' +
        (c.width * 100).toFixed(1) + '%">' + esc(c.label) + '</th>';
    }).join('') + '</tr>';

    var tbody = m.rows.length ? m.rows.map(function (row) {
      return '<tr>' + m.columns.map(function (c) {
        var v = row[c.key];
        if (c.key === 'description') {
          return '<td>' + (row.descriptionUr ? ur(row.descriptionUr) : '') +
            (row.description ? (row.descriptionUr ? '<span class="fc-sub">' + esc(row.description) + '</span>'
                                                  : esc(row.description)) : '') +
            (row.batch ? '<span class="fc-sub">Batch ' + esc(row.batch) + '</span>' : '') +
            (row.returned ? '<span class="fc-sub">' + esc(row.returned) + ' returned</span>' : '') + '</td>';
        }
        return '<td class="' + (c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '') + '">' +
          (v === undefined || v === null || v === '' ? '—' : (isUrdu(v) ? ur(v) : esc(v))) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + m.columns.length + '" class="c" style="padding:16px;color:#8C8C99">No lines on this document.</td></tr>';

    var tfoot = m.itemsFooter ? '<tfoot><tr>' + m.columns.map(function (c) {
      var v = m.itemsFooter[c.key];
      return '<td class="' + (c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : '') + '">' +
             (v === undefined ? '' : esc(v)) + '</td>';
    }).join('') + '</tr></tfoot>' : '';

    var totals = (m.totals || []).map(function (t) {
      return '<tr class="' + (t.big ? 'big' : t.bold ? 'bold' : '') + '"><td>' + esc(t.label) +
             (t.labelUr ? ' ' + ur(t.labelUr) : '') + '</td><td>' + esc(t.value) + '</td></tr>';
    }).join('');

    var left = '';
    if (m.words) left += '<div class="fc-words"><div class="fc-lbl">Amount in words</div>' + esc(m.words) + '</div>';
    if (m.paymentsList && m.paymentsList.length) {
      left += '<div style="margin-top:10px"><div class="fc-lbl">Payments against this document</div>' +
        m.paymentsList.map(function (p) {
          return '<div class="fc-kv"><span>' + esc(p.date) + '</span><b>' + esc(p.method) +
                 (p.ref ? ' · ' + esc(p.ref) : '') + ' — ' + esc(p.amount) + '</b></div>';
        }).join('') + '</div>';
    }
    if (m.notes) left += '<div style="margin-top:10px"><div class="fc-lbl">Notes</div>' +
      (isUrdu(m.notes) ? ur(m.notes) : esc(m.notes)) + '</div>';

    var ledger = (m.ledger && m.ledger.length) ? '<div class="fc-ledger">' + m.ledger.map(function (r) {
      return '<div><span>' + esc(r[0]) + (r[2] ? ' ' + ur(r[2]) : '') + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join('') + '</div>' : '';

    return '<div class="fcdoc">' +
      (m.cancelled ? '<div class="fc-ribbon">CANCELLED</div>' : m.isDraft ? '<div class="fc-ribbon">DRAFT</div>' : '') +
      '<div class="fc-head"><div>' +
        (b.logoDataUrl ? '<div class="fc-logo"><img src="' + esc(b.logoDataUrl) + '" alt=""></div>'
                       : '<div class="fc-logo">' + esc(b.logoText) + '</div>') +
        '<div class="fc-name">' + esc(b.name) + '</div>' +
        '<div class="fc-tag">' + esc(b.tagline) + '</div>' +
        (b.taglineUr ? '<div class="fc-slogan">' + ur(b.taglineUr) + '</div>' : '') +
        (b.slogan ? '<div class="fc-slogan">' + ur(b.slogan) + '</div>' : '') +
      '</div><div class="fc-contact">' + contact + '</div></div>' +
      '<div class="fc-title">' + esc(m.title) + '</div>' +
      '<div class="fc-parties"><div>' +
        '<div class="fc-lbl">' + esc(m.party.label) + (m.party.labelUr ? ' ' + ur(m.party.labelUr) : '') + '</div>' +
        '<div class="fc-shop">' + (isUrdu(m.party.shop) ? ur(m.party.shop) : esc(m.party.shop || '—')) + '</div>' +
        partyRows +
      '</div><div>' +
        '<div class="fc-lbl">' + esc(m.metaLabel || 'DETAILS') + '</div>' +
        '<table class="fc-meta">' + metaRows + '</table>' +
      '</div></div>' +
      (strip ? '<div class="fc-strip">' + strip + '</div>' : '') +
      '<table class="fc-items"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody>' + tfoot + '</table>' +
      '<div class="fc-bottom"><div>' + left + '</div><div><table class="fc-tot">' + totals + '</table></div></div>' +
      ledger +
      ((m.signatures || []).length ? '<div class="fc-sigs">' + m.signatures.map(function (s) {
        return '<div>' + esc(s) + '</div>'; }).join('') + '</div>' : '') +
      '<div class="fc-foot">' +
        (m.footer.thanks ? '<b>' + esc(m.footer.thanks) + '</b>' : '') +
        esc(b.name) + ' · ' + esc(b.tagline) +
        (m.footer.terms ? '<div style="margin-top:3px">' + esc(m.footer.terms) + '</div>' : '') +
        (m.footer.bank ? '<div style="margin-top:3px">' + esc(m.footer.bank) + '</div>' : '') +
        '<div style="margin-top:4px;font-size:8.5px">' + esc(m.number || '') + ' · issued ' + esc(m.date || '') + '</div>' +
      '</div>' +
      '<div class="fc-pagefoot">' + esc(b.name) + ' · ' + esc(m.number || '') + '</div>' +
    '</div>';
  },

  /* ── messaging (§31 §32) ─────────────────────────────────────────────── */
  waText: function (m) {
    var b = m.business;
    if (m.kind === 'INVOICE') {
      var grand = m.totals.find(function (t) { return t.big; });
      var paid = m.totals.find(function (t) { return /^Amount [Pp]aid$/.test(t.label); });
      var bal = m.totals.find(function (t) { return /Balance on this invoice/.test(t.label); });
      return b.name + '\n\nInvoice: ' + m.number + '\nDate: ' + m.date +
        '\nCustomer: ' + (m.party.shop || '') +
        '\nItems: ' + m.rows.length +
        '\nTotal: ' + (grand ? grand.value : '') +
        '\nPaid: ' + (paid ? paid.value : '') +
        '\nBalance: ' + (bal ? bal.value : '') +
        '\n\nThank you for doing business with ' + b.name + '.';
    }
    if (m.kind === 'RECEIPT') {
      return b.name + '\n\nPayment received — thank you.\n\nReceipt: ' + m.number + '\nDate: ' + m.date +
        '\nAmount: ' + (m.totals[0] ? m.totals[0].value : '') +
        '\nRemaining balance: ' + (m.totals[2] ? m.totals[2].value : '') + '\n\n' + b.name;
    }
    if (m.kind === 'CUSTOMER_RETURN') {
      return b.name + '\n\nReturn accepted.\n\nCredit note: ' + m.number + '\nAgainst invoice: ' +
        (m.meta[1] ? m.meta[1][1] : '') + '\nCredit: ' + (m.totals[0] ? m.totals[0].value : '') + '\n\n' + b.name;
    }
    if (m.kind === 'STATEMENT') {
      return b.name + '\n\nAccount statement for ' + (m.party.shop || '') +
        '\nClosing balance: ' + (m.totals[3] ? m.totals[3].value : '') + '\n\n' + b.name;
    }
    return m.title + ' ' + m.number + ' — ' + b.name;
  },
  smsText: function (m) {
    var b = m.business;
    if (m.kind === 'INVOICE') {
      var grand = m.totals.find(function (t) { return t.big; });
      var bal = m.totals.find(function (t) { return /Balance on this invoice/.test(t.label); });
      return b.name + ': Invoice ' + m.number + ' ' + (grand ? grand.value : '') +
             ', balance ' + (bal ? bal.value : '') + '. Thank you.';
    }
    if (m.kind === 'RECEIPT') {
      return b.name + ': Received ' + (m.totals[0] ? m.totals[0].value : '') + ' vide ' + m.number +
             '. Balance ' + (m.totals[2] ? m.totals[2].value : '') + '.';
    }
    return b.name + ': ' + m.title + ' ' + m.number + '.';
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   PREVIEW / PRINT / DOWNLOAD  (§8 §9 §35 §50)
   ══════════════════════════════════════════════════════════════════════════ */
var Viewer = {
  current: null, zoom: 1,

  open: function (model, opts) {
    if (!model) { global.say && global.say('That document could not be built.'); return; }
    opts = opts || {};
    Viewer.current = model; Viewer.zoom = opts.zoom || (global.innerWidth < 900 ? 0.55 : 1);
    var host = global.document.getElementById('fcviewer');
    if (!host) {
      host = global.document.createElement('div');
      host.id = 'fcviewer';
      global.document.body.appendChild(host);
    }
    var a = model.actions || {};
    var btn = function (act, label, cls) {
      return '<button class="fcv-btn ' + (cls || '') + '" data-fcv="' + act + '">' + label + '</button>';
    };
    host.innerHTML =
      '<div class="fcv-bar">' +
        '<div class="fcv-t"><b>' + esc(model.title) + '</b><span class="mono">' + esc(model.number || '') + '</span>' +
          '<span class="fcv-pill ' + (model.cancelled ? 'bad' : model.isDraft ? 'neu' : 'ok') + '">' +
          esc(model.status || '') + '</span></div>' +
        '<div class="fcv-sp"></div>' +
        '<button class="fcv-btn" data-fcv="zoomout" aria-label="Zoom out">−</button>' +
        '<span class="fcv-z" id="fcvZoom">' + Math.round(Viewer.zoom * 100) + '%</span>' +
        '<button class="fcv-btn" data-fcv="zoomin" aria-label="Zoom in">+</button>' +
        btn('print', 'Print') + btn('pdf', 'Download PDF') + btn('word', 'Download Word', 'pri') +
        (a.whatsapp ? btn('wa', 'WhatsApp') : '') +
        (a.sms ? btn('sms', 'Send SMS') : '') +
        (a.edit ? btn('edit', 'Edit') : '') +
        (a.changeShop ? btn('changeshop', 'Change shop') : '') +
        (a.duplicate ? btn('dup', 'Duplicate') : '') +
        (a.payment ? btn('pay', 'Payment') : '') +
        (a.ret ? btn('return', 'Return') : '') +
        (a.cancel ? btn('cancel', 'Cancel invoice') : '') +
        '<button class="fcv-btn" data-fcv="close" aria-label="Close">' + (global.I ? global.I('x') : '') + 'Close</button>' +
      '</div>' +
      '<div class="fcv-scroll"><div class="fcv-page" id="fcvPage" style="transform:scale(' + Viewer.zoom + ')">' +
        Paper.html(model) + '</div></div>';
    host.classList.add('on');
    ERP.Audit.detached({ action: 'Document viewed', entity: model.kind, entityId: model.entityId, ref: model.number });
  },

  close: function () {
    var h = global.document.getElementById('fcviewer');
    /* empty it as well as hiding it — a closed preview should not keep a
       whole invoice in the page, where it also confuses searching */
    if (h) { h.classList.remove('on'); h.innerHTML = ''; }
    Viewer.current = null;
  },
  setZoom: function (dir) {
    Viewer.zoom = Math.min(1.7, Math.max(0.35, Viewer.zoom + dir * 0.1));
    var p = global.document.getElementById('fcvPage');
    if (p) p.style.transform = 'scale(' + Viewer.zoom + ')';
    var z = global.document.getElementById('fcvZoom');
    if (z) z.textContent = Math.round(Viewer.zoom * 100) + '%';
  },

  /* Printing goes through the browser's own engine, which is the only
     client-side route that shapes Urdu correctly and produces a real
     vector PDF via "Save as PDF". */
  print: function (asPdf) {
    var m = Viewer.current; if (!m) return;
    var page = global.document.getElementById('fcvPage');
    if (page) page.style.transform = 'scale(1)';
    var prevTitle = global.document.title;
    global.document.title = (m.business.name + ' ' + m.title + ' ' + (m.number || ''))
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    global.document.body.classList.add('fc-printing');
    ERP.Audit.detached({ action: asPdf ? 'Document downloaded as PDF' : 'Document printed',
                         entity: m.kind, entityId: m.entityId, ref: m.number });
    setTimeout(function () {
      global.print();
      global.document.body.classList.remove('fc-printing');
      global.document.title = prevTitle;
      if (page) page.style.transform = 'scale(' + Viewer.zoom + ')';
    }, 80);
    if (asPdf && global.say) {
      global.say('In the print dialog choose "Save as PDF" as the destination.');
    }
  },

  /* Word download is deliberately separate from saving: a document failure
     can never lose the transaction (§50). */
  word: function () {
    var m = Viewer.current; if (!m) return;
    try {
      var name = DOCX.download(m);
      ERP.Audit.detached({ action: 'Word document generated', entity: m.kind, entityId: m.entityId, ref: m.number });
      global.say && global.say('Word file downloaded — ' + name);
    } catch (e) {
      global.say && global.say('Word generation failed. The record is safe — use Regenerate Word to try again.');
      try { global.console.error('[ERP] docx failed', e); } catch (x) {}
    }
  },

  whatsapp: function () {
    var m = Viewer.current; if (!m) return;
    var text = Paper.waText(m);
    var phone = '';
    if (m.party && m.party.id) {
      var c = global.custBy && global.custBy(m.party.id);
      phone = (c && (c.wa || c.ph)) || '';
    }
    var digits = String(phone).replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '0') digits = '92' + digits.slice(1);
    var url = 'https://wa.me/' + (digits || '') + '?text=' + encodeURIComponent(text);
    ERP.Audit.detached({ action: 'Sent on WhatsApp', entity: m.kind, entityId: m.entityId, ref: m.number });
    try { global.open(url, '_blank'); }
    catch (e) { global.navigator.clipboard && global.navigator.clipboard.writeText(text); }
    if (!digits && global.say) global.say('No WhatsApp number saved for this shop — the message was opened without a recipient.');
  },
  sms: function () {
    var m = Viewer.current; if (!m) return;
    var text = Paper.smsText(m);
    var c = m.party && m.party.id && global.custBy ? global.custBy(m.party.id) : null;
    var phone = (c && c.ph) || '';
    ERP.Audit.detached({ action: 'SMS prepared', entity: m.kind, entityId: m.entityId, ref: m.number });
    try { global.open('sms:' + phone + '?&body=' + encodeURIComponent(text), '_blank'); }
    catch (e) { global.navigator.clipboard && global.navigator.clipboard.writeText(text); }
    global.say && global.say('SMS prepared. Connect an SMS provider in Settings to send automatically.');
  }
};

/* SMS/WhatsApp notification hooks — modular, no credentials in code (§32) */
var Notify = ERP.Notify = {
  events: ['INVOICE_CREATED', 'ORDER_DISPATCHED', 'PAYMENT_RECEIVED', 'PAYMENT_REMINDER',
           'OUTSTANDING_BALANCE', 'RETURN_APPROVED'],
  handlers: {},
  on: function (ev, fn) { (Notify.handlers[ev] = Notify.handlers[ev] || []).push(fn); },
  fire: function (ev, payload) {
    (Notify.handlers[ev] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
    var cfg = ERP.Settings.get();
    if (!cfg.smsProvider && !cfg.whatsappProvider) return;   // nothing configured — stay silent
    ERP.Audit.detached({ action: 'Notification queued: ' + ev, entity: 'Notification',
                         entityId: (payload && payload.id) || '', ref: (payload && payload.ref) || '' });
  }
};

ERP.DocModel = DocModel;
ERP.Paper = Paper;
ERP.Viewer = Viewer;
global.FCDoc = { DocModel: DocModel, Paper: Paper, Viewer: Viewer };
})(typeof window !== 'undefined' ? window : globalThis);
