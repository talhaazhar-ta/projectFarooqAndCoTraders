/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 19
   COLLECTION, PROFIT REPORTS AND WHO MAY SEE WHAT
   The sheet a collector carries round the bazaar, printed with room to write
   in; the profit reports behind the counter; and the rule that a godown hand
   does not see what the business earns on a bag.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';
var ERP = global.ERP, M = global.Money, FDB = global.FDB, D = global.document;
var S = ERP.S, Staff = ERP.Staff, Areas = ERP.Areas, Profit = ERP.Profit;
var I = function (n) { return global.I ? global.I(n) : ''; };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function u(t) { return global.u ? global.u(t) : esc(t); }
function say(m) { return global.say ? global.say(m) : null; }
function today() { return global.FC_TODAY ? global.FC_TODAY() : new Date().toISOString().slice(0, 10); }
function fmtDate(x) { return global.fmtDate ? global.fmtDate(x) : x; }
function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

/* ══════════════════════════════════════════════════════════════════════════
   ROLES
   Enforcement here is in the app, not on a server — there is no server. It
   stops the wrong screen being opened and the wrong figure being shown; it
   is not a defence against someone determined with the device in their hand.
   ══════════════════════════════════════════════════════════════════════════ */
var ROLES = {
  OWNER:      { label: 'Owner', all: true },
  MANAGER:    { label: 'Manager', perms: ['MASTER_DATA_VIEW', 'MASTER_DATA_CREATE', 'MASTER_DATA_EDIT',
                 'MASTER_DATA_ARCHIVE', 'PRODUCT_EDIT', 'SUPPLIER_EDIT', 'CUSTOMER_EDIT',
                 'SALES_CREATE', 'PURCHASE_CREATE', 'PAYMENT_CREATE', 'COLLECTION_VIEW',
                 'COLLECTION_EXPORT', 'FINANCIAL_REPORT_VIEW', 'PROFIT_VIEW', 'TRANSACTION_CORRECT',
                 'AUDIT_LOG_VIEW', 'STOCK_MANAGE'] },
  ACCOUNTANT: { label: 'Accountant', perms: ['MASTER_DATA_VIEW', 'CUSTOMER_EDIT', 'PAYMENT_CREATE',
                 'COLLECTION_VIEW', 'COLLECTION_EXPORT', 'FINANCIAL_REPORT_VIEW', 'PROFIT_VIEW',
                 'TRANSACTION_CORRECT', 'AUDIT_LOG_VIEW'] },
  SALES:      { label: 'Sales', perms: ['MASTER_DATA_VIEW', 'SALES_CREATE', 'PAYMENT_CREATE',
                 'COLLECTION_VIEW', 'CUSTOMER_EDIT'] },
  INVENTORY:  { label: 'Warehouse', perms: ['MASTER_DATA_VIEW', 'STOCK_MANAGE'] }
};
var RBAC = ERP.RBAC = {
  roles: ROLES,
  role: function () { return ERP.Settings.get().currentRole || 'OWNER'; },
  setRole: function (r) { return ERP.Settings.save({ currentRole: r }).then(function () { global.paint(); }); },
  can: function (perm) {
    var r = ROLES[RBAC.role()] || ROLES.OWNER;
    if (r.all) return true;
    if (perm === 'PROFIT_VIEW' && ERP.Settings.get().showProfitToStaff) return true;
    return (r.perms || []).indexOf(perm) > -1;
  },
  label: function () { return (ROLES[RBAC.role()] || ROLES.OWNER).label; }
};
ERP.Can = function (perm) { return RBAC.can(perm); };

function locked(what) {
  return '<div class="card"><div class="card-b fcp-locked">' + I('lock') +
    '<p style="margin-top:8px"><b>' + esc(what) + ' is not shown for the ' + esc(RBAC.label()) +
    ' role.</b><br>Change the role in Settings if you are the owner.</p></div></div>';
}

/* ══════════════════════════════════════════════════════════════════════════
   COLLECTION
   ══════════════════════════════════════════════════════════════════════════ */
var C = ERP.CollectionState = {
  regionId: 'all', salesmanId: 'all', outstandingOnly: true, minBalance: '',
  sort: 'balance', from: '', to: '', q: ''
};

var Collection = ERP.Collection = {
  rows: function (o) {
    o = o || C;
    var from = o.from || null, to = o.to || null;
    var list = (global.CUSTOMERS || []).filter(function (c) {
      if (c.active === false) return false;
      if (o.regionId !== 'all' && c.region !== o.regionId) return false;
      if (o.salesmanId !== 'all' && Staff.forCustomer(c.id) !== o.salesmanId) return false;
      if (o.q) {
        var hay = [c.sh, c.ow, c.ph, c.legacyCode].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(o.q.toLowerCase()) === -1) return false;
      }
      return true;
    }).map(function (c) {
      var L = ERP.Ledger.customer(c.id, from, to);
      var invoices = S.invoices.filter(function (i) {
        return i.customerId === c.id && i.status !== 'DRAFT' && i.status !== 'CANCELLED' &&
               (!from || i.invoiceDate >= from) && (!to || i.invoiceDate <= to);
      });
      var pays = S.payments.filter(function (p) {
        return p.partyId === c.id && p.direction === 'IN' && p.status !== 'REVERSED' &&
               (!from || p.paymentDate >= from) && (!to || p.paymentDate <= to);
      });
      var lastPay = S.payments.filter(function (p) {
        return p.partyId === c.id && p.direction === 'IN' && p.status !== 'REVERSED';
      }).sort(function (a, b) { return a.paymentDate < b.paymentDate ? 1 : -1; })[0];
      var lastSale = S.invoices.filter(function (i) {
        return i.customerId === c.id && i.status !== 'DRAFT' && i.status !== 'CANCELLED';
      }).sort(function (a, b) { return a.invoiceDate < b.invoiceDate ? 1 : -1; })[0];
      var region = c.region && global.regionOf ? global.regionOf(c.region) : null;
      return {
        id: c.id, shop: c.sh, owner: c.ow || '', phone: c.ph || '', whatsapp: c.wa || '',
        code: c.legacyCode || c.id, address: c.addr || c.area || '', route: c.route || '',
        region: region ? region.en : '', regionUr: region ? region.ur : '',
        salesman: Staff.nameForCustomer(c.id),
        opening: L.opening, sales: invoices.reduce(function (a, i) { return a + i.grandTotal; }, 0),
        payments: pays.reduce(function (a, p) { return a + p.amount; }, 0),
        balance: ERP.Ledger.customerBalance(c.id),
        periodBalance: L.closing,
        lastPayment: lastPay ? lastPay.amount : 0,
        lastPaymentDate: lastPay ? lastPay.paymentDate : '',
        lastSaleDate: lastSale ? lastSale.invoiceDate : '',
        limit: c.limit || 0
      };
    });
    var hidden = 0;
    if (o.outstandingOnly) {
      var before = list.length;
      list = list.filter(function (r) { return r.balance > 0; });
      hidden = before - list.length;
    }
    var min = o.minBalance ? M.toP(o.minBalance) : 0;
    if (min) list = list.filter(function (r) { return r.balance >= min; });
    var sort = o.sort || 'balance';
    list.sort(function (a, b) {
      if (sort === 'name') return (a.shop || '').localeCompare(b.shop || '');
      if (sort === 'lowest') return a.balance - b.balance;
      if (sort === 'route') return (a.route || '').localeCompare(b.route || '') ||
                                   (a.shop || '').localeCompare(b.shop || '');
      if (sort === 'lastpay') return (a.lastPaymentDate || '') < (b.lastPaymentDate || '') ? -1 : 1;
      return b.balance - a.balance;
    });
    list.hidden = hidden;
    return list;
  },
  summary: function (rows) {
    return {
      customers: rows.length,
      sales: rows.reduce(function (a, r) { return a + r.sales; }, 0),
      payments: rows.reduce(function (a, r) { return a + r.payments; }, 0),
      outstanding: rows.reduce(function (a, r) { return a + Math.max(0, r.balance); }, 0),
      overdue: rows.filter(function (r) {
        if (!r.lastPaymentDate) return r.balance > 0;
        var days = (new Date(today()) - new Date(r.lastPaymentDate)) / 86400000;
        return r.balance > 0 && days > 30;
      }).reduce(function (a, r) { return a + Math.max(0, r.balance); }, 0)
    };
  }
};

/* ── the printed sheet ── */
var SHEET_CSS = `
.cs-sheet{background:#fff;color:#16161F;font-family:"Segoe UI",Manrope,system-ui,sans-serif;
  width:297mm;min-height:210mm;padding:10mm 10mm 12mm;margin:0 auto;box-sizing:border-box;font-size:11px}
.cs-sheet h1{font-size:17px;margin:0;letter-spacing:.3px}
.cs-sheet .cs-head{display:flex;justify-content:space-between;align-items:flex-start;
  border-bottom:2px solid #5B21B6;padding-bottom:7px;margin-bottom:8px}
.cs-sheet .cs-sub{font-size:10px;color:#63636F;text-transform:uppercase;letter-spacing:1.2px}
.cs-sheet .cs-meta{text-align:right;font-size:10.5px;color:#63636F;line-height:1.6}
.cs-sheet .cs-strip{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid #D8D8E0;
  border-radius:4px;overflow:hidden;margin-bottom:8px}
.cs-sheet .cs-strip div{padding:5px 9px;border-right:1px solid #D8D8E0}
.cs-sheet .cs-strip div:last-child{border-right:none}
.cs-sheet .cs-strip i{font-style:normal;display:block;font-size:8.5px;letter-spacing:1px;
  text-transform:uppercase;color:#63636F}
.cs-sheet .cs-strip b{font-size:12.5px}
.cs-sheet table{width:100%;border-collapse:collapse}
.cs-sheet th{background:#EFECF9;border:1px solid #B9B9C4;padding:5px 6px;font-size:9px;
  letter-spacing:.6px;text-transform:uppercase;text-align:left}
.cs-sheet td{border:1px solid #B9B9C4;padding:6px;vertical-align:middle}
.cs-sheet td.r{text-align:right;font-variant-numeric:tabular-nums}
.cs-sheet .cs-write{background:#FCFCFE}
.cs-sheet .cs-ur{font-family:"Noto Nastaliq Urdu","Jameel Noori Nastaleeq",serif;line-height:1.9}
.cs-sheet tfoot td{background:#F1EEFB;font-weight:700}
.cs-sheet .cs-sign{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:26px;margin-top:18px}
.cs-sheet .cs-sign div{border-top:1px solid #8C8C99;padding-top:4px;font-size:9px;
  text-transform:uppercase;letter-spacing:.8px;color:#63636F}
@media print{
  .cs-sheet{width:auto;min-height:auto;padding:0}
  .cs-sheet thead{display:table-header-group}
  .cs-sheet tr{break-inside:avoid;page-break-inside:avoid}
  @page{size:A4 landscape;margin:10mm}
}
.cs-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
`;
(function () { var s = D.createElement('style'); s.id = 'fc-collect-css'; s.textContent = SHEET_CSS; D.head.appendChild(s); })();

Collection.sheetHtml = function (rows, opts) {
  opts = opts || {};
  var b = ERP.Settings.get();
  var sum = Collection.summary(rows);
  var area = C.regionId !== 'all' ? Areas.byId(C.regionId) : null;
  var sm = C.salesmanId !== 'all' ? Staff.byId(C.salesmanId) : null;
  return '<div class="cs-sheet">' +
    '<div class="cs-head"><div><h1>' + esc(b.businessName) + '</h1>' +
      '<div class="cs-sub">Customer collection sheet</div></div>' +
      '<div class="cs-meta">' +
        (area ? 'Area: <b>' + esc(area.en) + ' — </b><span class="cs-ur">' + esc(area.ur) + '</span><br>' : 'All areas<br>') +
        (sm ? 'Salesman: <b>' + esc(sm.name) + '</b>' + (sm.phone ? ' · ' + esc(sm.phone) : '') + '<br>' : '') +
        'Generated: ' + esc(fmtDate(today())) + ' ' + new Date().toTimeString().slice(0, 5) + '<br>' +
        'By: ' + esc(global.CURRENT_USER || 'Owner') + '<br>' +
        'Collection date: ______________' +
      '</div></div>' +
    '<div class="cs-strip">' +
      '<div><i>Shops</i><b>' + sum.customers + '</b></div>' +
      '<div><i>Sales in period</i><b>' + M.fmtPlain(sum.sales) + '</b></div>' +
      '<div><i>Payments received</i><b>' + M.fmtPlain(sum.payments) + '</b></div>' +
      '<div><i>Outstanding</i><b>' + M.fmtPlain(sum.outstanding) + '</b></div>' +
      '<div><i>Over 30 days</i><b>' + M.fmtPlain(sum.overdue) + '</b></div>' +
    '</div>' +
    '<table><thead><tr>' +
      '<th style="width:3%">#</th><th style="width:20%">Shop / customer</th>' +
      '<th style="width:12%">Owner</th><th style="width:10%">Phone</th>' +
      '<th style="width:9%" class="r">Previous</th><th style="width:8%" class="r">New sales</th>' +
      '<th style="width:8%" class="r">Payments</th><th style="width:9%" class="r">Balance now</th>' +
      '<th style="width:10%">Amount collected</th><th style="width:11%">Signature / notes</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r, ix) {
      return '<tr><td class="r">' + (ix + 1) + '</td>' +
        '<td><b>' + esc(r.shop) + '</b>' + (r.code ? ' <span style="color:#63636F">· ' + esc(r.code) + '</span>' : '') +
          (r.route ? '<div style="color:#63636F;font-size:9.5px">' + esc(r.route) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.owner || '—') + '</td>' +
        '<td>' + esc(r.phone || '—') + '</td>' +
        '<td class="r">' + M.fmtPlain(r.opening) + '</td>' +
        '<td class="r">' + M.fmtPlain(r.sales) + '</td>' +
        '<td class="r">' + M.fmtPlain(r.payments) + '</td>' +
        '<td class="r"><b>' + M.fmtPlain(r.balance) + '</b></td>' +
        '<td class="cs-write">&nbsp;</td><td class="cs-write">&nbsp;</td></tr>';
    }).join('') + '</tbody>' +
    '<tfoot><tr><td colspan="4">Total — ' + rows.length + ' shops</td>' +
      '<td class="r">' + M.fmtPlain(rows.reduce(function (a, r) { return a + r.opening; }, 0)) + '</td>' +
      '<td class="r">' + M.fmtPlain(sum.sales) + '</td>' +
      '<td class="r">' + M.fmtPlain(sum.payments) + '</td>' +
      '<td class="r">' + M.fmtPlain(sum.outstanding) + '</td>' +
      '<td class="cs-write">&nbsp;</td><td class="cs-write">&nbsp;</td></tr></tfoot></table>' +
    '<div class="cs-sign"><div>Collector / salesman</div><div>Cash received by</div>' +
      '<div>Checked by</div><div>Authorised signature</div></div>' +
    '</div>';
};

Collection.print = function () {
  var rows = Collection.rows();
  if (!rows.length) { say('No shops match these filters.'); return; }
  var host = D.getElementById('fcviewer');
  if (!host) { host = D.createElement('div'); host.id = 'fcviewer'; D.body.appendChild(host); }
  host.innerHTML = '<div class="fcv-bar"><div class="fcv-t"><b>Collection sheet</b>' +
      '<span class="mono">' + rows.length + ' shops</span></div><div class="fcv-sp"></div>' +
      '<button class="fcv-btn pri" data-csprint="1">Print</button>' +
      '<button class="fcv-btn" data-csprint="pdf">Save as PDF</button>' +
      '<button class="fcv-btn" data-csexcel="1">Excel</button>' +
      '<button class="fcv-btn" data-fcv="close">' + I('x') + 'Close</button></div>' +
    '<div class="fcv-scroll"><div class="fcv-page" id="fcvPage" style="transform:scale(' +
      (ERP.isMobile && ERP.isMobile() ? 0.34 : 0.78) + ')">' + Collection.sheetHtml(rows) + '</div></div>';
  host.classList.add('on');
  ERP.Viewer.current = { kind: 'COLLECTION', entityId: C.regionId, title: 'Collection sheet',
                         number: '', business: ERP.DocModel.business(), rows: rows };
  ERP.Audit.detached({ action: 'Collection sheet generated', entity: 'Collection',
    entityId: C.regionId, ref: String(rows.length) + ' shops' });
};

Collection.excel = function () {
  var rows = Collection.rows(), b = ERP.Settings.get(), sum = Collection.summary(rows);
  var area = C.regionId !== 'all' ? Areas.byId(C.regionId) : null;
  var sm = C.salesmanId !== 'all' ? Staff.byId(C.salesmanId) : null;
  var head = [[{ v: b.businessName, style: 3 }], ['Customer collection sheet'],
    ['Area', area ? area.en + ' — ' + area.ur : 'All areas'],
    ['Salesman', sm ? sm.name : 'All'],
    ['Generated', fmtDate(today()) + ' ' + new Date().toTimeString().slice(0, 5)],
    ['Generated by', global.CURRENT_USER || 'Owner'],
    ['Shops', sum.customers], ['Outstanding', M.toR(sum.outstanding)], []];
  var sheet = head.concat([['#', 'Shop', 'Owner', 'Phone', 'Area', 'Salesman', 'Previous',
      'New sales', 'Payments', 'Balance', 'Last payment', 'Amount collected', 'Notes']])
    .concat(rows.map(function (r, ix) {
      return [ix + 1, r.shop, r.owner, r.phone, r.region, r.salesman, M.toR(r.opening),
              M.toR(r.sales), M.toR(r.payments), M.toR(r.balance),
              r.lastPaymentDate ? fmtDate(r.lastPaymentDate) : '', '', ''];
    }))
    .concat([[], ['', 'Total', '', '', '', '', '', M.toR(sum.sales), M.toR(sum.payments), M.toR(sum.outstanding)]]);
  var bytes = ERP.XLSX.build([{ name: 'Collection', rows: sheet }],
    { title: 'Collection sheet', author: b.businessName });
  var name = 'collection-' + (area ? area.en.replace(/[^\w]+/g, '-').toLowerCase() : 'all') + '-' + today() + '.xlsx';
  var blob = new global.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  var a = D.createElement('a');
  a.href = global.URL.createObjectURL(blob); a.download = name;
  D.body.appendChild(a); a.click();
  setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
  return name;
};

global.PAGES.collection = function () {
  if (!ERP.Can('COLLECTION_VIEW')) return locked('The collection list');
  var rows = Collection.rows(), sum = Collection.summary(rows);
  var card = function (l, v, d, cls) {
    return '<div class="fcp-card ' + (cls || '') + '"><i>' + l + '</i><b>' + v + '</b>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  };
  return '<div class="fcp-cards">' +
      card('Shops to visit', String(sum.customers), C.outstandingOnly ? 'With money outstanding' : 'All shops') +
      card('Outstanding', M.fmt(sum.outstanding), 'To collect', 'loss') +
      card('Over 30 days', M.fmt(sum.overdue), 'No payment in a month') +
      card('Collected in period', M.fmt(sum.payments), '', 'profit') +
    '</div>' +
    '<div class="bar">' +
      '<div class="tsearch">' + I('search') + '<input placeholder="Shop, owner, phone…" data-csq value="' + esc(C.q) + '"></div>' +
      '<label class="fld">' + I('pin') + '<select data-csfil="regionId"><option value="all">All areas</option>' +
        Areas.active().map(function (r) {
          return '<option value="' + r.id + '"' + (C.regionId === r.id ? ' selected' : '') + '>' +
            esc(r.en) + ' — ' + esc(r.ur) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('users') + '<select data-csfil="salesmanId"><option value="all">Any salesman</option>' +
        Staff.active().map(function (s) {
          return '<option value="' + s.id + '"' + (C.salesmanId === s.id ? ' selected' : '') + '>' +
            esc(s.name) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('filter') + '<select data-csfil="outstandingOnly">' +
        '<option value="yes"' + (C.outstandingOnly ? ' selected' : '') + '>Outstanding only</option>' +
        '<option value="no"' + (!C.outstandingOnly ? ' selected' : '') + '>All shops</option></select></label>' +
      '<label class="fld">' + I('swap') + '<select data-csfil="sort">' +
        [['balance', 'Highest balance'], ['lowest', 'Lowest balance'], ['name', 'Shop name'],
         ['route', 'Route order'], ['lastpay', 'Longest unpaid']].map(function (o) {
          return '<option value="' + o[0] + '"' + (C.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld"><input inputmode="decimal" placeholder="Min balance" data-csmin value="' +
        esc(C.minBalance) + '" style="width:110px"></label>' +
      '<div class="grow"></div>' +
      (ERP.Can('COLLECTION_EXPORT')
        ? '<button class="btn" data-csexcel="1">' + I('sheet') + 'Excel</button>' +
          '<button class="btn pri" data-csprintopen="1">' + I('print') + 'Collection sheet</button>' : '') +
    '</div>' +
    (rows.hidden > 0
      ? '<p class="hint" style="margin:0 0 10px">' + rows.hidden + ' shop' + (rows.hidden === 1 ? '' : 's') +
        ' that owe' + (rows.hidden === 1 ? 's' : '') + ' nothing ' + (rows.hidden === 1 ? 'is' : 'are') + ' not shown. ' +
        '<button class="btn sm" data-csshowall>Show all shops</button></p>' : '') +
    (rows.length
      ? '<div class="card"><div class="card-b" style="padding:0"><div class="tw">' +
        '<table class="fcb-list"><thead><tr><th>Shop</th><th>Owner</th><th>Phone</th><th>Area</th>' +
        '<th>Salesman</th><th class="r">Previous</th><th class="r">Sales</th><th class="r">Paid</th>' +
        '<th class="r">Balance</th><th>Last payment</th><th class="c">Actions</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td data-label="Shop"><b>' + esc(r.shop) + '</b>' +
              '<div class="sub mono">' + esc(r.code) + '</div></td>' +
            '<td data-label="Owner">' + esc(r.owner || '—') + '</td>' +
            '<td data-label="Phone" class="mono">' + esc(r.phone || '—') + '</td>' +
            '<td data-label="Area">' + esc(r.region || '—') + '</td>' +
            '<td data-label="Salesman">' + (r.salesman ? esc(r.salesman) : '<span class="hint">—</span>') + '</td>' +
            '<td data-label="Previous" class="r num">' + M.fmtPlain(r.opening) + '</td>' +
            '<td data-label="Sales" class="r num">' + M.fmtPlain(r.sales) + '</td>' +
            '<td data-label="Paid" class="r num">' + M.fmtPlain(r.payments) + '</td>' +
            '<td data-label="Balance" class="r num"><b>' + M.fmtPlain(r.balance) + '</b></td>' +
            '<td data-label="Last payment">' + (r.lastPaymentDate ? esc(fmtDate(r.lastPaymentDate)) +
              '<div class="sub">' + M.fmtPlain(r.lastPayment) + '</div>' : '<span class="hint">Never</span>') + '</td>' +
            '<td data-label="" class="c fcb-rowacts">' +
              (ERP.Can('PAYMENT_CREATE') ? '<button class="btn sm pri" data-khpay="' + r.id + '">Receive</button>' : '') +
              '<button class="btn sm" data-khata="' + r.id + '">Statement</button></td></tr>';
        }).join('') + '</tbody></table></div></div></div>'
      : '<div class="empty"><div class="ei">' + I('wallet') + '</div><b>No shops match</b>' +
        '<p>' + (C.outstandingOnly ? 'Nobody in this selection owes anything — try “All shops”.'
          : 'Widen the area or salesman filter.') + '</p></div>');
};

/* ══════════════════════════════════════════════════════════════════════════
   PROFIT REPORTS
   ══════════════════════════════════════════════════════════════════════════ */
var PR = ERP.ProfitState = { preset: 'month', from: '', to: '', by: 'product', sort: 'profit',
                             warehouseId: '', supplierId: '', regionId: '', salesmanId: '', category: '' };

function prPeriod() {
  if (PR.preset === 'custom') return [PR.from || null, PR.to || null, 'Custom range'];
  return ERP.Period.resolve(PR.preset);
}

global.PAGES.profit = function () {
  if (!ERP.Can('PROFIT_VIEW')) return locked('Profit and margin');
  var p = prPeriod();
  var rep = Profit.report(p[0], p[1], {
    by: PR.by, sort: PR.sort, warehouseId: PR.warehouseId || null,
    supplierId: PR.supplierId || null, regionId: PR.regionId || null,
    salesmanId: PR.salesmanId || null, category: PR.category || null
  });
  var t = rep.totals;
  var card = function (l, v, d, cls) {
    return '<div class="fcp-card ' + (cls || '') + '"><i>' + l + '</i><b>' + v + '</b>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  };
  var groups = [['product', 'Product'], ['category', 'Category'], ['brand', 'Brand'],
                ['supplier', 'Supplier / mill'], ['region', 'Area'], ['customer', 'Customer'],
                ['salesman', 'Salesman'], ['warehouse', 'Warehouse']];
  var sorts = [['profit', 'Highest profit'], ['lowprofit', 'Lowest profit'], ['margin', 'Highest margin'],
               ['lowmargin', 'Lowest margin'], ['revenue', 'Highest revenue'], ['qty', 'Most bags']];

  return '<div class="fcp-cards">' +
      card('Sales', M.fmt(t.revenue), rep.invoices.length + ' invoices') +
      card('Cost of goods sold', M.fmt(t.cost), 'At the cost recorded on the day') +
      card('Gross profit', M.fmt(t.profit), 'Margin ' + pct(t.margin) + ' · markup ' + pct(t.markup),
        t.profit >= 0 ? 'profit' : 'loss') +
      card('Purchases', M.fmt(t.purchases), 'Received in the period') +
      card('After returns', M.fmt(t.netProfit), 'Returns took back ' + M.fmt(t.returnedRevenue)) +
      card('After expenses', M.fmt(t.netAfterExpenses),
        'Expenses ' + M.fmt(t.expenses) + (t.salaries ? ' · salaries ' + M.fmt(t.salaries) : '') + ' — this is net, not gross',
        t.netAfterExpenses >= 0 ? 'profit' : 'loss') +
    '</div>' +
    '<div class="bar">' +
      '<label class="fld">' + I('cal') + '<select data-prfil="preset">' +
        ERP.Period.presets.map(function (x) {
          return '<option value="' + x[0] + '"' + (PR.preset === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
        }).join('') + '<option value="custom"' + (PR.preset === 'custom' ? ' selected' : '') + '>Custom range</option>' +
      '</select></label>' +
      (PR.preset === 'custom'
        ? '<label class="fld"><input type="date" data-prfil="from" value="' + esc(PR.from) + '"></label>' +
          '<label class="fld"><input type="date" data-prfil="to" value="' + esc(PR.to) + '"></label>' : '') +
      '<label class="fld">' + I('layers') + '<select data-prfil="by">' + groups.map(function (g) {
        return '<option value="' + g[0] + '"' + (PR.by === g[0] ? ' selected' : '') + '>By ' + g[1] + '</option>';
      }).join('') + '</select></label>' +
      '<label class="fld">' + I('swap') + '<select data-prfil="sort">' + sorts.map(function (s) {
        return '<option value="' + s[0] + '"' + (PR.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select></label>' +
      '<label class="fld">' + I('box') + '<select data-prfil="warehouseId"><option value="">All warehouses</option>' +
        (global.activeWh ? global.activeWh() : []).map(function (w) {
          return '<option value="' + w.id + '"' + (PR.warehouseId === w.id ? ' selected' : '') + '>' +
            esc(w.name) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('pin') + '<select data-prfil="regionId"><option value="">All areas</option>' +
        Areas.active().map(function (r) {
          return '<option value="' + r.id + '"' + (PR.regionId === r.id ? ' selected' : '') + '>' + esc(r.en) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="fld">' + I('truck') + '<select data-prfil="supplierId"><option value="">All mills</option>' +
        (global.SUPPLIERS || []).map(function (s) {
          return '<option value="' + s.id + '"' + (PR.supplierId === s.id ? ' selected' : '') + '>' + esc(s.co) + '</option>';
        }).join('') + '</select></label>' +
      '<div class="grow"></div>' +
      (ERP.Can('FINANCIAL_REPORT_VIEW')
        ? '<button class="btn" data-prexport="excel">' + I('sheet') + 'Excel</button>' +
          '<button class="btn" data-prexport="print">' + I('print') + 'Print</button>' : '') +
    '</div>' +
    (rep.rows.length
      ? '<div class="card"><div class="card-h"><h3>' +
          (groups.filter(function (g) { return g[0] === PR.by; })[0] || ['', ''])[1] +
          '</h3><span class="pill neu">' + (p[2] || '') + '</span></div>' +
        '<div class="card-b" style="padding:0"><div class="tw"><table class="fcb-list"><thead><tr>' +
          '<th>' + (groups.filter(function (g) { return g[0] === PR.by; })[0] || ['', ''])[1] + '</th>' +
          '<th class="r">Bags sold</th><th class="r">Sales</th><th class="r">Cost</th>' +
          '<th class="r">Gross profit</th><th class="r">Margin</th><th class="r">Markup</th>' +
        '</tr></thead><tbody>' +
        rep.rows.map(function (r) {
          var bad = r.profit < 0, low = !bad && r.margin < Number(ERP.Settings.get().lowMarginWarnPct || 5);
          return '<tr><td data-label="Group"><b>' + (PR.by === 'product' ? u(r.sub || '') + ' ' : '') +
              esc(r.label) + '</b>' + (r.invoiceCount ? '<div class="sub">' + r.invoiceCount + ' invoices</div>' : '') + '</td>' +
            '<td data-label="Bags" class="r num">' + Number(r.qty).toLocaleString('en-US') + '</td>' +
            '<td data-label="Sales" class="r num">' + M.fmtPlain(r.revenue) + '</td>' +
            '<td data-label="Cost" class="r num">' + M.fmtPlain(r.cost) + '</td>' +
            '<td data-label="Profit" class="r num" style="color:' + (bad ? 'var(--clay)' : 'var(--green)') +
              ';font-weight:700">' + M.fmtPlain(r.profit) + '</td>' +
            '<td data-label="Margin" class="r num" style="color:' +
              (bad ? 'var(--clay)' : low ? 'var(--ochre)' : 'inherit') + '">' + pct(r.margin) + '</td>' +
            '<td data-label="Markup" class="r num">' + pct(r.markup) + '</td></tr>';
        }).join('') + '</tbody><tfoot><tr><td><b>Totals</b></td>' +
          '<td class="r num">' + Number(t.qty).toLocaleString('en-US') + '</td>' +
          '<td class="r num">' + M.fmtPlain(t.revenue) + '</td>' +
          '<td class="r num">' + M.fmtPlain(t.cost) + '</td>' +
          '<td class="r num">' + M.fmtPlain(t.profit) + '</td>' +
          '<td class="r num">' + pct(t.margin) + '</td>' +
          '<td class="r num">' + pct(t.markup) + '</td></tr></tfoot></table></div></div></div>'
      : '<div class="empty"><div class="ei">' + I('chart') + '</div><b>No profit data for this range</b>' +
        '<p>There were no sales in this period, or the filters exclude them all.</p>' +
        '<button class="btn" data-prfil-reset="1">Widen to all time</button></div>');
};

if (global.PAGEMETA) {
  global.PAGEMETA.collection = ['Collection list',
    'Who owes what, by area and salesman — and the sheet to carry round the bazaar.'];
  global.PAGEMETA.profit = ['Profit & margin',
    'What the bags cost against what they sold for, once discounts and returns are taken off.'];
}
if (global.NAV && !global.NAV.some(function (n) { return n.id === 'collection'; })) {
  global.NAV.push({ id: 'collection', l: 'Collection list', i: 'wallet', g: 'Business' });
  global.NAV.push({ id: 'profit', l: 'Profit & margin', i: 'chart', g: 'Business' });
}

/* ══════════════════════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════════════════════ */
D.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var t;
  if ((t = e.target.closest('[data-collect]'))) {
    e.preventDefault();
    C.regionId = t.dataset.collect; C.salesmanId = 'all';
    global.go('collection');
    return;
  }
  if ((t = e.target.closest('[data-collectsm]'))) {
    e.preventDefault();
    C.salesmanId = t.dataset.collectsm; C.regionId = 'all';
    global.go('collection');
    return;
  }
  if (e.target.closest('[data-csshowall]')) { e.preventDefault(); C.outstandingOnly = false; global.paint(); return; }
  if (e.target.closest('[data-csprintopen]')) { e.preventDefault(); Collection.print(); return; }
  if ((t = e.target.closest('[data-csprint]'))) {
    e.preventDefault();
    D.body.classList.add('fc-printing');
    setTimeout(function () { global.print(); D.body.classList.remove('fc-printing'); }, 80);
    if (t.dataset.csprint === 'pdf') say('Choose "Save as PDF" in the print dialog. Landscape suits this sheet.');
    return;
  }
  if (e.target.closest('[data-csexcel]')) {
    e.preventDefault();
    say('Excel file downloaded — ' + Collection.excel());
    return;
  }
  if (e.target.closest('[data-prfil-reset]')) { e.preventDefault(); PR.preset = 'all'; global.paint(); return; }
  if ((t = e.target.closest('[data-prexport]'))) {
    e.preventDefault();
    var p = prPeriod();
    var rep = Profit.report(p[0], p[1], { by: PR.by, sort: PR.sort });
    if (t.dataset.prexport === 'excel') {
      var b = ERP.Settings.get();
      var rows = [[{ v: b.businessName, style: 3 }], ['Profit & margin report'],
        ['Grouped by', PR.by], ['Period', p[2] || ''],
        ['Generated', fmtDate(today()) + ' ' + new Date().toTimeString().slice(0, 5)],
        ['Generated by', global.CURRENT_USER || 'Owner'], [],
        ['Group', 'Bags sold', 'Sales', 'Cost', 'Gross profit', 'Margin %', 'Markup %']]
        .concat(rep.rows.map(function (r) {
          return [r.label, r.qty, M.toR(r.revenue), M.toR(r.cost), M.toR(r.profit),
                  Math.round(r.margin * 10) / 10, Math.round(r.markup * 10) / 10];
        }))
        .concat([[], ['Totals', rep.totals.qty, M.toR(rep.totals.revenue), M.toR(rep.totals.cost),
                      M.toR(rep.totals.profit), Math.round(rep.totals.margin * 10) / 10,
                      Math.round(rep.totals.markup * 10) / 10],
                 ['Returns', rep.totals.returnedQty, M.toR(rep.totals.returnedRevenue), M.toR(rep.totals.returnedCost)],
                 ['Expenses', '', M.toR(rep.totals.expenses)],
                 ['Salaries (Payroll)', '', M.toR(rep.totals.salaries || 0)],
                 ['Net after expenses', '', M.toR(rep.totals.netAfterExpenses)]]);
      var bytes = ERP.XLSX.build([{ name: 'Profit', rows: rows }],
        { title: 'Profit report', author: b.businessName });
      var name = 'profit-' + PR.by + '-' + today() + '.xlsx';
      var blob = new global.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var a = D.createElement('a');
      a.href = global.URL.createObjectURL(blob); a.download = name;
      D.body.appendChild(a); a.click();
      setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
      say('Excel file downloaded — ' + name);
    } else {
      D.body.classList.add('printing');
      setTimeout(function () { global.print(); D.body.classList.remove('printing'); }, 80);
    }
    return;
  }
}, true);

D.addEventListener('change', function (e) {
  var el = e.target;
  if (el.dataset && el.dataset.csfil !== undefined) {
    var k = el.dataset.csfil;
    C[k] = k === 'outstandingOnly' ? el.value === 'yes' : el.value;
    global.paint(); return;
  }
  if (el.dataset && el.dataset.prfil !== undefined) {
    PR[el.dataset.prfil] = el.value; global.paint(); return;
  }
  if (el.dataset && el.dataset.fcrole !== undefined) {
    RBAC.setRole(el.value).then(function () { say('Now viewing as ' + RBAC.label() + '.'); });
  }
});
D.addEventListener('input', function (e) {
  var el = e.target;
  if (!el.dataset) return;
  if (el.dataset.csq !== undefined || el.dataset.csmin !== undefined) {
    if (el.dataset.csq !== undefined) C.q = el.value; else C.minBalance = el.value;
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      if (global.cur !== 'collection') return;
      var which = el.dataset.csq !== undefined ? 'csq' : 'csmin', pos = el.selectionStart;
      global.paint();
      var back = D.querySelector('[data-' + which + ']');
      if (back) { back.focus(); try { back.setSelectionRange(pos, pos); } catch (err) {} }
    }, 200);
  }
});

/* ── the role selector, and hiding what a role may not see ── */
var origSettings = global.PAGES.settings;
global.PAGES.settings = function () {
  var html = origSettings();
  return html + '<div class="card"><div class="card-h"><h3>Role on this device</h3>' +
    '<span class="pill neu">' + esc(RBAC.label()) + '</span></div><div class="card-b">' +
    '<div class="banner warn">' + I('alert') + '<div><p>This hides screens and figures on this device. ' +
      'It is not a login — anyone holding the device can change it back here. Real enforcement needs a server.</p></div></div>' +
    '<label class="f"><span>Viewing as</span><select data-fcrole>' +
      Object.keys(ROLES).map(function (k) {
        return '<option value="' + k + '"' + (RBAC.role() === k ? ' selected' : '') + '>' +
          esc(ROLES[k].label) + '</option>';
      }).join('') + '</select>' +
      '<span class="hint">Warehouse staff see stock but not cost, profit or margin.</span></label>' +
    '</div></div>';
};

var origPaintNav = global.paintNav;
if (origPaintNav) {
  global.paintNav = function () {
    origPaintNav.apply(global, arguments);
    try {
      if (ERP.Can('PROFIT_VIEW')) return;
      ['profit'].forEach(function (id) {
        var el = D.querySelector('[data-go="' + id + '"]');
        if (el && el.style) el.style.display = 'none';
      });
    } catch (e) {}
  };
}

/* dashboard profit cards, for those allowed to see them */
var origDash = global.PAGES.dashboard;
global.PAGES.dashboard = function () {
  var html = origDash ? origDash() : '';
  if (!ERP.Can('PROFIT_VIEW')) return html;
  var mk = function (key, label) {
    var p = ERP.Period.resolve(key);
    var r = Profit.report(p[0], p[1], { by: 'none' });
    /* after returns: a sale whose bags all came back must not still show its profit (2026-09-26, client: 31,500 sold
       and fully returned still read Sales 31,500 / Gross profit 500). The gross figures stay on the Profit screen. */
    var t = r.totals;
    return { label: label, revenue: t.netRevenue, cost: t.netCost,
             profit: t.netProfit, margin: t.netMargin, purchases: t.purchases };
  };
  var spans = [mk('today', 'Today'), mk('week', 'This week'), mk('month', 'This month'), mk('year', 'This year')];
  return '<div class="card"><div class="card-h"><h3>Profit &amp; margin</h3>' +
      '<span class="pill neu">From the cost recorded on each sale</span></div><div class="card-b">' +
      '<div class="tw"><table class="fcb-list"><thead><tr><th>Period</th><th class="r">Sales (after returns)</th>' +
      '<th class="r">Cost of goods</th><th class="r">Gross profit</th><th class="r">Margin</th>' +
      '<th class="r">Purchases</th></tr></thead><tbody>' +
      spans.map(function (s) {
        return '<tr><td data-label="Period"><b>' + s.label + '</b></td>' +
          '<td data-label="Sales" class="r num">' + M.fmtPlain(s.revenue) + '</td>' +
          '<td data-label="Cost" class="r num">' + M.fmtPlain(s.cost) + '</td>' +
          '<td data-label="Profit" class="r num" style="color:' +
            (s.profit >= 0 ? 'var(--green)' : 'var(--clay)') + ';font-weight:700">' +
            M.fmtPlain(s.profit) + '</td>' +
          '<td data-label="Margin" class="r num">' + (s.revenue ? pct(s.margin) : '—') + '</td>' +
          '<td data-label="Purchases" class="r num">' + M.fmtPlain(s.purchases) + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>' + html;
};
})(typeof window !== 'undefined' ? window : globalThis);
