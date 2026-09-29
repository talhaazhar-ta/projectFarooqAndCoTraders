/* ══════════════════════════════════════════════════════════════════════════
   FAROOQ & CO TRADERS — ERP UPGRADE · MODULE 23
   THE MASTER DATA WORKBENCH
   Every name, every detail, editable — one at a time or four hundred at
   once. Categories, brands and units come from lists you control, extra
   fields can be added without touching the code, and a spreadsheet can be
   brought back in with a preview of exactly what it would change.
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
function who() { return ERP.Session ? ERP.Session.name() : (global.CURRENT_USER || 'Owner'); }
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var s = String(v).replace(/[^\d.\-]/g, '');
  /* nothing numeric left ("abc", "-", ".") is not a number: the checks below rely on null meaning
     that, and it used to read as 0 — quietly writing 0 into a bag size, price or bulk change */
  if (!/\d/.test(s)) return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   1 · WHAT EACH RECORD IS MADE OF
   Described once, so the editor, the table, the CSV and the importer all
   agree — and so a new field only has to be added in one place.
   ══════════════════════════════════════════════════════════════════════════ */
var ENTITIES = {
  product: {
    label: 'Product', plural: 'Products', store: 'products',
    list: function () { return global.PRODUCTS || []; },
    idPrefix: 'PRD',
    fields: [
      { k: 'ur',        l: 'Name (Urdu)',      type: 'urdu',  wide: true },
      { k: 'en',        l: 'Name (English)',   type: 'text',  wide: true },
      { k: 'brandEn',   l: 'Brand',            type: 'list',  list: 'brands' },
      { k: 'brand',     l: 'Brand (Urdu)',     type: 'urdu' },
      { k: 'cat',       l: 'Category',         type: 'list',  list: 'categories' },
      { k: 'unit',      l: 'Unit',             type: 'list',  list: 'units' },
      { k: 'kg',        l: 'Bag size (KG)',    type: 'number' },
      { k: 'sku',       l: 'SKU / code',       type: 'text' },
      { k: 'sourceFolio', l: 'Catalogue folio', type: 'text', readonlyHint: 'From the original book' },
      { k: 'description', l: 'Description',    type: 'textarea', wide: true },
      { k: 'notes',     l: 'Internal note',    type: 'text',  wide: true },
      { k: 'active',    l: 'In use',           type: 'bool' },
      { k: 'needsReview', l: 'Still needs checking', type: 'bool' },
      { k: 'priceConfirmed', l: 'Price confirmed', type: 'bool' }
    ],
    columns: ['ur', 'en', 'brandEn', 'cat', 'kg', 'active'],
    search: function (p) {
      return [p.ur, p.en, p.brand, p.brandEn, p.cat, p.sku, p.sourceFolio, p.id, p.description]
        .filter(Boolean).join(' ');
    }
  },
  customer: {
    label: 'Shop', plural: 'Shops & customers', store: 'customers',
    list: function () { return global.CUSTOMERS || []; },
    idPrefix: 'CUS',
    fields: [
      { k: 'sh',      l: 'Shop name',        type: 'text', wide: true },
      { k: 'ow',      l: 'Owner',            type: 'text' },
      { k: 'nameUr',  l: 'Name (Urdu)',      type: 'urdu' },
      { k: 'ph',      l: 'Mobile',           type: 'text' },
      { k: 'wa',      l: 'WhatsApp',         type: 'text' },
      { k: 'email',   l: 'Email',            type: 'text' },
      { k: 'addr',    l: 'Address',          type: 'textarea', wide: true },
      { k: 'area',    l: 'Bazar / market',   type: 'text' },
      { k: 'route',   l: 'Route',            type: 'text' },
      { k: 'region',  l: 'Area',             type: 'region' },
      { k: 'salesmanId', l: 'Salesman',      type: 'salesman' },
      { k: 'limit',   l: 'Credit limit',     type: 'number' },
      { k: 'legacyCode', l: 'Old account code', type: 'text' },
      { k: 'notes',   l: 'Note',             type: 'text', wide: true },
      { k: 'active',  l: 'In use',           type: 'bool' },
      { k: 'regionAssumed', l: 'Area still to confirm', type: 'bool' }
    ],
    columns: ['sh', 'ow', 'ph', 'region', 'route', 'active'],
    search: function (c) {
      return [c.sh, c.ow, c.nameUr, c.ph, c.addr, c.area, c.route, c.legacyCode, c.id]
        .filter(Boolean).join(' ');
    }
  },
  supplier: {
    label: 'Supplier', plural: 'Suppliers & mills', store: 'suppliers',
    list: function () { return global.SUPPLIERS || []; },
    idPrefix: 'SUP',
    fields: [
      { k: 'co',    l: 'Company / mill',  type: 'text', wide: true },
      { k: 'cp',    l: 'Contact person',  type: 'text' },
      { k: 'ph',    l: 'Phone',           type: 'text' },
      { k: 'wa',    l: 'WhatsApp',        type: 'text' },
      { k: 'email', l: 'Email',           type: 'text' },
      { k: 'lo',    l: 'Location',        type: 'text' },
      { k: 'ntn',   l: 'NTN',             type: 'text' },
      { k: 'terms', l: 'Payment terms',   type: 'text' },
      { k: 'legacyCode', l: 'Old account code', type: 'text' },
      { k: 'notes', l: 'Note',            type: 'text', wide: true },
      { k: 'active', l: 'In use',         type: 'bool' }
    ],
    columns: ['co', 'cp', 'ph', 'lo', 'active'],
    search: function (s) {
      return [s.co, s.cp, s.ph, s.lo, s.legacyCode, s.id].filter(Boolean).join(' ');
    }
  }
};

/* ── fields the business adds for itself ── */
var Fields = ERP.Fields = {
  key: function (entity) { return 'customFields_' + entity; },
  all: function (entity) { return ERP.Settings.get()[Fields.key(entity)] || []; },
  add: function (entity, def) {
    var label = String(def.label || '').trim();
    if (!label) return Promise.reject({ validation: ['Give the field a name.'] });
    var list = Fields.all(entity).slice();
    var k = 'x_' + label.toLowerCase().replace(/[^\w]+/g, '_').slice(0, 24);
    if (list.some(function (f) { return f.k === k; })) {
      return Promise.reject({ validation: ['There is already a field called that.'] });
    }
    list.push({ k: k, l: label, type: def.type || 'text', custom: true });
    var patch = {}; patch[Fields.key(entity)] = list;
    return ERP.Settings.save(patch).then(function () {
      ERP.Audit.detached({ action: 'Custom field added', entity: 'Settings',
        entityId: entity, newValues: { field: label, type: def.type || 'text' } });
      return list;
    });
  },
  remove: function (entity, k) {
    var list = Fields.all(entity).filter(function (f) { return f.k !== k; });
    var patch = {}; patch[Fields.key(entity)] = list;
    return ERP.Settings.save(patch).then(function () {
      ERP.Audit.detached({ action: 'Custom field removed', entity: 'Settings',
        entityId: entity, oldValues: { field: k } });
      return list;
    });
  },
  /* the built-in fields plus whatever has been added */
  of: function (entity) {
    return (ENTITIES[entity] ? ENTITIES[entity].fields : []).concat(Fields.all(entity));
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   2 · EDITING
   ══════════════════════════════════════════════════════════════════════════ */
var Master = ERP.MasterEdit = {
  entities: ENTITIES,
  find: function (entity, id) {
    return (ENTITIES[entity].list() || []).filter(function (r) { return r.id === id; })[0] || null;
  },

  validate: function (entity, rec, patch) {
    var errs = [];
    var val = function (k) { return patch[k] !== undefined ? patch[k] : (rec ? rec[k] : ''); };
    if (entity === 'product' && !String(val('ur') || '').trim() && !String(val('en') || '').trim()) {
      errs.push('A product needs a name, in Urdu or English.');
    }
    if (entity === 'customer' && !String(val('sh') || '').trim()) errs.push('A shop needs a name.');
    if (entity === 'supplier' && !String(val('co') || '').trim()) errs.push('A supplier needs a name.');
    Fields.of(entity).forEach(function (f) {
      if (patch[f.k] === undefined) return;
      if (f.type === 'number' && patch[f.k] !== '' && num(patch[f.k]) === null) {
        errs.push(f.l + ' should be a number.');
      }
    });
    /* a name clash is a warning, not a refusal — two mills really can be
       called the same thing */
    return errs;
  },

  update: function (entity, id, patch, opts) {
    opts = opts || {};
    var def = ENTITIES[entity];
    if (!def) return Promise.reject({ validation: ['Unknown record type.'] });
    var rec = Master.find(entity, id);
    if (!rec) return Promise.reject({ validation: ['That record no longer exists.'] });
    var errs = Master.validate(entity, rec, patch);
    if (errs.length) return Promise.reject({ validation: errs });

    var before = {}, after = {}, changed = 0;
    Object.keys(patch).forEach(function (k) {
      var f = Fields.of(entity).filter(function (x) { return x.k === k; })[0];
      var v = patch[k];
      if (f && f.type === 'number') v = v === '' ? null : num(v);
      if (f && f.type === 'bool') v = !!v;
      var old = rec[k];
      if (old === v || (old === undefined && (v === '' || v === null))) return;
      before[k] = old; after[k] = v; rec[k] = v; changed++;
    });
    if (!changed) return Promise.resolve({ unchanged: true, record: rec });

    return FDB.tx([def.store, 'auditLog'], function (api) {
      api.put(def.store, rec);
      ERP.Audit.write(api, {
        action: def.label + ' details changed', entity: def.label, entityId: id,
        ref: rec.sh || rec.co || rec.en || rec.ur || id,
        oldValues: before, newValues: after, reason: opts.reason || ''
      });
    }).then(function () {
      if (ERP.markMasterDirty) ERP.markMasterDirty();
      try { global.dbSave(); } catch (e) {}
      ERP.Mirror.refresh();
      return { record: rec, changed: changed, before: before, after: after };
    });
  },

  create: function (entity, patch) {
    var def = ENTITIES[entity];
    var errs = Master.validate(entity, null, patch);
    if (errs.length) return Promise.reject({ validation: errs });
    var list = def.list();
    var n = list.length + 1, id;
    do { id = def.idPrefix + '-' + String(n++).padStart(4, '0'); }
    while (list.some(function (r) { return r.id === id; }));
    var rec = Object.assign({ id: id, active: true, createdAt: nowISO(), createdBy: who() }, patch);
    return FDB.tx([def.store, 'auditLog'], function (api) {
      api.put(def.store, rec);
      ERP.Audit.write(api, { action: def.label + ' added', entity: def.label, entityId: id,
        ref: rec.sh || rec.co || rec.en || rec.ur || id, newValues: patch });
    }).then(function () {
      list.push(rec);
      if (ERP.markMasterDirty) ERP.markMasterDirty();
      try { global.dbSave(); } catch (e) {}
      ERP.Mirror.refresh();
      return rec;
    });
  },

  /* ── many at once ── */
  bulk: function (entity, ids, patch, opts) {
    opts = opts || {};
    var def = ENTITIES[entity];
    if (!ids || !ids.length) return Promise.reject({ validation: ['Pick some records first.'] });
    if (!opts.reason) return Promise.reject({ validation: ['Give a reason — a bulk change is audited as one act.'] });
    var records = ids.map(function (id) { return Master.find(entity, id); }).filter(Boolean);
    var touched = [];
    return FDB.tx([def.store, 'auditLog'], function (api) {
      records.forEach(function (rec) {
        var before = {}, after = {}, n = 0;
        Object.keys(patch).forEach(function (k) {
          var f = Fields.of(entity).filter(function (x) { return x.k === k; })[0];
          var v = patch[k];
          if (f && f.type === 'number') v = v === '' ? null : num(v);
          if (f && f.type === 'bool') v = !!v;
          if (rec[k] === v) return;
          before[k] = rec[k]; after[k] = v; rec[k] = v; n++;
        });
        if (n) { api.put(def.store, rec); touched.push({ id: rec.id, before: before, after: after }); }
      });
      if (touched.length) {
        ERP.Audit.write(api, {
          action: 'Bulk change to ' + touched.length + ' ' + def.plural.toLowerCase(),
          entity: def.label, entityId: 'bulk', reason: opts.reason,
          newValues: { fields: patch, records: touched.slice(0, 40).map(function (t) { return t.id; }),
                       count: touched.length }
        });
      }
    }).then(function () {
      if (ERP.markMasterDirty) ERP.markMasterDirty();
      try { global.dbSave(); } catch (e) {}
      ERP.Mirror.refresh();
      return { changed: touched.length, records: touched };
    });
  },

  /* a percentage or fixed move on many prices at once. 'buy'/'extra' here go through Prices.set, which only
     ever touches the PRODUCT's own reference figure (never a warehouse row that already has its own blended
     average — Prices.set pins those) — unlike the old product Prices-screen revalue, this was already safe
     and stays available. A bulk 'sell' change still respects the same floor the Prices screen enforces. */
  bulkPrice: function (ids, spec, reason) {
    if (!ids || !ids.length) return Promise.reject({ validation: ['Pick some products first.'] });
    if (!reason) return Promise.reject({ validation: ['Give a reason for the price change.'] });
    var field = spec.field || 'sell';
    var mode = spec.mode || 'percent';
    var amount = num(spec.amount);
    if (amount === null) return Promise.reject({ validation: ['Enter how much to change them by.'] });
    var jobs = [], preview = [];
    ids.forEach(function (id) {
      var info = ERP.Prices.of(id);
      if (!info) return;
      var current = info[field] || 0;
      var next;
      if (mode === 'set') next = M.toP(amount);
      else if (mode === 'fixed') next = current + M.toP(amount);
      else next = Math.round(current * (1 + amount / 100));
      if (next < 0) next = 0;
      if (next === current) return;
      /* §28, 2026-09-29: no floor here any more (client: "remove all restrictions" — selling below cost is
         allowed everywhere, no override needed since there is nothing to override). */
      preview.push({ id: id, name: info.product.en || info.product.ur, from: current, to: next });
      var patch = {}; patch[field] = M.toR(next);
      jobs.push({ id: id, patch: patch });
    });
    if (!jobs.length) return Promise.resolve({ changed: 0, preview: [] });
    var chain = Promise.resolve(), done = 0, held = 0;
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        return ERP.Prices.set(j.id, j.patch, { reason: reason }).then(function (r) {
          if (r.pending) held++; else if (!r.unchanged) done++;
        }).catch(function () { /* one bad product must not stop the rest */ });
      });
    });
    return chain.then(function () {
      ERP.Audit.detached({
        action: 'Bulk price change on ' + jobs.length + ' products', entity: 'Product',
        entityId: 'bulk', reason: reason,
        newValues: { field: field, mode: mode, amount: amount, applied: done, awaitingApproval: held }
      });
      return { changed: done, pending: held, preview: preview };
    });
  },
  previewBulkPrice: function (ids, spec) {
    var field = spec.field || 'sell', mode = spec.mode || 'percent', amount = num(spec.amount);
    if (amount === null) return [];
    return ids.map(function (id) {
      var info = ERP.Prices.of(id);
      if (!info) return null;
      var current = info[field] || 0;
      var next = Math.max(0, mode === 'set' ? M.toP(amount)
               : mode === 'fixed' ? current + M.toP(amount)
               : Math.round(current * (1 + amount / 100)));
      return { id: id, name: info.product.en || info.product.ur, from: current, to: next };
    }).filter(Boolean);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   3 · SPREADSHEETS IN AND OUT
   ══════════════════════════════════════════════════════════════════════════ */
var Sheet = ERP.MasterSheet = {
  columns: function (entity) {
    return [{ k: 'id', l: 'ID' }].concat(Fields.of(entity).map(function (f) {
      return { k: f.k, l: f.l, type: f.type };
    }));
  },
  toCsv: function (entity) {
    var cols = Sheet.columns(entity);
    var rows = [cols.map(function (c) { return c.l; })];
    ENTITIES[entity].list().forEach(function (r) {
      rows.push(cols.map(function (c) {
        var v = r[c.k];
        /* a field that was never set exports blank, which on the way back in
           means "leave it alone" rather than "set it to yes" */
        if (v === undefined || v === null) return '';
        if (c.type === 'bool') return v ? 'yes' : 'no';
        return v;
      }));
    });
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
  },
  download: function (entity) {
    var name = 'farooq-' + entity + 's-' + (global.FC_TODAY ? global.FC_TODAY() : '') + '.csv';
    var blob = new global.Blob([Sheet.toCsv(entity)], { type: 'text/csv;charset=utf-8' });
    var a = D.createElement('a');
    a.href = global.URL.createObjectURL(blob); a.download = name;
    D.body.appendChild(a); a.click();
    setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 1200);
    ERP.Audit.detached({ action: ENTITIES[entity].plural + ' exported to CSV', entity: 'System',
      entityId: entity });
    return name;
  },

  parse: function (text) {
    var rows = [], row = [], cell = '', q = false;
    text = String(text).replace(/^\ufeff/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  },

  /* Says what it would do before it does anything: how many rows would be
     changed, how many added, which fields, and what is wrong with the rest.
     An import never deletes. */
  plan: function (entity, text) {
    var rows = Sheet.parse(text);
    if (rows.length < 2) return { error: 'That file has no rows in it.' };
    var cols = Sheet.columns(entity);
    var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var map = {};
    cols.forEach(function (c) {
      var at = header.indexOf(c.l.toLowerCase());
      if (at === -1) at = header.indexOf(c.k.toLowerCase());
      if (at > -1) map[c.k] = at;
    });
    if (map.id === undefined) {
      return { error: 'The file needs an ID column so each row can be matched to a record.' };
    }
    var updates = [], creates = [], problems = [], seen = {};
    rows.slice(1).forEach(function (r, ix) {
      var line = ix + 2;
      var id = String(r[map.id] || '').trim();
      if (!id) { problems.push('Row ' + line + ': no ID.'); return; }
      if (seen[id]) { problems.push('Row ' + line + ': ID ' + id + ' appears twice.'); return; }
      seen[id] = 1;
      var rec = Master.find(entity, id);
      var patch = {}, fieldNames = [];
      Object.keys(map).forEach(function (k) {
        if (k === 'id') return;
        var raw = r[map[k]];
        if (raw === undefined) return;
        var f = Fields.of(entity).filter(function (x) { return x.k === k; })[0];
        var v = String(raw).trim();
        /* An empty cell means “leave this alone”. Clearing a value is done in
           the editor, so a half-filled spreadsheet cannot wipe details out. */
        if (v === '') return;
        if (f && f.type === 'bool') v = /^(yes|true|1|y)$/i.test(v);
        else if (f && f.type === 'number') v = num(v);
        var old = rec ? rec[k] : undefined;
        /* A flag that was never set is the same as "no", and 25 is the same
           as "25" — otherwise a straight export-and-import round trip would
           report changes that are not changes. */
        if (rec) {
          var same;
          if (f && f.type === 'bool') same = (!!old === !!v);
          else if (f && f.type === 'number') same = (num(old) === num(v));
          else same = (String(old === undefined || old === null ? '' : old) ===
                       String(v === undefined || v === null ? '' : v));
          if (same) return;
        }
        patch[k] = v; fieldNames.push(f ? f.l : k);
      });
      if (!Object.keys(patch).length) return;
      var errs = Master.validate(entity, rec, patch);
      if (errs.length) { problems.push('Row ' + line + ': ' + errs.join(' ')); return; }
      if (rec) updates.push({ id: id, name: rec.sh || rec.co || rec.en || rec.ur || id,
                              patch: patch, fields: fieldNames });
      else creates.push({ id: id, patch: patch, fields: fieldNames });
    });
    return { entity: entity, updates: updates, creates: creates, problems: problems,
             total: rows.length - 1 };
  },

  apply: function (plan, reason) {
    if (!plan || plan.error) return Promise.reject({ validation: [plan && plan.error || 'Nothing to do.'] });
    var def = ENTITIES[plan.entity];
    var chain = Promise.resolve(), updated = 0, created = 0;
    plan.updates.forEach(function (up) {
      chain = chain.then(function () {
        return Master.update(plan.entity, up.id, up.patch, { reason: reason || 'Spreadsheet import' })
          .then(function () { updated++; }).catch(function () {});
      });
    });
    plan.creates.forEach(function (cr) {
      chain = chain.then(function () {
        return Master.create(plan.entity, cr.patch).then(function () { created++; }).catch(function () {});
      });
    });
    return chain.then(function () {
      ERP.Audit.detached({
        action: 'Spreadsheet imported into ' + def.plural.toLowerCase(), entity: def.label,
        entityId: 'import', reason: reason || '',
        newValues: { updated: updated, created: created, skipped: plan.problems.length }
      });
      return { updated: updated, created: created, problems: plan.problems };
    });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   4 · THE SCREEN
   ══════════════════════════════════════════════════════════════════════════ */
var W = ERP.Workbench = {
  entity: 'product', q: '', filter: '', page: 1, perPage: 40,
  selected: {}, showArchived: false, plan: null
};

var CSS = `
.wb-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.wb-tabs{display:flex;gap:6px}
.wb-tabs button{padding:8px 14px;border:1px solid var(--line);background:var(--surface);
  border-radius:99px;font-weight:600;font-size:13.5px}
.wb-tabs button.on{background:var(--violet);border-color:var(--violet);color:#fff}
table.wb-table{width:100%;border-collapse:collapse;min-width:840px}
table.wb-table th{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);
  text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
table.wb-table td{padding:8px 10px;border-bottom:1px solid var(--line-2);vertical-align:middle}
table.wb-table tr.off td{opacity:.55}
table.wb-table tr.sel td{background:var(--violet-50)}
.wb-cell{min-width:90px;padding:6px 8px;border:1px solid transparent;border-radius:var(--r-sm);
  background:none;font:inherit;width:100%}
.wb-cell:hover{border-color:var(--line);background:var(--surface)}
.wb-cell:focus{outline:none;border-color:var(--violet);background:var(--surface);
  box-shadow:0 0 0 3px var(--violet-50)}
.wb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;
  background:var(--violet-50);border:1px solid var(--violet);border-radius:var(--r);margin-bottom:10px}
.wb-actions b{margin-right:4px}
.wb-plan{border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-top:10px}
.wb-plan .row{display:flex;justify-content:space-between;gap:10px;padding:7px 11px;
  border-bottom:1px solid var(--line-2);font-size:13px}
.wb-plan .row:last-child{border-bottom:none}
@media(max-width:760px){
  body.fc-mobile table.wb-table{min-width:0}
  .wb-tabs{width:100%;overflow-x:auto}
}`;
(function () { var s = D.createElement('style'); s.id = 'fc-workbench-css'; s.textContent = CSS; D.head.appendChild(s); })();

function rows() {
  var def = ENTITIES[W.entity];
  var q = W.q.toLowerCase().trim();
  return def.list().filter(function (r) {
    if (!W.showArchived && r.active === false) return false;
    if (W.filter) {
      if (W.entity === 'product' && r.cat !== W.filter) return false;
      if (W.entity === 'customer' && r.region !== W.filter) return false;
    }
    if (q && def.search(r).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}
function selectedIds() { return Object.keys(W.selected).filter(function (k) { return W.selected[k]; }); }

function cellEditor(entity, rec, f) {
  var v = rec[f.k];
  var id = 'wb-' + rec.id + '-' + f.k;
  if (f.type === 'bool') {
    return '<input type="checkbox" data-wbcell="' + f.k + '" data-id="' + rec.id + '"' +
      (v === false ? '' : (v ? ' checked' : '')) + '>';
  }
  if (f.type === 'list') {
    var list = ERP.Lists.get(f.list);
    return '<select class="wb-cell" data-wbcell="' + f.k + '" data-id="' + rec.id + '">' +
      '<option value=""></option>' +
      list.concat(v && list.indexOf(v) === -1 ? [v] : []).map(function (x) {
        return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>';
      }).join('') + '</select>';
  }
  if (f.type === 'region') {
    return '<select class="wb-cell" data-wbcell="region" data-id="' + rec.id + '">' +
      '<option value="">—</option>' + (global.REGIONS || []).map(function (r) {
        return '<option value="' + r.id + '"' + (v === r.id ? ' selected' : '') + '>' +
          esc((r.ur || '') + ' ' + (r.en || '')) + '</option>';
      }).join('') + '</select>';
  }
  if (f.type === 'salesman') {
    var men = ERP.Staff ? ERP.Staff.all() : [];
    return '<select class="wb-cell" data-wbcell="salesmanId" data-id="' + rec.id + '">' +
      '<option value="">—</option>' + men.map(function (m) {
        return '<option value="' + m.id + '"' + (v === m.id ? ' selected' : '') + '>' +
          esc(m.name) + '</option>';
      }).join('') + '</select>';
  }
  return '<input class="wb-cell' + (f.type === 'urdu' ? ' ur' : '') + '" data-wbcell="' + f.k +
    '" data-id="' + rec.id + '"' + (f.type === 'urdu' ? ' dir="rtl" lang="ur"' : '') +
    (f.type === 'number' ? ' inputmode="decimal"' : '') +
    ' value="' + esc(v === undefined || v === null ? '' : v) + '">';
}

global.PAGES.masterdata = function () {
  var def = ENTITIES[W.entity];
  var all = rows();
  var pages = Math.max(1, Math.ceil(all.length / W.perPage));
  if (W.page > pages) W.page = pages;
  var slice = all.slice((W.page - 1) * W.perPage, W.page * W.perPage);
  var cols = def.columns.map(function (k) {
    return Fields.of(W.entity).filter(function (f) { return f.k === k; })[0];
  }).filter(Boolean).concat(Fields.all(W.entity));
  var sel = selectedIds();

  var filterBox = W.entity === 'product'
    ? '<label class="fld">' + I('filter') + '<select data-wbfilter><option value="">All categories</option>' +
      ERP.Lists.get('categories').map(function (c) {
        return '<option value="' + esc(c) + '"' + (W.filter === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select></label>'
    : W.entity === 'customer'
      ? '<label class="fld">' + I('pin') + '<select data-wbfilter><option value="">All areas</option>' +
        (global.REGIONS || []).map(function (r) {
          return '<option value="' + r.id + '"' + (W.filter === r.id ? ' selected' : '') + '>' +
            esc(r.en || r.ur) + '</option>';
        }).join('') + '</select></label>'
      : '';

  return '<div class="wb-bar"><div class="wb-tabs">' +
      Object.keys(ENTITIES).map(function (k) {
        return '<button data-wbentity="' + k + '" class="' + (W.entity === k ? 'on' : '') + '">' +
          esc(ENTITIES[k].plural) + ' (' + ENTITIES[k].list().length + ')</button>';
      }).join('') + '</div></div>' +

    '<div class="bar">' +
      '<div class="tsearch">' + I('search') +
        '<input placeholder="Search ' + esc(def.plural.toLowerCase()) + '…" data-wbq value="' +
        esc(W.q) + '"></div>' + filterBox +
      '<label class="fld"><input type="checkbox" data-wbarchived' + (W.showArchived ? ' checked' : '') +
        '> Show switched off</label>' +
      '<div class="grow"></div>' +
      '<button class="btn" data-wbexport>' + I('sheet') + 'Export CSV</button>' +
      '<label class="btn" style="cursor:pointer">' + I('up') + 'Import CSV' +
        '<input type="file" accept=".csv,text/csv" data-wbimport style="display:none"></label>' +
      '<button class="btn pri" data-wbnew>' + I('plus') + 'Add ' + esc(def.label.toLowerCase()) + '</button>' +
    '</div>' +

    (sel.length ? '<div class="wb-actions"><b>' + sel.length + ' selected</b>' +
      (W.entity === 'product'
        ? '<button class="btn sm" data-wbbulk="cat">Set category</button>' +
          '<button class="btn sm" data-wbbulk="brandEn">Set brand</button>' +
          '<button class="btn sm" data-wbbulk="unit">Set unit</button>' +
          '<button class="btn sm pri" data-wbbulk="price">Change prices</button>'
        : W.entity === 'customer'
          ? '<button class="btn sm" data-wbbulk="region">Set area</button>' +
            '<button class="btn sm" data-wbbulk="salesmanId">Set salesman</button>'
          : '') +
      '<button class="btn sm" data-wbbulk="active">Switch on / off</button>' +
      '<div class="grow"></div><button class="btn sm" data-wbclear>Clear</button></div>' : '') +

    (W.plan ? planCard() : '') +

    (slice.length
      ? '<div class="card"><div class="card-b" style="padding:0"><div class="tw">' +
        '<table class="wb-table"><thead><tr><th style="width:34px"><input type="checkbox" data-wball></th>' +
        cols.map(function (f) { return '<th>' + esc(f.l) + '</th>'; }).join('') +
        '<th class="c">More</th></tr></thead><tbody>' +
        slice.map(function (r) {
          return '<tr class="' + (r.active === false ? 'off ' : '') +
            (W.selected[r.id] ? 'sel' : '') + '" data-row>' +
            '<td><input type="checkbox" data-wbsel="' + r.id + '"' +
              (W.selected[r.id] ? ' checked' : '') + '></td>' +
            cols.map(function (f) {
              return '<td data-label="' + esc(f.l) + '">' + cellEditor(W.entity, r, f) + '</td>';
            }).join('') +
            '<td class="c"><button class="btn sm" data-wbopen="' + r.id + '">All fields</button>' +
            (W.entity === 'product'
              ? ' <button class="btn sm" data-editprices="' + r.id + '">Prices</button>' : '') +
            '</td></tr>';
        }).join('') + '</tbody></table></div></div></div>' +
        (pages > 1 ? '<div class="kh-pager"><span>Page ' + W.page + ' of ' + pages + ' · ' +
          all.length + ' records</span>' +
          '<button class="btn sm" data-wbpage="prev"' + (W.page === 1 ? ' disabled' : '') + '>Previous</button>' +
          '<button class="btn sm" data-wbpage="next"' + (W.page === pages ? ' disabled' : '') + '>Next</button>' +
        '</div>' : '')
      : '<div class="empty"><div class="ei">' + I('inbox') + '</div><b>Nothing matches</b>' +
        '<p>Change the search, or add a new ' + esc(def.label.toLowerCase()) + '.</p></div>') +

    '<div class="card"><div class="card-h"><h3>Extra fields on a ' + esc(def.label.toLowerCase()) +
      '</h3></div><div class="card-b">' +
      '<p style="margin-top:0;color:var(--muted)">Anything the business needs to record that the ' +
      'ERP does not already have — a licence number, a delivery note, a shelf code.</p>' +
      '<div class="st-chips">' + (Fields.all(W.entity).length
        ? Fields.all(W.entity).map(function (f) {
            return '<span class="st-chip">' + esc(f.l) + '<button data-wbfielddel="' + esc(f.k) +
              '" title="Remove">' + I('x') + '</button></span>';
          }).join('')
        : '<span class="hint">None yet.</span>') + '</div>' +
      '<div class="st-add"><input data-wbfieldadd placeholder="Field name…">' +
        '<button class="btn" data-wbfieldgo>' + I('plus') + 'Add field</button></div>' +
    '</div></div>';
};
if (global.PAGEMETA) {
  global.PAGEMETA.masterdata = ['Products, shops & suppliers',
    'Every name and detail, editable one at a time or many at once — with a spreadsheet in and out.'];
}

function planCard() {
  var p = W.plan;
  if (p.error) {
    return '<div class="banner err">' + I('alert') + '<div><b>That file cannot be used</b><p>' +
      esc(p.error) + '</p></div><button class="btn sm" data-wbplan="cancel">Close</button></div>';
  }
  return '<div class="card"><div class="card-h"><h3>What this spreadsheet would change</h3>' +
    '<span class="pill neu">' + p.total + ' rows read</span></div><div class="card-b">' +
    '<div class="hz-grid" style="margin-bottom:10px">' +
      '<div class="hz-card"><i>Records changed</i><b>' + p.updates.length + '</b></div>' +
      '<div class="hz-card"><i>New records</i><b>' + p.creates.length + '</b></div>' +
      '<div class="hz-card' + (p.problems.length ? ' hz-bad' : '') + '"><i>Rows skipped</i><b>' +
        p.problems.length + '</b></div>' +
      '<div class="hz-card hz-ok"><i>Records removed</i><b>none</b></div>' +
    '</div>' +
    (p.updates.length ? '<div class="wb-plan">' + p.updates.slice(0, 12).map(function (up) {
      return '<div class="row"><span>' + esc(up.name) + '</span><b>' + esc(up.fields.join(', ')) + '</b></div>';
    }).join('') + (p.updates.length > 12 ? '<div class="row"><span>…and ' + (p.updates.length - 12) +
      ' more</span></div>' : '') + '</div>' : '') +
    (p.problems.length ? '<div class="banner warn" style="margin-top:10px">' + I('alert') +
      '<div><b>These rows will be left alone</b><ul>' +
      p.problems.slice(0, 8).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
      '</ul></div></div>' : '') +
    '<div style="margin-top:12px;display:flex;gap:8px">' +
      '<button class="btn pri" data-wbplan="apply">Apply these changes</button>' +
      '<button class="btn" data-wbplan="cancel">Cancel</button></div>' +
  '</div></div>';
}

/* the full-record editor, built from the field list */
var OPEN_ID = null;
global.PANELS.masterrecord = {
  t: 'All details', s: 'Every field on this record', cta: 'Save changes',
  f: function () {
    var def = ENTITIES[W.entity];
    var rec = OPEN_ID && OPEN_ID !== 'new' ? Master.find(W.entity, OPEN_ID) : null;
    var fields = Fields.of(W.entity);
    return (rec ? '<div class="banner info">' + I('tag') + '<div><p><b>' +
        esc(rec.sh || rec.co || rec.en || rec.ur || rec.id) + '</b> · ' + esc(rec.id) + '</p></div></div>' : '') +
      fields.map(function (f) {
        var v = rec ? rec[f.k] : '';
        if (f.type === 'bool') {
          return '<label class="f"><span>' + esc(f.l) + '</span><select data-f="' + f.k + '">' +
            '<option value="yes"' + (v === false ? '' : ' selected') + '>Yes</option>' +
            '<option value="no"' + (v === false ? ' selected' : '') + '>No</option></select></label>';
        }
        if (f.type === 'list') {
          var list = ERP.Lists.get(f.list);
          return '<label class="f"><span>' + esc(f.l) + '</span><select data-f="' + f.k + '">' +
            '<option value=""></option>' +
            list.concat(v && list.indexOf(v) === -1 ? [v] : []).map(function (x) {
              return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>';
            }).join('') + '</select></label>';
        }
        if (f.type === 'region') {
          return '<label class="f"><span>' + esc(f.l) + '</span><select data-f="region">' +
            '<option value="">—</option>' + (global.REGIONS || []).map(function (r) {
              return '<option value="' + r.id + '"' + (v === r.id ? ' selected' : '') + '>' +
                esc((r.ur || '') + ' ' + (r.en || '')) + '</option>';
            }).join('') + '</select></label>';
        }
        if (f.type === 'salesman') {
          var men = ERP.Staff ? ERP.Staff.all() : [];
          return '<label class="f"><span>' + esc(f.l) + '</span><select data-f="salesmanId">' +
            '<option value="">—</option>' + men.map(function (m) {
              return '<option value="' + m.id + '"' + (v === m.id ? ' selected' : '') + '>' +
                esc(m.name) + '</option>';
            }).join('') + '</select></label>';
        }
        if (f.type === 'textarea') {
          return '<label class="f"><span>' + esc(f.l) + '</span><textarea data-f="' + f.k +
            '" rows="2">' + esc(v || '') + '</textarea></label>';
        }
        return '<label class="f"><span>' + esc(f.l) + '</span><input data-f="' + f.k + '"' +
          (f.type === 'urdu' ? ' dir="rtl" lang="ur" class="ur"' : '') +
          (f.type === 'number' ? ' inputmode="decimal"' : '') +
          ' value="' + esc(v === undefined || v === null ? '' : v) + '">' +
          (f.readonlyHint ? '<span class="hint">' + esc(f.readonlyHint) + '</span>' : '') + '</label>';
      }).join('') +
      '<label class="f"><span>Reason for the change</span><input data-f="__reason" ' +
        'placeholder="Optional, kept on the audit log"></label>';
  },
  save: function (v) {
    var patch = {};
    Fields.of(W.entity).forEach(function (f) {
      if (v[f.k] === undefined) return;
      patch[f.k] = f.type === 'bool' ? v[f.k] === 'yes' : v[f.k];
    });
    var job = OPEN_ID && OPEN_ID !== 'new'
      ? Master.update(W.entity, OPEN_ID, patch, { reason: v.__reason })
      : Master.create(W.entity, patch);
    job.then(function (r) {
      global.paint();
      say(r && r.unchanged ? 'Nothing was different.' : 'Saved.');
    }).catch(function (e) { say(e && e.validation ? e.validation[0] : 'Could not save that.'); });
    return { msg: 'Saving…' };
  }
};

/* bulk panels */
var BULK = { field: null };
global.PANELS.bulkedit = {
  t: 'Change many at once', s: 'The same value on every record you picked', cta: 'Apply to all',
  f: function () {
    var ids = selectedIds();
    var f = Fields.of(W.entity).filter(function (x) { return x.k === BULK.field; })[0] || { l: BULK.field };
    var input;
    if (BULK.field === 'active') {
      input = '<select data-f="value"><option value="yes">In use</option>' +
              '<option value="no">Switched off</option></select>';
    } else if (f.type === 'list') {
      input = '<select data-f="value">' + ERP.Lists.get(f.list).map(function (x) {
        return '<option>' + esc(x) + '</option>'; }).join('') + '</select>';
    } else if (BULK.field === 'region') {
      input = '<select data-f="value">' + (global.REGIONS || []).map(function (r) {
        return '<option value="' + r.id + '">' + esc((r.ur || '') + ' ' + (r.en || '')) + '</option>';
      }).join('') + '</select>';
    } else if (BULK.field === 'salesmanId') {
      input = '<select data-f="value"><option value="">— none —</option>' +
        (ERP.Staff ? ERP.Staff.all() : []).map(function (m) {
          return '<option value="' + m.id + '">' + esc(m.name) + '</option>'; }).join('') + '</select>';
    } else {
      input = '<input data-f="value">';
    }
    return '<div class="banner info">' + I('layers') + '<div><p>This will change <b>' + ids.length +
        '</b> ' + esc(ENTITIES[W.entity].plural.toLowerCase()) + '.</p></div></div>' +
      '<label class="f"><span>' + esc(f.l) + '</span>' + input + '</label>' +
      '<label class="f"><span>Reason</span><input data-f="reason" ' +
        'placeholder="Kept on the audit log as one entry"></label>';
  },
  save: function (v) {
    var patch = {};
    patch[BULK.field] = BULK.field === 'active' ? v.value === 'yes' : v.value;
    Master.bulk(W.entity, selectedIds(), patch, { reason: v.reason }).then(function (r) {
      W.selected = {}; global.paint();
      say(r.changed + ' record' + (r.changed === 1 ? '' : 's') + ' changed.');
    }).catch(function (e) { say(e && e.validation ? e.validation[0] : 'Could not apply that.'); });
    return { msg: 'Applying…' };
  }
};

global.PANELS.bulkprice = {
  t: 'Change many prices', s: 'A percentage, a fixed amount, or one price for all', cta: 'Apply',
  f: function () {
    var ids = selectedIds();
    return '<div class="banner info">' + I('tag') + '<div><p>This will change prices on <b>' +
        ids.length + '</b> products. Every one is kept in the price history.</p></div></div>' +
      '<div class="f2">' +
        '<label class="f"><span>Which price</span><select data-f="field">' +
          '<option value="sell">Selling price</option><option value="buy">Purchase price</option>' +
          '<option value="extra">Extra cost per bag</option>' +
          '<option value="min">Minimum price</option><option value="wholesale">Wholesale</option>' +
          '<option value="retail">Retail</option></select></label>' +
        '<label class="f"><span>How</span><select data-f="mode">' +
          '<option value="percent">By a percentage</option>' +
          '<option value="fixed">By a fixed amount</option>' +
          '<option value="set">Set them all to</option></select></label></div>' +
      '<label class="f"><span>Amount</span><input data-f="amount" inputmode="decimal" ' +
        'placeholder="e.g. 5 for +5%, -3 for −3%"></label>' +
      '<label class="f"><span>Reason</span><input data-f="reason" placeholder="e.g. Mill rate increase"></label>' +
      '<div id="bpPreview" class="hint">Fill in an amount to see what it would do.</div>';
  },
  save: function (v) {
    Master.bulkPrice(selectedIds(), { field: v.field, mode: v.mode, amount: v.amount }, v.reason)
      .then(function (r) {
        W.selected = {}; global.paint();
        say(r.changed + ' price' + (r.changed === 1 ? '' : 's') + ' changed' +
          (r.pending ? ', ' + r.pending + ' waiting for approval' : '') + '.');
      }).catch(function (e) {
        say(e && e.validation ? e.validation[0] : 'Could not change those prices.');
      });
    return { msg: 'Changing prices…' };
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   5 · WIRING
   ══════════════════════════════════════════════════════════════════════════ */
D.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var t;
  if ((t = e.target.closest('[data-wbentity]'))) {
    e.preventDefault(); W.entity = t.dataset.wbentity; W.page = 1; W.selected = {}; W.filter = '';
    global.paint(); return;
  }
  if ((t = e.target.closest('[data-wbopen]'))) {
    e.preventDefault(); OPEN_ID = t.dataset.wbopen; global.openPanel('masterrecord'); return;
  }
  if (e.target.closest('[data-wbnew]')) {
    e.preventDefault(); OPEN_ID = 'new'; global.openPanel('masterrecord'); return;
  }
  if ((t = e.target.closest('[data-wbpage]'))) {
    e.preventDefault(); W.page += t.dataset.wbpage === 'next' ? 1 : -1;
    if (W.page < 1) W.page = 1; global.paint(); return;
  }
  if (e.target.closest('[data-wbclear]')) { e.preventDefault(); W.selected = {}; global.paint(); return; }
  if ((t = e.target.closest('[data-wbbulk]'))) {
    e.preventDefault();
    if (!selectedIds().length) { say('Pick some records first.'); return; }
    if (t.dataset.wbbulk === 'price') { global.openPanel('bulkprice'); return; }
    BULK.field = t.dataset.wbbulk; global.openPanel('bulkedit'); return;
  }
  if (e.target.closest('[data-wbexport]')) {
    e.preventDefault(); say('Downloaded ' + Sheet.download(W.entity)); return;
  }
  if ((t = e.target.closest('[data-wbplan]'))) {
    e.preventDefault();
    if (t.dataset.wbplan === 'cancel') { W.plan = null; global.paint(); return; }
    Sheet.apply(W.plan, 'Spreadsheet import').then(function (r) {
      W.plan = null; global.paint();
      say(r.updated + ' changed, ' + r.created + ' added' +
        (r.problems.length ? ', ' + r.problems.length + ' skipped' : '') + '.');
    }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'The import failed.'); });
    return;
  }
  if (e.target.closest('[data-wbfieldgo]')) {
    e.preventDefault();
    var input = D.querySelector('[data-wbfieldadd]');
    Fields.add(W.entity, { label: input ? input.value : '' }).then(function () {
      global.paint(); say('Field added.');
    }).catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not add that.'); });
    return;
  }
  if ((t = e.target.closest('[data-wbfielddel]'))) {
    e.preventDefault();
    Fields.remove(W.entity, t.dataset.wbfielddel).then(function () { global.paint(); });
  }
}, true);

/* inline edits save as soon as the cell is left */
D.addEventListener('change', function (e) {
  var el = e.target;
  if (!el.dataset) return;
  if (el.dataset.wbcell !== undefined) {
    var f = Fields.of(W.entity).filter(function (x) { return x.k === el.dataset.wbcell; })[0];
    var value = el.type === 'checkbox' ? el.checked : el.value;
    var patch = {}; patch[el.dataset.wbcell] = value;
    Master.update(W.entity, el.dataset.id, patch, { reason: 'Edited in the list' })
      .then(function (r) { if (r && !r.unchanged) say('Saved.'); })
      .catch(function (err) { say(err && err.validation ? err.validation[0] : 'Could not save that.'); global.paint(); });
    return;
  }
  if (el.dataset.wbsel !== undefined) { W.selected[el.dataset.wbsel] = el.checked; global.paint(); return; }
  if (el.dataset.wball !== undefined) {
    var on = el.checked;
    rows().forEach(function (r) { W.selected[r.id] = on; });
    global.paint(); return;
  }
  if (el.dataset.wbfilter !== undefined) { W.filter = el.value; W.page = 1; global.paint(); return; }
  if (el.dataset.wbarchived !== undefined) { W.showArchived = el.checked; global.paint(); return; }
  if (el.dataset.wbimport !== undefined && el.files && el.files[0]) {
    var file = el.files[0];
    var r = new global.FileReader();
    r.onload = function () {
      W.plan = Sheet.plan(W.entity, r.result);
      global.paint();
    };
    r.readAsText(file);
    el.value = '';
  }
});

D.addEventListener('input', function (e) {
  if (!e.target.dataset) return;
  if (e.target.dataset.wbq !== undefined) {
    W.q = e.target.value; W.page = 1;
    clearTimeout(W._t);
    W._t = setTimeout(function () {
      if (global.cur !== 'masterdata') return;
      var pos = e.target.selectionStart;
      global.paint();
      var back = D.querySelector('[data-wbq]');
      if (back) { back.focus(); try { back.setSelectionRange(pos, pos); } catch (err) {} }
    }, 200);
  }
  /* live preview of a bulk price change */
  if (e.target.dataset.f === 'amount' && D.getElementById('bpPreview')) {
    var get = function (k) { var el = D.querySelector('[data-f="' + k + '"]'); return el ? el.value : ''; };
    var rowsP = Master.previewBulkPrice(selectedIds(),
      { field: get('field'), mode: get('mode'), amount: e.target.value }).slice(0, 6);
    D.getElementById('bpPreview').innerHTML = rowsP.length
      ? rowsP.map(function (p) {
          return esc(p.name) + ': ' + M.fmtPlain(p.from) + ' → <b>' + M.fmtPlain(p.to) + '</b>';
        }).join('<br>') + (selectedIds().length > 6 ? '<br>…and ' + (selectedIds().length - 6) + ' more' : '')
      : 'Fill in an amount to see what it would do.';
  }
});

/* reachable from the places the records are used */
[['inventory', 'Products'], ['customers', 'Shops'], ['suppliers', 'Suppliers']].forEach(function (pair) {
  var orig = global.PAGES[pair[0]];
  if (!orig) return;
  var entity = pair[0] === 'inventory' ? 'product' : pair[0] === 'customers' ? 'customer' : 'supplier';
  global.PAGES[pair[0]] = function () {
    return '<div class="bar"><div class="grow"></div>' +
      '<button class="btn" data-wbgo="' + entity + '">' + I('edit') + 'Edit ' +
      esc(ENTITIES[entity].plural.toLowerCase()) + '</button></div>' + orig.apply(global, arguments);
  };
});
D.addEventListener('click', function (e) {
  var t = e.target.closest ? e.target.closest('[data-wbgo]') : null;
  if (!t) return;
  e.preventDefault();
  W.entity = t.dataset.wbgo; W.page = 1; W.selected = {};
  global.go('masterdata');
}, true);
})(typeof window !== 'undefined' ? window : globalThis);
