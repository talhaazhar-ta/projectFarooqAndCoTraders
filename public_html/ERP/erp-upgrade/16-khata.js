/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 16
   THE CUSTOMER ACCOUNT STATEMENT  ·  the khata, kept properly
   Every shop has one account page showing its whole history: what was sold,
   what was paid, what came back, and what was adjusted — each line with the
   balance as it stood after it. The running balance is worked out from the
   transactions every time it is shown; it is never stored and never patched.
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
function today() {
  if (global.FC_TODAY) return global.FC_TODAY();
  var d = new Date();   /* local date parts — toISOString() is UTC and says yesterday until 05:00 in Pakistan */
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(x) { return global.fmtDate ? global.fmtDate(x) : x; }

/* ══════════════════════════════════════════════════════════════════════════
   ACCOUNT ADJUSTMENTS
   A correction to an account is a posted entry of its own with a reason and
   an audit record — never a quiet edit of a balance.
   ══════════════════════════════════════════════════════════════════════════ */
var Adjustments = ERP.Adjustments = {
  reasons: ['Opening balance correction', 'Discount allowed', 'Rounding', 'Bad debt written off',
            'Cheque returned', 'Additional charges', 'Freight recovered', 'Other correction'],
  all: function () { return S.accountAdjustments || (S.accountAdjustments = []); },
  forCustomer: function (id) {
    return Adjustments.all().filter(function (a) { return a.customerId === id && a.status !== 'REVERSED'; });
  },
  create: function (o) {
    var amount = M.toP(o.amount);
    var errs = [];
    if (!o.customerId || !global.custBy(o.customerId)) errs.push('Choose a shop.');
    if (!(amount > 0)) errs.push('Enter an amount greater than zero.');
    if (o.direction !== 'DEBIT' && o.direction !== 'CREDIT') errs.push('Choose whether this adds to or reduces what the shop owes.');
    if (!o.reason) errs.push('Give a reason — every adjustment is recorded against your name.');
    if (errs.length) return Promise.reject({ validation: errs });

    var opId = o.clientOpId || FDB.uid('adjop');
    return FDB.tx(['sequences', 'accountAdjustments', 'auditLog', 'operations'], function (api) {
      return FDB.claimOperation(api, opId, 'AccountAdjustment', {}).then(function () {
        return FDB.nextNumber(api, 'ACC').then(function (number) {
          var c = global.custBy(o.customerId) || {};
          var rec = {
            id: FDB.uid('acc'), adjustmentNumber: number, clientOpId: opId,
            customerId: o.customerId, customerNameSnapshot: c.sh || '',
            adjustmentDate: o.date || today(),
            direction: o.direction,                  /* DEBIT adds to what is owed */
            amount: amount, reason: o.reason, notes: o.notes || '',
            description: (ERP.Desc ? ERP.Desc.clean(o.description) : (o.description || '')),
            status: 'POSTED', createdBy: global.CURRENT_USER || 'Owner', createdAt: nowISO()
          };
          api.put('accountAdjustments', rec);
          Adjustments.all().unshift(rec);
          ERP.Audit.write(api, {
            action: 'Account adjustment posted', entity: 'AccountAdjustment', entityId: rec.id,
            ref: number, reason: rec.reason,
            newValues: { shop: rec.customerNameSnapshot, direction: rec.direction, amount: rec.amount }
          });
          return rec;
        });
      });
    }).then(function (r) { ERP.Mirror.refresh(); return r; });
  },
  reverse: function (id, reason) {
    var rec = Adjustments.all().filter(function (a) { return a.id === id; })[0];
    if (!rec) return Promise.resolve(null);
    return FDB.tx(['accountAdjustments', 'auditLog'], function (api) {
      rec.status = 'REVERSED'; rec.reversedAt = nowISO(); rec.reverseReason = reason || '';
      api.put('accountAdjustments', rec);
      ERP.Audit.write(api, { action: 'Account adjustment reversed', entity: 'AccountAdjustment',
        entityId: id, ref: rec.adjustmentNumber, reason: reason || '',
        oldValues: { status: 'POSTED' }, newValues: { status: 'REVERSED' } });
    }).then(function () { ERP.Mirror.refresh(); return rec; });
  }
};

/* ── the ledger everywhere now includes adjustments ───────────────────────
   Patched in one place so the statement, the invoice's "previous balance",
   the receivables report and the collection figures cannot disagree. ── */
var origCustomerLedger = ERP.Ledger.customer;
ERP.Ledger.customer = function (customerId, fromISO, toISO) {
  var full = origCustomerLedger.call(ERP.Ledger, customerId, null, null);
  /* copy every field the lower layers set (description, qty, …) — never pick a few */
  var rows = full.rows.map(function (r) { return Object.assign({}, r); });
  Adjustments.forCustomer(customerId).forEach(function (a) {
    rows.push({
      iso: a.adjustmentDate, ref: a.adjustmentNumber,
      what: 'Adjustment — ' + a.reason,
      description: a.description || '',
      dr: a.direction === 'DEBIT' ? a.amount : 0,
      cr: a.direction === 'CREDIT' ? a.amount : 0,
      kind: 'ADJUSTMENT', id: a.id, createdAt: a.createdAt
    });
  });
  rows.sort(ERP.Ledger.rowOrder);
  /* Opening is the balance as it stood before the period; closing is the
     balance at the end of it. Anything dated after the period is left out
     of both — a statement for January must not be moved by a February sale. */
  var bal = 0, opening = 0, out = [];
  rows.forEach(function (r) {
    var delta = r.dr - r.cr;
    if (toISO && r.iso > toISO) return;
    if (fromISO && r.iso < fromISO) { bal += delta; opening = bal; return; }
    bal += delta;
    out.push(Object.assign({}, r, { balance: bal }));
  });
  return {
    opening: opening, rows: out, closing: bal,
    debit: out.reduce(function (a, r) { return a + r.dr; }, 0),
    credit: out.reduce(function (a, r) { return a + r.cr; }, 0)
  };
};

/* ══════════════════════════════════════════════════════════════════════════
   THE KHATA — one page of entries, with everything needed to read them
   ══════════════════════════════════════════════════════════════════════════ */
var TYPE = {
  OPENING:    { label: 'Opening balance', cls: 'neu',  icon: 'clock' },
  SALE:       { label: 'Sale',            cls: 'info', icon: 'tag' },
  PAYMENT:    { label: 'Payment received', cls: 'ok',  icon: 'wallet' },
  REFUND:     { label: 'Refund paid',     cls: 'low',  icon: 'wallet' },
  RETURN:     { label: 'Sales return',    cls: 'low',  icon: 'swap' },
  ADJUSTMENT: { label: 'Adjustment',      cls: 'neu',  icon: 'edit' },
  BF:         { label: 'Brought forward', cls: 'neu',  icon: 'clock' }
};
var SUP_TYPE = {
  OPENING:  TYPE.OPENING,
  PURCHASE: { label: 'Purchase',           cls: 'info', icon: 'tag' },
  PAYMENT:  { label: 'Payment made',       cls: 'ok',   icon: 'wallet' },
  RETURN:   { label: 'Return to supplier', cls: 'low',  icon: 'swap' },
  MILLING:  { label: 'Milling',            cls: 'neu',  icon: 'tag' },
  BF:       TYPE.BF
};

var Khata = ERP.Khata = {
  TYPE: TYPE,

  /* one ledger row → one statement entry (customer side) */
  entryOf: function (r) {
    var e = {
      id: r.id, iso: r.iso, date: fmtDate(r.iso), type: r.kind, ref: r.ref,
      description: r.description || r.what, debit: r.dr, credit: r.cr, balance: r.balance,
      qty: r.qty, qtyLabel: (ERP.Desc && ERP.Desc.qtyLabel) ? ERP.Desc.qtyLabel(r) : '—',
      detail: '', method: '', canOpen: false
    };
    if (r.kind === 'INVOICE') {
      e.type = 'SALE';
      var inv = ERP.Invoices.byId(r.id);
      if (inv) {
        var items = ERP.Invoices.items(inv.id);
        /* the ledger row already resolved this: a manually entered
           description wins, otherwise the generated one. Never regenerate
           over the user's own words. */
        e.description = r.description || ('Invoice ' + inv.invoiceNumber);
        e.detail = items.slice(0, 4).map(function (it) {
          return (it.descriptionEnSnapshot || it.descriptionSnapshot) +
            (it.packageSnapshot && it.packageSnapshot !== 'Bag' ? ' ' + it.packageSnapshot : '') +
            ' × ' + Number(it.quantity).toLocaleString('en-US') + ' bags';
        }).join(' · ') + (items.length > 4 ? ' · +' + (items.length - 4) + ' more' : '');
        e.method = inv.paymentMethod || '';
        e.warehouse = inv.warehouseSnapshot;
        e.salesperson = inv.salesperson;
        e.canOpen = 'invoice';
      }
    } else if (r.kind === 'PAYMENT' || r.kind === 'REFUND') {
      var p = ERP.Payments.byId(r.id);
      e.type = r.kind === 'REFUND' ? 'REFUND' : 'PAYMENT';
      if (p) {
        e.description = r.description || ((r.kind === 'REFUND' ? 'Refund ' : 'Receipt ') + p.receiptNumber);
        e.method = p.method;
        e.detail = [p.reference ? 'Ref ' + p.reference : '', p.note || ''].filter(Boolean).join(' · ');
        e.canOpen = 'payment';
      }
    } else if (r.kind === 'RETURN') {
      var ret = S.custReturns.filter(function (x) { return x.id === r.id; })[0];
      if (ret) {
        e.description = 'Return ' + ret.returnNumber + ' against ' + ret.invoiceNumber;
        e.detail = ERP.Returns.customerItems(ret.id).map(function (it) {
          return (it.descriptionEnSnapshot || it.descriptionSnapshot) + ' × ' + it.quantity;
        }).join(' · ') + (ret.reason ? ' — ' + ret.reason : '');
        e.canOpen = 'custreturn';
      }
    } else if (r.kind === 'ADJUSTMENT') {
      var a = Adjustments.all().filter(function (x) { return x.id === r.id; })[0];
      if (a) { e.detail = a.notes || ''; e.canReverse = true; }
    }
    return e;
  },

  /* Every entry of the period, with the running balance worked out across the
     whole account — so a dated view still shows true balances. */
  entries: function (customerId, from, to) {
    return ERP.Ledger.customer(customerId, from || null, to || null).rows.map(Khata.entryOf);
  },

  /* the VIEW filters (type, method, search) only decide which lines are listed;
     they never touch a balance. A stored opening line always stays. */
  filter: function (list, f) {
    f = f || {};
    var q = (f.q || '').toLowerCase().trim();
    return list.filter(function (e) {
      if (e.type === 'OPENING') return true;
      if (f.from && e.iso < f.from) return false;
      if (f.to && e.iso > f.to) return false;
      if (f.types && f.types.length && f.types.indexOf(e.type) === -1) return false;
      if (f.method && e.method !== f.method) return false;
      if (q) {
        var hay = [e.ref, e.description, e.detail, e.method, e.date].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  },

  summary: function (customerId, f) {
    f = f || {};
    var st = Statement.build('CUSTOMER', customerId, { from: f.from, to: f.to });
    var v = Statement.view(st, f);
    var b = st.breakdown;
    return {
      opening: st.opening, closing: st.closing, debit: st.debit, credit: st.credit,
      sales: b.inflow, salesCount: b.inflowCount,
      payments: b.outflow, paymentCount: b.outflowCount,
      returns: b.returns, refunds: b.refunds,
      adjustmentsDr: b.adjustmentsDr, adjustmentsCr: b.adjustmentsCr,
      other: b.other,
      overall: st.current,
      lastTransactionDate: st.lastTransactionDate,
      lastPaymentDate: st.lastPayment ? st.lastPayment.iso : null,
      lastPaymentAmount: st.lastPayment ? st.lastPayment.amount : 0,
      count: v.count, rows: v.rows, all: st.entries,
      filtered: v.filtered, viewDebit: v.debit, viewCredit: v.credit,
      bf: st.bf, invalid: st.invalid, stmt: st
    };
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   ERP.Statement — ONE statement for a shop or a supplier
   The khata page, the Statement of Account screen, the printed sheet, the
   Word file, the Excel file and the WhatsApp text all read this. It adds no
   ledger maths: every figure is the period's own Ledger result. The period
   (From / To) is the only thing that decides opening and closing; the
   type / method / search choices only decide which lines are LISTED.
   ══════════════════════════════════════════════════════════════════════════ */
function localISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function headingOf(key, fallback) { return ERP.OptionText ? ERP.OptionText(key, fallback) : fallback; }
var HEAD_URDU = {
  desc: 'Description / تفصیل', dr: 'Debit / بنام',
  cr: 'Credit / جمع', bal: 'Balance / بقایا'
};

var Statement = ERP.Statement = {
  isCustomer: function (type) { return type !== 'SUPPLIER'; },
  typeMap: function (type) { return Statement.isCustomer(type) ? TYPE : SUP_TYPE; },
  typeOf: function (type, t) { return Statement.typeMap(type)[t] || { label: t || 'Entry', cls: 'neu' }; },
  heads: function () {
    return {
      ref: headingOf('stmtRefLabel', 'Folio / Reference #'),
      desc: headingOf('stmtDescriptionLabel', HEAD_URDU.desc),
      qty: headingOf('stmtQtyLabel', 'Qty'),
      dr: headingOf('stmtDebitLabel', HEAD_URDU.dr),
      cr: headingOf('stmtCreditLabel', HEAD_URDU.cr),
      bal: headingOf('stmtBalanceLabel', HEAD_URDU.bal)
    };
  },
  ledger: function (type, id, from, to) {
    return Statement.isCustomer(type)
      ? ERP.Ledger.customer(id, from || null, to || null)
      : ERP.Ledger.supplier(id, from || null, to || null);
  },
  periodText: function (from, to) {
    if (!from && !to) return 'All time';
    return (from ? fmtDate(from) : 'Beginning') + ' → ' + (to ? fmtDate(to) : 'Today');
  },
  invalidRange: function (from, to) { return !!(from && to && from > to); },

  /* which side a balance sits on. A shop's balance is debit-positive (it owes
     us = Dr); a supplier's is credit-positive (we owe it = Cr). */
  side: function (type, bal) {
    if (!bal) return '';
    var owes = Statement.isCustomer(type) ? bal > 0 : bal < 0;
    return owes ? 'Dr' : 'Cr';
  },
  balText: function (type, bal) {
    if (!bal) return M.fmtPlain(0);
    return M.fmtPlain(Math.abs(bal)) + ' ' + Statement.side(type, bal);
  },
  balHtml: function (type, bal) {
    if (!bal) return M.fmtPlain(0);
    return M.fmtPlain(Math.abs(bal)) + '<span class="kh-side">' + Statement.side(type, bal) + '</span>';
  },
  /* in words: who owes whom */
  standing: function (type, closing) {
    if (Statement.isCustomer(type)) {
      return closing > 0 ? { text: 'Owed by the shop', status: 'Balance due', tone: 'due' }
           : closing < 0 ? { text: 'In credit', status: 'In credit', tone: 'credit' }
           : { text: 'Settled', status: 'Settled', tone: 'credit' };
    }
    return closing > 0 ? { text: 'Payable to the supplier', status: 'Payable', tone: 'due' }
         : closing < 0 ? { text: 'Paid in advance', status: 'Paid in advance', tone: 'credit' }
         : { text: 'Settled', status: 'Settled', tone: 'credit' };
  },

  entryOf: function (type, r) {
    if (Statement.isCustomer(type)) return Khata.entryOf(r);
    var e = {
      id: r.id, iso: r.iso, date: fmtDate(r.iso), type: r.kind, ref: r.ref,
      description: r.description || r.what, debit: r.dr, credit: r.cr, balance: r.balance,
      qty: r.qty, qtyLabel: (ERP.Desc && ERP.Desc.qtyLabel) ? ERP.Desc.qtyLabel(r) : '—',
      detail: '', method: '', canOpen: false
    };
    if (r.kind === 'PURCHASE') {
      e.canOpen = 'purchase';
    } else if (r.kind === 'PAYMENT') {
      var p = ERP.Payments.byId(r.id);
      if (p) {
        e.method = p.method || '';
        e.detail = [p.reference ? 'Ref ' + p.reference : '', p.note || ''].filter(Boolean).join(' · ');
        e.canOpen = 'payment';
      }
    } else if (r.kind === 'RETURN') {
      e.canOpen = 'supreturn';
    }
    return e;
  },

  /* the statement for a period — always the whole period, oldest first */
  build: function (type, id, f) {
    f = f || {};
    var cust = Statement.isCustomer(type);
    var from = f.from || null, to = f.to || null;
    var st = {
      type: cust ? 'CUSTOMER' : 'SUPPLIER', partyId: id, isCustomer: cust, from: from, to: to,
      label: Statement.periodText(from, to), invalid: false,
      opening: 0, closing: 0, debit: 0, credit: 0, entries: [], bf: null, current: 0,
      lastTransactionDate: null, lastPayment: null,
      breakdown: { inflow: 0, inflowCount: 0, outflow: 0, outflowCount: 0, returns: 0, refunds: 0,
                   adjustmentsDr: 0, adjustmentsCr: 0, credits: 0, other: 0 }
    };
    if (Statement.invalidRange(from, to)) { st.invalid = true; return st; }

    var L = Statement.ledger(cust ? 'CUSTOMER' : 'SUPPLIER', id, from, to);
    var entries = L.rows.map(function (r) { return Statement.entryOf(cust ? 'CUSTOMER' : 'SUPPLIER', r); });
    var sum = function (list, k) { return list.reduce(function (a, e) { return a + e[k]; }, 0); };
    var ofType = function (t) { return entries.filter(function (e) { return e.type === t; }); };

    /* a stored opening line is part of the OPENING figure, not of the movement,
       so opening + debit − credit = closing always holds */
    var opRow = entries.filter(function (e) { return e.type === 'OPENING'; })[0];
    var opNet = opRow ? (cust ? opRow.debit - opRow.credit : opRow.credit - opRow.debit) : 0;
    st.entries = entries;
    st.opening = L.opening + opNet;
    st.closing = L.closing;
    st.debit = L.debit - (opRow ? opRow.debit : 0);
    st.credit = L.credit - (opRow ? opRow.credit : 0);
    st.bfBalance = L.opening;
    if (from) {
      st.bf = { id: 'bf', iso: from, date: fmtDate(from), type: 'BF', ref: '',
        description: 'Balance brought forward', detail: 'Balance before ' + fmtDate(from),
        debit: 0, credit: 0, balance: L.opening, method: '', qtyLabel: '', canOpen: false, synthetic: true };
    }
    var b = st.breakdown;
    if (cust) {
      b.inflow = sum(ofType('SALE'), 'debit'); b.inflowCount = ofType('SALE').length;
      b.outflow = sum(ofType('PAYMENT'), 'credit'); b.outflowCount = ofType('PAYMENT').length;
      b.returns = sum(ofType('RETURN'), 'credit'); b.refunds = sum(ofType('REFUND'), 'debit');
      b.adjustmentsDr = sum(ofType('ADJUSTMENT'), 'debit'); b.adjustmentsCr = sum(ofType('ADJUSTMENT'), 'credit');
      b.credits = b.returns + b.adjustmentsCr;
    } else {
      b.inflow = sum(ofType('PURCHASE'), 'credit'); b.inflowCount = ofType('PURCHASE').length;
      b.outflow = sum(ofType('PAYMENT'), 'debit'); b.outflowCount = ofType('PAYMENT').length;
      b.returns = sum(ofType('RETURN'), 'debit'); b.refunds = 0;
      b.credits = b.returns;
    }
    /* whatever is left (refunds paid, charges, milling, …) is shown as one
       signed "Other" line so the sum on the page is always complete */
    b.other = st.closing - st.opening - b.inflow + b.outflow + b.credits;

    var inPeriod = entries.filter(function (e) { return e.type !== 'OPENING'; });
    st.lastTransactionDate = inPeriod.length ? inPeriod[inPeriod.length - 1].iso : null;
    var pays = ofType('PAYMENT');
    if (pays.length) {
      var lp = pays[pays.length - 1];
      st.lastPayment = { iso: lp.iso, amount: cust ? lp.credit : lp.debit };
    }
    /* the balance as it stands today (a dated statement is not "now") */
    st.current = to ? Statement.ledger(cust ? 'CUSTOMER' : 'SUPPLIER', id, null, null).closing : st.closing;
    return st;
  },

  /* the lines to list for a statement, after the view filters */
  view: function (st, f) {
    f = f || {};
    var shown = Khata.filter(st.entries, { types: f.types, method: f.method, q: f.q });
    var filtered = !!((f.types && f.types.length) || f.method || (f.q && String(f.q).trim()));
    var real = shown.filter(function (e) { return e.type !== 'OPENING'; });
    return {
      rows: shown, filtered: filtered, count: real.length, total: st.entries.length,
      debit: real.reduce(function (a, e) { return a + e.debit; }, 0),
      credit: real.reduce(function (a, e) { return a + e.credit; }, 0)
    };
  },

  /* the sum, in the order it is read */
  parts: function (st, labels) {
    labels = labels || {};
    var cust = st.isCustomer, b = st.breakdown;
    var out = [
      { key: 'opening', label: labels.opening || 'Opening balance', value: st.opening, sign: '' },
      { key: 'inflow', label: labels.inflow || (cust ? 'Total sales' : 'Total purchased'), value: b.inflow, sign: '+' },
      { key: 'outflow', label: labels.outflow || (cust ? 'Payments received' : 'Total paid'), value: b.outflow, sign: '−' },
      { key: 'credits', label: labels.credits || (cust ? 'Returns and credits' : 'Returns to supplier'), value: b.credits, sign: '−' }
    ];
    if (b.other) out.push({ key: 'other', label: labels.other || (cust ? 'Other (refunds, charges)' : 'Other (milling, adjustments)'),
      value: Math.abs(b.other), sign: b.other > 0 ? '+' : '−' });
    out.push({ key: 'closing', label: labels.closing || 'Closing balance', value: st.closing, sign: '=' });
    return out;
  },
  equationHtml: function (st) {
    return Statement.parts(st).map(function (p) {
      return '<span class="kh-eq-p' + (p.key === 'closing' ? ' end' : '') + '">' +
        (p.sign ? '<i>' + p.sign + '</i> ' : '') + esc(p.label) + ' <b>' + M.fmtPlain(p.value) + '</b></span>';
    }).join('');
  },

  /* ── the table, shared by the khata page and the Statement of Account ─ */
  rowHtml: function (type, e, actions) {
    var t = Statement.typeOf(type, e.type);
    var cls = e.type === 'OPENING' ? ' class="opening"' : e.type === 'BF' ? ' class="bf"' : '';
    var nil = '<span class="kh-nil">—</span>';
    /* a stored opening line is the balance the account started with: it shows in the Balance column only,
       so the Debit and Credit columns add up to the Totals row */
    var isOp = e.type === 'OPENING';
    return '<tr' + cls + (e.synthetic ? '' : ' data-row') + '>' +
      '<td data-label="Date" class="kh-c-date">' + esc(e.date) + '</td>' +
      '<td data-label="Type" class="kh-c-type">' + (global.pill ? global.pill(t.cls, t.label) : esc(t.label)) + '</td>' +
      '<td data-label="Reference" class="mono kh-c-ref">' + (e.ref ? esc(e.ref) : nil) + '</td>' +
      '<td data-label="Description / تفصیل" class="kh-desc kh-c-desc"><b>' + esc(e.description) + '</b>' +
        (e.detail ? '<span>' + esc(e.detail) + '</span>' : '') +
        (e.method ? '<span>' + esc(e.method) + '</span>' : '') + '</td>' +
      '<td data-label="Qty" class="kh-qty kh-c-qty' + (e.qtyLabel && e.qtyLabel !== '—' ? '' : ' kh-none') + '">' + (e.qtyLabel && e.qtyLabel !== '—' ? esc(e.qtyLabel) : nil) + '</td>' +
      '<td data-label="Debit" class="kh-dr kh-c-dr">' + (e.debit && !isOp ? M.fmtPlain(e.debit) : nil) + '</td>' +
      '<td data-label="Credit" class="kh-cr kh-c-cr">' + (e.credit && !isOp ? M.fmtPlain(e.credit) : nil) + '</td>' +
      '<td data-label="Balance" class="kh-bal kh-c-bal' + (e.balance < 0 ? ' neg' : '') + '">' +
        Statement.balHtml(type, e.balance) + '</td>' +
      '<td data-label="" class="c kh-c-act">' +
        (actions && e.canOpen ? '<button class="btn sm" data-khopen="' + e.canOpen + '" data-id="' + esc(e.id) + '">Open</button>' : '') +
        (actions && e.canReverse ? '<button class="btn sm" data-khreverse="' + esc(e.id) + '">Reverse</button>' : '') +
      '</td></tr>';
  },
  tableHtml: function (type, rows, foot, actions) {
    var H = Statement.heads();
    return '<div class="tw"><table class="kh-table"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>' + esc(H.ref) + '</th>' +
        '<th>' + esc(H.desc) + '</th><th class="r">' + esc(H.qty) + '</th>' +
        '<th class="r">' + esc(H.dr) + '</th><th class="r">' + esc(H.cr) + '</th>' +
        '<th class="r">' + esc(H.bal) + '</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(function (e) { return Statement.rowHtml(type, e, actions); }).join('') +
      '</tbody><tfoot><tr><td colspan="5" data-label=""><b>' + esc(foot.label) + '</b></td>' +
        '<td class="kh-dr" data-label="Debit">' + M.fmtPlain(foot.debit) + '</td>' +
        '<td class="kh-cr" data-label="Credit">' + M.fmtPlain(foot.credit) + '</td>' +
        '<td class="kh-bal" data-label="' + (foot.balanceLabel || 'Balance') + '">' + foot.balance + '</td><td></td></tr></tfoot>' +
      '</table></div>';
  },
  pagerHtml: function (attr, page, pages, total) {
    if (pages <= 1) return '';
    return '<div class="kh-pager"><span>Page ' + page + ' of ' + pages + ' · ' + total + ' entries</span>' +
      '<button class="btn sm" ' + attr + '="prev"' + (page === 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button class="btn sm" ' + attr + '="next"' + (page === pages ? ' disabled' : '') + '>Next</button></div>';
  },

  /* ── the printed / Word / WhatsApp document ────────────────────────── */
  model: function (type, id, f) {
    var cust = Statement.isCustomer(type);
    var st = Statement.build(type, id, f);
    var party = (cust ? global.custBy(id) : global.supOf(id)) || {};
    var region = cust && party.region && global.regionOf ? global.regionOf(party.region) : null;
    var b = st.breakdown, H = Statement.heads(), T = st.type;
    var stand = Statement.standing(T, st.closing);
    var rows = [];
    if (st.bf) rows.push({ sr: st.bf.date, pack: '—', description: 'Balance brought forward',
      brand: '—', qty: '—', rate: '—', amount: Statement.balText(T, st.bf.balance), cls: 'fc-bf' });
    st.entries.forEach(function (e) {
      rows.push({
        sr: e.date, brand: e.qtyLabel || '—', pack: e.ref || '—',
        description: e.description + (e.detail ? ' — ' + e.detail : ''), descriptionUr: '',
        qty: e.debit && e.type !== 'OPENING' ? M.fmtPlain(e.debit) : '—',
        rate: e.credit && e.type !== 'OPENING' ? M.fmtPlain(e.credit) : '—',
        amount: Statement.balText(T, e.balance),
        cls: e.type === 'OPENING' ? 'fc-bf' : ''
      });
    });
    var totals = [
      { label: 'Opening balance', value: M.fmt(st.opening) },
      { label: cust ? 'Total sales' : 'Total purchased', value: M.fmt(b.inflow) },
      { label: cust ? 'Payments received' : 'Total paid', value: '− ' + M.fmt(b.outflow) },
      { label: cust ? 'Returns and credits' : 'Returns to supplier', value: '− ' + M.fmt(b.credits) }
    ];
    if (b.other) totals.push({ label: cust ? 'Other (refunds, charges)' : 'Other (milling, adjustments)',
      value: (b.other < 0 ? '− ' : '') + M.fmt(Math.abs(b.other)) });
    totals.push({ label: 'Closing balance', labelUr: 'بقایا رقم',
      value: st.closing ? M.fmt(Math.abs(st.closing)) + ' ' + Statement.side(T, st.closing) : M.fmt(0), big: true, rule: true });
    var side = st.closing ? ' (' + Statement.side(T, st.closing) + ')' : '';
    return {
      kind: 'STATEMENT', entityId: id, template: 'modern', statement: st,
      title: cust ? 'ACCOUNT STATEMENT' : 'SUPPLIER STATEMENT',
      number: (cust ? 'STMT-' : 'SST-') + (party.legacyCode || id),
      status: stand.status,
      date: fmtDate(today()), rawDate: today(),
      business: ERP.DocModel.business(),
      party: {
        label: cust ? 'ACCOUNT OF' : 'SUPPLIER', shop: cust ? party.sh : party.co,
        owner: cust ? party.ow : party.cp, code: party.legacyCode || (cust ? id : ''),
        contact: party.ph || '', whatsapp: cust ? (party.wa || '') : '',
        address: cust ? (party.addr || party.area || '') : '',
        region: region ? region.ur + ' — ' + region.en : '', id: id
      },
      metaLabel: 'STATEMENT DETAILS',
      meta: [
        ['Period', st.label],
        ['Opening balance', M.fmt(st.opening)],
        ['Closing balance', M.fmt(st.closing), true],
        ['Entries', String(st.entries.filter(function (e) { return e.type !== 'OPENING'; }).length)],
        ['Generated', fmtDate(today()) + ' ' + new Date().toTimeString().slice(0, 5)],
        ['Generated by', global.CURRENT_USER || 'Owner']
      ],
      strip: [['Opening', M.fmt(st.opening)], [cust ? 'Sales' : 'Purchases', M.fmt(b.inflow)],
              [cust ? 'Payments' : 'Paid', M.fmt(b.outflow)], ['Balance', M.fmt(st.closing)]],
      columns: [
        { key: 'sr', label: 'Date', width: 0.12 },
        { key: 'pack', label: H.ref, align: 'center', width: 0.16 },
        { key: 'description', label: H.desc, width: 0.26 },
        { key: 'brand', label: H.qty, align: 'right', width: 0.07 },
        { key: 'qty', label: H.dr, align: 'right', width: 0.12 },
        { key: 'rate', label: H.cr, align: 'right', width: 0.12 },
        { key: 'amount', label: H.bal, align: 'right', width: 0.15 }
      ],
      rows: rows,
      itemsFooter: { description: 'Totals', qty: M.fmtPlain(st.debit), rate: M.fmtPlain(st.credit),
                     amount: Statement.balText(T, st.closing) },
      totals: totals,
      words: global.words ? global.words(Math.round(M.toR(Math.abs(st.closing)))) + (stand.status === 'Settled' ? '' : ' — ' + stand.text.toLowerCase()) : '',
      notes: st.lastPayment
        ? 'Last payment of ' + M.fmt(st.lastPayment.amount) + (cust ? ' received on ' : ' made on ') + fmtDate(st.lastPayment.iso) + '.'
        : (cust ? 'No payment has been received in this period.' : 'No payment has been made in this period.'),
      ledger: [],
      signatures: cust ? ['Prepared by', 'Authorised signature', 'Received by (shopkeeper)'] : ['Accountant', 'Authorised signature'],
      footer: {
        thanks: 'Please confirm the closing balance at your earliest convenience.',
        terms: 'Generated from the recorded transactions of ' + ERP.Settings.get().businessName +
               '. Dr = ' + (cust ? 'the shop owes us' : 'we owe the supplier') + ' · Cr = ' + (cust ? 'we owe the shop' : 'the supplier owes us') + '.',
        bank: cust ? (ERP.Settings.get().bankDetails || '') : ''
      },
      actions: cust ? { whatsapp: true, sms: true, email: true } : { whatsapp: false },
      closing: st.closing, closingText: M.fmt(Math.abs(st.closing)) + side, periodText: st.label,
      summary: st
    };
  },

  /* ── Excel — one builder for every screen ──────────────────────────── */
  excel: function (type, id, f) {
    var cust = Statement.isCustomer(type), T = cust ? 'CUSTOMER' : 'SUPPLIER';
    var st = Statement.build(T, id, f);
    var party = (cust ? global.custBy(id) : global.supOf(id)) || {};
    var pname = cust ? party.sh : party.co;
    var b = ERP.Settings.get(), H = Statement.heads();
    var head = [
      [{ v: b.businessName, style: 3 }], [b.tagline || ''], [cust ? 'Customer account statement' : 'Supplier account statement'],
      [cust ? 'Shop' : 'Supplier', pname || ''], [cust ? 'Owner' : 'Contact', (cust ? party.ow : party.cp) || ''],
      [cust ? 'Customer ID' : 'Supplier ID', party.legacyCode || id], ['Phone', party.ph || ''],
      ['Period', st.label],
      ['Generated', fmtDate(today()) + ' ' + new Date().toTimeString().slice(0, 5)],
      ['Generated by', global.CURRENT_USER || 'Owner'],
      ['Dr / Cr', cust ? 'Dr = the shop owes us · Cr = we owe the shop' : 'Cr = we owe the supplier · Dr = the supplier owes us'], []
    ];
    var blank = function (v) { return v ? M.toR(v) : ''; };
    var lines = [];
    if (st.bf) lines.push([st.bf.date, 'Brought forward', '', 'Balance brought forward', '', '', '', M.toR(st.bf.balance), Statement.side(T, st.bf.balance)]);
    st.entries.forEach(function (e) {
      lines.push([e.date, Statement.typeOf(T, e.type).label, e.ref || '',
        e.description + (e.detail ? ' — ' + e.detail : ''), e.qtyLabel && e.qtyLabel !== '—' ? e.qtyLabel : '',
        e.type === 'OPENING' ? '' : blank(e.debit), e.type === 'OPENING' ? '' : blank(e.credit), M.toR(e.balance), Statement.side(T, e.balance)]);
    });
    var ledger = head.concat([['Date', 'Type', H.ref, H.desc, H.qty, H.dr, H.cr, H.bal, 'Dr / Cr']])
      .concat(lines)
      .concat([[], ['', '', '', 'Totals', '', M.toR(st.debit), M.toR(st.credit), M.toR(st.closing), Statement.side(T, st.closing)]]);
    var stand = Statement.standing(T, st.closing);
    var summary = head.concat(Statement.parts(st).map(function (p) {
      return [p.label, p.sign === '−' ? -M.toR(p.value) : M.toR(p.value)];
    })).concat([
      ['Standing', stand.text],
      ['Last transaction', st.lastTransactionDate ? fmtDate(st.lastTransactionDate) : ''],
      ['Last payment', st.lastPayment ? fmtDate(st.lastPayment.iso) : '']
    ]);
    return { name: pname || id, sheets: [{ name: 'Statement', rows: ledger }, { name: 'Summary', rows: summary }], title: (cust ? 'Account statement — ' : 'Supplier statement — ') + (pname || '') };
  },
  download: function (type, id, f) {
    var cust = Statement.isCustomer(type);
    var x = Statement.excel(type, id, f), b = ERP.Settings.get();
    var bytes = ERP.XLSX.build(x.sheets, { title: x.title, author: b.businessName });
    /* keep Urdu letters in the file name; drop only what a file name cannot hold */
    var safe = String(x.name).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '-');
    var name = (cust ? 'statement-' : 'supplier-statement-') + (safe || id).toLowerCase() + '-' + today() + '.xlsx';
    var blob = new global.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = D.createElement('a');
    a.href = global.URL.createObjectURL(blob); a.download = name;
    D.body.appendChild(a); a.click();
    setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
    ERP.Audit.detached({ action: 'Statement exported to Excel', entity: cust ? 'Customer' : 'Supplier', entityId: id });
    return name;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   THE PAGE
   ══════════════════════════════════════════════════════════════════════════ */
var CSS = `
.kh-head{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;margin-bottom:14px}
@media(max-width:900px){.kh-head{grid-template-columns:1fr}}
.kh-id b{font-size:20px;display:block;line-height:1.25}
.kh-id .sub{color:var(--muted);font-size:13.5px;margin-top:2px}
.kh-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:12px}
.kh-facts div{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:8px 10px}
.kh-facts i{font-style:normal;display:block;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.kh-facts b{font-size:14px}
.kh-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kh-card{border:1px solid var(--line);border-radius:var(--r);padding:12px 13px;background:var(--surface)}
.kh-card i{font-style:normal;display:block;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.kh-card b{display:block;font-size:19px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}
.kh-card.sale b{color:var(--violet)}
.kh-card.credit b{color:var(--green)}
.kh-card.due b{color:var(--clay)}
.kh-card.warn b{color:var(--ochre)}
.kh-card .d{font-size:11.5px;color:var(--muted);margin-top:2px}
.kh-eq{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;margin:12px 0 0;padding:9px 12px;
  background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);font-size:12.5px;color:var(--muted)}
.kh-eq-p{white-space:nowrap}
.kh-eq i{font-style:normal;font-weight:700;color:var(--ink)}
.kh-eq b{color:var(--ink);font-variant-numeric:tabular-nums}
.kh-eq .end b{font-size:14px}
.kh-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px}
.kh-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--surface-2);
  border-radius:999px;padding:3px 6px 3px 11px;font-size:12.5px}
.kh-chip button{border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 5px}
.kh-chip button:hover{color:var(--ink)}
.kh-note{font-size:12.5px;color:var(--muted);margin:0 0 10px}
table.kh-table{width:100%;border-collapse:collapse;min-width:880px}
table.kh-table th{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);
  text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
table.kh-table th.r{text-align:right}
table.kh-table td{padding:10px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.kh-table tr.opening td,table.kh-table tr.bf td{background:var(--surface-2);font-weight:600}
table.kh-table tr.bf td{font-style:italic}
table.kh-table tfoot td{border-top:2px solid var(--line);border-bottom:0;font-weight:700}
.kh-desc b{display:block}
.kh-desc span{display:block;font-size:12px;color:var(--muted);margin-top:1px}
.kh-qty{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.kh-nil{color:var(--muted);opacity:.55}
.kh-dr{color:var(--clay);font-weight:600;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kh-cr{color:var(--green);font-weight:600;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kh-bal{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.kh-bal.neg{color:var(--green)}
.kh-side{font-size:10.5px;font-weight:700;margin-left:4px;letter-spacing:.3px;color:var(--muted)}
.kh-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;padding:10px 2px;flex-wrap:wrap}
.kh-pager span{font-size:12.5px;color:var(--muted)}
@media(max-width:760px){
  body.fc-mobile table.kh-table{min-width:0}
  body.fc-mobile .kh-cards{grid-template-columns:1fr 1fr}
  body.fc-mobile .kh-card b{font-size:16px}
  body.fc-mobile .kh-eq{flex-direction:column;gap:3px}
  /* each entry is a card: date and type on top, the words, then the three amounts on one line */
  body.fc-mobile #view .tw>table.kh-table tbody tr{grid-template-columns:repeat(3,minmax(0,1fr))}
  body.fc-mobile #view .tw>table.kh-table tbody td{grid-column:auto}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-date{grid-column:1/2}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-type{grid-column:2/4;text-align:right}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-date::before,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-type::before{display:none}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-none{display:none}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-ref,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-desc,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-qty,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-act{grid-column:1/-1}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-qty{text-align:left}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-dr,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-cr,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-bal{text-align:right}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-act:empty{display:none}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-date,
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-desc{font-weight:600}
  body.fc-mobile #view .tw>table.kh-table tbody td.kh-c-ref{font-weight:400}
  /* the totals stay readable too: a block under the list, not a squashed table footer */
  body.fc-mobile #view .tw>table.kh-table tfoot{display:block}
  body.fc-mobile #view .tw>table.kh-table tfoot tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 12px;
    border:2px solid var(--line);border-radius:var(--r);padding:12px;background:var(--surface-2)}
  body.fc-mobile #view .tw>table.kh-table tfoot td{display:block;border:0;padding:0;font-size:13.5px}
  body.fc-mobile #view .tw>table.kh-table tfoot td[colspan]{grid-column:1/-1}
  body.fc-mobile #view .tw>table.kh-table tfoot td:empty{display:none}
  body.fc-mobile #view .tw>table.kh-table tfoot td[data-label]:not([data-label=""])::before{content:attr(data-label);
    display:block;font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);font-weight:400}
  body.fc-mobile #view .tw>table.kh-table tfoot td.kh-dr,
  body.fc-mobile #view .tw>table.kh-table tfoot td.kh-cr,
  body.fc-mobile #view .tw>table.kh-table tfoot td.kh-bal{text-align:right}
}`;
(function () { var s = D.createElement('style'); s.id = 'fc-khata-css'; s.textContent = CSS; D.head.appendChild(s); })();

var K = ERP.KhataState = {
  customerId: null, preset: 'all', from: '', to: '',
  types: [], method: '', q: '', order: 'desc', page: 1, perPage: 50
};

function period() {
  if (K.preset === 'custom') return { from: K.from || null, to: K.to || null, label: 'Custom range' };
  var p = ERP.Period.resolve ? ERP.Period.resolve(K.preset) : null;
  if (p) return { from: p[0], to: p[1], label: p[2] || '' };
  return { from: null, to: null, label: 'All time' };
}
function filters() {
  var p = period();
  return { from: p.from, to: p.to, types: K.types, method: K.method, q: K.q };
}

global.PAGES.khata = function (customerId) {
  K.customerId = customerId || K.customerId;
  var c = global.custBy ? global.custBy(K.customerId) : null;
  if (!c) return '<div class="empty"><div class="ei">' + I('users') + '</div><b>Shop not found</b>' +
    '<p>Pick a shop from the customers list.</p>' +
    '<button class="btn pri" data-go="customers">Open customers</button></div>';

  var f = filters(), p = period();
  var sum = Khata.summary(c.id, f);
  var st = sum.stmt;
  var rows = sum.rows.slice();
  if (K.order === 'desc') rows.reverse();
  var pages = Math.max(1, Math.ceil(rows.length / K.perPage));
  if (K.page > pages) K.page = pages;
  var slice = rows.slice((K.page - 1) * K.perPage, K.page * K.perPage);
  /* the "brought forward" line sits at the start of the period: top when oldest first, bottom when newest first */
  var showBF = !!st.bf && !sum.filtered && (K.order === 'desc' ? K.page === pages : K.page === 1);
  if (showBF) { if (K.order === 'desc') slice.push(st.bf); else slice.unshift(st.bf); }
  var region = c.region && global.regionOf ? global.regionOf(c.region) : null;
  var stand = Statement.standing('CUSTOMER', sum.closing);

  var fact = function (l, v) { return '<div><i>' + l + '</i><b>' + (v || '—') + '</b></div>'; };
  var card = function (cls, l, v, d) {
    return '<div class="kh-card ' + cls + '"><i>' + l + '</i><b>' + v + '</b>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  };

  var presets = [['all', 'All time'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
                 ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'],
                 ['custom', 'Custom range']];
  var typeOpts = ['SALE', 'PAYMENT', 'RETURN', 'ADJUSTMENT', 'REFUND'];

  var chips = [];
  if (K.types.length) chips.push(['type', TYPE[K.types[0]].label]);
  if (K.method) chips.push(['method', K.method]);
  if (K.q) chips.push(['q', '“' + K.q + '”']);
  var chipsHtml = chips.length
    ? '<div class="kh-chips">' + chips.map(function (x) {
        return '<span class="kh-chip">' + esc(x[1]) + '<button type="button" data-khclear="' + x[0] +
          '" aria-label="Remove filter">×</button></span>';
      }).join('') +
      '<button class="btn sm" data-khclear="all">Clear filters</button></div>'
    : '';

  var body;
  if (st.invalid) {
    body = '<div class="banner warn">' + I('alert') + '<div><b>The "From" date is after the "To" date</b>' +
      '<p>Pick a From date on or before the To date.</p></div></div>';
  } else if (slice.length) {
    body = (sum.filtered
        ? '<p class="kh-note">Showing ' + sum.count + ' of ' + st.entries.filter(function (e) { return e.type !== 'OPENING'; }).length +
          ' entries. Balances are the true running balance of the whole account; the totals below cover only the lines shown. Print and Excel always include the whole period.</p>'
        : '') +
      '<div class="card"><div class="card-b" style="padding:0">' +
      Statement.tableHtml('CUSTOMER', slice, sum.filtered
        ? { label: 'Totals for the ' + sum.count + ' entries shown', debit: sum.viewDebit, credit: sum.viewCredit,
            balance: '<span class="kh-nil">—</span>' }
        : { label: p.from || p.to ? 'Totals for this period' : 'Totals', debit: sum.debit, credit: sum.credit,
            balance: Statement.balHtml('CUSTOMER', sum.closing), balanceLabel: 'Closing' }, true) +
      '</div></div>' + Statement.pagerHtml('data-khpage', K.page, pages, rows.length);
  } else {
    body = '<div class="empty"><div class="ei">' + I('doc') + '</div><b>No entries in this view</b>' +
      '<p>' + (K.q || K.types.length || K.method || K.preset !== 'all'
        ? 'Nothing matches these filters. Widen the period or clear the search.'
        : 'This shop has no transactions yet. Raise an invoice or record a payment to start the account.') +
      '</p><button class="btn pri" data-fcnew="sale">' + I('plus') + 'New invoice</button></div>';
  }

  return '<div class="kh-head">' +
      '<div class="card"><div class="card-b">' +
        '<div class="kh-id"><b>' + esc(c.sh || '') + '</b>' +
          '<div class="sub">' + esc(c.ow || 'Owner not recorded') + ' · ' +
            (region ? u(region.ur) + ' — ' + esc(region.en) : 'No region') + '</div></div>' +
        '<div class="kh-facts">' +
          fact('Customer ID', esc(c.legacyCode || c.id)) +
          fact('Phone', esc(c.ph || '')) +
          fact('WhatsApp', esc(c.wa || c.ph || '')) +
          fact('Address', esc(c.addr || c.area || '')) +
          fact('Route', esc(c.route || '')) +
          fact('Salesperson', esc(c.salesperson || 'Not assigned')) +
        '</div>' +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn pri" data-khpay="' + c.id + '">' + I('wallet') + 'Receive payment</button>' +
          '<button class="btn pri" data-khrefund="' + c.id + '">' + I('wallet') + 'Pay this shop</button>' +
          '<button class="btn" data-khadjust="' + c.id + '">' + I('edit') + 'Adjustment</button>' +
          '<button class="btn" data-fcnew="sale">' + I('plus') + 'New invoice</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="card"><div class="card-b"><div class="kh-cards">' +
        card('', 'Opening balance', M.fmt(sum.opening), p.label) +
        card('sale', 'Total sales', M.fmt(sum.sales), sum.salesCount + ' invoice' + (sum.salesCount === 1 ? '' : 's')) +
        card('credit', 'Payments received', M.fmt(sum.payments),
          sum.lastPaymentDate ? 'Last ' + fmtDate(sum.lastPaymentDate) : 'None in this period') +
        card('credit', 'Returns &amp; credits', M.fmt(sum.returns + sum.adjustmentsCr)) +
        card(stand.tone, p.to ? 'Closing balance' : 'Current balance', M.fmt(sum.closing),
          stand.text + (p.to ? ' · at ' + fmtDate(p.to) : '')) +
        card('warn', 'Last transaction', sum.lastTransactionDate ? fmtDate(sum.lastTransactionDate) : '—',
          p.to && sum.overall !== sum.closing ? 'Balance today ' + M.fmt(sum.overall) : '') +
      '</div>' + (st.invalid ? '' : '<div class="kh-eq">' + Statement.equationHtml(st) + '</div>') +
      '</div></div>' +
    '</div>' +

    '<div class="bar">' +
      '<div class="tsearch">' + I('search') +
        '<input placeholder="Invoice or receipt number, product, note…" data-khq value="' + esc(K.q) + '"></div>' +
      '<label class="fld">' + I('cal') + '<select data-khfil="preset">' + presets.map(function (x) {
        return '<option value="' + x[0] + '"' + (K.preset === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
      }).join('') + '</select></label>' +
      (K.preset === 'custom'
        ? '<label class="fld"><input type="date" data-khfil="from" value="' + esc(K.from) + '" aria-label="From"></label>' +
          '<label class="fld"><input type="date" data-khfil="to" value="' + esc(K.to) + '" aria-label="To"></label>' : '') +
      '<label class="fld">' + I('filter') + '<select data-khfil="type">' +
        '<option value="">All entries</option>' +
        typeOpts.map(function (t) {
          return '<option value="' + t + '"' + (K.types[0] === t ? ' selected' : '') + '>' +
            TYPE[t].label + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('wallet') + '<select data-khfil="method"><option value="">Any method</option>' +
        ERP.ENUM.methods.map(function (m) {
          return '<option value="' + m + '"' + (K.method === m ? ' selected' : '') + '>' + m + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('swap') + '<select data-khfil="order">' +
        '<option value="desc"' + (K.order === 'desc' ? ' selected' : '') + '>Newest first</option>' +
        '<option value="asc"' + (K.order === 'asc' ? ' selected' : '') + '>Oldest first</option>' +
      '</select></label>' +
      '<div class="grow"></div>' +
      '<button class="btn" data-khexport="print">' + I('print') + 'Print / PDF</button>' +
      '<button class="btn" data-khexport="word">Word</button>' +
      '<button class="btn" data-khexport="excel">' + I('sheet') + 'Excel</button>' +
    '</div>' + chipsHtml + body;
};

if (global.PAGEMETA) {
  global.PAGEMETA.khata = ['Account statement',
    'The complete history of a shop — sales, payments, returns and adjustments, with the balance after each one.'];
}

/* a way in from the customer profile */
var origProfile = global.PAGES.customerProfile;
if (origProfile) {
  global.PAGES.customerProfile = function (id) {
    var html = origProfile(id);
    return '<div class="bar"><div class="grow"></div>' +
      '<button class="btn pri" data-khata="' + id + '">' + I('doc') + 'Account statement</button>' +
      '<button class="btn" data-khpay="' + id + '">' + I('wallet') + 'Receive payment</button>' +
      '<button class="btn" data-khrefund="' + id + '">' + I('wallet') + 'Pay this shop</button>' +
      '</div>' + html;
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   DOCUMENTS — built from ERP.Statement, never from the khata page's state
   ══════════════════════════════════════════════════════════════════════════ */
function statementModel(customerId, f) {
  f = f || {};
  return Statement.model('CUSTOMER', customerId, { from: f.from, to: f.to });
}
ERP.statementModel = statementModel;

/* the old statement panels, the Statement of Account screen and the khata page
   all open this one document, for either kind of party */
ERP.DocModel.statement = function (partyId, type, fromISO, toISO) {
  return Statement.model(type === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER', partyId,
    { from: fromISO || null, to: toISO || null });
};

function exportExcel(customerId) {
  var f = filters();
  return Statement.download('CUSTOMER', customerId, { from: f.from, to: f.to });
}
ERP.exportStatementExcel = exportExcel;

/* ══════════════════════════════════════════════════════════════════════════
   PANEL — posting an adjustment
   ══════════════════════════════════════════════════════════════════════════ */
var ADJ_FOR = null;
global.PANELS.adjustment = {
  t: 'Account adjustment', s: 'Correct a shop account, on the record', cta: 'Post adjustment',
  f: function () {
    var custs = (global.CUSTOMERS || []);
    var pre = ADJ_FOR || K.customerId || (custs[0] || {}).id;
    return '<div class="banner info">' + I('alert') + '<div><p>An adjustment is posted as its own entry ' +
      'with your name and the reason against it. Balances are never quietly rewritten.</p></div></div>' +
      '<label class="f"><span>Shop</span><select data-f="cust">' +
        custs.map(function (c) {
          return '<option value="' + c.id + '"' + (c.id === pre ? ' selected' : '') + '>' + esc(c.sh) + '</option>';
        }).join('') + '</select></label>' +
      '<div class="f2">' +
        '<label class="f"><span>Effect</span><select data-f="direction">' +
          '<option value="DEBIT">Increase what the shop owes (debit)</option>' +
          '<option value="CREDIT">Reduce what the shop owes (credit)</option></select></label>' +
        '<label class="f"><span>Amount</span><input data-f="amount" inputmode="decimal" placeholder="0"></label>' +
      '</div>' +
      '<div class="f2">' +
        '<label class="f"><span>Date</span><input type="date" data-f="date" value="' + today() + '"></label>' +
        '<label class="f"><span>Reason</span><select data-f="reason">' +
          Adjustments.reasons.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') +
        '</select></label>' +
      '</div>' +
      '<label class="f fc-desc"><span>Description / تفصیل</span>' +
        '<input data-f="description" maxlength="500" ' +
        'placeholder="Appears on the statement \u2014 English or Urdu"></label>' +
      '<label class="f"><span>Internal note</span><input data-f="notes" placeholder="Optional"></label>';
  },
  save: function (v) {
    ERP.Adjustments.create({
      customerId: v.cust, direction: v.direction, amount: v.amount,
      date: v.date, reason: v.reason, notes: v.notes, description: v.description
    }).then(function (r) {
      global.paint();
      say('Adjustment ' + r.adjustmentNumber + ' posted.');
    }).catch(function (e) {
      say(e && e.validation ? e.validation[0] : 'The adjustment could not be posted.');
    });
    return { msg: 'Posting adjustment…' };
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════════════════════ */
D.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var go = e.target.closest('[data-khata]');
  if (go) {
    e.preventDefault();
    K.customerId = go.dataset.khata; K.page = 1;
    global.go('khata', K.customerId);
    return;
  }
  var pay = e.target.closest('[data-khpay]');
  if (pay) {
    e.preventDefault();
    if (ERP.setPayFor) ERP.setPayFor(pay.dataset.khpay);
    global.openPanel('payment');
    return;
  }
  var refund = e.target.closest('[data-khrefund]');
  if (refund) {
    e.preventDefault();
    if (ERP.setRefundFor) ERP.setRefundFor(refund.dataset.khrefund);
    global.openPanel('refund');
    return;
  }
  var adj = e.target.closest('[data-khadjust]');
  if (adj) { e.preventDefault(); ADJ_FOR = adj.dataset.khadjust; global.openPanel('adjustment'); return; }

  var open = e.target.closest('[data-khopen]');
  if (open) {
    e.preventDefault();
    var kind = open.dataset.khopen, id = open.dataset.id;
    if (kind === 'invoice') ERP.Viewer.open(ERP.DocModel.invoice(id));
    else if (kind === 'payment') ERP.Viewer.open(ERP.DocModel.receipt(id));
    else if (kind === 'custreturn') ERP.Viewer.open(ERP.DocModel.customerReturn(id));
    else if (kind === 'purchase') ERP.Viewer.open(ERP.DocModel.purchase(id));
    else if (kind === 'supreturn') ERP.Viewer.open(ERP.DocModel.supplierReturn(id));
    return;
  }
  var rev = e.target.closest('[data-khreverse]');
  if (rev) {
    e.preventDefault();
    var revId = rev.dataset.khreverse;
    ERP.UI.prompt('Reverse this adjustment?', {
      detail: 'The shop\u2019s balance goes back to what it was before. The reason is kept in the audit log.',
      label: 'Reason', placeholder: 'Why is this adjustment being reversed?',
      okText: 'Reverse it', cancelText: 'Keep it', tone: 'warn'
    }).then(function (why) {
      if (why === null) return;
      return ERP.Adjustments.reverse(revId, why || 'No reason given')
        .then(function () { global.paint(); say('Adjustment reversed.'); });
    });
    return;
  }
  var pg = e.target.closest('[data-khpage]');
  if (pg) {
    e.preventDefault();
    K.page += pg.dataset.khpage === 'next' ? 1 : -1;
    if (K.page < 1) K.page = 1;
    global.paint();
    return;
  }
  var clr = e.target.closest('[data-khclear]');
  if (clr) {
    e.preventDefault();
    var what0 = clr.dataset.khclear;
    if (what0 === 'type' || what0 === 'all') K.types = [];
    if (what0 === 'method' || what0 === 'all') K.method = '';
    if (what0 === 'q' || what0 === 'all') K.q = '';
    K.page = 1;
    global.paint();
    return;
  }
  var ex = e.target.closest('[data-khexport]');
  if (ex) {
    e.preventDefault();
    var what = ex.dataset.khexport, f = filters();
    if (Statement.invalidRange(f.from, f.to)) { say('The "From" date is after the "To" date — fix the range first.'); return; }
    if (what === 'excel') { say('Excel file downloaded — ' + exportExcel(K.customerId)); return; }
    /* paper always carries the whole period: the screen's type / method / search choices are not applied */
    if (K.types.length || K.method || K.q) say('The printed statement covers the whole period — the screen filters are not applied to it.');
    var m = statementModel(K.customerId, f);
    ERP.Viewer.open(m);
    if (what === 'word') { setTimeout(function () { ERP.Viewer.word(); }, 120); }
    else if (what === 'print' || what === 'pdf') {
      setTimeout(function () { ERP.Viewer.print(what === 'pdf'); }, 160);
    }
    return;
  }
}, true);

D.addEventListener('input', function (e) {
  if (e.target.dataset && e.target.dataset.khq !== undefined) {
    K.q = e.target.value; K.page = 1;
    clearTimeout(K._t);
    K._t = setTimeout(function () {
      if (global.cur !== 'khata') return;
      var el = D.querySelector('[data-khq]'), pos = el && el.selectionStart;
      global.paint();
      var back = D.querySelector('[data-khq]');
      if (back) { back.focus(); try { back.setSelectionRange(pos, pos); } catch (err) {} }
    }, 180);
  }
});
D.addEventListener('change', function (e) {
  var el = e.target;
  if (!el.dataset || el.dataset.khfil === undefined) return;
  var k = el.dataset.khfil;
  if (k === 'type') K.types = el.value ? [el.value] : [];
  else if (k === 'preset') { K.preset = el.value; }
  else K[k] = el.value;
  K.page = 1;
  global.paint();
});

/* adjustments load with everything else. The promise is exposed so callers —
   and tests — can wait for the account to be complete rather than guessing at
   a delay; the khata repaints itself either way once the rows land. */
ERP.adjustmentsReady = (ERP.bootPromise || Promise.resolve()).then(function () {
  return FDB.hydrate().then(function (d) {
    S.accountAdjustments = (d.accountAdjustments || [])
      .sort(function (a, b) { return a.adjustmentDate < b.adjustmentDate ? 1 : -1; });
    ERP.Mirror.refresh();
  });
}).catch(function () { S.accountAdjustments = S.accountAdjustments || []; });
})(typeof window !== 'undefined' ? window : globalThis);
