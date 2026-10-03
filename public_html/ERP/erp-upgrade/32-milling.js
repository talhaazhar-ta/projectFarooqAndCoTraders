/* ══════════════════════════════════════════════════════════════════════════
   MILLING JOBS — TOLL MILLING (wheat out, flour + chokar back)

   Client request, analysed 2026-09-16 (clientNewReq/): Farooq & Co hand
   wheat to a flour mill and get flour bags plus chokar (bran) back, with
   some grain lost in grinding, and settle the difference in the mill's
   own account — currently kept on a paper khata page with four columns:
   تعداد (bags), وزن (weight), ریٹ (rate), رقم (amount). This is a second-hand
   reading of that request (the referenced photo of the paper page was not
   available), confirmed against the ERP's own data rather than guessed:
   25 of 32 suppliers are flour mills, there is a "گندم 49 کلو" (wheat)
   product and two "چوکر" (chokar/bran) products, and a supplier record is
   literally named "Zam Zam chokar khata" carrying a running balance.

     - A "Milling job": pick a mill (an existing supplier), list the wheat
       issued and the flour/bran received back, each line in bags AND
       kilograms (weight auto-fills from the product's existing bag-weight
       field and stays editable for the real weighbridge figure).
     - Process loss (issued weight − received weight) is calculated and
       shown, never enforced — no saved yield recipes or conversion ratios.
       Output heavier than input is refused (grinding cannot create mass);
       a loss outside a rough 1–8% band is flagged, never blocked.
     - The money settles into the mill's own existing supplier khata: wheat
       issued reduces what is owed, flour/chokar received plus a milling
       fee increase it — only the net difference moves the balance. A
       "Grinding fee only" setting is also offered for the case where the
       wheat never changes ownership and only a milling charge is owed.

   Deliberately NOT built here (flagged for the client to specify before
   any of this is attempted): saved yield recipes / expected conversion
   ratios, an in-house (no-mill) production mode, editing a posted job
   (only Cancel, which reverses the stock movements — same as every other
   posted document in this app).

   STOCK LYING AT THE MILL (added 2026-09-20, from the client's voice notes
   about Punjab): the mill often finishes the goods and keeps them there —
   e.g. 30,000 bags made, all still in Punjab — and sends them here in loads.
   A job therefore says where the finished goods are (`receiveMode`):
     AT_MILL    — recorded as produced (the mill's account is credited exactly
                  as before) but NOT put into any warehouse yet.
     DELIVERED  — put into our warehouse when the job is saved (how every job
                  worked before this, and what a job saved without the field
                  means, so old records read the same).
   Each load that arrives is an "arrival" (millingArrivals, MAR-…): it adds the
   bags to our warehouse and takes them off what is lying at the mill. The
   balance at the mill = produced − arrived, per mill and product, worked out
   on the fly (nothing about it is stored), and an arrival can never be more
   than that balance. An arrival moves goods, not money: the value was already
   put on the mill's account when the job was posted.

   Its own pair of IndexedDB stores (01-db.js, DB_VER 11) — separate from
   `purchases`/`stockDocs` because this is neither a purchase (the mill
   doesn't sell the wheat back) nor a plain stock adjustment (it settles a
   supplier balance). The financial side reuses the supplier's own khata
   rather than a new ledger store — see the ERP.Ledger.supplier patch
   below, which follows the same pattern 16-khata.js uses for customer
   account adjustments.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var ERP = global.ERP; if (!ERP) return;
  var M = global.Money, FDB = global.FDB, D = global.document, S = ERP.S;
  if (!M || !FDB || !S || !global.PAGES || !ERP.Ledger || !ERP.Inventory || !ERP.Settings) return;
  var Inventory = ERP.Inventory, Audit = ERP.Audit;

  S.millingJobs = S.millingJobs || [];
  S.millingJobItems = S.millingJobItems || [];
  S.millingArrivals = S.millingArrivals || [];

  (function injectCss() {
    var s = D.createElement('style');
    s.id = 'fc-milling-css';
    /* The boxes in the line tables sit in table cells, not inside a `label.f`, so they never got the app's field
       look (38px, 8px corners, themed border, violet focus ring) and showed as plain browser boxes. They get the
       same look here. The long `div.f.fc-mill-lines table.tbl td` prefix is deliberate: the base app also has
       `.f input[inputmode]{width:112px}`, which would otherwise win. The dropdown arrow and its right padding
       come from the UI kit (36) and are left alone. */
    var L = 'div.f.fc-mill-lines table.tbl td ';
    s.textContent =
      'div.f.fc-mill-lines table.tbl{min-width:0;width:100%}' +
      'div.f.fc-mill-lines table.tbl td{padding:7px 8px;vertical-align:middle}' +
      'div.f.fc-mill-lines table.tbl th{white-space:nowrap}' +
      L + 'input,' + L + 'select{width:100%;min-width:0;height:38px;box-sizing:border-box;border:1px solid var(--line);' +
        'border-radius:8px;padding:0 11px;background-color:var(--surface);color:var(--ink);outline:none;font-size:13.5px;font-family:inherit}' +
      L + 'input::placeholder{color:var(--faint)}' +
      L + 'input:hover,' + L + 'select:hover{border-color:#CFD4CB}' +
      L + 'input:focus,' + L + 'select:focus{border-color:var(--violet);box-shadow:0 0 0 4px rgba(124,58,237,.14)}' +
      L + 'input[data-millf="qty"],' + L + 'input[data-millf="weight"],' + L + 'input[data-millf="rate"],' +
        L + 'input[data-msf="qty"],' + L + 'input[data-msf="weight"]{text-align:right;font-variant-numeric:tabular-nums}' +
      'div.f.fc-mill-lines table.tbl td:first-child{min-width:260px}' +
      L + 'select[data-millf="basis"]{min-width:78px}' +
      'div.f.fc-mill-lines table.tbl td.r{white-space:nowrap;font-variant-numeric:tabular-nums}' +
      'table.tbl .sub{font-size:12px;color:var(--muted);margin-top:1px}' +
      'table.tbl td.c,table.tbl th.c{text-align:center}';
    D.head.appendChild(s);
  })();

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* the base app exposes its icon function as window.I (there is no window.icon) — reading the wrong name made every icon here silently blank */
  function I(n) { return global.I ? global.I(n) : ''; }
  function say(m) { try { global.say(m); } catch (e) {} }
  function fmtDate(d) { return global.fmtDate ? global.fmtDate(d) : d; }
  function nowISO() { return new Date().toISOString(); }
  function today() { return global.FC_TODAY ? global.FC_TODAY() : new Date().toISOString().slice(0, 10); }
  function pill(cls, label) { return global.pill ? global.pill(cls, label) : esc(label); }
  function whName(id) { return global.whName ? global.whName(id) : id; }
  function prodOf(id) { return (global.prodOf && global.prodOf(id)) || null; }
  function currentUser() { return global.CURRENT_USER || 'Owner'; }
  function can(p) { return ERP.Can ? ERP.Can(p) : true; }
  function qtyFmt(q) { return Number(q).toLocaleString('en-US'); }
  /* The name people know a product by: Urdu first (the app's own convention, 05-ui-builder), then English. Where the
     English name is only a piece of the Urdu one — this catalogue has "50 kg" inside "سوجر 50 kg" — only the fuller of the
     two is shown, so nothing repeats and nothing is cut short. Falls back to the names saved on a document line, then the id. */
  function nameKey(v) { return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function nameParts(p, snapEn, snapUr) {
    var ur = String((p && p.ur) || snapUr || '').trim(), en = String((p && p.en) || snapEn || '').trim();
    if (!ur && !en) return [];
    if (!ur) return [en];
    if (!en) return [ur];
    var a = nameKey(ur), b = nameKey(en);
    if (a === b || a.indexOf(b) !== -1) return [ur];
    if (b.indexOf(a) !== -1) return [en];
    return [ur, en];
  }
  function fullName(p, snapEn, snapUr) {
    var a = nameParts(p, snapEn, snapUr);
    return a.length ? a.join(' — ') : (p ? String(p.id || '') : '');
  }
  /* ON-SCREEN ONLY: each language part in its own Unicode bidi isolate (FSI…PDI). An Urdu name is right-to-left; dropped as plain
     text into a left-to-right list or dropdown, its digits and the "kg" after it get reordered ("50 سوجر kg"). Isolated, it reads
     as an Urdu reader expects ("سوجر 50 kg"). Error messages and Excel keep the plain text from fullName(). */
  function isoName(p, snapEn, snapUr) {
    var a = nameParts(p, snapEn, snapUr);
    return a.length ? a.map(function (x) { return '\u2068' + x + '\u2069'; }).join(' — ') : (p ? String(p.id || '') : '');
  }
  /* the same, plus the bag weight when the name does not already say it */
  function prodLabel(p) {
    var n = fullName(p), kg = Number(p && p.kg) || 0, tail = '';
    if (kg && !new RegExp('(^|[^0-9.])' + kg + '([^0-9.]|$)').test(n)) tail = ' — ' + kg + ' KG';
    return isoName(p) + tail;
  }
  function activeProducts() {
    var list = ERP.sources ? ERP.sources.PRODS() : (global.PRODUCTS || []);
    return list.filter(function (p) { return p.active !== false; });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SERVICE
     ══════════════════════════════════════════════════════════════════════════ */
  /* a date the person typed must be a real calendar day (the field is a date box, but a pasted or scripted value is not) */
  function validDay(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  /* One small shared row per mill that every arrival — and every cancel of a job whose goods are at the mill — reads and rewrites
     inside its own transaction. Without it, two windows working from old copies both see the same bags "still at the mill" and both
     receive them; into two different warehouses they share no other record, so the server's per-record revision check cannot tell.
     With it the second save is refused ("NOT saved — reload") and the person sees the real balance. Stored in the existing `meta`
     key-value store as {k:'millguard:<mill>', v:<counter>}; harmless in the single-window browser mode. */
  function touchGuard(api, millId) {
    var k = 'millguard:' + millId;
    return api.get('meta', k).then(function (g) { api.put('meta', { k: k, v: ((g && Number(g.v)) || 0) + 1 }); });
  }
  function whExists(id) { return (global.WAREHOUSES || []).some(function (w) { return w.id === id; }); }

  var Milling = ERP.Milling = {
    all: function () {
      return (S.millingJobs || []).slice().sort(function (a, b) {
        if (a.jobDate !== b.jobDate) return a.jobDate < b.jobDate ? 1 : -1;
        return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
      });
    },
    byId: function (id) { return (S.millingJobs || []).filter(function (j) { return j.id === id; })[0] || null; },
    items: function (jobId) {
      return (S.millingJobItems || []).filter(function (i) { return i.jobId === jobId; })
        .sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    },
    /* only posted jobs move the mill's balance — a cancelled job contributes nothing */
    forMill: function (millId) {
      return (S.millingJobs || []).filter(function (j) { return j.millId === millId && j.status !== 'CANCELLED'; });
    },

    /* where a job's finished goods are: 'AT_MILL' or 'DELIVERED' (absent = DELIVERED, the only way jobs worked before) */
    receiveMode: function (job) { return job && job.receiveMode === 'AT_MILL' ? 'AT_MILL' : 'DELIVERED'; },

    arrivals: function () {
      return (S.millingArrivals || []).slice().sort(function (a, b) {
        if (a.arrivalDate !== b.arrivalDate) return a.arrivalDate < b.arrivalDate ? 1 : -1;
        return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
      });
    },
    arrivalById: function (id) { return (S.millingArrivals || []).filter(function (a) { return a.id === id; })[0] || null; },

    /* What is lying at the mills: one row per mill + product that has ever had goods left there, from
       posted AT_MILL jobs (their RECEIVE lines) less posted arrivals. `excludeJobId` answers "what would
       be left if this job did not exist" — used to refuse cancelling a job whose goods already came.
       qty and kg are produced − arrived; valueP is the remaining bags at the average cost per bag the
       job(s) put on them (whole paisa). */
    atMill: function (opt) {
      opt = opt || {};
      var rows = {};
      function row(millId, pid) {
        var k = millId + '|' + pid;
        return rows[k] || (rows[k] = { millId: millId, productId: pid, producedQty: 0, producedKg: 0, producedValueP: 0,
          arrivedQty: 0, arrivedKg: 0 });
      }
      (S.millingJobs || []).forEach(function (j) {
        if (j.status === 'CANCELLED' || Milling.receiveMode(j) !== 'AT_MILL' || j.id === opt.excludeJobId) return;
        if (opt.millId && j.millId !== opt.millId) return;
        Milling.items(j.id).forEach(function (it) {
          if (it.side !== 'RECEIVE') return;
          var r = row(j.millId, it.productId);
          r.producedQty += it.quantity; r.producedKg += it.weightKg; r.producedValueP += it.lineTotal || 0;
        });
      });
      (S.millingArrivals || []).forEach(function (a) {
        if (a.status === 'CANCELLED' || (opt.millId && a.millId !== opt.millId)) return;
        (a.lines || []).forEach(function (l) {
          var r = row(a.millId, l.productId); r.arrivedQty += l.quantity; r.arrivedKg += l.weightKg;
        });
      });
      return Object.keys(rows).map(function (k) {
        var r = rows[k];
        r.producedQty = Math.round(r.producedQty * 1000) / 1000; r.arrivedQty = Math.round(r.arrivedQty * 1000) / 1000;
        r.producedKg = Math.round(r.producedKg * 1000) / 1000; r.arrivedKg = Math.round(r.arrivedKg * 1000) / 1000;
        r.qty = Math.round((r.producedQty - r.arrivedQty) * 1000) / 1000;
        r.kg = Math.round((r.producedKg - r.arrivedKg) * 1000) / 1000;
        r.costPerBagP = r.producedQty > 0 ? Math.round(r.producedValueP / r.producedQty) : 0;
        r.valueP = r.qty > 0 ? Math.round(r.qty * r.costPerBagP) : 0;
        r.productName = fullName(prodOf(r.productId)) || r.productId;
        r.productLabel = isoName(prodOf(r.productId)) || r.productId;   /* for the screen; productName is the plain text */
        return r;
      });
    },
    atMillBalance: function (millId, productId, excludeJobId) {
      return Milling.atMill({ millId: millId, excludeJobId: excludeJobId })
        .filter(function (r) { return r.productId === productId; })[0] ||
        { millId: millId, productId: productId, qty: 0, kg: 0, producedQty: 0, arrivedQty: 0, costPerBagP: 0, valueP: 0 };
    },
    /* the weight story for one mill (or all): wheat given, finished goods made, the loss, what came, what is left */
    atMillTotals: function (millId) {
      var t = { issuedKg: 0, producedKg: 0, producedQty: 0, arrivedKg: 0, arrivedQty: 0, qty: 0, kg: 0, valueP: 0 };
      (S.millingJobs || []).forEach(function (j) {
        if (j.status === 'CANCELLED' || Milling.receiveMode(j) !== 'AT_MILL' || (millId && j.millId !== millId)) return;
        t.issuedKg += j.inWeightKg || 0;
      });
      Milling.atMill({ millId: millId }).forEach(function (r) {
        t.producedKg += r.producedKg; t.producedQty += r.producedQty; t.arrivedKg += r.arrivedKg; t.arrivedQty += r.arrivedQty;
        t.qty += r.qty; t.kg += r.kg; t.valueP += r.valueP;
      });
      ['issuedKg', 'producedKg', 'arrivedKg', 'qty', 'kg'].forEach(function (k) { t[k] = Math.round(t[k] * 1000) / 1000; });
      t.lossKg = Math.round((t.issuedKg - t.producedKg) * 1000) / 1000;
      return t;
    },

    /* live totals for the entry screen — plain rupee arithmetic, nothing
       persisted, so an incomplete draft can still be previewed */
    summary: function (draft) {
      function calcSide(lines) {
        return (lines || []).filter(function (l) { return l && l.productId; }).map(function (l) {
          var qty = Number(l.quantity) || 0, weightKg = Number(l.weightKg) || 0, rate = Number(l.unitRate) || 0;
          var basis = l.rateBasis === 'KG' ? 'KG' : 'BAG';
          var basisQty = basis === 'KG' ? weightKg : qty;
          return { weightKg: weightKg, lineTotal: Math.round(basisQty * rate * 100) / 100 };
        });
      }
      var issue = calcSide(draft.issue), receive = calcSide(draft.receive);
      var inWeightKg = Math.round(issue.reduce(function (a, l) { return a + l.weightKg; }, 0) * 1000) / 1000;
      var outWeightKg = Math.round(receive.reduce(function (a, l) { return a + l.weightKg; }, 0) * 1000) / 1000;
      var lossKg = Math.round((inWeightKg - outWeightKg) * 1000) / 1000;
      var lossPct = inWeightKg > 0 ? Math.round((lossKg / inWeightKg) * 10000) / 100 : 0;
      var issuedValue = Math.round(issue.reduce(function (a, l) { return a + l.lineTotal; }, 0) * 100) / 100;
      var receivedValue = Math.round(receive.reduce(function (a, l) { return a + l.lineTotal; }, 0) * 100) / 100;
      var fee = Number(draft.feeAmount) || 0;
      var settle = draft.settle === 'FEE_ONLY' ? 'FEE_ONLY' : 'NET';
      var net = settle === 'FEE_ONLY' ? fee : (receivedValue + fee - issuedValue);
      return { inWeightKg: inWeightKg, outWeightKg: outWeightKg, lossKg: lossKg, lossPct: lossPct,
        issuedValue: issuedValue, receivedValue: receivedValue, fee: fee, net: net, settle: settle };
    },

    save: function (draft) {
      var mill = draft.millId ? global.supOf(draft.millId) : null;
      var errs = [];
      if (!mill) errs.push('Choose a mill.');
      if (!draft.warehouseId) errs.push('Choose a warehouse.');
      else if (!whExists(draft.warehouseId)) errs.push('That warehouse no longer exists.');
      if (draft.jobDate && !validDay(draft.jobDate)) errs.push('The date is not a real date.');
      var settle = draft.settle === 'FEE_ONLY' ? 'FEE_ONLY' : 'NET';
      var mode = draft.receiveMode === 'AT_MILL' ? 'AT_MILL' : 'DELIVERED';

      var issueRaw = (draft.issue || []).filter(function (l) { return l && l.productId; });
      var receiveRaw = (draft.receive || []).filter(function (l) { return l && l.productId; });
      if (!issueRaw.length) errs.push('Add at least one line to what was issued.');
      if (!receiveRaw.length) errs.push('Add at least one line to what was received back.');

      function checkLine(l, n, side) {
        var p = prodOf(l.productId);
        var label = side + ' line ' + (n + 1) + (p ? ' (' + fullName(p) + ')' : '');
        if (!p) { errs.push(label + ': that product no longer exists.'); return null; }
        var qty = M.qty(l.quantity);
        if (!(qty > 0)) { errs.push(label + ': bag count must be more than zero.'); return null; }
        var weightKg = Number(l.weightKg);
        if (!(weightKg > 0)) { errs.push(label + ': weight must be more than zero.'); return null; }
        var rate = M.toP(l.unitRate || 0);
        if (rate < 0) { errs.push(label + ': the rate cannot be negative.'); return null; }
        var basis = l.rateBasis === 'KG' ? 'KG' : 'BAG';
        var basisQty = basis === 'KG' ? weightKg : qty;
        var lineTotal = settle === 'FEE_ONLY' ? 0 : M.mul(rate, basisQty);
        return { productId: l.productId, product: p, quantity: qty, weightKg: weightKg,
          bagKg: p.kg || 0, rateBasis: basis, unitRate: rate, lineTotal: lineTotal };
      }

      var issueClean = [], receiveClean = [];
      issueRaw.forEach(function (l, n) { var c = checkLine(l, n, 'Issued'); if (c) issueClean.push(c); });
      receiveRaw.forEach(function (l, n) { var c = checkLine(l, n, 'Received'); if (c) receiveClean.push(c); });
      if (errs.length) return Promise.reject({ validation: errs });

      /* stock check on the issue side only — same rule as any other
         outgoing movement in the app */
      if (!ERP.Settings.allowNegativeStock()) {
        var demand = {};
        issueClean.forEach(function (l) { demand[l.productId] = (demand[l.productId] || 0) + l.quantity; });
        Object.keys(demand).forEach(function (pid) {
          var have = Inventory.available(pid, draft.warehouseId);
          if (demand[pid] > have) {
            var p = prodOf(pid) || {};
            errs.push('Only ' + have + ' bags of ' + (fullName(p) || pid) + ' are available in ' +
              whName(draft.warehouseId) + '. Requested: ' + demand[pid] + '.');
          }
        });
      }
      if (errs.length) return Promise.reject({ validation: errs });

      var inWeightKg = Math.round(issueClean.reduce(function (a, l) { return a + l.weightKg; }, 0) * 1000) / 1000;
      var outWeightKg = Math.round(receiveClean.reduce(function (a, l) { return a + l.weightKg; }, 0) * 1000) / 1000;
      var lossKg = Math.round((inWeightKg - outWeightKg) * 1000) / 1000;
      if (lossKg < 0) {
        return Promise.reject({ validation: ['The weight received back (' + outWeightKg +
          ' kg) is more than the weight issued (' + inWeightKg + ' kg). Grinding cannot create extra ' +
          'weight — check the entries.'] });
      }
      var lossPct = inWeightKg > 0 ? Math.round((lossKg / inWeightKg) * 10000) / 100 : 0;

      var issuedValue = M.sum(issueClean.map(function (l) { return l.lineTotal; }));
      var receivedValue = M.sum(receiveClean.map(function (l) { return l.lineTotal; }));
      var feeAmount = M.toP(draft.feeAmount || 0);
      if (feeAmount < 0) return Promise.reject({ validation: ['The milling fee cannot be negative.'] });
      var netAmount = settle === 'FEE_ONLY' ? feeAmount : (receivedValue + feeAmount - issuedValue);

      draft.id = draft.id || FDB.uid('mil');
      var opId = (draft.clientOpId || draft.id) + '#0';

      return FDB.tx(['sequences', 'millingJobs', 'millingJobItems', 'inventory', 'stockMovements',
        'auditLog', 'operations'], function (api) {
        return FDB.claimOperation(api, opId, 'MillingJob', { entityId: draft.id }).then(function () {
          return FDB.nextNumber(api, 'MIL').then(function (number) {
            var rec = {
              id: draft.id, jobNumber: number, clientOpId: draft.clientOpId || draft.id,
              jobDate: draft.jobDate || today(),
              millId: draft.millId, millSnapshot: mill.co,
              warehouseId: draft.warehouseId, warehouseSnapshot: whName(draft.warehouseId),
              settle: settle, receiveMode: mode,
              inWeightKg: inWeightKg, outWeightKg: outWeightKg, lossKg: lossKg, lossPct: lossPct,
              issuedValue: issuedValue, receivedValue: receivedValue,
              feeAmount: feeAmount, feeNote: draft.feeNote || '', netAmount: netAmount,
              notes: draft.notes || '', status: 'POSTED', cancelReason: '',
              createdBy: currentUser(), createdAt: nowISO()
            };
            var sort = 0;
            issueClean.forEach(function (l) {
              var r = {
                id: FDB.uid('mli'), jobId: rec.id, sortOrder: sort++, side: 'ISSUE',
                productId: l.productId, productSnapshot: l.product.en || l.product.ur || '',
                productUrSnapshot: l.product.ur || '', packageSnapshot: l.bagKg ? l.bagKg + ' KG' : 'Bag',
                quantity: l.quantity, bagKg: l.bagKg, weightKg: l.weightKg,
                rateBasis: l.rateBasis, unitRate: l.unitRate, lineTotal: l.lineTotal, unitCostP: 0
              };
              api.put('millingJobItems', r); (S.millingJobItems || (S.millingJobItems = [])).push(r);
              Inventory.apply(api, {
                productId: l.productId, warehouseId: rec.warehouseId, qtyDelta: -l.quantity,
                kind: 'MILL_ISSUE_OUT', ref: number, refType: 'MILLING',
                note: 'Issued for milling — ' + rec.millSnapshot, date: rec.jobDate
              });
            });
            receiveClean.forEach(function (l) {
              var costPerBag = l.quantity > 0 ? Math.round(l.lineTotal / l.quantity) : 0;
              var r = {
                id: FDB.uid('mli'), jobId: rec.id, sortOrder: sort++, side: 'RECEIVE',
                productId: l.productId, productSnapshot: l.product.en || l.product.ur || '',
                productUrSnapshot: l.product.ur || '', packageSnapshot: l.bagKg ? l.bagKg + ' KG' : 'Bag',
                quantity: l.quantity, bagKg: l.bagKg, weightKg: l.weightKg,
                rateBasis: l.rateBasis, unitRate: l.unitRate, lineTotal: l.lineTotal, unitCostP: costPerBag
              };
              /* the product's extra cost per bag of the day, kept so cancelling the job takes exactly that back
                 out of the stock's average (Inventory.rowExtraP) — set BEFORE the put */
              if (mode === 'DELIVERED') r.extraUnitP = Inventory.rawExtraOf(l.productId);
              api.put('millingJobItems', r); (S.millingJobItems || (S.millingJobItems = [])).push(r);
              /* AT_MILL: the goods are still lying at the mill — no warehouse stock until an arrival says so */
              if (mode === 'DELIVERED') Inventory.apply(api, {
                productId: l.productId, warehouseId: rec.warehouseId, qtyDelta: l.quantity, extraCostP: r.extraUnitP,
                kind: 'MILL_RECEIPT_IN', ref: number, refType: 'MILLING',
                note: 'Received from mill — ' + rec.millSnapshot, date: rec.jobDate, unitCostP: costPerBag
              });
            });
            api.put('millingJobs', rec); (S.millingJobs || (S.millingJobs = [])).unshift(rec);
            Audit.write(api, {
              action: 'Milling job posted', entity: 'MillingJob', entityId: rec.id, ref: number,
              newValues: { mill: rec.millSnapshot, goods: mode === 'AT_MILL' ? 'at the mill' : 'delivered', inWeightKg: inWeightKg, outWeightKg: outWeightKg,
                lossKg: lossKg, net: M.toR(netAmount) }
            });
            return rec;
          });
        });
      }).then(function (rec) { if (ERP.Mirror) ERP.Mirror.refresh(); return rec; });
    },

    cancel: function (id, reason) {
      var job = Milling.byId(id);
      if (!job) return Promise.reject(new Error('Milling job not found.'));
      if (job.status === 'CANCELLED') return Promise.resolve(job);
      var atMill = Milling.receiveMode(job) === 'AT_MILL';
      if (atMill) {
        /* goods that already came here cannot be un-made: refuse if removing this job would leave the mill
           owing us negative bags of anything (the arrivals must be cancelled first) */
        var left = Milling.atMill({ millId: job.millId, excludeJobId: job.id }), bad = [];
        left.forEach(function (r) { if (r.qty < 0) bad.push(Math.abs(r.qty) + ' bags of ' + r.productName); });
        if (bad.length) return Promise.reject({ validation: ['This job cannot be cancelled: ' + bad.join(', ') +
          ' from it have already arrived here. Cancel those arrivals first.'] });
      }
      return FDB.tx(['millingJobs', 'inventory', 'stockMovements', 'auditLog', 'meta'], function (api) {
        return (atMill ? touchGuard(api, job.millId) : Promise.resolve()).then(function () {
        Milling.items(id).forEach(function (it) {
          if (it.side === 'RECEIVE' && atMill) return;  /* never entered a warehouse */
          if (it.side === 'ISSUE') {
            Inventory.apply(api, {
              productId: it.productId, warehouseId: job.warehouseId, qtyDelta: it.quantity,
              kind: 'MILL_ISSUE_REVERSAL_IN', ref: job.jobNumber, refType: 'MILLING_CANCEL',
              note: 'Milling job cancelled — ' + (reason || 'no reason given'), date: today()
            });
          } else {
            Inventory.apply(api, {
              productId: it.productId, warehouseId: job.warehouseId, qtyDelta: -it.quantity,
              extraCostP: typeof it.extraUnitP === 'number' ? it.extraUnitP : undefined, carriageCostP: 0,
              kind: 'MILL_RECEIPT_REVERSAL_OUT', ref: job.jobNumber, refType: 'MILLING_CANCEL',
              note: 'Milling job cancelled — ' + (reason || 'no reason given'), date: today()
            });
          }
        });
        var old = { status: job.status };
        job.status = 'CANCELLED'; job.cancelReason = reason || ''; job.cancelledAt = nowISO();
        api.put('millingJobs', job);
        Audit.write(api, {
          action: 'Milling job cancelled', entity: 'MillingJob', entityId: job.id, ref: job.jobNumber,
          oldValues: old, newValues: { status: 'CANCELLED' }, reason: reason || ''
        });
        return job;
        });
      }).then(function (r) { if (ERP.Mirror) ERP.Mirror.refresh(); return r; });
    },

    /* A load of finished goods leaves the mill and arrives in one of our warehouses.
       draft: { millId, warehouseId, arrivalDate, vehicle, notes, lines: [{productId, quantity, weightKg}] }.
       Bags only — no money moves (the value went on the mill's account when the job was posted). Cost per
       bag for the stock average is what the job(s) put on those bags. Never more bags than are at the mill. */
    receiveArrival: function (draft) {
      var mill = draft.millId ? global.supOf(draft.millId) : null;
      var errs = [];
      if (!mill) errs.push('Choose a mill.');
      if (!draft.warehouseId) errs.push('Choose the warehouse the goods arrived in.');
      else if (!whExists(draft.warehouseId)) errs.push('That warehouse no longer exists.');
      if (draft.arrivalDate && !validDay(draft.arrivalDate)) errs.push('The arrival date is not a real date.');
      var raw = (draft.lines || []).filter(function (l) { return l && l.productId; });
      if (!raw.length) errs.push('Add at least one product that arrived.');
      var clean = [], demand = {};
      raw.forEach(function (l, n) {
        var p = prodOf(l.productId);
        var label = 'Line ' + (n + 1) + (p ? ' (' + fullName(p) + ')' : '');
        if (!p) { errs.push(label + ': that product no longer exists.'); return; }
        var qty = M.qty(l.quantity);
        if (!(qty > 0)) { errs.push(label + ': bag count must be more than zero.'); return; }
        var weightKg = Number(l.weightKg);
        if (!(weightKg > 0)) { errs.push(label + ': weight must be more than zero.'); return; }
        demand[l.productId] = (demand[l.productId] || 0) + qty;
        clean.push({ productId: l.productId, product: p, quantity: qty, weightKg: weightKg, bagKg: p.kg || 0 });
      });
      if (mill && !errs.length) {
        Object.keys(demand).forEach(function (pid) {
          var have = Milling.atMillBalance(draft.millId, pid).qty, p = prodOf(pid) || {}, nm = fullName(p) || pid;
          if (demand[pid] > have) errs.push(have > 0
            ? 'Only ' + have + ' bags of ' + nm + ' are lying at ' + mill.co + '; this load has ' + demand[pid] + '.'
            : 'No ' + nm + ' is recorded as lying at ' + mill.co + '. Record the milling job that produced it first.');
        });
      }
      if (errs.length) return Promise.reject({ validation: errs });

      draft.id = draft.id || FDB.uid('mar');
      var opId = (draft.clientOpId || draft.id) + '#0';
      return FDB.tx(['sequences', 'millingArrivals', 'inventory', 'stockMovements', 'auditLog', 'operations', 'meta'], function (api) {
        return FDB.claimOperation(api, opId, 'MillingArrival', { entityId: draft.id }).then(function () {
          return touchGuard(api, draft.millId);
        }).then(function () {
          return FDB.nextNumber(api, 'MAR').then(function (number) {
            var date = draft.arrivalDate || today();
            var totalQty = 0, totalKg = 0;
            var rec = {
              id: draft.id, arrivalNumber: number, clientOpId: draft.clientOpId || draft.id, arrivalDate: date,
              millId: draft.millId, millSnapshot: mill.co,
              warehouseId: draft.warehouseId, warehouseSnapshot: whName(draft.warehouseId),
              vehicle: draft.vehicle || '', notes: draft.notes || '', lines: [],
              status: 'POSTED', cancelReason: '', createdBy: currentUser(), createdAt: nowISO()
            };
            clean.forEach(function (l) {
              var cost = Milling.atMillBalance(draft.millId, l.productId).costPerBagP;
              var extraP = Inventory.rawExtraOf(l.productId);   /* kept on the line so cancelling the arrival takes it back out */
              rec.lines.push({ id: FDB.uid('mal'), productId: l.productId, productSnapshot: l.product.en || l.product.ur || '',
                productUrSnapshot: l.product.ur || '', packageSnapshot: l.bagKg ? l.bagKg + ' KG' : 'Bag',
                quantity: l.quantity, bagKg: l.bagKg, weightKg: l.weightKg, unitCostP: cost, extraUnitP: extraP });
              totalQty += l.quantity; totalKg += l.weightKg;
              Inventory.apply(api, {
                productId: l.productId, warehouseId: rec.warehouseId, qtyDelta: l.quantity, extraCostP: extraP,
                kind: 'MILL_RECEIPT_IN', ref: number, refType: 'MILL_ARRIVAL',
                note: 'Arrived from mill — ' + rec.millSnapshot, date: date, unitCostP: cost
              });
            });
            rec.totalQty = Math.round(totalQty * 1000) / 1000; rec.totalKg = Math.round(totalKg * 1000) / 1000;
            api.put('millingArrivals', rec); (S.millingArrivals || (S.millingArrivals = [])).unshift(rec);
            Audit.write(api, { action: 'Milling arrival posted', entity: 'MillingArrival', entityId: rec.id, ref: number,
              newValues: { mill: rec.millSnapshot, bags: rec.totalQty, kg: rec.totalKg, warehouse: rec.warehouseSnapshot } });
            return rec;
          });
        });
      }).then(function (rec) { if (ERP.Mirror) ERP.Mirror.refresh(); return rec; });
    },

    cancelArrival: function (id, reason) {
      var a = Milling.arrivalById(id);
      if (!a) return Promise.reject(new Error('Arrival not found.'));
      if (a.status === 'CANCELLED') return Promise.resolve(a);
      return FDB.tx(['millingArrivals', 'inventory', 'stockMovements', 'auditLog'], function (api) {
        (a.lines || []).forEach(function (l) {
          Inventory.apply(api, {
            productId: l.productId, warehouseId: a.warehouseId, qtyDelta: -l.quantity,
            extraCostP: typeof l.extraUnitP === 'number' ? l.extraUnitP : undefined, carriageCostP: 0,
            kind: 'MILL_RECEIPT_REVERSAL_OUT', ref: a.arrivalNumber, refType: 'MILL_ARRIVAL_CANCEL',
            note: 'Arrival cancelled — ' + (reason || 'no reason given'), date: today()
          });
        });
        var old = { status: a.status };
        a.status = 'CANCELLED'; a.cancelReason = reason || ''; a.cancelledAt = nowISO();
        api.put('millingArrivals', a);
        Audit.write(api, { action: 'Milling arrival cancelled', entity: 'MillingArrival', entityId: a.id, ref: a.arrivalNumber,
          oldValues: old, newValues: { status: 'CANCELLED' }, reason: reason || '' });
        return a;
      }).then(function (r) { if (ERP.Mirror) ERP.Mirror.refresh(); return r; });
    }
  };

  /* ── the mill's own khata now includes milling jobs — patched in one place
     the same way 16-khata.js patches ERP.Ledger.customer for account
     adjustments, so the statement, the payables total and the invoice-style
     "current balance" figure cannot disagree. ── */
  var origSupplierLedger = ERP.Ledger.supplier;
  ERP.Ledger.supplier = function (supplierId, fromISO, toISO) {
    var full = origSupplierLedger.call(ERP.Ledger, supplierId, null, null);
    var rows = full.rows.map(function (r) {
      return Object.assign({}, r);
    });
    Milling.forMill(supplierId).forEach(function (j) {
      if (j.settle !== 'FEE_ONLY') {
        if (j.issuedValue) rows.push({
          iso: j.jobDate, ref: j.jobNumber, what: 'Wheat issued — milling job',
          dr: j.issuedValue, cr: 0, kind: 'MILLING', id: j.id + '#issue', createdAt: (j.createdAt || '') + '#1'
        });
        if (j.receivedValue) rows.push({
          iso: j.jobDate, ref: j.jobNumber,
          what: Milling.receiveMode(j) === 'AT_MILL' ? 'Finished goods made at the mill — milling job' : 'Received from mill — milling job',
          dr: 0, cr: j.receivedValue, kind: 'MILLING', id: j.id + '#recv', createdAt: (j.createdAt || '') + '#2'
        });
      }
      if (j.feeAmount) rows.push({
        iso: j.jobDate, ref: j.jobNumber, what: 'Milling fee',
        dr: 0, cr: j.feeAmount, kind: 'MILLING', id: j.id + '#fee', createdAt: (j.createdAt || '') + '#3'
      });
    });
    return ERP.Ledger._roll(rows, fromISO, toISO, true);
  };

  /* exposed so callers (and tests, after simulating a restart) can know when
     the milling stores have actually finished loading — same pattern
     30-payroll.js uses for ERP.payrollReady */
  ERP.millingReady = (ERP.bootPromise || Promise.resolve()).then(function () {
    return FDB.hydrate().then(function (d) {
      S.millingJobs = d.millingJobs || [];
      S.millingJobItems = d.millingJobItems || [];
      S.millingArrivals = d.millingArrivals || [];
    });
  }).catch(function () {
    S.millingJobs = S.millingJobs || []; S.millingJobItems = S.millingJobItems || []; S.millingArrivals = S.millingArrivals || [];
  });

  /* ════════════════════════════════════════════════════════════════════════
     THE SCREEN
     ════════════════════════════════════════════════════════════════════════ */
  var MILL = { view: 'list', selectedId: null };
  var DRAFT = null;
  var RID = 0;

  function blankLine() {
    return { rid: 'r' + (++RID), productId: '', quantity: '', weightKg: '', weightManual: false,
      rateBasis: 'KG', unitRate: '' };
  }
  function freshDraft() {
    var whs = global.activeWh ? global.activeWh() : [];
    return { millId: '', warehouseId: (whs[0] || {}).id || '', jobDate: today(), settle: 'NET', receiveMode: 'AT_MILL',
      feeAmount: '', feeNote: '', notes: '', issue: [blankLine()], receive: [blankLine()] };
  }
  function autoWeight(line) {
    var p = line.productId ? prodOf(line.productId) : null;
    var bagKg = p ? (Number(p.kg) || 0) : 0;
    var qty = Number(line.quantity) || 0;
    return bagKg && qty ? Math.round(bagKg * qty * 1000) / 1000 : '';
  }

  function card(cls, l, v, d) {
    return '<div class="kh-card ' + cls + '"><i>' + l + '</i><b>' + v + '</b>' +
      (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  }

  function millOptions(preId) {
    var all = (global.SUPPLIERS || []);
    var sups = all.filter(function (s) { return s.active !== false; });
    /* an inactive mill a job already points at stays selectable, marked
       (inactive) — the same fix made for the payment Area filter and the
       Statement of Account screen, so a job doesn't silently swap mills */
    if (preId && !sups.some(function (s) { return s.id === preId; })) {
      var inactive = all.filter(function (s) { return s.id === preId; })[0];
      if (inactive) sups = sups.concat([inactive]);
    }
    if (!sups.length) return '<option value="">— no suppliers on file —</option>';
    return '<option value="">— choose a mill —</option>' + sups.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === preId ? ' selected' : '') + '>' +
        esc(s.co) + (s.active === false ? ' (inactive)' : '') + '</option>';
    }).join('');
  }

  function warehouseOptions(preId) {
    var whs = global.activeWh ? global.activeWh() : (global.WAREHOUSES || []).filter(function (w) { return w.active !== false; });
    if (preId && !whs.some(function (w) { return w.id === preId; })) {
      var inactive = (global.WAREHOUSES || []).filter(function (w) { return w.id === preId; })[0];
      if (inactive) whs = whs.concat([inactive]);
    }
    return whs.map(function (w) {
      return '<option value="' + esc(w.id) + '"' + (w.id === preId ? ' selected' : '') + '>' +
        esc(w.name) + (w.active === false ? ' (inactive)' : '') + '</option>';
    }).join('');
  }

  function lineRow(side, l) {
    var basis = l.rateBasis === 'KG' ? 'KG' : 'BAG';
    var basisQty = basis === 'KG' ? (Number(l.weightKg) || 0) : (Number(l.quantity) || 0);
    var amount = Math.round((Number(l.unitRate) || 0) * basisQty);
    return '<tr>' +
      '<td><select data-millrow="' + l.rid + '" data-millside="' + side + '" data-millf="product">' +
        '<option value="">— choose —</option>' +
        activeProducts().map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === l.productId ? ' selected' : '') + '>' +
            esc(prodLabel(p)) + '</option>';
        }).join('') + '</select></td>' +
      '<td><input data-millrow="' + l.rid + '" data-millside="' + side + '" data-millf="qty" ' +
        'inputmode="decimal" placeholder="Bags" value="' + esc(l.quantity) + '"></td>' +
      '<td><input data-millrow="' + l.rid + '" data-millside="' + side + '" data-millf="weight" ' +
        'inputmode="decimal" placeholder="kg" value="' + esc(l.weightKg) + '"></td>' +
      '<td><select data-millrow="' + l.rid + '" data-millside="' + side + '" data-millf="basis">' +
        '<option value="KG"' + (basis === 'KG' ? ' selected' : '') + '>/kg</option>' +
        '<option value="BAG"' + (basis === 'BAG' ? ' selected' : '') + '>/bag</option></select></td>' +
      '<td><input data-millrow="' + l.rid + '" data-millside="' + side + '" data-millf="rate" ' +
        'inputmode="decimal" placeholder="0" value="' + esc(l.unitRate) + '"></td>' +
      '<td class="r">' + amount.toLocaleString('en-US') + '</td>' +
      '<td><button class="btn sm" data-millrmline="' + side + ':' + l.rid + '">' + I('x') + '</button></td>' +
    '</tr>';
  }

  function linesTable(side, title, lines) {
    return '<div class="f fc-mill-lines" style="margin-top:10px"><span>' + esc(title) + '</span>' +
      '<div class="tw"><table class="tbl"><thead><tr>' +
        '<th>Product</th><th>Bags / تعداد</th><th>Weight (kg) / وزن</th><th>Basis</th>' +
        '<th>Rate / ریٹ</th><th class="r">Amount / رقم</th><th></th>' +
      '</tr></thead><tbody>' + lines.map(function (l) { return lineRow(side, l); }).join('') +
      '</tbody></table></div>' +
      '<button class="btn sm" data-milladdline="' + side + '" style="margin-top:6px">' + I('plus') + 'Add line</button>' +
    '</div>';
  }

  function entryView() {
    var sum = Milling.summary(DRAFT);
    var warnBand = sum.inWeightKg > 0 && (sum.lossPct < 1 || sum.lossPct > 8);
    var millRec = DRAFT.millId && global.supOf ? global.supOf(DRAFT.millId) : null;
    var atMill = DRAFT.receiveMode !== 'DELIVERED';
    return '<div class="card"><div class="card-h"><h3>New milling job</h3><div class="grow"></div>' +
        '<button class="btn" data-millentrycancel>Cancel</button></div><div class="card-b">' +
      '<div class="f2">' +
        '<label class="f"><span>Mill</span><select data-millh="mill">' + millOptions(DRAFT.millId) + '</select></label>' +
        '<label class="f"><span>' + (atMill ? 'Wheat taken from warehouse' : 'Warehouse') + '</span><select data-millh="wh">' + warehouseOptions(DRAFT.warehouseId) + '</select></label>' +
      '</div>' +
      '<label class="f" style="margin-top:12px"><span>Where are the finished goods?</span><select data-millh="mode">' +
        '<option value="AT_MILL"' + (atMill ? ' selected' : '') + '>Still at the mill (Punjab) — I will record each load as it arrives</option>' +
        '<option value="DELIVERED"' + (!atMill ? ' selected' : '') + '>Already in our warehouse — add to stock now</option>' +
      '</select></label>' +
      '<div class="f2">' +
        '<label class="f"><span>Date</span><input type="date" data-millh="date" value="' + esc(DRAFT.jobDate) + '"></label>' +
        '<label class="f"><span>Settlement</span><select data-millh="settle">' +
          '<option value="NET"' + (DRAFT.settle !== 'FEE_ONLY' ? ' selected' : '') + '>Net off against the mill’s account</option>' +
          '<option value="FEE_ONLY"' + (DRAFT.settle === 'FEE_ONLY' ? ' selected' : '') + '>Grinding fee only — wheat stays ours</option>' +
        '</select></label>' +
      '</div>' +
      linesTable('issue', 'Issued — wheat out', DRAFT.issue) +
      linesTable('receive', atMill ? 'Made at the mill — finished goods (stay at the mill until they arrive)' : 'Received — back from the mill', DRAFT.receive) +
      '<div class="kh-cards" style="margin-top:12px">' +
        card('', 'Weight issued', sum.inWeightKg.toLocaleString('en-US') + ' kg') +
        card('', 'Weight received', sum.outWeightKg.toLocaleString('en-US') + ' kg') +
        card(warnBand ? 'due' : '', 'Process loss', sum.lossKg.toLocaleString('en-US') + ' kg (' + sum.lossPct + '%)',
          warnBand ? 'Outside the usual 1–8% range — check the weights' : '') +
      '</div>' +
      (sum.settle !== 'FEE_ONLY'
        ? '<div class="f2" style="margin-top:10px">' +
            '<div class="f"><span>Value issued</span><b>' + sum.issuedValue.toLocaleString('en-US') + '</b></div>' +
            '<div class="f"><span>Value received</span><b>' + sum.receivedValue.toLocaleString('en-US') + '</b></div>' +
          '</div>'
        : '') +
      '<div class="f2" style="margin-top:10px">' +
        '<label class="f"><span>Milling fee</span><input data-millh="fee" inputmode="decimal" value="' + esc(DRAFT.feeAmount) + '"></label>' +
        '<label class="f"><span>Fee note</span><input data-millh="feenote" placeholder="Optional" value="' + esc(DRAFT.feeNote) + '"></label>' +
      '</div>' +
      '<label class="f"><span>Notes</span><input data-millh="notes" placeholder="Optional" value="' + esc(DRAFT.notes) + '"></label>' +
      '<div class="banner ' + (sum.net >= 0 ? 'info' : 'warn') + '" style="margin-top:10px">' + I('wallet') +
        '<div><p>Net ' + (sum.net >= 0 ? 'payable to' : 'receivable from') + ' ' +
        esc(millRec ? millRec.co : 'the mill') + ' <b>' + Math.abs(sum.net).toLocaleString('en-US') + '</b></p></div></div>' +
      '<div style="margin-top:12px">' +
        (can('PURCHASE_CREATE') ? '<button class="btn pri" data-millsave>' + I('check') + 'Save milling job</button>' : '') +
      '</div>' +
    '</div></div>';
  }

  function itemRow(it) {
    return '<tr><td>' + esc(isoName(prodOf(it.productId), it.productSnapshot, it.productUrSnapshot)) + '</td><td class="r">' + it.quantity + '</td>' +
      '<td class="r">' + it.weightKg + ' kg</td>' +
      '<td class="r">' + M.fmtPlain(it.unitRate) + ' /' + (it.rateBasis === 'KG' ? 'kg' : 'bag') + '</td>' +
      '<td class="r">' + M.fmtPlain(it.lineTotal) + '</td></tr>';
  }

  function listView() {
    var rows = Milling.all();
    var body = rows.map(function (j) {
      return '<tr>' +
        '<td data-label="Date">' + esc(fmtDate(j.jobDate)) + '</td>' +
        '<td data-label="Job #" class="mono">' + esc(j.jobNumber) + '</td>' +
        '<td data-label="Mill">' + esc(j.millSnapshot) +
          (Milling.receiveMode(j) === 'AT_MILL' ? '<div class="sub">Goods at the mill</div>' : '') + '</td>' +
        '<td data-label="In (kg)" class="r">' + Number(j.inWeightKg).toLocaleString('en-US') + '</td>' +
        '<td data-label="Out (kg)" class="r">' + Number(j.outWeightKg).toLocaleString('en-US') + '</td>' +
        '<td data-label="Loss %" class="r">' + j.lossPct + '%</td>' +
        '<td data-label="Net" class="r">' + M.fmtPlain(j.netAmount) + '</td>' +
        '<td data-label="Status">' + (j.status === 'CANCELLED' ? pill('neu', 'Cancelled') : pill('ok', 'Posted')) + '</td>' +
        '<td data-label="" class="c fcb-rowacts">' +
          '<button class="btn sm" data-millview="' + j.id + '">View</button>' +
          '<button class="btn sm" data-millprint="' + j.id + '">Print</button>' +
          (j.status !== 'CANCELLED' && can('PURCHASE_CREATE')
            ? '<button class="btn sm" data-millcancel="' + j.id + '">Cancel</button>' : '') +
        '</td></tr>';
    }).join('');

    var listCard = '<div class="card"><div class="card-h"><h3>Milling jobs</h3>' +
        '<span class="pill neu">' + rows.length + '</span><div class="grow"></div>' +
        (rows.length ? '<button class="btn" data-millexcel>' + I('sheet') + 'Excel</button>' : '') +
        (can('PURCHASE_CREATE') ? '<button class="btn pri" data-millnew>' + I('plus') + 'New milling job</button>' : '') +
      '</div><div class="card-b" style="padding:0">' +
      (rows.length
        ? '<div class="tw"><table class="tbl"><thead><tr>' +
            '<th>Date</th><th>Job #</th><th>Mill</th><th class="r">In (kg)</th><th class="r">Out (kg)</th>' +
            '<th class="r">Loss %</th><th class="r">Net</th><th>Status</th><th></th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div>'
        : '<div class="empty"><div class="ei">' + I('mill') + '</div><b>No milling jobs yet</b>' +
          '<p>Record wheat handed to a mill and the flour and chokar received back.</p>' +
          (can('PURCHASE_CREATE') ? '<button class="btn pri" data-millnew>' + I('plus') + 'New milling job</button>' : '') +
          '</div>') +
      '</div></div>';

    var detail = '';
    var job = MILL.selectedId ? Milling.byId(MILL.selectedId) : null;
    if (job) {
      var items = Milling.items(job.id);
      var issueRows = items.filter(function (i) { return i.side === 'ISSUE'; });
      var recvRows = items.filter(function (i) { return i.side === 'RECEIVE'; });
      detail = '<div class="card" style="margin-top:14px"><div class="card-h">' +
          '<h3>' + esc(job.jobNumber) + '</h3><span class="pill neu">' + esc(job.millSnapshot) + '</span>' +
          '<div class="grow"></div>' +
          '<button class="btn" data-millprint="' + job.id + '">' + I('print') + 'Print / PDF</button>' +
          (job.status !== 'CANCELLED' && can('PURCHASE_CREATE')
            ? '<button class="btn" data-millcancel="' + job.id + '">Cancel</button>' : '') +
          '<button class="btn" data-millclose>Close</button>' +
        '</div><div class="card-b">' +
        '<div class="kh-cards">' +
          card('', 'Weight issued', Number(job.inWeightKg).toLocaleString('en-US') + ' kg') +
          card('', 'Weight received', Number(job.outWeightKg).toLocaleString('en-US') + ' kg') +
          card('', 'Process loss', Number(job.lossKg).toLocaleString('en-US') + ' kg (' + job.lossPct + '%)') +
          card(job.netAmount >= 0 ? 'due' : 'credit', 'Net', M.fmt(job.netAmount)) +
        '</div>' +
        (Milling.receiveMode(job) === 'AT_MILL' && job.status !== 'CANCELLED'
          ? '<div class="banner info" style="margin-top:10px">' + I('mill') + '<div><p>The finished goods from this job are <b>lying at the mill</b>, not in a warehouse. ' +
            'Record each load as it arrives under Stock at mills.</p></div><div class="r"><button class="btn sm" data-go="millstock">Stock at mills</button></div></div>'
          : '') +
        (issueRows.length ? '<p class="hint" style="margin-top:12px">Issued — wheat out</p>' +
          '<div class="tw"><table class="kh-table"><thead><tr><th>Product</th><th class="r">Bags</th>' +
          '<th class="r">Weight</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>' +
          issueRows.map(itemRow).join('') + '</tbody></table></div>' : '') +
        (recvRows.length ? '<p class="hint" style="margin-top:12px">' +
          (Milling.receiveMode(job) === 'AT_MILL' ? 'Made at the mill — finished goods' : 'Received — back from the mill') + '</p>' +
          '<div class="tw"><table class="kh-table"><thead><tr><th>Product</th><th class="r">Bags</th>' +
          '<th class="r">Weight</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>' +
          recvRows.map(itemRow).join('') + '</tbody></table></div>' : '') +
        (job.status === 'CANCELLED' ? '<div class="banner warn" style="margin-top:10px">' + I('alert') +
          '<div><p><b>Cancelled</b> — ' + esc(job.cancelReason || 'No reason given') + '</p></div></div>' : '') +
      '</div></div>';
    }
    return listCard + detail;
  }

  global.PAGES.milling = function () { return MILL.view === 'entry' && DRAFT ? entryView() : listView(); };


  /* ════════════════════════════════════════════════════════════════════════
     STOCK AT MILLS — what is lying at the mill (Punjab) and what has come
     ════════════════════════════════════════════════════════════════════════ */
  var MS = { mill: '', view: 'list' };
  var ADRAFT = null, ARID = 0;

  function ablankLine() { return { rid: 'a' + (++ARID), productId: '', quantity: '', weightKg: '', weightManual: false }; }
  function afreshDraft(millId) {
    var whs = global.activeWh ? global.activeWh() : [];
    var d = { millId: millId || '', warehouseId: (whs[0] || {}).id || '', arrivalDate: today(), vehicle: '', notes: '', lines: [ablankLine()] };
    if (millId) pickMillWarehouse(d);
    return d;
  }
  /* the warehouse the wheat left from is the natural place for its flour to arrive */
  function pickMillWarehouse(d) {
    var last = Milling.all().filter(function (j) { return j.millId === d.millId && j.status !== 'CANCELLED' && Milling.receiveMode(j) === 'AT_MILL'; })[0];
    if (last && last.warehouseId) d.warehouseId = last.warehouseId;
  }
  function aAutoWeight(l) {
    var p = l.productId ? prodOf(l.productId) : null, bagKg = p ? (Number(p.kg) || 0) : 0, qty = Number(l.quantity) || 0;
    return bagKg && qty ? Math.round(bagKg * qty * 1000) / 1000 : '';
  }
  function n0(v) { return Number(v).toLocaleString('en-US'); }

  /* mills that have ever had goods left with them (the filter list), and those with something still there (the arrival picker) */
  function millIdsWith(pred) {
    var seen = {}, out = [];
    Milling.atMill().forEach(function (r) { if (pred(r) && !seen[r.millId]) { seen[r.millId] = 1; out.push(r.millId); } });
    return out;
  }
  function millName(id) { var m = global.supOf ? global.supOf(id) : null; return m ? m.co : id; }
  function idOptions(ids, preId, blank) {
    var list = ids.slice();
    if (preId && list.indexOf(preId) === -1) list.push(preId);
    return '<option value="">' + esc(blank) + '</option>' + list.map(function (id) {
      return '<option value="' + esc(id) + '"' + (id === preId ? ' selected' : '') + '>' + esc(millName(id)) + '</option>';
    }).join('');
  }

  function arrivalEntryView() {
    var bal = ADRAFT.millId ? Milling.atMill({ millId: ADRAFT.millId }) : [];
    var havePid = {}; bal.forEach(function (r) { havePid[r.productId] = r; });
    var want = {};
    ADRAFT.lines.forEach(function (l) { if (l.productId) want[l.productId] = (want[l.productId] || 0) + (Number(l.quantity) || 0); });
    var after = bal.filter(function (r) { return r.qty > 0 || want[r.productId]; }).map(function (r) {
      var left = Math.round((r.qty - (want[r.productId] || 0)) * 1000) / 1000;
      return '<tr><td>' + esc(r.productLabel) + '</td><td class="r">' + n0(r.qty) + '</td><td class="r">' + n0(want[r.productId] || 0) +
        '</td><td class="r">' + (left < 0 ? '<b style="color:var(--bad,#c0392b)">' + n0(left) + ' — more than is at the mill</b>' : n0(left)) + '</td></tr>';
    }).join('');
    var rows = ADRAFT.lines.map(function (l) {
      var opts = bal.filter(function (r) { return r.qty > 0 || r.productId === l.productId; }).map(function (r) {
        return '<option value="' + esc(r.productId) + '"' + (r.productId === l.productId ? ' selected' : '') + '>' +
          esc(r.productLabel) + ' — ' + n0(r.qty) + ' bags at the mill</option>';
      }).join('');
      return '<tr><td><select data-msrow="' + l.rid + '" data-msf="product"><option value="">' +
          (ADRAFT.millId ? '— choose —' : '— choose a mill first —') + '</option>' + opts + '</select></td>' +
        '<td><input data-msrow="' + l.rid + '" data-msf="qty" inputmode="decimal" placeholder="Bags" value="' + esc(l.quantity) + '"></td>' +
        '<td><input data-msrow="' + l.rid + '" data-msf="weight" inputmode="decimal" placeholder="kg" value="' + esc(l.weightKg) + '"></td>' +
        '<td><button class="btn sm" data-msrm="' + l.rid + '">' + I('x') + '</button></td></tr>';
    }).join('');
    return '<div class="card"><div class="card-h"><h3>Goods arrived from a mill</h3><div class="grow"></div>' +
        '<button class="btn" data-msentrycancel>Cancel</button></div><div class="card-b">' +
      '<div class="f2">' +
        '<label class="f"><span>Mill</span><select data-msh="mill">' +
          idOptions(millIdsWith(function (r) { return r.qty > 0; }), ADRAFT.millId, '— choose a mill —') + '</select></label>' +
        '<label class="f"><span>Arrived in warehouse</span><select data-msh="wh">' + warehouseOptions(ADRAFT.warehouseId) + '</select></label>' +
      '</div>' +
      '<div class="f2">' +
        '<label class="f"><span>Date arrived</span><input type="date" data-msh="date" value="' + esc(ADRAFT.arrivalDate) + '"></label>' +
        '<label class="f"><span>Vehicle / bilti no.</span><input data-msh="vehicle" placeholder="Optional" value="' + esc(ADRAFT.vehicle) + '"></label>' +
      '</div>' +
      '<div class="f fc-mill-lines" style="margin-top:10px"><span>What arrived</span>' +
        '<div class="tw"><table class="tbl"><thead><tr><th>Product</th><th>Bags / تعداد</th><th>Weight (kg) / وزن</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' +
        '<button class="btn sm" data-msadd style="margin-top:6px">' + I('plus') + 'Add line</button></div>' +
      (after ? '<p class="hint" style="margin-top:12px">Lying at the mill, before and after this load</p><div class="tw"><table class="kh-table"><thead><tr>' +
        '<th>Product</th><th class="r">At the mill now</th><th class="r">This load</th><th class="r">Still there after</th></tr></thead><tbody>' + after + '</tbody></table></div>' : '') +
      '<label class="f" style="margin-top:10px"><span>Notes</span><input data-msh="notes" placeholder="Optional" value="' + esc(ADRAFT.notes) + '"></label>' +
      '<div class="banner info" style="margin-top:10px">' + I('alert') + '<div><p>This adds the bags to the warehouse and takes them off the balance at the mill. No money moves — the value was put on the mill’s account when the milling job was saved.</p></div></div>' +
      '<div style="margin-top:12px">' +
        (can('PURCHASE_CREATE') ? '<button class="btn pri" data-mssave>' + I('check') + 'Record arrival</button>' : '') +
      '</div></div></div>';
  }

  function millStockView() {
    var ids = millIdsWith(function () { return true; });
    if (MS.mill && ids.indexOf(MS.mill) === -1) MS.mill = '';   /* a remembered mill that no longer has anything: back to All, never a list filtered under an "All" label */
    var mill = MS.mill, tot = Milling.atMillTotals(mill);
    var rows = Milling.atMill({ millId: mill }).sort(function (a, b) {
      return (b.qty - a.qty) || millName(a.millId).localeCompare(millName(b.millId)) || a.productName.localeCompare(b.productName);
    });
    var arrs = Milling.arrivals().filter(function (a) { return !mill || a.millId === mill; });
    var canWrite = can('PURCHASE_CREATE');
    var canArrive = rows.some(function (r) { return r.qty > 0; });

    /* more bags received than the mill was ever recorded as making: only possible by two people saving at once (the server's
       revision check is per record, and the two loads are two new records) or a job edited out from under an arrival — say so */
    var over = rows.filter(function (r) { return r.qty < 0; });
    var overBanner = over.length
      ? '<div class="banner warn" style="margin:0 0 14px">' + I('alert') + '<div><p><b>More has arrived than the mill was recorded as making</b> — ' +
        over.map(function (r) { return esc(r.productLabel) + ' by ' + n0(-r.qty) + ' bags'; }).join(', ') +
        '. Check the milling jobs for that mill and cancel any load entered twice.</p></div></div>'
      : '';
    var head = overBanner + '<div class="card"><div class="card-h"><h3>Stock at mills</h3><div class="grow"></div>' +
        '<label class="f" style="margin:0"><select data-msfilter aria-label="Mill">' +
          '<option value="">All mills</option>' + ids.map(function (id) {
            return '<option value="' + esc(id) + '"' + (id === mill ? ' selected' : '') + '>' + esc(millName(id)) + '</option>';
          }).join('') + '</select></label>' +
        (rows.length ? '<button class="btn" data-msexcel>' + I('sheet') + 'Excel</button>' : '') +
        (canWrite ? '<button class="btn pri" data-msnew' + (canArrive ? '' : ' disabled') + '>' + I('plus') + 'Goods arrived</button>' : '') +
      '</div><div class="card-b">' +
      (rows.length
        ? '<div class="kh-cards">' +
            card('', 'Wheat given', n0(tot.issuedKg) + ' kg') +
            card('', 'Made at the mill', n0(tot.producedQty) + ' bags', n0(tot.producedKg) + ' kg · loss ' + n0(tot.lossKg) + ' kg') +
            card('', 'Arrived here', n0(tot.arrivedQty) + ' bags', n0(tot.arrivedKg) + ' kg') +
            card(over.length ? 'due' : '', 'Still at the mill', n0(tot.qty) + ' bags', n0(tot.kg) + ' kg · worth ' + M.fmt(tot.valueP)) +
          '</div>'
        : '') + '</div></div>';

    var table = '<div class="card" style="margin-top:14px"><div class="card-h"><h3>What is lying at the mill</h3></div><div class="card-b" style="padding:0">' +
      (rows.length
        ? '<div class="tw"><table class="tbl"><thead><tr>' + (mill ? '' : '<th>Mill</th>') +
          '<th>Product</th><th class="r">Made (bags)</th><th class="r">Arrived (bags)</th><th class="r">At the mill (bags)</th><th class="r">At the mill (kg)</th><th class="r">Worth</th></tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + (mill ? '' : '<td data-label="Mill">' + esc(millName(r.millId)) + '</td>') +
              '<td data-label="Product">' + esc(r.productLabel) + '</td>' +
              '<td data-label="Made" class="r">' + n0(r.producedQty) + '</td>' +
              '<td data-label="Arrived" class="r">' + n0(r.arrivedQty) + '</td>' +
              '<td data-label="At the mill" class="r"><b>' + n0(r.qty) + '</b>' + (r.qty <= 0 ? ' ' + pill('ok', 'All received') : '') + '</td>' +
              '<td data-label="Kg" class="r">' + (r.qty > 0 ? n0(r.kg) :
                '<span class="sub">' + (r.kg ? 'weight difference ' + n0(r.kg) : '—') + '</span>') + '</td>' +
              '<td data-label="Worth" class="r">' + M.fmtPlain(r.valueP) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty"><div class="ei">' + I('mill') + '</div><b>Nothing is lying at a mill</b>' +
          '<p>When you save a milling job with “Still at the mill”, the finished goods appear here until you record them arriving.</p></div>') +
      '</div></div>';

    var arrCard = '<div class="card" style="margin-top:14px"><div class="card-h"><h3>Loads that arrived</h3><span class="pill neu">' + arrs.length + '</span></div>' +
      '<div class="card-b" style="padding:0">' + (arrs.length
        ? '<div class="tw"><table class="tbl"><thead><tr><th>Date</th><th>No.</th><th>Mill</th><th>Into</th><th class="r">Bags</th><th class="r">Kg</th><th>Vehicle</th><th>Status</th><th></th></tr></thead><tbody>' +
          arrs.slice(0, 100).map(function (a) {
            return '<tr><td data-label="Date">' + esc(fmtDate(a.arrivalDate)) + '</td><td data-label="No." class="mono">' + esc(a.arrivalNumber) + '</td>' +
              '<td data-label="Mill">' + esc(a.millSnapshot) + '</td><td data-label="Into">' + esc(a.warehouseSnapshot) + '</td>' +
              '<td data-label="Bags" class="r">' + n0(a.totalQty) + '</td><td data-label="Kg" class="r">' + n0(a.totalKg) + '</td>' +
              '<td data-label="Vehicle">' + esc(a.vehicle || '') + '</td>' +
              '<td data-label="Status">' + (a.status === 'CANCELLED' ? pill('neu', 'Cancelled') : pill('ok', 'Received')) + '</td>' +
              '<td data-label="" class="c fcb-rowacts"><button class="btn sm" data-msarrprint="' + a.id + '">Print</button>' +
              (a.status !== 'CANCELLED' && canWrite ? '<button class="btn sm" data-msarrcancel="' + a.id + '">Cancel</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' +
          (arrs.length > 100 ? '<p class="hint" style="padding:10px 14px">Showing the latest 100 of ' + arrs.length + '. Excel has them all.</p>' : '')
        : '<div class="empty"><b>No loads recorded yet</b><p>Use “Goods arrived” when a truck from the mill reaches a warehouse.</p></div>') +
      '</div></div>';
    return head + table + arrCard;
  }

  global.PAGES.millstock = function () { return MS.view === 'entry' && ADRAFT ? arrivalEntryView() : millStockView(); };

  /* ════════════════════════════════════════════════════════════════════════
     NAV — two entries under Inventory & supply
     ════════════════════════════════════════════════════════════════════════ */
  try {
    var NAV = global.NAV, GROUPS = global.NAVGROUPS;
    if (!NAV.some(function (n) { return n.id === 'milling'; })) {
      var at = NAV.map(function (n) { return n.id; }).indexOf('purchases');
      NAV.splice(at < 0 ? NAV.length : at + 1, 0, { id: 'milling', l: 'Milling', i: 'mill' });
    }
    if (!NAV.some(function (n) { return n.id === 'millstock'; })) {
      var at2 = NAV.map(function (n) { return n.id; }).indexOf('milling');
      NAV.splice(at2 < 0 ? NAV.length : at2 + 1, 0, { id: 'millstock', l: 'Stock at mills', i: 'mill' });
    }
    GROUPS.forEach(function (g) {
      if (g[0] === 'Inventory & supply' && g[1].indexOf('milling') === -1) {
        var pos = g[1].indexOf('purchases');
        g[1].splice(pos < 0 ? g[1].length : pos + 1, 0, 'milling');
      }
      if (g[0] === 'Inventory & supply' && g[1].indexOf('millstock') === -1) {
        var pos2 = g[1].indexOf('milling');
        g[1].splice(pos2 < 0 ? g[1].length : pos2 + 1, 0, 'millstock');
      }
    });
    if (global.PAGEMETA) {
      global.PAGEMETA.milling = ['Milling',
        'Wheat handed to a mill and the flour and chokar received back, with the process loss shown and the net settled into the mill’s own account.'];
      global.PAGEMETA.millstock = ['Stock at mills',
        'Finished goods still lying at a mill (Punjab) — how much was made, how much has arrived here, and what is left there.'];
    }
  } catch (e) {}

  /* ════════════════════════════════════════════════════════════════════════
     HANDLERS
     ════════════════════════════════════════════════════════════════════════ */
  D.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset) return;
    if (el.dataset.millh !== undefined && DRAFT) {
      var k = el.dataset.millh;
      if (k === 'mill') DRAFT.millId = el.value;
      else if (k === 'wh') DRAFT.warehouseId = el.value;
      else if (k === 'date') DRAFT.jobDate = el.value;
      else if (k === 'settle') DRAFT.settle = el.value;
      else if (k === 'mode') DRAFT.receiveMode = el.value === 'DELIVERED' ? 'DELIVERED' : 'AT_MILL';
      else if (k === 'fee') DRAFT.feeAmount = el.value;
      else if (k === 'feenote') DRAFT.feeNote = el.value;
      else if (k === 'notes') DRAFT.notes = el.value;
      global.paint(); return;
    }
    if (el.dataset.millrow !== undefined && DRAFT) {
      var side = el.dataset.millside === 'receive' ? 'receive' : 'issue';
      var line = DRAFT[side].filter(function (l) { return l.rid === el.dataset.millrow; })[0];
      if (!line) return;
      var field = el.dataset.millf;
      if (field === 'product') { line.productId = el.value; if (!line.weightManual) line.weightKg = autoWeight(line); }
      else if (field === 'qty') { line.quantity = el.value; if (!line.weightManual) line.weightKg = autoWeight(line); }
      else if (field === 'weight') { line.weightKg = el.value; line.weightManual = true; }
      else if (field === 'basis') { line.rateBasis = el.value; }
      else if (field === 'rate') { line.unitRate = el.value; }
      global.paint();
    }
  });

  D.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset) return;
    if (el.dataset.msfilter !== undefined) { MS.mill = el.value; global.paint(); return; }
    if (el.dataset.msh !== undefined && ADRAFT) {
      var k = el.dataset.msh;
      if (k === 'mill') {
        if (el.value !== ADRAFT.millId) { ADRAFT.millId = el.value; ADRAFT.lines = [ablankLine()]; pickMillWarehouse(ADRAFT); }  /* other mill = other products */
      }
      else if (k === 'wh') ADRAFT.warehouseId = el.value;
      else if (k === 'date') ADRAFT.arrivalDate = el.value;
      else if (k === 'vehicle') ADRAFT.vehicle = el.value;
      else if (k === 'notes') ADRAFT.notes = el.value;
      global.paint(); return;
    }
    if (el.dataset.msrow !== undefined && ADRAFT) {
      var line = ADRAFT.lines.filter(function (l) { return l.rid === el.dataset.msrow; })[0];
      if (!line) return;
      var f = el.dataset.msf;
      if (f === 'product') { line.productId = el.value; if (!line.weightManual) line.weightKg = aAutoWeight(line); }
      else if (f === 'qty') { line.quantity = el.value; if (!line.weightManual) line.weightKg = aAutoWeight(line); }
      else if (f === 'weight') { line.weightKg = el.value; line.weightManual = true; }
      global.paint();
    }
  });

  D.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var t;
    if (e.target.closest('[data-msnew]')) {
      e.preventDefault(); if (e.target.closest('[data-msnew]').disabled) return;
      ADRAFT = afreshDraft(MS.mill); MS.view = 'entry'; global.paint(); return;
    }
    if (e.target.closest('[data-msentrycancel]')) {
      e.preventDefault(); ADRAFT = null; MS.view = 'list'; global.paint(); return;
    }
    if (e.target.closest('[data-msadd]')) {
      e.preventDefault(); if (ADRAFT) ADRAFT.lines.push(ablankLine()); global.paint(); return;
    }
    if ((t = e.target.closest('[data-msrm]'))) {
      e.preventDefault();
      if (ADRAFT) {
        ADRAFT.lines = ADRAFT.lines.filter(function (l) { return l.rid !== t.dataset.msrm; });
        if (!ADRAFT.lines.length) ADRAFT.lines.push(ablankLine());
      }
      global.paint(); return;
    }
    if (e.target.closest('[data-mssave]')) {
      e.preventDefault();
      if (!ADRAFT) return;
      var savingArr = ADRAFT;   /* same guard as the job screen: a slow save must not wipe a newer draft */
      Milling.receiveArrival(savingArr).then(function (a) {
        if (ADRAFT === savingArr) { ADRAFT = null; MS.view = 'list'; }
        global.paint(); say('Arrival ' + a.arrivalNumber + ' recorded — ' + n0(a.totalQty) + ' bags added to ' + a.warehouseSnapshot + '.');
        setTimeout(function () {
          var m = ERP.DocModel && ERP.DocModel.millingArrival ? ERP.DocModel.millingArrival(a.id) : null;
          if (m) ERP.Viewer.open(m);
        }, 220);
      }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not record the arrival.'); });
      return;
    }
    if ((t = e.target.closest('[data-msarrprint]'))) {
      e.preventDefault();
      var m3 = ERP.DocModel && ERP.DocModel.millingArrival ? ERP.DocModel.millingArrival(t.dataset.msarrprint) : null;
      if (m3) ERP.Viewer.open(m3);
      return;
    }
    if ((t = e.target.closest('[data-msarrcancel]'))) {
      e.preventDefault();
      var aid = t.dataset.msarrcancel;
      ERP.UI.prompt('Cancel this arrival?', {
        detail: 'The bags come out of the warehouse again and go back to “lying at the mill”. The reason is kept in the audit log.',
        label: 'Reason', placeholder: 'Why is this arrival being cancelled?',
        okText: 'Cancel arrival', cancelText: 'Keep arrival', tone: 'danger'
      }).then(function (why) {
        if (why === null) return;
        return Milling.cancelArrival(aid, why || 'No reason given').then(function () {
          global.paint(); say('Arrival cancelled — the bags are back at the mill.');
        }).catch(function (err) { say((err && err.validation && err.validation[0]) || 'Could not cancel that.'); });
      });
      return;
    }
    if (e.target.closest('[data-msexcel]')) {
      e.preventDefault();
      var sheetA = [['Mill', 'Product', 'Made (bags)', 'Arrived (bags)', 'At the mill (bags)', 'At the mill (kg)', 'Worth']];
      Milling.atMill({ millId: MS.mill }).forEach(function (r) {
        sheetA.push([millName(r.millId), r.productName, r.producedQty, r.arrivedQty, r.qty, r.kg, M.toR(r.valueP)]);
      });
      var sheetB = [['Date', 'No.', 'Mill', 'Into', 'Product', 'Bags', 'Kg', 'Vehicle', 'Status']];
      Milling.arrivals().filter(function (a) { return !MS.mill || a.millId === MS.mill; }).forEach(function (a) {
        (a.lines || []).forEach(function (l) {
          sheetB.push([fmtDate(a.arrivalDate), a.arrivalNumber, a.millSnapshot, a.warehouseSnapshot, fullName(prodOf(l.productId), l.productSnapshot, l.productUrSnapshot), l.quantity, l.weightKg, a.vehicle || '', a.status]);
        });
      });
      if (ERP.XLSX) {
        ERP.XLSX.download([{ name: 'At the mills', rows: sheetA }, { name: 'Arrivals', rows: sheetB }],
          'Stock-at-mills-' + today() + '.xlsx', { title: 'Stock at mills', author: ERP.Settings.get().businessName });
        ERP.Audit.detached({ action: 'Stock at mills exported to Excel', entity: 'Report', entityId: 'millstock' });
      }
      return;
    }
    if (e.target.closest('[data-millnew]')) {
      e.preventDefault(); DRAFT = freshDraft(); MILL.view = 'entry'; global.paint(); return;
    }
    if (e.target.closest('[data-millentrycancel]')) {
      e.preventDefault(); DRAFT = null; MILL.view = 'list'; global.paint(); return;
    }
    if ((t = e.target.closest('[data-milladdline]'))) {
      e.preventDefault();
      if (DRAFT) DRAFT[t.dataset.milladdline].push(blankLine());
      global.paint(); return;
    }
    if ((t = e.target.closest('[data-millrmline]'))) {
      e.preventDefault();
      var parts = t.dataset.millrmline.split(':');
      if (DRAFT) {
        DRAFT[parts[0]] = DRAFT[parts[0]].filter(function (l) { return l.rid !== parts[1]; });
        /* never leave a side with no rows at all — same rule 27-landed-ui.js
           uses for its own dynamic line list, so there is always a row to
           type into rather than a dead-end empty table */
        if (!DRAFT[parts[0]].length) DRAFT[parts[0]].push(blankLine());
      }
      global.paint(); return;
    }
    if (e.target.closest('[data-millsave]')) {
      e.preventDefault();
      if (!DRAFT) return;
      /* captured so a slower save that resolves after the person has
         already moved on to a second draft (e.g. clicked "New milling job"
         again before this one finished) cannot wipe that second draft out
         from under them */
      var savingDraft = DRAFT;
      Milling.save(savingDraft).then(function (job) {
        if (DRAFT === savingDraft) { DRAFT = null; MILL.view = 'list'; }
        MILL.selectedId = job.id;
        global.paint(); say('Milling job ' + job.jobNumber + ' posted.' +
          (Milling.receiveMode(job) === 'AT_MILL' ? ' The finished goods are recorded at the mill.' : ''));
        setTimeout(function () {
          var m = ERP.DocModel && ERP.DocModel.millingJob ? ERP.DocModel.millingJob(job.id) : null;
          if (m) ERP.Viewer.open(m);
        }, 220);
      }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not save the milling job.'); });
      return;
    }
    if ((t = e.target.closest('[data-millview]'))) {
      e.preventDefault(); MILL.selectedId = t.dataset.millview; global.paint(); return;
    }
    if (e.target.closest('[data-millclose]')) {
      e.preventDefault(); MILL.selectedId = null; global.paint(); return;
    }
    if ((t = e.target.closest('[data-millprint]'))) {
      e.preventDefault();
      var m2 = ERP.DocModel && ERP.DocModel.millingJob ? ERP.DocModel.millingJob(t.dataset.millprint) : null;
      if (m2) ERP.Viewer.open(m2);
      return;
    }
    if ((t = e.target.closest('[data-millcancel]'))) {
      e.preventDefault();
      var id2 = t.dataset.millcancel;
      ERP.UI.prompt('Cancel this milling job?', {
        detail: 'The stock movements are reversed. The reason is kept in the audit log.',
        label: 'Reason', placeholder: 'Why is this milling job being cancelled?',
        okText: 'Cancel job', cancelText: 'Keep job', tone: 'danger'
      }).then(function (why) {
        if (why === null) return;
        return Milling.cancel(id2, why || 'No reason given').then(function () {
          global.paint(); say('Milling job cancelled and the stock movements reversed.');
        }).catch(function (err) { say((err && err.validation && err.validation[0]) || 'Could not cancel that.'); });
      });
      return;
    }
    if (e.target.closest('[data-millexcel]')) {
      e.preventDefault();
      var rows = [['Date', 'Job #', 'Mill', 'In (kg)', 'Out (kg)', 'Loss (kg)', 'Loss %', 'Issued', 'Received', 'Fee', 'Net', 'Status', 'Finished goods']];
      Milling.all().forEach(function (j) {
        rows.push([fmtDate(j.jobDate), j.jobNumber, j.millSnapshot, j.inWeightKg, j.outWeightKg,
          j.lossKg, j.lossPct, M.toR(j.issuedValue), M.toR(j.receivedValue), M.toR(j.feeAmount),
          M.toR(j.netAmount), j.status, Milling.receiveMode(j) === 'AT_MILL' ? 'At the mill' : 'In our warehouse']);
      });
      if (ERP.XLSX) {
        ERP.XLSX.download([{ name: 'Milling jobs', rows: rows }], 'Milling-jobs-' + today() + '.xlsx',
          { title: 'Milling jobs', author: ERP.Settings.get().businessName });
        ERP.Audit.detached({ action: 'Milling jobs exported to Excel', entity: 'Report', entityId: 'milling' });
      }
      return;
    }
  });
})(typeof window !== 'undefined' ? window : this);
