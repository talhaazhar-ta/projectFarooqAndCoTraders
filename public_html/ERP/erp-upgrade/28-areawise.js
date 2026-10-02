/* ══════════════════════════════════════════════════════════════════════════
   AREA-WISE COLLECTION REPORT

   A rebuild of the sheet the business already prints from its old system:
   shops grouped by area, each with total sales, total collection and the
   balance outstanding, with a grand total and a line for the accountant to
   sign.

   The figures are taken from the ledger, not recomputed from invoices, so
   this report can never disagree with a customer's statement.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var ERP = global.ERP; if (!ERP) return;
  var M = global.Money, S = ERP.S, D = global.document;
  if (!M || !S || !ERP.Ledger) return;

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
     THE DATA
     ════════════════════════════════════════════════════════════════════════ */
  var Area = ERP.AreaReport = {
    /* One row per shop. Sales and collection are the movements inside the
       period; opening is the balance the shop carried into it. Balance is the
       ledger's own closing figure, so it reconciles with the statement. */
    build: function (from, to, opts) {
      opts = opts || {};
      var groups = {};
      var hidden = 0;
      (global.CUSTOMERS || []).forEach(function (c) {
        if (opts.regionId && (c.region || '') !== opts.regionId) return;
        var L = ERP.Ledger.customer(c.id, from || null, to || null);
        var sales = L.debit, collection = L.credit;
        /* a shop with no movement and nothing owing is noise on a collection
           sheet, so it is left off unless asked for (the screen says how many) */
        if (!opts.includeIdle && !sales && !collection && !L.closing) { hidden++; return; }

        var region = (global.regionOf && c.region) ? global.regionOf(c.region) : null;
        var key = region ? region.id : (c.region || 'unassigned');
        if (!groups[key]) {
          groups[key] = {
            id: key,
            en: region ? region.en : 'Unassigned',
            ur: region ? region.ur : '',
            rows: [], opening: 0, sales: 0, collection: 0, balance: 0
          };
        }
        var g = groups[key];
        var row = {
          customerId: c.id,
          code: c.legacyCode || c.code || '',
          name: c.shEn || c.en || c.sh || c.name || '',
          nameUr: c.sh && /[\u0600-\u06FF]/.test(c.sh) ? c.sh : (c.ur || ''),
          contact: c.ph || c.wa || '',
          opening: L.opening, sales: sales, collection: collection, balance: L.closing
        };
        g.rows.push(row);
        g.opening += row.opening; g.sales += sales;
        g.collection += collection; g.balance += row.balance;
      });

      var list = Object.keys(groups).map(function (k) { return groups[k]; });
      list.forEach(function (g) {
        g.rows.sort(function (a, b) {
          return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
        });
        /* serial number, restarting in each area (replaces the old account code on this list) */
        g.rows.forEach(function (r, i) { r.sr = i + 1; });
      });
      list.sort(function (a, b) { return a.en < b.en ? -1 : 1; });

      var total = list.reduce(function (a, g) {
        a.opening += g.opening; a.sales += g.sales;
        a.collection += g.collection; a.balance += g.balance;
        a.shops += g.rows.length;
        return a;
      }, { opening: 0, sales: 0, collection: 0, balance: 0, shops: 0 });

      return { groups: list, total: total, hidden: hidden, from: from || null, to: to || null,
               showOpening: !!total.opening };
    },

    /* the same figures as a printable/exportable document, through the
       existing report framework so Print, PDF, Word and Excel come free */
    docModel: function (from, to, opts) {
      var data = Area.build(from, to, opts);
      var showOpening = data.showOpening;
      var cols = [
        { key: 'sr', label: 'Sr. No.', width: 0.09 },
        { key: 'description', label: 'Name', width: showOpening ? 0.24 : 0.28 },
        { key: 'pack', label: 'Contact #', align: 'center', width: 0.15 }
      ];
      if (showOpening) cols.push({ key: 'brand', label: 'Opening', align: 'right', width: 0.13 });
      cols.push(
        { key: 'qty', label: 'Total Sales', align: 'right', width: showOpening ? 0.13 : 0.16 },
        { key: 'rate', label: 'Total Collection', align: 'right', width: showOpening ? 0.13 : 0.16 },
        { key: 'amount', label: 'Balance / \u0628\u0642\u0627\u06cc\u0627', align: 'right', width: 0.15 }
      );

      var rows = [];
      data.groups.forEach(function (g) {
        rows.push({ sr: '', description: (g.ur ? g.ur + ' — ' : '') + g.en,
                    descriptionUr: g.ur, pack: '', brand: '', qty: '', rate: '', amount: '',
                    _group: true });
        g.rows.forEach(function (r) {
          var row = {
            sr: String(r.sr),
            description: r.name + (r.nameUr && r.nameUr !== r.name ? '  ' + r.nameUr : ''),
            descriptionUr: r.nameUr,
            pack: r.contact || '—',
            qty: M.fmtPlain(r.sales), rate: M.fmtPlain(r.collection),
            amount: M.fmtPlain(r.balance)
          };
          if (showOpening) row.brand = M.fmtPlain(r.opening);
          rows.push(row);
        });
        var sub = { sr: '', description: g.en + ' — subtotal', pack: '',
                    qty: M.fmtPlain(g.sales), rate: M.fmtPlain(g.collection),
                    amount: M.fmtPlain(g.balance), _subtotal: true };
        if (showOpening) sub.brand = M.fmtPlain(g.opening);
        rows.push(sub);
      });

      var footer = { description: 'TOTAL VALUE', qty: M.fmtPlain(data.total.sales),
                     rate: M.fmtPlain(data.total.collection),
                     amount: M.fmtPlain(data.total.balance) };
      if (showOpening) footer.brand = M.fmtPlain(data.total.opening);

      return ERP.Analytics.docModel({
        id: 'areawise', title: 'Area-wise collection', from: from, to: to,
        partyLabel: 'REPORT FOR', partyName: ERP.Settings.get().businessName,
        columns: cols, rows: rows, footer: footer,
        meta: [['Areas', String(data.groups.length)], ['Shops', String(data.total.shops)]],
        totals: [
          { label: 'Total sales', value: M.fmt(data.total.sales) },
          { label: 'Total collection', value: M.fmt(data.total.collection) },
          { label: 'Balance outstanding', labelUr: '\u0628\u0642\u0627\u06cc\u0627',
            value: M.fmt(data.total.balance), big: true, rule: true }
        ],
        summary: 'Balances are taken from each shop\u2019s ledger, so every figure here ' +
                 'matches that shop\u2019s own statement.'
      });
    },

    /* the sheet, for Excel */
    sheet: function (from, to, opts) {
      var data = Area.build(from, to, opts);
      var head = ['Sr. No.', 'Name', 'Urdu name', 'Contact #', 'Area',
                  'Opening', 'Total Sales', 'Total Collection', 'Balance'];
      var rows = [];
      data.groups.forEach(function (g) {
        g.rows.forEach(function (r) {
          rows.push([r.sr, r.name, r.nameUr, r.contact, g.en,
                     M.toR(r.opening), M.toR(r.sales), M.toR(r.collection), M.toR(r.balance)]);
        });
      });
      rows.push([]);
      rows.push(['', 'TOTAL VALUE', '', '', '',
                 M.toR(data.total.opening), M.toR(data.total.sales),
                 M.toR(data.total.collection), M.toR(data.total.balance)]);
      var title = ['Area-wise collection'];
      var period = ['Period', (from ? fmtDate(from) : 'Beginning') + ' to ' + (to ? fmtDate(to) : 'Today')];
      return { name: 'Area-wise collection',
               rows: [title, period, []].concat([head]).concat(rows) };
    }
  };

  /* ════════════════════════════════════════════════════════════════════════
     THE SCREEN
     ════════════════════════════════════════════════════════════════════════ */
  var AW = { from: '', to: '', regionId: '', includeIdle: false };
  /* an area deleted elsewhere must not stay selected here (the list would silently show nothing) */
  if (ERP.Areas && ERP.Areas.onDelete) ERP.Areas.onDelete(function (id) { if (AW.regionId === id) AW.regionId = ''; });

  function regionOptions() {
    return '<option value="">All areas</option>' +
      (global.REGIONS || []).filter(function (r) { return r.active !== false; })
        .map(function (r) {
          return '<option value="' + esc(r.id) + '"' + (AW.regionId === r.id ? ' selected' : '') +
            '>' + esc(r.en) + ' — ' + esc(r.ur) + '</option>';
        }).join('');
  }

  function table(data) {
    if (!data.groups.length) {
      return data.hidden > 0 ? '' : '<p class="hint">No shops with activity or a balance in this period.</p>';
    }
    var showOpening = data.showOpening;
    var head = '<tr><th>Sr. No.</th><th>Name</th><th>Contact #</th>' +
      (showOpening ? '<th class="r">Opening</th>' : '') +
      '<th class="r">Total Sales</th><th class="r">Total Collection</th>' +
      '<th class="r">Balance / بقایا</th></tr>';
    var span = showOpening ? 7 : 6;
    var body = data.groups.map(function (g) {
      return '<tr class="aw-group"><td colspan="' + span + '"><b>' + esc(g.en) + '</b>' +
          (g.ur ? ' <span class="aw-ur">' + esc(g.ur) + '</span>' : '') +
          ' <span class="hint">' + g.rows.length + ' shops</span></td></tr>' +
        g.rows.map(function (r) {
          return '<tr>' +
            '<td data-label="Sr. No." class="mono">' + r.sr + '</td>' +
            '<td data-label="Name">' + esc(r.name) +
              (r.nameUr && r.nameUr !== r.name
                ? '<span class="aw-ur"> ' + esc(r.nameUr) + '</span>' : '') + '</td>' +
            '<td data-label="Contact" class="mono">' + esc(r.contact || '—') + '</td>' +
            (showOpening ? '<td data-label="Opening" class="r">' + M.fmtPlain(r.opening) + '</td>' : '') +
            '<td data-label="Total Sales" class="r">' + M.fmtPlain(r.sales) + '</td>' +
            '<td data-label="Total Collection" class="r">' + M.fmtPlain(r.collection) + '</td>' +
            '<td data-label="Balance" class="r"><b>' + M.fmtPlain(r.balance) + '</b></td>' +
          '</tr>';
        }).join('') +
        '<tr class="aw-sub"><td colspan="' + (showOpening ? 4 : 3) + '">' +
          esc(g.en) + ' subtotal</td>' +
          '<td class="r">' + M.fmtPlain(g.sales) + '</td>' +
          '<td class="r">' + M.fmtPlain(g.collection) + '</td>' +
          '<td class="r"><b>' + M.fmtPlain(g.balance) + '</b></td></tr>';
    }).join('');
    var foot = '<tr><td colspan="' + (showOpening ? 4 : 3) + '"><b>TOTAL VALUE</b></td>' +
      '<td class="r"><b>' + M.fmtPlain(data.total.sales) + '</b></td>' +
      '<td class="r"><b>' + M.fmtPlain(data.total.collection) + '</b></td>' +
      '<td class="r"><b>' + M.fmtPlain(data.total.balance) + '</b></td></tr>';
    return '<div class="aw-wrap"><table class="tbl aw-tbl"><thead>' + head + '</thead>' +
      '<tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  global.PAGES.areawise = function () {
    if (!can('COLLECTION_VIEW') && !can('FINANCIAL_REPORT_VIEW')) {
      return '<div class="empty"><div class="ei">' + I('lock') + '</div>' +
        '<b>Collection figures are not open to you</b><p>Ask the owner.</p></div>';
    }
    var data = Area.build(AW.from, AW.to, AW);
    return '<div class="card"><div class="card-h"><h3>Area-wise collection</h3>' +
        '<span class="pill neu">' + data.total.shops + ' shops · ' +
        data.groups.length + ' areas</span></div><div class="card-b">' +
      '<div class="bar aw-bar">' +
        '<label class="f"><span>From</span><input type="date" data-awf="from" value="' + esc(AW.from) + '"></label>' +
        '<label class="f"><span>To</span><input type="date" data-awf="to" value="' + esc(AW.to) + '"></label>' +
        '<label class="f"><span>Area</span><select data-awf="regionId">' + regionOptions() + '</select></label>' +
        '<label class="f aw-chk"><span>&nbsp;</span><span class="aw-inline">' +
          '<input type="checkbox" data-awidle' + (AW.includeIdle ? ' checked' : '') + '> ' +
          'Include shops with no activity</span></label>' +
        '<div class="grow"></div>' +
        '<button class="btn" data-awprint>' + I('print') + 'Print</button>' +
        '<button class="btn" data-awpdf>' + I('doc') + 'PDF</button>' +
        '<button class="btn pri" data-awexcel>' + I('sheet') + 'Excel</button>' +
      '</div>' +
      (data.hidden > 0
        ? '<p class="hint" style="margin:10px 0 0">' + data.hidden + ' shop' + (data.hidden === 1 ? '' : 's') +
          ' with no sales or payments in this period ' + (data.hidden === 1 ? 'is' : 'are') + ' not shown. ' +
          '<button class="btn sm" data-awshowidle>Show all shops</button></p>' : '') +
      table(data) +
      '<div class="aw-sign">Accountant Sign: <span></span></div>' +
    '</div></div>';
  };

  /* ════════════════════════════════════════════════════════════════════════
     NAV
     ════════════════════════════════════════════════════════════════════════ */
  try {
    var NAV = global.NAV, GROUPS = global.NAVGROUPS;
    if (!NAV.some(function (n) { return n.id === 'areawise'; })) {
      var at = NAV.map(function (n) { return n.id; }).indexOf('reports');
      NAV.splice(at < 0 ? NAV.length : at + 1, 0,
        { id: 'areawise', l: 'Area-wise collection', i: 'chart' });
    }
    GROUPS.forEach(function (g) {
      if (g[0] === 'Finance' && g[1].indexOf('areawise') === -1) {
        g[1].splice(g[1].indexOf('reports') + 1, 0, 'areawise');
      }
    });
    if (global.PAGEMETA) {
      global.PAGEMETA.areawise = ['Area-wise collection',
        'Sales, collection and balance for every shop, grouped by area.'];
    }
  } catch (e) {}

  /* ════════════════════════════════════════════════════════════════════════
     HANDLERS
     ════════════════════════════════════════════════════════════════════════ */
  D.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset) return;
    if (el.dataset.awf !== undefined) { AW[el.dataset.awf] = el.value; global.paint(); return; }
    if (el.dataset.awidle !== undefined) { AW.includeIdle = el.checked; global.paint(); return; }
  });

  D.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-awshowidle]')) { e.preventDefault(); AW.includeIdle = true; global.paint(); return; }
    if (e.target.closest('[data-awprint]') || e.target.closest('[data-awpdf]')) {
      e.preventDefault();
      var pdf = !!e.target.closest('[data-awpdf]');
      var m = Area.docModel(AW.from, AW.to, AW);
      ERP.Viewer.open(m);
      ERP.Audit.detached({ action: 'Area-wise collection ' + (pdf ? 'opened as PDF' : 'printed'),
                           entity: 'Report', entityId: 'areawise' });
      return;
    }
    if (e.target.closest('[data-awexcel]')) {
      e.preventDefault();
      var sh = Area.sheet(AW.from, AW.to, AW);
      var name = 'Areawise-collection-' + (AW.to || today()) + '.xlsx';
      try {
        var bytes = ERP.XLSX.build([{ name: sh.name, rows: sh.rows }],
          { title: 'Area-wise collection', author: ERP.Settings.get().businessName });
        var blob = new global.Blob([bytes],
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var a = D.createElement('a');
        a.href = global.URL.createObjectURL(blob); a.download = name;
        D.body.appendChild(a); a.click();
        setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
        ERP.Audit.detached({ action: 'Area-wise collection exported to Excel',
                             entity: 'Report', entityId: 'areawise' });
        say('Excel file downloaded — ' + name);
      } catch (err) { say('Could not build the Excel file.'); }
      return;
    }
  });

  /* ════════════════════════════════════════════════════════════════════════
     STYLES
     ════════════════════════════════════════════════════════════════════════ */
  var CSS =
    '.aw-wrap{overflow-x:auto}' +
    '.aw-tbl th,.aw-tbl td{white-space:nowrap}' +
    '.aw-tbl td[data-label="Name"]{white-space:normal;min-width:180px}' +
    '.aw-group td{background:var(--surface-2,#f4f4f2);padding-top:11px;padding-bottom:11px}' +
    '.aw-sub td{border-top:1px solid var(--line);font-size:12.5px;opacity:.85}' +
    '.aw-ur{font-family:"Noto Nastaliq Urdu",serif;direction:rtl;unicode-bidi:isolate;opacity:.85}' +
    '.aw-tbl .r{font-variant-numeric:tabular-nums}' +
    '.aw-bar{flex-wrap:wrap;gap:10px;align-items:flex-end}' +
    '.aw-inline{display:flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap}' +
    '.aw-sign{margin-top:22px;font-size:13px;display:flex;align-items:flex-end;gap:10px}' +
    '.aw-sign span{flex:0 0 220px;border-bottom:1px solid var(--ink,#111)}' +
    '@media(max-width:760px){.aw-tbl th{display:none}' +
    '.aw-tbl td{display:flex;justify-content:space-between;gap:12px;white-space:normal}' +
    '.aw-tbl td:before{content:attr(data-label);opacity:.6;font-size:11px}' +
    '.aw-group td,.aw-sub td{display:table-cell}}';
  try {
    var st = D.createElement('style');
    st.setAttribute('data-fc', 'areawise');
    st.textContent = CSS;
    D.head.appendChild(st);
  } catch (e) {}

  ERP.AreaWiseUI = { version: '2026-09-15' };

})(typeof window !== 'undefined' ? window : globalThis);
