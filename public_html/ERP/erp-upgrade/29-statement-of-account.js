/* ══════════════════════════════════════════════════════════════════════════
   STATEMENT OF ACCOUNT — ONE SCREEN, EITHER PARTY

   Client request (2026-09-16): a place under Finance to check the complete
   khata of a Customer OR a Supplier — every purchase/sale, payment and the
   outstanding balance, with dates — without having to first open that
   shop's or mill's own profile page to find the "Statement" button.

   This adds no new ledger math. It is a filter bar (party type, area, party,
   date range) in front of the same ERP.Ledger.customer()/.supplier() figures
   and the same ERP.DocModel.statement() used by the existing per-shop and
   per-supplier "Statement" buttons, so this can never disagree with them.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var ERP = global.ERP; if (!ERP) return;
  var M = global.Money, D = global.document;
  if (!M || !ERP.Ledger || !ERP.DocModel || !global.PAGES) return;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function I(n) { return global.I ? global.I(n) : ''; }
  function say(m) { try { global.say(m); } catch (e) {} }
  function fmtDate(d) { return global.fmtDate ? global.fmtDate(d) : d; }

  /* ════════════════════════════════════════════════════════════════════════
     STATE
     ════════════════════════════════════════════════════════════════════════ */
  var SOA = { type: 'CUSTOMER', regionId: '', partyId: '', from: '', to: '', page: 1, perPage: 50 };
  /* an area deleted elsewhere must not stay selected here (the list would silently show nothing) */
  if (ERP.Areas && ERP.Areas.onDelete) ERP.Areas.onDelete(function (id) { if (SOA.regionId === id) { SOA.regionId = ''; SOA.partyId = ''; SOA.page = 1; } });

  function customersInArea() {
    return (global.CUSTOMERS || []).filter(function (c) {
      return !SOA.regionId || (c.region || '') === SOA.regionId;
    });
  }
  function partyList() {
    if (SOA.type === 'SUPPLIER') {
      /* a switched-off supplier (or mill) that still has a balance must stay reachable */
      return (global.SUPPLIERS || []).filter(function (s) {
        return s.active !== false || s.id === SOA.partyId || ERP.Ledger.supplier(s.id, null, null).rows.length > 0;
      }).slice().sort(function (a, b) {
        return (a.co || '').toLowerCase() < (b.co || '').toLowerCase() ? -1 : 1;
      });
    }
    return customersInArea().slice().sort(function (a, b) {
      return (a.sh || '').toLowerCase() < (b.sh || '').toLowerCase() ? -1 : 1;
    });
  }
  function partyName(p) { return SOA.type === 'SUPPLIER' ? (p.co || '') : (p.sh || ''); }
  function partyLabel(p) { return partyName(p) + (SOA.type === 'SUPPLIER' && p.active === false ? ' (inactive)' : ''); }
  function ledgerFor(id) {
    return SOA.type === 'SUPPLIER'
      ? ERP.Ledger.supplier(id, SOA.from || null, SOA.to || null)
      : ERP.Ledger.customer(id, SOA.from || null, SOA.to || null);
  }
  function partyById(id) {
    return SOA.type === 'SUPPLIER' ? (global.supOf && global.supOf(id)) : (global.custBy && global.custBy(id));
  }
  function regionOptions() {
    /* keep the currently selected area choosable even if it's since been
       switched off, or the dropdown would silently jump to "All areas"
       while the party list stayed filtered to the (now invisible) area */
    var regions = (global.REGIONS || []).filter(function (r) { return r.active !== false || r.id === SOA.regionId; });
    return '<option value="">All areas</option>' +
      regions.map(function (r) {
        return '<option value="' + esc(r.id) + '"' + (SOA.regionId === r.id ? ' selected' : '') +
          '>' + esc(r.en) + (r.ur ? ' — ' + esc(r.ur) : '') + (r.active === false ? ' (inactive)' : '') + '</option>';
      }).join('');
  }
  function card(cls, l, v, d) {
    return '<div class="kh-card ' + cls + '"><i>' + l + '</i><b>' + v + '</b>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  }
  /* A zero-length party list (e.g. an area with no shops) must still leave
     the filter bar on screen — an empty state with no way to change the
     Area or Party type is a dead end the person can only escape by leaving
     the page and losing the screen's remembered state anyway. */
  function partyOptionsHtml(list) {
    if (!list.length) {
      return '<option value="" disabled selected>No ' +
        (SOA.type === 'SUPPLIER' ? 'suppliers on file' : (SOA.regionId ? 'shops in this area' : 'shops on file')) +
        '</option>';
    }
    return (SOA.partyId ? '' : '<option value="" disabled selected>— Choose ' + (SOA.type === 'SUPPLIER' ? 'a supplier' : 'a shop') + ' —</option>') +
      list.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === SOA.partyId ? ' selected' : '') + '>' +
          esc(partyLabel(p)) + '</option>';
      }).join('');
  }

  /* ════════════════════════════════════════════════════════════════════════
     THE SCREEN
     ════════════════════════════════════════════════════════════════════════ */
  global.PAGES.soa = function () {
    var isCust = SOA.type !== 'SUPPLIER';
    var T = isCust ? 'CUSTOMER' : 'SUPPLIER';
    var list = partyList();

    /* the screen never picks a party for the reader: a statement of the wrong
       shop looks exactly like a right one. A choice that no longer exists is dropped. */
    if (SOA.partyId && !list.some(function (p) { return p.id === SOA.partyId; })) SOA.partyId = '';
    var party = list.length && SOA.partyId ? list.filter(function (p) { return p.id === SOA.partyId; })[0] : null;

    var filterBar = '<div class="bar">' +
        '<label class="f"><span>Party type</span><select data-soaf="type">' +
          '<option value="CUSTOMER"' + (isCust ? ' selected' : '') + '>Customer</option>' +
          '<option value="SUPPLIER"' + (!isCust ? ' selected' : '') + '>Supplier</option>' +
        '</select></label>' +
        (isCust ? '<label class="f"><span>Area</span><select data-soaf="regionId">' + regionOptions() +
          '</select></label>' : '') +
        '<label class="f"><span>' + (isCust ? 'Shop' : 'Supplier') + '</span><select data-soaf="partyId"' +
          (list.length ? '' : ' disabled') + '>' + partyOptionsHtml(list) + '</select></label>' +
        '<label class="f"><span>From</span><input type="date" data-soaf="from" value="' + esc(SOA.from) + '"></label>' +
        '<label class="f"><span>To</span><input type="date" data-soaf="to" value="' + esc(SOA.to) + '"></label>' +
        (SOA.from || SOA.to ? '<button class="btn sm" data-soaclear title="Show all dates">All dates</button>' : '') +
        '<div class="grow"></div>' +
        (party ? (isCust
          ? '<button class="btn" data-soapay>' + I('wallet') + 'Receive payment</button>' +
            '<button class="btn" data-soarefund>' + I('wallet') + 'Pay this shop</button>'
          : '<button class="btn" data-soapaysup>' + I('wallet') + 'Pay this supplier</button>') : '') +
        '<button class="btn" data-soaprint' + (party ? '' : ' disabled') + '>' + I('print') + 'Print / PDF</button>' +
        '<button class="btn pri" data-soaexcel' + (party ? '' : ' disabled') + '>' + I('sheet') + 'Excel</button>' +
      '</div>';
    var head = '<div class="card"><div class="card-h"><h3>Statement of Account</h3>' +
      '<span class="pill neu">' + (isCust ? 'Customer' : 'Supplier') + ' ledger</span></div><div class="card-b">';

    if (!list.length) {
      return head + filterBar +
        '<div class="banner warn" style="margin-top:12px">' + I('alert') +
          '<div><b>No ' + (isCust ? 'shops' : 'suppliers') + ' on file' +
            (isCust && SOA.regionId ? ' in this area' : '') + '</b>' +
          '<p>' + (isCust ? 'Pick a different area, or add a shop.' : 'Add a supplier first.') + '</p></div></div>' +
      '</div></div>';
    }

    /* Ledger._roll() treats an inverted range as "drop everything after To, fold
       everything before From into opening" — a silently wrong balance. Refuse it here. */
    if (SOA.from && SOA.to && SOA.from > SOA.to) {
      return head + filterBar +
        '<div class="banner warn" style="margin-top:12px">' + I('alert') +
          '<div><b>The "From" date is after the "To" date</b>' +
          '<p>Pick a From date on or before the To date.</p></div></div>' +
      '</div></div>';
    }

    if (!party) {
      return head + filterBar +
        '<div class="empty" style="margin-top:12px"><div class="ei">' + I('doc') + '</div>' +
          '<b>Choose ' + (isCust ? 'a shop' : 'a supplier') + ' to see the statement</b>' +
          '<p>Pick ' + (isCust ? 'a shop' : 'a supplier') + ' above. Dates are optional — leave them empty for the whole account.</p></div>' +
      '</div></div>';
    }

    var st = ERP.Statement.build(T, SOA.partyId, { from: SOA.from || null, to: SOA.to || null });
    var b = st.breakdown, stand = ERP.Statement.standing(T, st.closing);

    /* oldest first, as a ledger reads; the screen pages 50 at a time */
    var all = st.entries.slice();
    var pages = Math.max(1, Math.ceil(all.length / SOA.perPage));
    if (SOA.page > pages) SOA.page = pages;
    if (SOA.page < 1) SOA.page = 1;
    var slice = all.slice((SOA.page - 1) * SOA.perPage, SOA.page * SOA.perPage);
    if (st.bf && SOA.page === 1) slice.unshift(st.bf);

    return head + filterBar +

      '<div class="kh-cards">' +
        card('', 'Opening balance', M.fmt(st.opening), st.label) +
        card('sale', isCust ? 'Total invoiced' : 'Total purchased', M.fmt(b.inflow)) +
        card('credit', isCust ? 'Total received' : 'Total paid', M.fmt(b.outflow)) +
        card('credit', isCust ? 'Returns and credits' : 'Returns to supplier', M.fmt(b.credits)) +
        card(stand.tone, 'Closing balance', M.fmt(st.closing), stand.text) +
      '</div>' +
      '<div class="kh-eq">' + ERP.Statement.equationHtml(st) + '</div>' +

      '<p class="hint" style="margin:10px 0 0">' + esc(partyName(party)) +
        (isCust && party.ow ? ' · ' + esc(party.ow) : (!isCust && party.cp ? ' · ' + esc(party.cp) : '')) +
        (function () {
          var region = isCust && party.region && global.regionOf ? global.regionOf(party.region) : null;
          return region ? ' · ' + esc(region.en) : '';
        })() +
        (st.current !== st.closing ? ' · Balance today ' + M.fmt(st.current) : '') +
        '</p>' +

      (all.length
        ? '<div style="margin-top:12px">' + ERP.Statement.tableHtml(T, slice, {
            label: 'Totals for this period', debit: st.debit, credit: st.credit,
            balance: ERP.Statement.balHtml(T, st.closing), balanceLabel: 'Closing'
          }, false) + '</div>' + ERP.Statement.pagerHtml('data-soapage', SOA.page, pages, all.length)
        : '<p class="hint" style="margin-top:12px">No transactions in this period.</p>') +
    '</div></div>';
  };

  /* ════════════════════════════════════════════════════════════════════════
     NAV — one entry under the existing Finance group, right after Payments
     ════════════════════════════════════════════════════════════════════════ */
  try {
    var NAV = global.NAV, GROUPS = global.NAVGROUPS;
    if (!NAV.some(function (n) { return n.id === 'soa'; })) {
      var at = NAV.map(function (n) { return n.id; }).indexOf('payments');
      NAV.splice(at < 0 ? NAV.length : at + 1, 0, { id: 'soa', l: 'Statement of Account', i: 'doc' });
    }
    GROUPS.forEach(function (g) {
      if (g[0] === 'Finance' && g[1].indexOf('soa') === -1) {
        var pos = g[1].indexOf('payments');
        g[1].splice(pos < 0 ? g[1].length : pos + 1, 0, 'soa');
      }
    });
    if (global.PAGEMETA) {
      global.PAGEMETA.soa = ['Statement of Account',
        'Pick a customer or supplier and see every invoice, payment and the balance, with dates.'];
    }
  } catch (e) {}

  /* ════════════════════════════════════════════════════════════════════════
     HANDLERS
     ════════════════════════════════════════════════════════════════════════ */
  D.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset || el.dataset.soaf === undefined) return;
    var k = el.dataset.soaf, v = el.value;
    if (k === 'type') { SOA.type = v; SOA.regionId = ''; SOA.partyId = ''; }
    else if (k === 'regionId') { SOA.regionId = v; SOA.partyId = ''; }
    else { SOA[k] = v; }
    SOA.page = 1;
    global.paint();
  });

  function invalidRange() { return SOA.from && SOA.to && SOA.from > SOA.to; }

  D.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-soapay]')) {
      e.preventDefault();
      if (!SOA.partyId) return;
      if (ERP.setPayFor) ERP.setPayFor(SOA.partyId);
      global.openPanel('payment');
      return;
    }
    if (e.target.closest('[data-soarefund]')) {
      e.preventDefault();
      if (!SOA.partyId) return;
      if (ERP.setRefundFor) ERP.setRefundFor(SOA.partyId);
      global.openPanel('refund');
      return;
    }
    if (e.target.closest('[data-soapaysup]')) {
      e.preventDefault();
      if (!SOA.partyId) return;
      if (ERP.setPayFor) ERP.setPayFor(SOA.partyId);
      global.openPanel('paysup');
      return;
    }
    if (e.target.closest('[data-soaprint]')) {
      e.preventDefault();
      if (!SOA.partyId) return;
      if (invalidRange()) { say('The "From" date is after the "To" date — fix the range first.'); return; }
      var m = ERP.DocModel.statement(SOA.partyId, SOA.type, SOA.from || null, SOA.to || null);
      ERP.Viewer.open(m);
      ERP.Audit.detached({ action: 'Statement of account opened', entity: 'Report', entityId: 'soa',
        reason: SOA.type + ' ' + SOA.partyId });
      return;
    }
    if (e.target.closest('[data-soaclear]')) {
      e.preventDefault(); SOA.from = ''; SOA.to = ''; SOA.page = 1; global.paint(); return;
    }
    var pg = e.target.closest('[data-soapage]');
    if (pg) {
      e.preventDefault();
      SOA.page += pg.dataset.soapage === 'next' ? 1 : -1;
      if (SOA.page < 1) SOA.page = 1;
      global.paint(); return;
    }
    if (e.target.closest('[data-soaexcel]')) {
      e.preventDefault();
      if (!SOA.partyId) return;
      if (invalidRange()) { say('The "From" date is after the "To" date — fix the range first.'); return; }
      try {
        var name = ERP.Statement.download(SOA.type === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER', SOA.partyId,
          { from: SOA.from || null, to: SOA.to || null });
        ERP.Audit.detached({ action: 'Statement of account exported to Excel', entity: 'Report', entityId: 'soa' });
        say('Excel file downloaded — ' + name);
      } catch (err) { say('Could not build the Excel file.'); }
      return;
    }
  });
})(typeof window !== 'undefined' ? window : this);
