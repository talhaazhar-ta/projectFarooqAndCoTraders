/* Statements overhaul (2026-10-03): one ERP.Statement behind the khata page, the Statement of Account
   screen, the printed / Word / WhatsApp document and both Excel files. Covers the defects found in
   the old, separate builders (see docs/STATEMENTS.md). */
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
const HTML = fs.readFileSync('dist/farooq-co-erp.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) { pass++; out.push('  ✔ ' + n); } else { fail++; out.push('  ✘ ' + n + (d ? '   → ' + d : '')); } };

function boot(store) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'https://x.local/e', beforeParse(w) {
      w.indexedDB = store.idb; w.IDBKeyRange = FDBKeyRange; w.print = () => {};
      w.confirm = () => true; w.prompt = () => 'test'; w.scrollTo = () => {}; w.open = () => null;
      w.URL.createObjectURL = () => 'b'; w.URL.revokeObjectURL = () => {};
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.matchMedia = q => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    } });
  return dom.window;
}
/* rendered text only — body.textContent also holds inlined <script> source */
const shown = (win, sel) => { const el = win.document.querySelector(sel || 'body'); if (!el) return '';
  const c = el.cloneNode(true); c.querySelectorAll('script,style').forEach(x => x.remove()); return c.textContent; };

const run = async () => {
  const store = { idb: new FDBFactory() };
  const win = boot(store);
  for (let i = 0; i < 400 && !(win.ERP && win.ERP.ready); i++) await sleep(25);
  await sleep(250);
  const ERP = win.ERP, M = win.Money, D = win.document;
  const $ = s => D.querySelector(s), $$ = s => Array.from(D.querySelectorAll(s));
  const click = el => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const change = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); } };
  const S = ERP.Statement;
  await ERP.Settings.save({ allowNegativeStock: true });

  const wh = win.WAREHOUSES[1].id, P = win.PRODUCTS.filter(p => p.active !== false);
  const c = win.CUSTOMERS[3];
  const sup = win.SUPPLIERS[0];
  await ERP.Purchases.save({ supplierId: sup.id, warehouseId: wh, purchaseDate: '2026-08-25',
    items: P.slice(0, 4).map(p => ({ productId: p.id, quantity: 400, unitPrice: 2000 })) });

  /* a shop that came with a balance of 100,000 on 1 August, then trades in September */
  c.openingBalanceP = M.toP(100000); c.openingBalanceDate = '2026-08-01';
  await ERP.Invoices.save({ customerId: c.id, warehouseId: wh, invoiceDate: '2026-09-01',
    items: [{ productId: P[0].id, quantity: 20, unitPrice: 10000 }] });                                 // +200,000
  await ERP.Payments.receive({ customerId: c.id, amount: 50000, method: 'Cash', date: '2026-09-10' }); // -50,000
  await ERP.Invoices.save({ customerId: c.id, warehouseId: wh, invoiceDate: '2026-09-12',
    items: [{ productId: P[1].id, quantity: 10, unitPrice: 5000 }] });                                   // +50,000
  await ERP.Payments.receive({ customerId: c.id, amount: 30000, method: 'Bank Transfer', reference: 'TRX-9', date: '2026-09-14' }); // -30,000
  await ERP.Adjustments.create({ customerId: c.id, direction: 'CREDIT', amount: 5000, reason: 'Discount allowed', date: '2026-09-16' });
  /* now: 100,000 + 200,000 - 50,000 + 50,000 - 30,000 - 5,000 = 265,000 */
  const FULL = M.toP(265000);

  /* ── 1 · opening balance and the sum ─────────────────────────────────── */
  const all = S.build('CUSTOMER', c.id, {});
  check('T1 a stored opening balance is the Opening figure and the sum closes',
    all.opening === M.toP(100000) && all.closing === FULL && all.opening + all.debit - all.credit === all.closing,
    [all.opening, all.debit, all.credit, all.closing].map(M.fmt).join(' | '));
  const sepMid = S.build('CUSTOMER', c.id, { from: '2026-09-12', to: '2026-09-15' });
  check('T2 a dated statement opens at the balance before it (the old opening line is folded in)',
    sepMid.opening === M.toP(250000) && sepMid.closing === M.toP(270000) &&
    sepMid.opening + sepMid.debit - sepMid.credit === sepMid.closing && sepMid.entries.length === 2,
    [sepMid.opening, sepMid.closing].map(M.fmt).join(' | ') + ' · ' + sepMid.entries.length);
  check('T2b it gets a "Balance brought forward" line carrying that opening balance',
    !!sepMid.bf && sepMid.bf.balance === M.toP(250000) && !all.bf);
  const ks = ERP.Khata.summary(c.id, { from: '2026-09-12', to: '2026-09-15' });
  check('T2c the khata summary agrees (it used to show the stored opening row instead)',
    ks.opening === M.toP(250000) && ks.closing === M.toP(270000));

  /* ── 2 · an empty period ─────────────────────────────────────────────── */
  const quiet = S.build('CUSTOMER', c.id, { from: '2026-08-10', to: '2026-08-20' });
  check('T3 a period with no entries shows the balance AT THAT TIME, not today\'s',
    quiet.entries.length === 0 && quiet.opening === M.toP(100000) && quiet.closing === M.toP(100000) &&
    quiet.current === FULL, [quiet.opening, quiet.closing, quiet.current].map(M.fmt).join(' | '));

  /* ── 3 · view filters never move a balance ───────────────────────────── */
  const onlyPay = ERP.Khata.summary(c.id, { types: ['PAYMENT'] });
  check('T4 filtering by type leaves opening and closing alone and says it is filtered',
    onlyPay.opening === M.toP(100000) && onlyPay.closing === FULL && onlyPay.filtered &&
    onlyPay.rows.filter(r => r.type !== 'OPENING').every(r => r.type === 'PAYMENT') &&
    onlyPay.opening + onlyPay.debit - onlyPay.credit === onlyPay.closing);
  const byQ = ERP.Khata.summary(c.id, { q: 'zzznothing' });
  check('T4b a search with no hits still reports the true closing balance',
    byQ.closing === FULL && byQ.count === 0);

  /* ── 4 · the printed document ────────────────────────────────────────── */
  ERP.KhataState.order = 'desc'; ERP.KhataState.preset = 'month'; ERP.KhataState.types = ['SALE'];
  const m = ERP.DocModel.statement(c.id, 'CUSTOMER', '2026-09-01', '2026-09-30');
  const dates = m.rows.filter(r => !r.cls).map(r => r.sr);
  const sorted = dates.slice().sort((a, b) => new Date(a) - new Date(b));
  check('T5 the printed statement is oldest-first whatever the khata page was last set to',
    dates.join() === sorted.join() && m.rows[0].cls === 'fc-bf', dates.join(' | '));
  check('T5b its Period line shows the dates it was built for, not the khata page\'s preset',
    m.meta[0][1].includes(win.fmtDate('2026-09-01')) && !/month/i.test(m.meta[0][1]), m.meta[0][1]);
  check('T5c it ignores the screen\'s type filter (all lines of the period are on paper)',
    m.rows.length >= 6, String(m.rows.length));
  ERP.KhataState.preset = 'all'; ERP.KhataState.types = [];
  const mAll = ERP.DocModel.statement(c.id, 'CUSTOMER', null, null);
  const wa = ERP.Paper.waText(mAll);
  check('T6 the WhatsApp text quotes the CLOSING balance (it quoted "Returns and credits")',
    wa.includes('Closing balance: ' + M.fmt(FULL)) && /Dr/.test(wa), wa);
  const html = ERP.Paper.html(mAll);
  check('T6b the sheet is marked as a statement and flags the opening line',
    /class="fcdoc fc-stmt"/.test(html) && /class="fc-bf"/.test(html));
  check('T6c every balance on paper says Dr or Cr', mAll.rows.every(r => /(Dr|Cr)$/.test(r.amount) || /^0\.00$/.test(r.amount)),
    mAll.rows.map(r => r.amount).join(' | '));

  /* ── 5 · a supplier statement keeps its description and quantity ─────── */
  const sEntries = S.build('SUPPLIER', sup.id, {}).entries.filter(e => e.type === 'PURCHASE');
  check('T7 a supplier purchase line still carries its quantity and description (milling re-roll dropped them)',
    sEntries.length > 0 && sEntries.every(e => e.qtyLabel && e.qtyLabel !== '—' && e.description),
    JSON.stringify(sEntries.map(e => [e.qtyLabel, e.description])));
  const sm = ERP.DocModel.statement(sup.id, 'SUPPLIER', null, null);
  check('T7b the supplier document is built by the same code (title, Dr/Cr, no Customer code)',
    sm.title === 'SUPPLIER STATEMENT' && sm.rows.length > 0 && !/Customer code/.test(ERP.Paper.html(sm)));

  /* ── 6 · same-day order is total ─────────────────────────────────────── */
  const rows = [
    { iso: '2026-09-01', kind: 'PAYMENT', ref: 'RCP-2', id: 'b' }, { iso: '2026-09-01', kind: 'PAYMENT', ref: 'RCP-1', id: 'a' },
    { iso: '2026-09-01', kind: 'REFUND', ref: 'RCP-1', id: 'c', createdAt: '2026-09-01T10:00:00Z' },
    { iso: '2026-09-01', kind: 'OPENING', ref: 'OPENING', id: 'opening' }
  ];
  const o1 = rows.slice().sort(ERP.Ledger.rowOrder).map(r => r.id).join();
  const o2 = rows.slice().reverse().sort(ERP.Ledger.rowOrder).map(r => r.id).join();
  check('T8 rows with the same date and no timestamp sort the same way from any starting order',
    o1 === o2 && o1.startsWith('opening'), o1 + ' / ' + o2);

  /* ── 7 · inverted range ──────────────────────────────────────────────── */
  check('T9 an inverted range builds nothing instead of a wrong balance',
    S.build('CUSTOMER', c.id, { from: '2026-09-20', to: '2026-09-01' }).invalid === true);
  ERP.KhataState.preset = 'custom'; ERP.KhataState.from = '2026-09-20'; ERP.KhataState.to = '2026-09-01';
  win.go('khata', c.id); await sleep(250);
  check('T9b the khata page warns about it instead of showing an empty ledger',
    /From.*is after.*To/i.test(shown(win, '#view')) && !$('table.kh-table'));
  ERP.KhataState.preset = 'all'; ERP.KhataState.from = ''; ERP.KhataState.to = '';

  /* ── 8 · Urdu shop name in the Excel file name ───────────────────────── */
  let downloaded = null;
  const origCreate = D.createElement.bind(D);
  D.createElement = function (tag) { const el = origCreate(tag); if (tag === 'a') el.click = () => { downloaded = el.download; }; return el; };
  const keep = c.sh; c.sh = 'فاروق اسٹور';
  const fn = ERP.exportStatementExcel(c.id);
  check('T10 an Urdu shop name stays in the Excel file name', /فاروق/.test(fn) && downloaded === fn, fn);
  c.sh = keep;
  const x = S.excel('CUSTOMER', c.id, { from: '2026-09-12' });
  const led = x.sheets[0].rows;
  check('T10b the Excel statement has the brought-forward line, totals and Dr/Cr',
    led.some(r => r[1] === 'Brought forward') && led.some(r => r[3] === 'Totals') && led.some(r => r[8] === 'Dr'));
  const sFile = S.download('SUPPLIER', sup.id, {});
  check('T10c supplier Excel uses the same builder', /^supplier-statement-/.test(sFile) && downloaded === sFile, sFile);
  D.createElement = origCreate;

  /* ── 9 · over-paid shop, advance to a supplier, a party with nothing ─── */
  const c2 = win.CUSTOMERS[5];
  await ERP.Payments.receive({ customerId: c2.id, amount: 7000, method: 'Cash', date: '2026-09-05' });
  const cr = S.build('CUSTOMER', c2.id, {});
  const crm = ERP.DocModel.statement(c2.id, 'CUSTOMER', null, null);
  check('T11 an over-paid shop reads Cr, "In credit", and the words are of the positive amount',
    cr.closing === -M.toP(7000) && S.balText('CUSTOMER', cr.closing) === '7,000.00 Cr' && crm.status === 'In credit' &&
    !/-/.test(crm.words) && crm.words.length > 0, crm.words);
  const sup2 = win.SUPPLIERS[2];
  await ERP.Payments.pay({ supplierId: sup2.id, amount: 3000, method: 'Cash', date: '2026-09-05' });
  const sadv = S.build('SUPPLIER', sup2.id, {});
  check('T11b money paid ahead to a supplier reads Dr, "Paid in advance"',
    sadv.closing === -M.toP(3000) && S.side('SUPPLIER', sadv.closing) === 'Dr' &&
    S.standing('SUPPLIER', sadv.closing).status === 'Paid in advance', String(sadv.closing));
  const none = win.CUSTOMERS[7];
  const nb = S.build('CUSTOMER', none.id, {});
  const nm = ERP.DocModel.statement(none.id, 'CUSTOMER', null, null);
  check('T12 a shop with no entries builds a clean empty statement',
    nb.entries.length === 0 && nb.closing === 0 && nm.rows.length === 0 && /No lines/.test(ERP.Paper.html(nm)));
  win.go('khata', none.id); await sleep(200);
  check('T12b and its page shows the empty state, not a blank screen', /No entries in this view/.test(shown(win, '#view')));

  /* ── 10 · cancelled and reversed things stay off the statement ───────── */
  const c3 = win.CUSTOMERS[6];
  const invX = await ERP.Invoices.save({ customerId: c3.id, warehouseId: wh, invoiceDate: '2026-09-03',
    items: [{ productId: P[2].id, quantity: 2, unitPrice: 4000 }] });
  const payX = await ERP.Payments.receive({ customerId: c3.id, amount: 1000, method: 'Cash', date: '2026-09-04' });
  const before = S.build('CUSTOMER', c3.id, {});
  await ERP.Payments.reverse(payX.id, 'test');
  await ERP.Invoices.cancel(invX.id, 'test');
  const after = S.build('CUSTOMER', c3.id, {});
  check('T13 a reversed payment and a cancelled invoice are gone and the sum still closes',
    before.entries.length === 2 && after.entries.length === 0 && after.closing === 0);

  /* ── 11 · the Statement of Account screen ────────────────────────────── */
  win.go('soa'); await sleep(200);
  check('T14 it opens on "— Choose a shop —", not on an arbitrary first shop',
    $('[data-soaf="partyId"]').value === '' && /Choose a shop/.test(shown(win, '#view')) && !$('table.kh-table'));
  check('T14b Print and Excel are disabled until a party is chosen',
    $('[data-soaprint]').disabled && $('[data-soaexcel]').disabled);
  change($('[data-soaf="partyId"]'), c.id); await sleep(150);
  check('T14c the table shares the khata columns (Type included) and the sum line is shown',
    $$('.kh-table thead th').map(t => t.textContent.trim()).includes('Type') && !!$('.kh-eq'));
  check('T14d the closing balance card carries Dr/Cr in the table footer',
    /Dr|Cr/.test($('.kh-table tfoot .kh-bal').textContent));
  change($('[data-soaf="from"]'), '2026-09-12'); await sleep(120);
  check('T14e a From date adds the brought-forward line', !!$('.kh-table tr.bf'));

  /* paging: 60 receipts → 2 pages of 50 */
  const c4 = win.CUSTOMERS[8];
  for (let i = 0; i < 60; i++) await ERP.Payments.receive({ customerId: c4.id, amount: 10 + i, method: 'Cash', date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') });
  change($('[data-soaf="from"]'), ''); await sleep(60);
  change($('[data-soaf="partyId"]'), c4.id); await sleep(150);
  check('T15 a long account is paged 50 at a time (it used to be cut to the latest 300 with no way back)',
    $$('.kh-table tbody tr').length === 50 && !!$('[data-soapage="next"]'), String($$('.kh-table tbody tr').length));
  click($('[data-soapage="next"]')); await sleep(120);
  check('T15b the next page holds the rest', $$('.kh-table tbody tr').length === 10, String($$('.kh-table tbody tr').length));
  change($('[data-soaf="partyId"]'), c.id); await sleep(80);

  /* an inactive supplier that still has a balance stays selectable */
  const sinact = win.SUPPLIERS[0]; sinact.active = false;
  change($('[data-soaf="type"]'), 'SUPPLIER'); await sleep(120);
  check('T16 an inactive supplier with history is still listed, marked inactive',
    $$('[data-soaf="partyId"] option').some(o => o.value === sinact.id && /inactive/.test(o.textContent)));
  sinact.active = true;

  /* ── 12 · the khata page ─────────────────────────────────────────────── */
  win.go('khata', c.id); await sleep(250);
  check('T17 the sum line (Opening + sales − payments … = Closing) is on the khata page', !!$('.kh-eq') && /Closing balance/.test($('.kh-eq').textContent));
  change($('[data-khfil="type"]'), 'PAYMENT'); await sleep(150);
  check('T17b a filter shows a removable chip and says the totals cover only the lines shown',
    !!$('.kh-chip') && /entries shown/.test($('.kh-table tfoot').textContent));
  click($('[data-khclear="all"]')); await sleep(150);
  check('T17c "Clear filters" brings every line back', !$('.kh-chip') && $$('.kh-table tbody tr').length >= 6);
  check('T17d Print and PDF are one button now', !!$('[data-khexport="print"]') && !$('[data-khexport="pdf"]'));
  check('T18 the phone styles cover the totals row and the three amounts',
    /kh-table tfoot/.test($('#fc-khata-css').textContent) && /kh-c-dr/.test($('#fc-khata-css').textContent));

  console.log('\n' + out.join('\n') + `\n\n${pass} passed, ${fail} failed\n`);
  win.close();
  process.exit(fail ? 1 : 0);
};
run().catch(e => { console.error('HARNESS ERROR:', e); console.log(out.join('\n')); process.exit(2); });
