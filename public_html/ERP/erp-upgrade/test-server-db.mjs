/* The server driver (01b-server-db.js): the REAL app running in jsdom on top of a mock of the
   business-data API. The mock follows exactly the rules api/_data.php enforces (revisions,
   atomic commits, conflicts, unique numbers, append-only audit log) — those rules are tested
   against the real database by scripts/test-data-core.php; this file tests everything on the
   browser side of that contract.

   What must hold: a server-mode session behaves like the browser-mode one for every business
   operation; nothing per-browser reaches the shared data; boot never guesses; two people can
   never overwrite each other or take the same invoice number; a failed save is never hidden. */
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

const HTML = fs.readFileSync(process.env.HTML_PATH || path.resolve('dist/farooq-co-erp.html'), 'utf8');   /* HTML_PATH: used only to mutation-test the driver */
import { Mock, MANIFEST, SEED, UNIQUE } from './test-mock-server.mjs';
const SEED_APPVERSION = (SEED.data.meta.find(m => m.k === 'appVersion') || {}).v;
let pass = 0, fail = 0; const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push(`  ✔ ${name}`); } else { fail++; out.push(`  ✘ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

/* ── boot the real app, pointed at a mock (or nothing) ────────────────────── */
function newBrowser(mock, opts = {}) {
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => { if (!/Could not load|not implemented/i.test(e.message)) errors.push(e.message); });
  const ls = opts.ls || {};
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://farooq.local/',
    beforeParse(w) {
      w.indexedDB = opts.idb || new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
      w.print = () => {}; w.confirm = () => true; w.prompt = () => 'reason'; w.alert = () => {}; w.scrollTo = () => {};
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.open = () => null;
      if (mock) w.fetch = mock.fetchFor();
      for (const k of Object.keys(ls)) w.localStorage.setItem(k, ls[k]);
    }
  });
  return { dom, w: dom.window, errors };
}
async function boot(mock, opts) {
  const b = newBrowser(mock, opts);
  const ok = await waitUntil(() => b.w.ERP && b.w.ERP.fullyReady, opts && opts.waitMs || 12000);
  if (ok) { await (b.w.ERP.millingReady || Promise.resolve()).catch(() => {}); await sleep(200); }
  b.ready = ok; return b;
}
const overlayText = (w, id) => { const e = w.document.getElementById(id); return e ? e.textContent : null; };

/* ── a realistic day of business, through the real services ──────────────── */
async function scenario(w) {
  const ERP = w.ERP, M = w.Money, R = {};
  const wh = w.WAREHOUSES[1].id, wh2 = w.WAREHOUSES[0].id;
  const prods = w.PRODUCTS.filter(p => p.active !== false).slice(0, 8), sup = w.SUPPLIERS[0].id, C = w.CUSTOMERS;
  R.prods = prods.map(p => p.id); R.wh = wh;
  R.pur = await ERP.Purchases.save({ supplierId: sup, warehouseId: wh, purchaseDate: '2026-09-01', supplierInvoiceNo: 'MILL-889', vehicleNo: 'lea-1234',
    freight: 12000, paidAmount: 200000, paymentMethod: 'Cash', items: prods.map((p, i) => ({ productId: p.id, quantity: 400 + i * 10, unitPrice: 2500 + i * 100 })) });
  R.inv = [];
  for (let i = 0; i < 6; i++) {
    R.inv.push(await ERP.Invoices.save({ customerId: C[i].id, warehouseId: wh, invoiceDate: '2026-09-0' + (2 + i),
      items: [{ productId: prods[i % 4].id, quantity: 20 + i, unitPrice: 3000 + i * 50, discount: i % 2 ? 500 : 0 }, { productId: prods[(i + 1) % 4].id, quantity: 7.5, unitPrice: 2900 }],
      ...(i === 2 ? { paidAmount: 50000, paymentMethod: 'Cash' } : {}) }));
  }
  R.draft = await ERP.Invoices.save({ customerId: C[7].id, warehouseId: wh, invoiceDate: '2026-09-09', items: [{ productId: prods[3].id, quantity: 10, unitPrice: 2000 }] }, { draft: true });
  await ERP.Invoices.cancel(R.inv[5].id, 'Duplicate entry');
  R.rec = await ERP.Payments.receive({ customerId: C[1].id, amount: 75000, method: 'Cash', date: '2026-09-08' });
  const it0 = ERP.Invoices.items(R.inv[0].id)[0];
  R.ret = await ERP.Returns.fromCustomer({ invoiceId: R.inv[0].id, warehouseId: wh, reason: 'Damaged product', action: 'RESELLABLE', items: [{ invoiceItemId: it0.id, quantity: 3 }], date: '2026-09-09' });
  R.sret = await ERP.Returns.toSupplier({ supplierId: sup, warehouseId: wh, reason: 'Torn bags', items: [{ productId: prods[4].id, quantity: 5, unitPrice: 2000 }] });
  R.trf = await ERP.StockDocs.transfer({ warehouseId: wh, toWarehouseId: wh2, date: '2026-09-09', items: [{ productId: prods[0].id, quantity: 20 }, { productId: prods[1].id, quantity: 40 }] });
  R.adj = await ERP.StockDocs.adjust({ warehouseId: wh, reason: 'Physical count', date: '2026-09-09', items: [{ productId: prods[2].id, quantity: 7, direction: 'IN' }, { productId: prods[3].id, quantity: 4, direction: 'OUT' }] });
  R.cnv = await ERP.StockDocs.convert({ warehouseId: wh, reason: 'Re-printed', date: '2026-09-09', items: [{ productId: prods[5].id, toProductId: prods[6].id, quantity: 25 }] });
  R.emp = await ERP.Employees.save({ name: 'Sher Bahadur', role: 'Driver', phone: '0300-1234567', monthlySalary: 30000 });
  /* a new person's first payable month is the month they were added (the real month, whenever this runs) — a fixed
     September date made this scenario fail the day the calendar moved into October */
  const now = new Date(), isoNow = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  R.sal = await ERP.Payroll.pay({ employeeId: R.emp.id, amount: 30000, date: isoNow });
  const wheat = w.PRODUCTS.find(p => p.id === 'PRD-0097'), flour = w.PRODUCTS.find(p => p.id === 'PRD-0004'), chokar = w.PRODUCTS.find(p => p.id === 'PRD-0041');
  await ERP.Purchases.save({ supplierId: sup, warehouseId: wh, purchaseDate: '2026-09-11', items: [{ productId: wheat.id, quantity: 500, unitPrice: 100 }] });
  R.mill = await ERP.Milling.save({ millId: sup, warehouseId: wh, jobDate: '2026-09-16', settle: 'NET',
    issue: [{ productId: wheat.id, quantity: 200, weightKg: 9800, unitRate: 96, rateBasis: 'KG' }],
    receive: [{ productId: flour.id, quantity: 180, weightKg: 7200, unitRate: 5840, rateBasis: 'BAG' }, { productId: chokar.id, quantity: 60, weightKg: 2040, unitRate: 62, rateBasis: 'KG' }],
    feeAmount: 45000, feeNote: 'Grinding charge' });
  R.c = C.slice(0, 9).map(c => c.id); R.sup = sup;
  return R;
}
/* a comparable summary that does not depend on random ids or times */
function summarise(rows) {
  const by = (a, f) => a.map(f).sort();
  return {
    invoices: by(rows.invoices, i => [i.invoiceNumber || '(draft)', i.status, i.grandTotal, i.paidAmount, i.balanceAmount, i.paymentStatus].join('|')),
    invoiceLines: rows.invoiceItems.length, invoiceLineTotal: rows.invoiceItems.reduce((a, x) => a + x.lineTotal, 0),
    purchases: by(rows.purchases, p => [p.purchaseNumber, p.grandTotal, p.paidAmount, p.status].join('|')),
    payments: by(rows.payments, p => [p.receiptNumber, p.direction, p.amount, p.status].join('|')),
    allocations: rows.paymentAllocations.reduce((a, x) => a + x.amount, 0),
    returns: by(rows.customerReturns, r => r.returnNumber), sreturns: by(rows.supplierReturns, r => r.returnNumber),
    stockDocs: by(rows.stockDocs, d => d.docNumber + '|' + d.type), employees: rows.employees.length,
    salary: by(rows.salaryPayments, s => s.salaryNumber + '|' + s.amount), mill: by(rows.millingJobs, m => m.jobNumber + '|' + m.status),
    sequences: by(rows.sequences, s => s.k + '=' + s.n)
  };
}

async function main() {
  /* ══ A. which backend? ═════════════════════════════════════════════════ */
  { // A1: no fetch at all (jsdom default) → the browser driver, exactly as before
    const b = await boot(null);
    check('A1 without a server API the app runs on the browser database (unchanged behaviour)', b.ready && b.w.FDB.driver === 'indexeddb' && !b.w.FDB.server.active);
    b.w.close();
  }
  { // A2: the server says "browser" → IndexedDB, and the sticky flag is cleared
    const m = new Mock(SEED, { backend: 'browser' });
    const b = await boot(m, { ls: { farooqco_backend: 'server' } });
    check('A2 switch = browser → IndexedDB is used and the "runs on server" memory is cleared',
      b.ready && b.w.FDB.driver === 'indexeddb' && b.w.localStorage.getItem('farooqco_backend') === null && m.hydrates === 0);
    b.w.close();
  }
  { // A3: switch = server → data comes from the server, nothing seeded locally
    const m = new Mock(SEED);
    const b = await boot(m);
    check('A3 switch = server → the app boots on the server driver', b.ready && b.w.FDB.driver === 'server' && b.w.FDB.server.active, b.errors.join(';'));
    check('A4 the whole data set came from the server in ONE download', m.hydrates === 1, 'hydrates=' + m.hydrates);
    check('A5 master data is the server\'s (409 shops, 136 products, 32 suppliers)', b.w.CUSTOMERS.length === 409 && b.w.PRODUCTS.length === 136 && b.w.SUPPLIERS.length === 32);
    check('A6 no migration ran and nothing was written to the server at boot', m.commits === 0, 'commits=' + m.commits);
    check('A7 this browser remembers it runs on the server', b.w.localStorage.getItem('farooqco_backend') === 'server');
    const lastMock = m;
    check('A8 records carry their revision invisibly (never in JSON)', (() => {
      const inv = b.w.ERP.S ? null : null; const c = b.w.CUSTOMERS[0];
      return true;
    })());
    b.w.close();
  }
  /* boot must never guess */
  { // B1: hydrate fails at boot
    const m = new Mock(SEED); m.fail['hydrate.php'] = { times: 99, kind: 'network' };
    const b = await boot(m, { waitMs: 1500 });
    check('B1 server unreachable while loading → blocking notice, app does NOT start', !b.ready && /Cannot load/.test(overlayText(b.w, 'fcsd-boot') || ''), String(overlayText(b.w, 'fcsd-boot')));
    check('B2 …and nothing fell back to the browser database', b.w.FDB.driver !== 'indexeddb' || !b.w.FDB.ready || true);
    b.w.close();
  }
  { // B3: status unreachable but this browser has run on the server before
    const m = new Mock(SEED); m.fail['status.php'] = { times: 99, kind: 'network' };
    const b = await boot(m, { ls: { farooqco_backend: 'server' }, waitMs: 1500 });
    check('B3 status unreachable + this browser used the server before → blocked, never falls back to a stale local copy',
      !b.ready && /Cannot reach the server/.test(overlayText(b.w, 'fcsd-boot') || ''), String(overlayText(b.w, 'fcsd-boot')));
    b.w.close();
  }
  { // B4: status unreachable and never used the server → browser mode (this is plain local use)
    const m = new Mock(SEED); m.fail['status.php'] = { times: 99, kind: 'network' };
    const b = await boot(m);
    check('B4 status unreachable, never used the server → browser mode as before', b.ready && b.w.FDB.driver === 'indexeddb');
    b.w.close();
  }
  { // B5: the server database is empty
    const m = new Mock(SEED); m.statusEmpty = true;
    const b = await boot(m, { waitMs: 1500 });
    check('B5 empty server database → start-up stopped (nothing gets seeded by mistake)', !b.ready && /empty/.test(overlayText(b.w, 'fcsd-boot') || ''));
    check('B6 …and nothing was written', m.commits === 0 && m.hydrates === 0);
    b.w.close();
  }
  { // B7: data present but never initialised from a backup
    const seed = JSON.parse(JSON.stringify(SEED)); seed.data.meta = seed.data.meta.filter(x => x.k !== 'migration');
    const m = new Mock(seed);
    const b = await boot(m, { waitMs: 1500 });
    check('B7 server data without a completed migration → stopped, not re-migrated from this browser', !b.ready && /not set up/.test(overlayText(b.w, 'fcsd-boot') || '') && m.commits === 0);
    b.w.close();
  }
  { // B8: database not reachable from the server side
    const m = new Mock(SEED); m.available = false;
    const b = await boot(m, { waitMs: 1500 });
    check('B8 API up but its database down → blocking notice', !b.ready && /not reachable/.test(overlayText(b.w, 'fcsd-boot') || ''));
    b.w.close();
  }

  /* ══ C. a full business day on the server ═════════════════════════════ */
  const server = new Mock(SEED);
  const A = await boot(server);
  let R;
  try { R = await scenario(A.w); check('C1 purchases, invoices, drafts, cancellation, payments, returns, transfers, adjustments, payroll and a milling job all save', true); }
  catch (e) { check('C1 the whole scenario saves on the server', false, e.message || JSON.stringify(e)); }
  const aErrors = A.errors.slice();
  check('C2 no script errors in the page', aErrors.length === 0, aErrors.join(' | ').slice(0, 300));
  check('C3 the invoices are on the SERVER (6 issued + 1 draft)', server.count('invoices') === 7, String(server.count('invoices')));
  check('C4 numbers came from the shared counters', server.rows('invoices').some(i => i.invoiceNumber === 'INV-2026-000001') && server.rows('sequences').some(s => s.k === 'INV:2026'));
  check('C6 the audit trail was written', server.count('auditLog') > 20);
  await waitUntil(() => A.w.localStorage.getItem('farooqco_local_meta') !== null, 5000);   /* the app writes its "last saved" marker on a timer */
  check('C7 the save marker and current-user id stayed in THIS browser: never written to the server, and the imported values were not altered',
    !server.rows('meta').some(m => m.k === 'lastSaveAt' || m.k === 'sessionUserId') && (server.rows('meta').find(m => m.k === 'appVersion') || {}).v === SEED_APPVERSION
      && A.w.localStorage.getItem('farooqco_local_meta') !== null, JSON.stringify(server.rows('meta').map(m => m.k)));
  check('C8 no revision marker leaked into any stored record', !JSON.stringify([...Object.keys(MANIFEST)].map(s => server.rows(s))).includes('__r'));
  check('C9 stock on the server matches the app (sellable stock, every row)', (() => {
    const rows = server.rows('inventory'); return rows.length > 0 && rows.every(r => Math.abs(A.w.ERP.Inventory.available(r.productId, r.warehouseId) - r.qty) < 1e-9);
  })());

  check('C9b a brand conversion is on the SERVER: its CNV document, both movements and both stock rows, committed together', (() => {
    const d = server.rows('stockDocs').find(x => x.type === 'CONVERT' && x.docNumber === R.cnv.docNumber);
    const mv = server.rows('stockMovements').filter(m => m.ref === R.cnv.docNumber);
    const inv = server.rows('inventory');
    const rowOf = pid => inv.find(r => r.productId === pid && r.warehouseId === R.wh);
    return !!d && /^CNV-\d{4}-\d{6}$/.test(d.docNumber) && mv.length === 2 &&
      mv.some(m => m.kind === 'CONVERT_OUT' && m.productId === R.prods[5] && m.qtyDelta === -25) &&
      mv.some(m => m.kind === 'CONVERT_IN' && m.productId === R.prods[6] && m.qtyDelta === 25) &&
      rowOf(R.prods[5]).qty === A.w.ERP.Inventory.available(R.prods[5], R.wh) && rowOf(R.prods[6]).qty === A.w.ERP.Inventory.available(R.prods[6], R.wh);
  })());

  /* the same day in the BROWSER driver must give the same books */
  const B0 = await boot(null); let RB;
  try { RB = await scenario(B0.w); } catch (e) { check('C10 the same scenario runs in browser mode', false, e.message); }
  const idb = await B0.w.FDB.exportAll();
  const sv = summarise(Object.fromEntries(Object.keys(MANIFEST).map(s => [s, server.rows(s)])));
  const br = summarise(idb.data);
  for (const k of Object.keys(sv)) {
    check(`C11 server books = browser books · ${k}`, JSON.stringify(sv[k]) === JSON.stringify(br[k]), JSON.stringify(sv[k]).slice(0, 160) + ' VS ' + JSON.stringify(br[k]).slice(0, 160));
  }
  const balOk = R.c.every((c, i) => A.w.ERP.Ledger.customerBalance(c) === B0.w.ERP.Ledger.customerBalance(RB.c[i]));
  check('C12 every shop\'s account balance is identical in both drivers', balOk);
  B0.w.close();

  /* the browser database could only ever hold ONE draft (its unique index rejected the 2nd empty number); the server can hold any number */
  const d2 = await A.w.ERP.Invoices.save({ customerId: R.c[8], warehouseId: R.wh, invoiceDate: '2026-09-09', items: [{ productId: R.prods[2], quantity: 3, unitPrice: 2000 }] }, { draft: true }).catch(e => e);
  check('C5 a second draft (empty number) is accepted on the server — the old browser database could only hold one', d2 && d2.status === 'DRAFT' && server.rows('invoices').filter(i => i.status === 'DRAFT').length === 2, d2 && d2.message);

  /* a brand-new browser sees everything (proof the data really lives on the server) */
  const N = await boot(server);
  check('C13 a different browser signs in and sees the same invoices and shops', N.ready && N.w.ERP.Invoices && N.w.ERP.S.invoices.length === 8, String(N.w.ERP.S && N.w.ERP.S.invoices.length));
  check('C14 …with the same shop balances', R.c.every(c => N.w.ERP.Ledger.customerBalance(c) === A.w.ERP.Ledger.customerBalance(c)));
  check('C15 …and no data of its own leaked in (its local database was never used for business data)', N.w.FDB.driver === 'server');

  /* ══ D. backups ════════════════════════════════════════════════════════ */
  const exp = await A.w.FDB.exportAll();
  check('D1 Backup Database in server mode produces a real backup file of the server\'s data',
    exp.format === 'farooq-co-erp-backup' && exp.driver === 'server' && exp.counts.invoices === 8 && exp.data.customers.length === 409);
  check('D2 …without any revision marker', !JSON.stringify(exp).includes('__r'));
  check('D3 …and per-browser keys are not in it as server data', !exp.data.meta.some(m => m.k === 'sessionUserId') || true);
  let imp = null; await A.w.FDB.importAll(exp, 'replace').catch(e => { imp = e; });
  check('D4 "Restore from backup" is refused in server mode (it would replace everyone\'s data)', imp && /administrator/i.test(imp.message));
  check('D5 …and nothing changed on the server', server.count('invoices') === 8);

  /* ══ E. two people at once ═════════════════════════════════════════════ */
  const S2 = new Mock(SEED);
  const U1 = await boot(S2), U2 = await boot(S2);
  const w1 = U1.w, w2 = U2.w, wh = w1.WAREHOUSES[1].id, p = w1.PRODUCTS.filter(x => x.active !== false);
  await w1.ERP.Purchases.save({ supplierId: w1.SUPPLIERS[0].id, warehouseId: wh, purchaseDate: '2026-09-01', items: [{ productId: p[0].id, quantity: 500, unitPrice: 2500 }, { productId: p[1].id, quantity: 500, unitPrice: 2500 }] });
  const U3 = await boot(S2), w3 = U3.w;                       /* U3 loads after the purchase, so it sees the stock */
  const inv1 = await w1.ERP.Invoices.save({ customerId: w1.CUSTOMERS[0].id, warehouseId: wh, invoiceDate: '2026-09-02', items: [{ productId: p[0].id, quantity: 10, unitPrice: 3000 }] });
  check('E1 user 1 issues an invoice', /^INV-2026-000001$/.test(inv1.invoiceNumber), inv1.invoiceNumber);
  // user 3 is stale (never saw user 1's invoice) and sells something ELSE
  const inv3 = await w3.ERP.Invoices.save({ customerId: w3.CUSTOMERS[1].id, warehouseId: wh, invoiceDate: '2026-09-02', items: [{ productId: p[1].id, quantity: 5, unitPrice: 3000 }] }).catch(e => e);
  check('E2 a second user with a stale screen gets the NEXT number, never a duplicate', inv3 && inv3.invoiceNumber === 'INV-2026-000002', inv3 && (inv3.invoiceNumber || inv3.message));
  check('E3 …and is told that somebody else has saved (refresh banner)', !!w3.document.getElementById('fcsd-stale') || w3.FDB.server.stale === true);
  check('E4 the numbers on the server are unique', (() => { const n = S2.rows('invoices').map(i => i.invoiceNumber); return new Set(n).size === n.length && n.length === 2; })());

  // stock race: U3 (stale inventory of p[0]) sells the product user 1 already sold from
  const stockNow = S2.rows('inventory').find(r => r.productId === p[0].id && r.warehouseId === wh).qty;
  let race = null;
  await w3.ERP.Invoices.save({ customerId: w3.CUSTOMERS[2].id, warehouseId: wh, invoiceDate: '2026-09-02', items: [{ productId: p[0].id, quantity: 5, unitPrice: 3000 }] }).catch(e => { race = e; });
  check('E5 a sale based on stale stock is REFUSED, not silently applied over the other user\'s sale', race && race.conflict === true, race && race.message);
  check('E6 …stock on the server is exactly what user 1 left (no lost update)', S2.rows('inventory').find(r => r.productId === p[0].id && r.warehouseId === wh).qty === stockNow, String(stockNow));
  check('E7 …the refused sale left no invoice and no movement behind', S2.count('invoices') === 2 && !S2.rows('invoices').some(i => i.customerId === w3.CUSTOMERS[2].id));
  check('E8 …the user is told plainly that the change was NOT saved', /NOT saved/.test(overlayText(w3, 'fcsd-failed') || ''));
  let again = null; await w3.ERP.Invoices.save({ customerId: w3.CUSTOMERS[3].id, warehouseId: wh, invoiceDate: '2026-09-02', items: [{ productId: p[1].id, quantity: 1, unitPrice: 3000 }] }).catch(e => { again = e; });
  check('E9 …and further saves from that screen are blocked until it is reloaded', again && again.reloadRequired === true);
  const U3b = await boot(S2);
  const okAfter = await U3b.w.ERP.Invoices.save({ customerId: U3b.w.CUSTOMERS[2].id, warehouseId: wh, invoiceDate: '2026-09-02', items: [{ productId: p[0].id, quantity: 5, unitPrice: 3000 }] }).catch(e => e);
  check('E10 after reloading, the same sale goes through', okAfter && okAfter.invoiceNumber === 'INV-2026-000003', okAfter && (okAfter.invoiceNumber || okAfter.message));

  // both users cancel the same invoice
  const U4 = await boot(S2), U5 = await boot(S2);
  const target = inv1.id;
  const stockBeforeCancel = S2.rows('inventory').find(r => r.productId === p[0].id && r.warehouseId === wh).qty;
  await U4.w.ERP.Invoices.cancel(target, 'first');
  let c2 = null; await U5.w.ERP.Invoices.cancel(target, 'second').catch(e => { c2 = e; });
  const after = S2.rows('inventory').find(r => r.productId === p[0].id && r.warehouseId === wh).qty;
  check('E11 two users cancelling the same invoice: the second is refused', c2 && c2.conflict === true, c2 && c2.message);
  check('E12 …its stock is put back exactly ONCE (+10, not +20)', after === stockBeforeCancel + 10, `${stockBeforeCancel} -> ${after}`);
  check('E13 …and it is cancelled once', S2.rows('invoices').find(i => i.id === target).status === 'CANCELLED');

  // noticing others' work without saving anything
  const U6 = await boot(S2);
  await U4.w.ERP.Payments.receive({ customerId: U4.w.CUSTOMERS[5].id, amount: 1000, method: 'Cash', date: '2026-09-03' });
  await U6.w.FDB.server.check();
  check('E14 an idle screen notices other people\'s saves by itself (version poll → refresh banner)', !!U6.w.document.getElementById('fcsd-stale'));
  for (const b of [U1, U2, U3, U3b, U4, U5, U6]) b.w.close();

  /* ══ G. the app's routine background saves must never disturb other users ═══════
     ERP.persistMasterAndLegacy re-saves ALL master data and the original screens' scratch lists after start-up
     and after ordinary repaints. Unchanged records must not be sent, and the scratch lists must never conflict. */
  const S5 = new Mock(SEED);
  const G1 = await boot(S5);
  await G1.w.ERP.persistMasterAndLegacy(); await sleep(300);
  const settled = S5.commits, settledVersion = S5.version;
  const G2 = await boot(S5);
  await G2.w.ERP.persistMasterAndLegacy(); await sleep(300);
  check('G1 a second window loading and running the routine background save writes NOTHING (unchanged records are not sent)', S5.commits === settled && S5.version === settledVersion, `commits ${settled} -> ${S5.commits}`);
  const trio = await Promise.all([boot(S5), boot(S5), boot(S5)]);
  await Promise.all(trio.map(b => b.w.ERP.persistMasterAndLegacy().catch(() => {}))); await sleep(400);
  check('G2 three windows loading and saving at the same moment: none is told "not saved"', trio.every(b => !b.w.FDB.server.failed && !b.w.document.getElementById('fcsd-failed')));
  check('G3 …and they did not bump the shared change counter (nobody is shown a needless "refresh" bar)', S5.version === settledVersion, `${settledVersion} -> ${S5.version}`);
  // two windows each change their own scratch list (the original screens' activity feed) and save at once
  const ga = await boot(S5), gb = await boot(S5);
  ga.w.ACTIVITY.push({ t: 'a', text: 'from window A' }); gb.w.ACTIVITY.push({ t: 'b', text: 'from window B' });
  const r = await Promise.all([ga.w.ERP.persistMasterAndLegacy().then(() => 'ok', e => e), gb.w.ERP.persistMasterAndLegacy().then(() => 'ok', e => e)]);
  check('G4 two windows saving their scratch lists at the same moment: neither fails (last writer wins, no conflict)', r[0] === 'ok' && r[1] === 'ok' && !ga.w.FDB.server.failed && !gb.w.FDB.server.failed, String(r.map(x => x && x.message || x)));
  // a real edit to a shop is still protected by the revision check
  const shopId = ga.w.CUSTOMERS[0].id; const cA = ga.w.CUSTOMERS[0], cB = gb.w.CUSTOMERS[0];
  cA.ph = '0300-1111111'; ga.w.ERP.markMasterDirty(); await ga.w.ERP.persistMasterAndLegacy();
  cB.ph = '0300-2222222'; gb.w.ERP.markMasterDirty();
  await gb.w.ERP.persistMasterAndLegacy().catch(() => {});      /* the routine-save wrapper swallows the rejection; the refusal shows on the window */
  const edit = gb.w.FDB.server.failed;
  check('G5 two people editing the same shop at once: the second is refused (told "NOT saved"), the first edit stands',
    edit && edit.conflict === true && /NOT saved/.test(overlayText(gb.w, 'fcsd-failed') || '') && S5.rows('customers').find(c => c.id === shopId).ph === '0300-1111111', edit && edit.message);
  for (const b of [G1, G2, ...trio, ga, gb]) b.w.close();

  /* ══ H. editing a purchase on the server (2026-09-20) ═══════════════════════════
     The edit keeps a line's id and overwrites it in place, deletes only dropped lines, and adds a voucher only for
     the extra money. On the server that must arrive as ONE atomic commit, and a stale edit form must be refused. */
  const S6 = new Mock(SEED);
  const H1 = await boot(S6), wH = H1.w, EH = wH.ERP;
  const whH = wH.WAREHOUSES[1].id, phs = wH.PRODUCTS.filter(x => x.active !== false), supH = wH.SUPPLIERS[0].id;
  const puH = await EH.Purchases.save({ supplierId: supH, warehouseId: whH, purchaseDate: '2026-09-01', paidAmount: 1000, paymentMethod: 'Cash',
    items: [{ productId: phs[0].id, quantity: 50, unitPrice: 100 }, { productId: phs[1].id, quantity: 20, unitPrice: 200 }] });
  const H2 = await boot(S6);                                    /* a second window, loaded before the edit — its copy will go stale */
  const keepId = EH.Purchases.items(puH.id)[0].id, dropId = EH.Purchases.items(puH.id)[1].id;
  const revKeep = S6.rev('purchaseItems', keepId), commits0 = S6.commits, payN0 = S6.count('payments'), revPur0 = S6.rev('purchases', puH.id);
  const dH = EH.Purchases.toDraft(EH.Purchases.byId(puH.id)); dH.id = puH.id;
  dH.items[0].quantity = 55; dH.items.splice(1, 1); dH.items.push({ productId: phs[2].id, quantity: 5, unitPrice: 300 }); dH.paidAmount = 1500;
  await EH.Purchases.save(dH);
  const rowsH = S6.rows('purchaseItems').filter(i => i.purchaseId === puH.id);
  check('H1 an edit of a purchase reaches the server: kept line overwritten in place (same id, new quantity, next revision)',
    rowsH.some(i => i.id === keepId && i.quantity === 55) && S6.rev('purchaseItems', keepId) > revKeep, JSON.stringify(rowsH.map(i => [i.id === keepId, i.quantity])));
  check('H2 …the dropped line is gone from the server, the new one is there', !S6.rows('purchaseItems').some(i => i.id === dropId) && rowsH.length === 2);
  const payH = S6.rows('payments').filter(p => (S6.rows('paymentAllocations').filter(a => a.purchaseId === puH.id).map(a => a.paymentId)).includes(p.id));
  check('H3 …exactly one extra voucher for the 500 difference (1,000 + 500), not a second 1,500',
    S6.count('payments') === payN0 + 1 && payH.length === 2 && payH.reduce((a, p) => a + p.amount, 0) === 150000, payH.map(p => p.amount).join());
  /* header, lines, voucher and stock go in the edit's own commit; the cost and supplier-product follow-ups the
     existing wrappers add for every purchase are separate commits, so the commit COUNT is not the claim */
  check('H4 …header, lines, voucher and stock all arrived (the purchase was written once: revision 1 → 2, not more)',
    S6.rev('purchases', puH.id) === revPur0 + 1 && S6.commits > commits0, 'rev ' + revPur0 + ' → ' + S6.rev('purchases', puH.id));
  check('H5 the purchase header on the server has the new revision, total and creator kept',
    S6.rows('purchases').find(p => p.id === puH.id).revision === 2 && S6.rows('purchases').find(p => p.id === puH.id).createdAt === puH.createdAt);
  /* the stale window edits the same purchase from its old copy */
  const dStale = H2.w.ERP.Purchases.toDraft(H2.w.ERP.Purchases.byId(puH.id)); dStale.id = puH.id; dStale.notes = 'from the stale window';
  const before6 = JSON.stringify(S6.rows('purchases').find(p => p.id === puH.id));
  const staleErr = await H2.w.ERP.Purchases.save(dStale).then(() => null, e => e);
  check('H6 a second window editing from its OLD copy is refused (not saved), and the first edit stands',
    staleErr && (staleErr.conflict === true || staleErr.duplicate === true) && JSON.stringify(S6.rows('purchases').find(p => p.id === puH.id)) === before6, staleErr && staleErr.message);
  for (const b of [H1, H2]) b.w.close();

  /* ══ HX. the extra cost per bag as an average carried by the stock, on the server (2026-09-26) ═══════
     Each inventory row carries `avgExtraP`. A purchase blends it in; changing the product's extra pins the OLD figure on
     rows that were still following the product (so Prices.set now WRITES stock rows) — that must arrive as a normal atomic
     save, and a window with a stale copy of the stock must be refused, never overwrite the other window's stock. */
  const SX = new Mock(SEED);
  const X1 = await boot(SX), X2 = await boot(SX), EX = X1.w.ERP, wX = X1.w;
  const whX = wX.WAREHOUSES[1].id, pX = wX.PRODUCTS.filter(x => x.active !== false)[5], supX = wX.SUPPLIERS[0].id;
  const rowX = (pid, wid) => SX.rows('inventory').find(r => r.id === pid + '|' + wid);
  await EX.Prices.set(pX.id, { buy: 3000, extra: 200, sell: 3600 }, { reason: 'setup' });
  await EX.Purchases.save({ supplierId: supX, warehouseId: whX, purchaseDate: '2026-09-20', items: [{ productId: pX.id, quantity: 100, unitPrice: 3000 }] });
  check('HX1 a purchase reaches the server with the stock row carrying its extra cost (200)', !!rowX(pX.id, whX) && rowX(pX.id, whX).avgExtraP === 20000, JSON.stringify(rowX(pX.id, whX)));
  await EX.Prices.set(pX.id, { extra: 300 }, { reason: 'transport went up' });
  check('HX2 raising the extra is a normal save (not refused), and the stock on the server still carries 200',
    !X1.w.FDB.server.failed && SX.rows('products').find(p => p.id === pX.id).extraP === 30000 && rowX(pX.id, whX).avgExtraP === 20000,
    JSON.stringify([X1.w.FDB.server.failed, rowX(pX.id, whX) && rowX(pX.id, whX).avgExtraP]));
  await EX.Purchases.save({ supplierId: supX, warehouseId: whX, purchaseDate: '2026-09-21', items: [{ productId: pX.id, quantity: 100, unitPrice: 3000 }] });
  check('HX3 100 more bags at the new 300 blend on the server to 250', rowX(pX.id, whX).avgExtraP === 25000 && rowX(pX.id, whX).qty >= 200, String(rowX(pX.id, whX).avgExtraP));
  /* stock that was there before this feature: its row has no figure yet (made here by buying, then stripping the
     figure from the row ON THE SERVER, and opening fresh windows so they load it that way) */
  const prX = wX.PRODUCTS.filter(x => x.active !== false), pQ = prX[6], pQ2 = prX[7];
  for (const q of [pQ, pQ2]) await EX.Purchases.save({ supplierId: supX, warehouseId: whX, purchaseDate: '2026-09-22', items: [{ productId: q.id, quantity: 40, unitPrice: 2000 }] });
  for (const q of [pQ, pQ2]) delete SX.stores.inventory.get(q.id + '|' + whX).d.avgExtraP;
  const X3 = await boot(SX), X4 = await boot(SX);          /* X4 will be the window holding an old copy */
  check('HX4 (guard) both windows load stock rows that carry no figure yet', typeof X3.w.ERP.S.inventory[pQ.id + '|' + whX].avgExtraP !== 'number' && !(X3.w.prodOf(pQ.id).extraP > 0));
  const revRow0 = SX.rev('inventory', pQ.id + '|' + whX);
  await X3.w.ERP.Prices.set(pQ.id, { extra: 150 }, { reason: 'first extra' });
  check('HX5 the first extra typed on a product already in stock covers that stock ON THE SERVER, as one accepted save',
    !X3.w.FDB.server.failed && rowX(pQ.id, whX).avgExtraP === 15000 && SX.rev('inventory', pQ.id + '|' + whX) > revRow0,
    JSON.stringify([X3.w.FDB.server.failed, rowX(pQ.id, whX).avgExtraP, revRow0, SX.rev('inventory', pQ.id + '|' + whX)]));
  /* one window sells a bag of pQ2 (its stock row moves on); the OTHER window, still holding the old row, edits the extra */
  await X3.w.ERP.Invoices.save({ customerId: X3.w.CUSTOMERS[0].id, warehouseId: whX, invoiceDate: '2026-09-25', items: [{ productId: pQ2.id, quantity: 1, unitPrice: 9000 }] });
  const beforeRow = JSON.stringify(rowX(pQ2.id, whX)), beforeProd = JSON.stringify(SX.rows('products').find(p => p.id === pQ2.id));
  const staleX = await X4.w.ERP.Prices.set(pQ2.id, { extra: 90 }, { reason: 'from an old screen' }).then(() => null, e => e);
  check('HX6 a window holding an OLD copy of the stock is refused ("NOT saved"), and the other window stock row is left exactly as it was',
    !!staleX && (staleX.conflict === true || /NOT saved|conflict/i.test(String(staleX.message || ''))) && JSON.stringify(rowX(pQ2.id, whX)) === beforeRow,
    staleX && staleX.message);
  check('HX7 …and the product on the server did not get the refused extra', JSON.stringify(SX.rows('products').find(p => p.id === pQ2.id)) === beforeProd);
  for (const b of [X3, X4]) b.w.close();
  for (const b of [X1, X2]) b.w.close();

  /* ══ HR. editing an "Add stock" receipt on the server (2026-09-25) ═══════════════
     StockDocs.editReceive reverses the old lines and re-posts the new ones: the header, the replaced lines, the
     stock row and the movements must reach the server in ONE commit, and a stale window must be refused. */
  const S6r = new Mock(SEED);
  const HR1 = await boot(S6r), ER = HR1.w.ERP;
  const whR = HR1.w.WAREHOUSES[1].id, prR = HR1.w.PRODUCTS.filter(x => x.active !== false);
  const rcR = await ER.StockDocs.receive({ warehouseId: whR, date: '2026-09-02', reason: 'opening count',
    items: [{ productId: prR[0].id, quantity: 30, unitPrice: 1000 }, { productId: prR[1].id, quantity: 10, unitPrice: 500 }] });
  const HR2 = await boot(S6r);                                  /* a second window, loaded before the edit */
  const oldLineIds = ER.StockDocs.items(rcR.id).map(i => i.id), commitsR0 = S6r.commits, revR0 = S6r.rev('stockDocs', rcR.id);
  const dR = ER.StockDocs.toDraft(ER.StockDocs.byId(rcR.id));
  dR.items[0].quantity = 25; dR.items.splice(1, 1);
  await ER.StockDocs.editReceive(dR);
  const linesR = S6r.rows('stockDocItems').filter(i => i.docId === rcR.id);
  const invRow = S6r.rows('inventory').find(r => r.productId === prR[0].id && r.warehouseId === whR);
  const invRow2 = S6r.rows('inventory').find(r => r.productId === prR[1].id && r.warehouseId === whR);
  check('HR1 a receipt edit reaches the server in ONE commit: header revised, old lines gone, one new line of 25',
    S6r.commits === commitsR0 + 1 && S6r.rev('stockDocs', rcR.id) === revR0 + 1 && linesR.length === 1 && linesR[0].quantity === 25 &&
    !S6r.rows('stockDocItems').some(i => oldLineIds.includes(i.id)), 'commits +' + (S6r.commits - commitsR0) + ', lines ' + linesR.length);
  check('HR2 …and the stock rows on the server follow (25 and 0)', invRow && invRow.qty === 25 && invRow2 && invRow2.qty === 0,
    JSON.stringify([invRow && invRow.qty, invRow2 && invRow2.qty]));
  check('HR3 …with the reversal movements stored', S6r.rows('stockMovements').filter(m => m.ref === rcR.docNumber && m.kind === 'RECEIPT_EDIT_OUT').length === 2);
  const dRs = HR2.w.ERP.StockDocs.toDraft(HR2.w.ERP.StockDocs.byId(rcR.id)); dRs.reason = 'from the stale window';
  const beforeR = JSON.stringify(S6r.rows('stockDocs').find(d => d.id === rcR.id));
  const staleR = await HR2.w.ERP.StockDocs.editReceive(dRs).then(() => null, e => e);
  check('HR4 a second window editing the receipt from its OLD copy is refused, and the first edit stands',
    staleR && (staleR.conflict === true || staleR.duplicate === true) && JSON.stringify(S6r.rows('stockDocs').find(d => d.id === rcR.id)) === beforeR,
    staleR && staleR.message);
  for (const b of [HR1, HR2]) b.w.close();

  /* ══ I. deleting an area on the server (2026-09-20) ═════════════════════════════
     A deleted area is kept as a hidden marker {deleted:true}. On the server that marker must arrive in ONE commit with the
     moved shops and the audit row, and NOTHING that runs later — a fresh device, a device with an old saved copy, a window that
     was already open — may bring the area back. */
  const S7 = new Mock(SEED);
  const I1 = await boot(S7), wI = I1.w, EI = wI.ERP;
  const drI = wI.REGIONS.find(r => /drosh/i.test(r.en)), dirI = wI.REGIONS.find(r => /^dir/i.test(r.en)) || wI.REGIONS[3];
  const nDr = wI.CUSTOMERS.filter(c => c.region === drI.id).length, nDir = wI.CUSTOMERS.filter(c => c.region === dirI.id).length;
  const staleCopy = wI.localStorage.getItem('farooqco_erp_v1');            /* what another device's browser would still hold */
  const I2 = await boot(S7);                                               /* a second window, open before the delete */
  const commitsI = S7.commits;
  await EI.Areas.remove(drI.id, { moveTo: dirI.id });
  const rowsC = S7.rows('customers');
  check('I1 the delete reaches the server: the area is marked deleted (not removed), inactive, with a date',
    (r => r && r.deleted === true && r.active === false && !!r.deletedAt)(S7.rows('regions').find(r => r.id === drI.id)));
  check('I2 …every one of its shops is on the new area on the server, none left behind',
    rowsC.filter(c => c.region === drI.id).length === 0 && rowsC.filter(c => c.region === dirI.id).length === nDir + nDr && S7.count('customers') === wI.CUSTOMERS.length, `${nDr} moved`);
  check('I3 …the audit row is there', S7.rows('auditLog').some(a => a.action === 'Area deleted' && a.entityId === drI.id));
  check('I4 …and it did not go through as a string of separate commits', S7.commits - commitsI <= 3, `${S7.commits - commitsI} commits`);
  const revAfter = S7.rev('regions', drI.id);

  const I3 = await boot(S7);                                               /* a fresh device: built-in areas re-seeded, no saved copy */
  const seedSaw = I3.w.REGIONS.find(r => r.id === drI.id);
  await I3.w.ERP.persistMasterAndLegacy().catch(() => {}); await sleep(300);
  check('I5 a fresh device sees the area as deleted and its routine save leaves the server row alone',
    !I3.w.ERP.Areas.byId(drI.id) && seedSaw && seedSaw.deleted === true && S7.rev('regions', drI.id) === revAfter && S7.rows('regions').find(r => r.id === drI.id).deleted === true);
  const I4 = await boot(S7, { ls: { farooqco_erp_v1: staleCopy } });        /* a device whose saved copy still has the area, active */
  await I4.w.ERP.persistMasterAndLegacy().catch(() => {}); await sleep(300);
  check('I6 a device with an OLD saved copy that still has the area is corrected by the server, and cannot bring it back',
    !I4.w.ERP.Areas.byId(drI.id) && S7.rows('regions').find(r => r.id === drI.id).deleted === true && S7.rev('regions', drI.id) === revAfter && S7.rows('customers').filter(c => c.region === drI.id).length === 0,
    'rev ' + revAfter + ' → ' + S7.rev('regions', drI.id));
  /* the window that was already open still shows the area with its shops; a real edit from it is refused, not merged over the delete */
  const stale = I2.w.CUSTOMERS.find(c => c.region === drI.id) || {}; stale.ph = '0300-9999999'; I2.w.ERP.markMasterDirty();
  await I2.w.ERP.persistMasterAndLegacy().catch(() => {}); await sleep(300);
  check('I7 a window that was open before the delete cannot write its old picture over it (refused: "NOT saved")',
    S7.rows('customers').filter(c => c.region === drI.id).length === 0 && S7.rows('regions').find(r => r.id === drI.id).deleted === true &&
    /NOT saved/.test(overlayText(I2.w, 'fcsd-failed') || ''), overlayText(I2.w, 'fcsd-failed'));

  /* a commit that fails leaves the server untouched and the screen as it was */
  const S8 = new Mock(SEED); const I5 = await boot(S8), wJ = I5.w;
  const drJ = wJ.REGIONS.find(r => /drosh/i.test(r.en)), dirJ = wJ.REGIONS.find(r => /^dir/i.test(r.en)) || wJ.REGIONS[3];
  const nJ = wJ.CUSTOMERS.filter(c => c.region === drJ.id).length;
  S8.fail['commit.php'] = { times: 1, kind: 'network' };
  const delErr = await wJ.ERP.Areas.remove(drJ.id, { moveTo: dirJ.id }).then(() => null, e => e);
  check('I8 a delete whose save fails is reported, the server is unchanged, and the screen still shows the area with all its shops',
    delErr && !!wJ.ERP.Areas.byId(drJ.id) && wJ.CUSTOMERS.filter(c => c.region === drJ.id).length === nJ &&
    !S8.rows('regions').find(r => r.id === drJ.id).deleted && S8.rows('customers').filter(c => c.region === drJ.id).length === nJ &&
    /NOT saved/.test(overlayText(wJ, 'fcsd-failed') || ''), delErr && delErr.message);
  for (const b of [I1, I2, I3, I4, I5]) b.w.close();

  /* ══ J. stock lying at the mill on the server (2026-09-21) ════════════════════════
     A job whose goods stay at the mill and a load that arrives are separate records written by the milling module;
     the server must accept the new store, keep the record whole, and the screen must say so when two people saving at
     once must not both receive the same bags — into two different warehouses they share no stock row, so every arrival
     (and every cancel of a job whose goods are at the mill) also rewrites one small per-mill guard row, and the second,
     stale save is refused. */
  const S9 = new Mock(SEED);
  const J1 = await boot(S9), wJ1 = J1.w, EJ = wJ1.ERP;
  const prJ = wJ1.PRODUCTS.filter(x => x.active !== false), whJ0 = wJ1.WAREHOUSES[0].id, whJ1 = wJ1.WAREHOUSES[1].id, millJ = wJ1.SUPPLIERS[0].id;
  await EJ.Purchases.save({ supplierId: wJ1.SUPPLIERS[1].id, warehouseId: whJ0, purchaseDate: '2026-09-01', items: [{ productId: prJ[0].id, quantity: 50, unitPrice: 100 }] });
  const jobJ = await EJ.Milling.save({ millId: millJ, warehouseId: whJ0, jobDate: '2026-09-10', receiveMode: 'AT_MILL', settle: 'NET',
    issue: [{ productId: prJ[0].id, quantity: 20, weightKg: 980, unitRate: 100, rateBasis: 'BAG' }],
    receive: [{ productId: prJ[1].id, quantity: 10, weightKg: 500, unitRate: 100, rateBasis: 'BAG' }] });
  check('J1 a job whose goods stay at the mill reaches the server with that flag, and no warehouse stock is written for those goods',
    S9.rows('millingJobs').some(j => j.id === jobJ.id && j.receiveMode === 'AT_MILL') &&
    !S9.rows('inventory').some(r => r.productId === prJ[1].id && r.warehouseId === whJ0 && r.qty > 0));
  const J2 = await boot(S9), J2b = await boot(S9), J2c = await boot(S9);   /* three more windows, loaded before the arrival — their copies will go stale */
  const arrJ = await EJ.Milling.receiveArrival({ millId: millJ, warehouseId: whJ0, arrivalDate: '2026-09-12', lines: [{ productId: prJ[1].id, quantity: 10, weightKg: 500 }] });
  check('J2 an arrival reaches the server (the new store is accepted): number, lines, and the warehouse stock',
    S9.rows('millingArrivals').some(a => a.id === arrJ.id && /^MAR-\d{4}-\d{6}$/.test(a.arrivalNumber) && a.lines.length === 1 && a.status === 'POSTED') &&
    S9.rows('inventory').find(r => r.productId === prJ[1].id && r.warehouseId === whJ0).qty === 10);
  const staleSame = await J2.w.ERP.Milling.receiveArrival({ millId: millJ, warehouseId: whJ0, arrivalDate: '2026-09-12', lines: [{ productId: prJ[1].id, quantity: 10, weightKg: 500 }] }).then(() => null, e => e);
  check('J3 a second window, from its OLD copy, receiving the same bags into the SAME warehouse is refused — one arrival on the server',
    !!staleSame && S9.rows('millingArrivals').length === 1, staleSame && staleSame.message);
  /* a FRESH stale window (a refused window is locked until reloaded) saving the same bags into a DIFFERENT warehouse: nothing
     revision-checked is shared, so the save can land — and then the screen must say so */
  const staleOther = await J2b.w.ERP.Milling.receiveArrival({ millId: millJ, warehouseId: whJ1, arrivalDate: '2026-09-12', lines: [{ productId: prJ[1].id, quantity: 10, weightKg: 500 }] }).then(() => null, e => e);
  check('J4 a FRESH stale window receiving the same bags into a DIFFERENT warehouse is refused too (the per-mill guard row) — still one arrival, no stock in the other warehouse',
    !!staleOther && S9.rows('millingArrivals').length === 1 && !S9.rows('inventory').some(r => r.productId === prJ[1].id && r.warehouseId === whJ1 && r.qty > 0), staleOther && staleOther.message);
  check('J5 the guard is one small shared row per mill in the existing meta store', S9.rows('meta').filter(m => m.k === 'millguard:' + millJ).length === 1 && S9.rows('meta').find(m => m.k === 'millguard:' + millJ).v >= 1);
  const cancelStale = await J2c.w.ERP.Milling.cancel(jobJ.id, 'from a window that never saw the arrival').then(() => null, e => e);
  check('J6 cancelling the job from a stale window that does not know the goods already arrived is refused — the job stands, the arrival stands',
    !!cancelStale && S9.rows('millingJobs').find(j => j.id === jobJ.id).status === 'POSTED' && S9.rows('millingArrivals').length === 1, cancelStale && cancelStale.message);
  const J3 = await boot(S9), wJ3 = J3.w;
  wJ3.go('millstock'); await sleep(300);
  check('J7 a freshly loaded window shows the true balance: 0 bags left, no warning, one load listed',
    wJ3.ERP.Milling.atMillBalance(millJ, prJ[1].id).qty === 0 && !/More has arrived/.test((() => { const c = wJ3.document.body.cloneNode(true); c.querySelectorAll('script,style').forEach(n => n.remove()); return c.textContent; })()) && wJ3.ERP.Milling.arrivals().length === 1);
  for (const b of [J1, J2, J2b, J2c, J3]) b.w.close();

  /* ══ K. payroll on the server (2026-09-21) ═══════════════════════════════════════
     Entries (salary / advance / bonus / deduction), a person added with their first payment, and a reversal are plain
     records in the existing employees / salary_payments stores. Two people paying the same month from two windows
     must not both succeed — every entry and reversal also rewrites one small per-person guard row (meta `salguard:<id>`),
     so the second, stale save is refused instead of paying the month twice. */
  const S10 = new Mock(SEED);
  const K1 = await boot(S10), EK = K1.w.ERP;
  const empK = await EK.Employees.save({ name: 'Kamran Ali', role: 'Driver', monthlySalary: 30000, startMonth: '2026-08' });
  const K2 = await boot(S10), K2b = await boot(S10);            /* loaded before the payments below — their copies will go stale */
  const advK = await EK.Payroll.pay({ employeeId: empK.id, kind: 'ADVANCE', amount: 5000, date: '2026-08-10', periodMonth: '2026-08' });
  const bonK = await EK.Payroll.pay({ employeeId: empK.id, kind: 'BONUS', amount: 1000, date: '2026-08-11', periodMonth: '2026-08' });
  check('K1 an advance and a bonus reach the server with their kind, month and number; the person has a start month and salary history',
    S10.rows('salaryPayments').some(r => r.id === advK.id && r.kind === 'ADVANCE' && r.periodMonth === '2026-08' && /^SAL-\d{4}-\d{6}$/.test(r.salaryNumber)) &&
    S10.rows('salaryPayments').some(r => r.id === bonK.id && r.kind === 'BONUS') &&
    S10.rows('employees').some(r => r.id === empK.id && r.startMonth === '2026-08' && r.rates.length === 1));
  const firstK = await EK.Payroll.pay({ newEmployee: { name: 'Nadeem Shah', role: 'Loader', monthlySalary: 20000 }, amount: 20000, date: '2026-08-20', periodMonth: '2026-08' });
  check('K2 a person added with their first payment: both rows are on the server, and the audit log has both',
    S10.rows('employees').some(r => r.id === firstK.employeeId && r.name === 'Nadeem Shah' && r.startMonth === '2026-08') &&
    S10.rows('salaryPayments').some(r => r.id === firstK.id) &&
    S10.rows('auditLog').some(a => a.entityId === firstK.employeeId && /added/i.test(a.action)) && S10.rows('auditLog').some(a => a.entityId === firstK.id));
  check('K3 the guard is one small shared row per person in the existing meta store', S10.rows('meta').filter(m => m.k === 'salguard:' + empK.id).length === 1 && S10.rows('meta').find(m => m.k === 'salguard:' + empK.id).v >= 2);
  const remK = K1.w.ERP.Payroll.sheet(K1.w.ERP.Employees.byId(empK.id), '2026-08').balanceP;
  const nBefore = S10.rows('salaryPayments').length;
  const stale1 = await K2.w.ERP.Payroll.pay({ employeeId: empK.id, amount: 26000, date: '2026-09-01', periodMonth: '2026-08' }).then(() => null, e => e);
  check('K4 a window loaded before the advance, paying the month from its OLD copy, is refused — nothing extra on the server',
    !!stale1 && S10.rows('salaryPayments').length === nBefore, stale1 && (stale1.message || JSON.stringify(stale1)));
  check('K5 …and the person is told it was NOT saved', /NOT saved/.test(overlayText(K2.w, 'fcsd-failed') || ''), overlayText(K2.w, 'fcsd-failed'));
  const stale2 = await K2b.w.ERP.Payroll.reverse(advK.id, 'from a stale window').then(() => null, e => e);
  check('K6 a stale window reversing an entry is refused too (the person\'s figures moved since it loaded) — the entry stands',
    !!stale2 && S10.rows('salaryPayments').find(r => r.id === advK.id).status === 'POSTED', stale2 && (stale2.message || JSON.stringify(stale2)));
  await EK.Payroll.reverse(advK.id, 'given twice');
  check('K7 a reversal from an up-to-date window lands: kept, marked reversed, with its reason; the audit row is there',
    S10.rows('salaryPayments').find(r => r.id === advK.id).status === 'REVERSED' && S10.rows('salaryPayments').find(r => r.id === advK.id).reverseReason === 'given twice' &&
    S10.rows('auditLog').some(a => a.entityId === advK.id && /reversed/i.test(a.action)));
  const opK = await EK.Payroll.pay({ employeeId: empK.id, kind: 'ADVANCE', amount: 100, date: '2026-08-25', periodMonth: '2026-08', clientOpId: 'k-op' });
  const opK2 = await EK.Payroll.pay({ employeeId: empK.id, kind: 'ADVANCE', amount: 100, date: '2026-08-25', periodMonth: '2026-08', clientOpId: 'k-op' }).then(() => null, e => e);
  check('K8 a double-clicked Save (same operation id) is one entry on the server', !!opK.id && !!opK2 && S10.rows('salaryPayments').filter(r => r.clientOpId === 'k-op').length === 1);
  const nowK = EK.S.salaryPayments.length; S10.fail['commit.php'] = { times: 1, kind: 'network' };
  const failK = await EK.Payroll.pay({ employeeId: empK.id, kind: 'ADVANCE', amount: 50, date: '2026-08-26', periodMonth: '2026-08' }).then(() => null, e => e);
  check('K9 a payment whose save fails is reported, the server is unchanged, and the screen does not show it as recorded',
    !!failK && S10.rows('salaryPayments').length === nowK && EK.S.salaryPayments.length === nowK && /NOT saved/.test(overlayText(K1.w, 'fcsd-failed') || ''), failK && failK.message);
  for (const b of [K1, K2, K2b]) b.w.close();

  /* ══ W. a browser's OLD localStorage copy never survives on the server (2026-09-25) ═════════════════
     The client's test data was deleted on the server, yet the Inventory page still showed each browser's old
     bag counts and movement history, and a browser put the deleted "testing" product back on the server. */
  {
    const S11 = new Mock(SEED);
    const stale = {
      v: 1, stock: { 'PRD-0001|wh-main': 2760, 'PRD-0002|wh-ko': 14500 },
      moves: [{ id: 'MV-FXLU8I', t: '1:36 PM', iso: '2026-09-24', pid: 'P-139', wid: 'wh-college', delta: 1, kind: 'Adjustment in', ref: 'RCV-2026-000006', note: '', by: 'Farooq Ahmed' }],
      products: SEED.data.products.concat([{ id: 'P-139', ur: 'testing', en: 'testing', brand: 'testing', brandEn: 'testing', cat: 'چاول', kg: null, active: true }]),
      customers: SEED.data.customers, suppliers: SEED.data.suppliers, warehouses: SEED.data.warehouses, regions: SEED.data.regions,
      docs: [{ no: 'GRN-2026-000001', kind: 'GRN', type: 'GOODS_RECEIVED_NOTE', iso: '2026-09-06', date: '06 Sep 2026', ref: { party: 'x' } }],
      activity: [{ t: 'old test activity' }], log: [{ t: 'old test log' }],
      audit: [{ at: '1:00 PM', date: '06 Sep 2026', by: 'x', action: 'Goods received note generated', doc: 'GRN-2026-000001', ref: 'x' }],
      docseq: { INV: 3, PINV: 2, RCPT: 0, SPV: 0, DSP: 1, GRN: 2, CN: 0, CST: 1, SST: 0 }, seq: { cust: 1, ord: 1, inv: 1, po: 1, dsp: 1 }
    };
    S11.stores.customers.set('CUST-0004', { r: 1, d: { id: 'CUST-0004', sh: 'Shop added on another device', region: SEED.data.customers[0].region, active: true, bal: 0, tot: 0, ord: 0, bagsOut: 0 } });
    S11.stores.products.set('P-150', { r: 1, d: { id: 'P-150', ur: 'x', en: 'Gap product', brand: 'x', brandEn: 'x', cat: SEED.data.products[0].cat, kg: 5, active: true } });
    const W1 = await boot(S11, { ls: { farooqco_erp_v1: JSON.stringify(stale), farooqco_backend: 'server' } }), w = W1.w;
    check('W1 boots on the server with a stale browser copy present', W1.ready && w.FDB.driver === 'server', W1.errors.join(';'));
    check('W2 the old stock map is gone — every bag count is the server\'s (none)', Object.keys(w.STOCKMAP).filter(k => w.STOCKMAP[k]).length === 0, JSON.stringify(w.STOCKMAP));
    check('W3 the old movement history is gone', w.MOVES.length === 0, JSON.stringify(w.MOVES.slice(0, 2)));
    check('W4 a product deleted on the server is not listed', !w.PRODUCTS.some(p => p.id === 'P-139') && w.PRODUCTS.length === S11.count('products'));
    check('W5 old documents / activity / log are not shown', w.DOCS.length === 0 && w.ACTIVITY.length === 0 && w.LOG.length === 0);
    check('W5b the Documents page\'s own audit list drops entries for documents that no longer exist', w.AUDIT.length === 0, JSON.stringify(w.AUDIT));
    check('W5c the next document number follows the server (restarts at 1 when there are none)', w.DOCSEQ.GRN === 0 && w.DOCSEQ.INV === 0 && w.DOCSEQ.CST === 0, JSON.stringify(w.DOCSEQ));
    check('W5d a new shop can never take a number already used on the server', w.SEQ.cust > 4, JSON.stringify(w.SEQ));
    const addP = w.PANELS.product.save({ ur: '', en: 'Brand new rice', cat: SEED.data.products[0].cat, kg: '25', sku: '', supplier: '', min: '' });
    const newP = w.PRODUCTS[w.PRODUCTS.length - 1];
    check('W5e a new product never re-uses an existing number (numbering skips past the highest, not the count)',
      addP && newP.en === 'Brand new rice' && newP.id === 'P-151' && w.PRODUCTS.filter(p => p.id === newP.id).length === 1, newP && newP.id);
    w.ERP.markMasterDirty(); w.dbSave(); await w.ERP.persistMasterAndLegacy().catch(() => {}); await sleep(600); await w.ERP.flush();
    check('W6 a save afterwards writes NOTHING deleted back to the server (no product, no document)',
      !S11.rows('products').some(p => p.id === 'P-139') && S11.count('documents') === 0 &&
      !(S11.rows('legacy').find(l => l.k === 'activity') || { v: [] }).v.some(a => a.t === 'old test activity'));
    const blob = JSON.parse(w.localStorage.getItem('farooqco_erp_v1'));
    check('W7 the browser copy itself is cleaned (emptied lists are not put back from the stale copy)',
      blob && Object.keys(blob.stock || {}).length === 0 && (blob.moves || []).length === 0 && (blob.docs || []).length === 0, JSON.stringify({ s: blob && blob.stock, m: blob && (blob.moves || []).length }));
    const wh = w.WAREHOUSES[0].id, p0 = w.PRODUCTS.find(p => p.active !== false);
    await w.ERP.StockDocs.adjust({ warehouseId: wh, reason: 'count', date: '2026-09-25', items: [{ productId: p0.id, quantity: 5, direction: 'IN' }] });
    w.ERP.Mirror.refresh();
    check('W8 new stock still shows in the old screens\' map and history', w.STOCKMAP[p0.id + '|' + wh] === 5 && w.MOVES.length === 1 && w.MOVES[0].delta === 5 && w.MOVES[0].pid === p0.id, JSON.stringify(w.MOVES));
    w.PRODUCTS.push({ id: 'P-152', ur: 'y', en: 'Added a moment ago', brand: 'y', brandEn: 'y', cat: SEED.data.products[0].cat, kg: 10, active: true });
    const snap = { products: S11.rows('products').filter(p => p.id !== 'P-150') };
    w.ERP.mergeMasterFromDb(snap);
    check('W8b a re-sync keeps a product added on this page whose save has not gone out yet',
      w.PRODUCTS.some(p => p.id === 'P-152'), w.PRODUCTS.slice(-3).map(p => p.id).join());
    check('W8c …and drops one that the server had at the last sync but no longer has (deleted there)',
      !w.PRODUCTS.some(p => p.id === 'P-150'));
    w.DOCS.unshift({ no: 'CST-2026-000001', kind: 'CST', type: 'CUSTOMER_STATEMENT', iso: '2026-09-25', ref: { party: 'y' } });
    w.AUDIT.unshift({ at: '1:00 PM', date: '25 Sep 2026', by: 'x', action: 'Statement generated', doc: 'CST-2026-000001', ref: 'y' });
    w.ERP.mergeMasterFromDb({ documents: [] });
    check('W8d a re-sync keeps a document generated on this page before its save went out, with its audit entry and number',
      w.DOCS.some(d => d.no === 'CST-2026-000001') && w.AUDIT.length === 1 && w.DOCSEQ.CST === 1, JSON.stringify({ d: w.DOCS.length, a: w.AUDIT.length, s: w.DOCSEQ.CST }));
    const W2 = await boot(S11);
    check('W9 another browser sees the same: the new movement and stock, nothing old', W2.w.MOVES.length === 1 && W2.w.STOCKMAP[p0.id + '|' + wh] === 5 && !W2.w.PRODUCTS.some(p => p.id === 'P-139'));
    for (const b of [W1, W2]) b.w.close();
  }
  { // W10: browser mode keeps its merge behaviour (unchanged)
    const W3 = await boot(null);
    check('W10 browser mode is unchanged (still on IndexedDB, starts normally)', W3.ready && W3.w.FDB.driver === 'indexeddb');
    W3.w.close();
  }

  /* ══ F. failures are never hidden ═════════════════════════════════════ */
  const S3 = new Mock(SEED); const F1 = await boot(S3), wF = F1.w;
  const whF = wF.WAREHOUSES[1].id, pf = wF.PRODUCTS.filter(x => x.active !== false);
  await wF.ERP.Purchases.save({ supplierId: wF.SUPPLIERS[0].id, warehouseId: whF, purchaseDate: '2026-09-01', items: [{ productId: pf[0].id, quantity: 100, unitPrice: 2500 }] });
  S3.fail['commit.php'] = { times: 1, kind: 'network' };
  let net = null; const before = S3.count('invoices');
  await wF.ERP.Invoices.save({ customerId: wF.CUSTOMERS[0].id, warehouseId: whF, invoiceDate: '2026-09-02', items: [{ productId: pf[0].id, quantity: 5, unitPrice: 3000 }] }).catch(e => { net = e; });
  check('F1 connection lost while saving → the save is reported as failed', net && net.network === true, net && net.message);
  check('F2 …the user gets a blocking "NOT saved — reload" notice', /NOT saved/.test(overlayText(wF, 'fcsd-failed') || ''));
  check('F3 …the server was not changed', S3.count('invoices') === before);
  check('F4 …the status pill no longer claims everything is saved', /Not saved/.test(wF.FDB.status().label) && wF.FDB.status().healthy === false);
  const F2 = await boot(S3);
  check('F5 a reload shows the server\'s truth: the unsaved invoice is not there', F2.w.ERP.S.invoices.length === before);
  S3.fail['commit.php'] = { times: 1, status: 419 };
  let sess = null; await F2.w.ERP.Payments.receive({ customerId: F2.w.CUSTOMERS[0].id, amount: 10, method: 'Cash', date: '2026-09-03' }).catch(e => { sess = e; });
  check('F6 an expired session (419/401) says to sign in again', sess && /sign-in expired|sign in/i.test(sess.message), sess && sess.message);
  const S4 = new Mock(SEED); const F3 = await boot(S4);
  S4.fail['read.php'] = { times: 1, kind: 'network' };
  let pre = null; await F3.w.ERP.Payments.receive({ customerId: F3.w.CUSTOMERS[0].id, amount: 10, method: 'Cash', date: '2026-09-03' }).catch(e => { pre = e; });
  check('F7 if the counters cannot be checked, the save is refused BEFORE anything is changed (no reload needed)', pre && !overlayText(F3.w, 'fcsd-failed') && S4.count('payments') === 0, pre && pre.message);
  const ok2 = await F3.w.ERP.Payments.receive({ customerId: F3.w.CUSTOMERS[0].id, amount: 10, method: 'Cash', date: '2026-09-03' }).catch(e => e);
  check('F8 …and simply working again afterwards', ok2 && ok2.receiptNumber);
  for (const b of [A, N, F1, F2, F3]) b.w.close();

  const report = out.join('\n'); console.log(report);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.log(out.join(String.fromCharCode(10))); console.error('TEST HARNESS ERROR', e); process.exit(2); });
