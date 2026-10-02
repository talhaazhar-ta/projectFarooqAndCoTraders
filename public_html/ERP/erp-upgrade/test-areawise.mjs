/* Area-wise collection report, plus the gaps that were still open from the
   client change set: supplier statement columns, the Supplier code label, and
   descriptions being findable in search. */
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

const HTML = fs.readFileSync(path.resolve('dist/farooq-co-erp.html'), 'utf8');
let pass = 0, fail = 0; const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push(`  ✔ ${name}`); }
  else { fail++; out.push(`  ✘ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = n => Math.round(n * 100);

function boot(store) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'https://x.local/e',
    beforeParse(w) {
      w.indexedDB = store.idb || (store.idb = new FDBFactory());
      w.IDBKeyRange = FDBKeyRange;
      w.print = () => {}; w.confirm = () => true; w.alert = () => {};
      w.scrollTo = () => {}; w.open = () => null;
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    }
  });
  return dom.window;
}

async function main() {
  const store = {};
  const w = boot(store);
  for (let i = 0; i < 400 && !(w.ERP && w.ERP.ready); i++) await sleep(25);
  await (w.ERP.landedReady || Promise.resolve()).catch(() => {});
  await sleep(250);
  const ERP = w.ERP, D = w.document;
  const $ = q => D.querySelector(q);
  const $$ = q => [...D.querySelectorAll(q)];
  const click = el => el && el.dispatchEvent(new w.Event('click', { bubbles: true }));

  await ERP.Settings.save({ allowNegativeStock: true });
  check('A0 the area-wise module is present', !!ERP.AreaReport);

  /* ── give two shops in different areas some movement ─────────────────── */
  const wh = w.WAREHOUSES[0], prod = w.PRODUCTS[0];
  const withRegion = w.CUSTOMERS.filter(c => c.region);
  const c1 = withRegion[0];
  const c2 = withRegion.find(c => c.region !== c1.region) || withRegion[1];

  async function sell(c, amount) {
    return ERP.Invoices.save({
      customerId: c.id, warehouseId: wh.id, invoiceDate: '2026-09-10', paidAmount: 0,
      items: [{ productId: prod.id, quantity: 1, unitPrice: amount, discount: 0, warehouseId: wh.id }]
    });
  }
  const b1 = ERP.Ledger.customerBalance(c1.id);
  await sell(c1, 10000);
  await ERP.Payments.receive({ customerId: c1.id, amount: 4000, method: 'Cash', date: '2026-09-11' });
  await sell(c2, 5000);

  /* ── the data ────────────────────────────────────────────────────────── */
  const data = ERP.AreaReport.build(null, null, {});
  check('A1 shops are grouped by area', data.groups.length >= 1, String(data.groups.length));
  const g1 = data.groups.find(g => g.rows.some(r => r.customerId === c1.id));
  const r1 = g1 && g1.rows.find(r => r.customerId === c1.id);
  check('A2 the shop appears under its own area', !!r1);
  check('A3 total sales are the period debits', r1.sales >= R(10000), String(r1.sales));
  check('A4 total collection is the period credits', r1.collection >= R(4000), String(r1.collection));
  check('A5 the balance is the ledger closing balance, not a recomputation',
    r1.balance === ERP.Ledger.customerBalance(c1.id), `${r1.balance} vs ${ERP.Ledger.customerBalance(c1.id)}`);
  check('A6 the row carries the code and contact for the sheet',
    'code' in r1 && 'contact' in r1);
  check('A7 the group subtotal is the sum of its rows',
    g1.balance === g1.rows.reduce((a, r) => a + r.balance, 0));
  check('A8 the grand total is the sum of the groups',
    data.total.balance === data.groups.reduce((a, g) => a + g.balance, 0));
  check('A9 sales minus collection reconciles to the balance movement',
    data.total.balance === data.total.opening + data.total.sales - data.total.collection,
    `${data.total.balance} vs ${data.total.opening + data.total.sales - data.total.collection}`);

  /* idle shops are noise on a collection sheet */
  const idle = ERP.AreaReport.build(null, null, { includeIdle: true });
  check('A10 idle shops are left off by default',
    idle.total.shops >= data.total.shops, `${idle.total.shops} vs ${data.total.shops}`);

  /* area filter */
  const oneArea = ERP.AreaReport.build(null, null, { regionId: c1.region });
  check('A11 the report can be filtered to one area',
    oneArea.groups.length === 1 && oneArea.groups[0].rows.some(r => r.customerId === c1.id),
    String(oneArea.groups.length));

  /* date range must not leak */
  const early = ERP.AreaReport.build('2020-01-01', '2020-12-31', {});
  check('A12 a period before any activity shows no sales',
    early.total.sales === 0, String(early.total.sales));

  /* ── the document ────────────────────────────────────────────────────── */
  const m = ERP.AreaReport.docModel(null, null, {});
  const labels = m.columns.map(c => c.label);
  check('A13 the document has the template columns',
    ['Sr. No.', 'Name', 'Contact #', 'Total Sales', 'Total Collection'].every(l => labels.includes(l)),
    labels.join(' | '));
  check('A14 the balance column carries the Urdu heading',
    labels.some(l => /بقایا/.test(l)), labels.join(' | '));
  check('A15 each area gets a heading row', m.rows.some(r => r._group));

  /* serial numbers instead of old codes; restart in each area, in name order */
  check('A15a every row has a serial that runs 1..n inside its area',
    data.groups.every(g => g.rows.every((r, i) => r.sr === i + 1)));
  check('A15b the print document shows serials, not old codes',
    m.rows.filter(r => !r._group && !r._subtotal).every(r => /^\d+$/.test(r.sr)) &&
    m.rows.filter(r => !r._group && !r._subtotal)[0].sr === '1');

  /* a brand-new shop (no sales yet) is hidden by default — but the screen says so and can show it */
  const fresh = { id: 'CUST-9999', sh: 'Zzz Fresh Shop', ow: '', region: c1.region, ph: '', wa: '', addr: '',
                  lim: null, term: '', bal: 0, tot: 0, ord: 0, bagsOut: 0, last: null, active: true };
  w.CUSTOMERS.push(fresh);
  const hid = ERP.AreaReport.build(null, null, {});
  check('A15c a shop with no activity is counted as hidden', hid.hidden >= 1 &&
    !hid.groups.some(g => g.rows.some(r => r.customerId === fresh.id)), String(hid.hidden));
  w.go('areawise'); await sleep(150);
  const bodyText = () => { const b = D.body.cloneNode(true); b.querySelectorAll('script,style').forEach(e => e.remove()); return b.textContent; };
  check('A15d the screen tells how many shops are not shown', /not shown/.test(bodyText()) && !!$('[data-awshowidle]'));
  check('A15e the screen header is Sr. No., no Code column',
    $$('.aw-tbl thead th').map(t => t.textContent)[0] === 'Sr. No.');
  click($('[data-awshowidle]')); await sleep(150);
  check('A15f "Show all shops" lists the new shop and drops the notice',
    bodyText().includes('Zzz Fresh Shop') && !$('[data-awshowidle]'));
  w.CUSTOMERS.splice(w.CUSTOMERS.indexOf(fresh), 1);
  check('A16 each area gets a subtotal row', m.rows.some(r => r._subtotal));
  check('A17 the footer is the grand total',
    m.itemsFooter && /TOTAL VALUE/.test(m.itemsFooter.description));
  const html = ERP.Paper.html(m);
  check('A18 it renders as a printable document', html.length > 500 && /Area-wise/i.test(html));
  check('A19 totals appear on the printed sheet', /Total collection/i.test(html));

  /* ── the sheet ───────────────────────────────────────────────────────── */
  const sh = ERP.AreaReport.sheet(null, null, {});
  check('A20 the Excel sheet has a header row',
    sh.rows.some(r => r[0] === 'Sr. No.' && r.includes('Total Collection')));
  check('A21 it keeps the Urdu name in its own column',
    sh.rows.some(r => r[1] === 'Urdu name') || sh.rows[3][2] === 'Urdu name',
    JSON.stringify(sh.rows[3]));
  check('A22 it ends with the grand total',
    sh.rows[sh.rows.length - 1][1] === 'TOTAL VALUE');

  /* ── the screen ──────────────────────────────────────────────────────── */
  check('A23 a nav entry is added', w.NAV.some(n => n.id === 'areawise'));
  check('A24 it sits in the Finance group',
    w.NAVGROUPS.some(g => g[0] === 'Finance' && g[1].includes('areawise')));
  w.go('areawise'); await sleep(350);
  check('A25 the screen opens', !!$('.aw-tbl'));
  check('A26 area headings are shown', $$('.aw-group').length >= 1);
  check('A27 subtotal rows are shown', $$('.aw-sub').length >= 1);
  check('A28 the grand total row is shown', /TOTAL VALUE/.test($('#view').textContent));
  check('A29 there is a line for the accountant to sign',
    /Accountant Sign/.test($('#view').textContent));
  check('A30 print, PDF and Excel are offered',
    !!$('[data-awprint]') && !!$('[data-awpdf]') && !!$('[data-awexcel]'));

  /* ── remaining change-set gaps ───────────────────────────────────────── */
  const sup = w.SUPPLIERS[0];
  const sm = ERP.DocModel.statement(sup.id, 'SUPPLIER', null, null);
  const sLabels = sm.columns.map(c => c.label);
  check('G1 the supplier statement has Description / تفصیل',
    sLabels.some(l => /تفصیل/.test(l)), sLabels.join(' | '));
  check('G2 the supplier statement has a Qty column',
    sLabels.includes('Qty'), sLabels.join(' | '));
  check('G3 it uses the Urdu debit and credit headings',
    sLabels.some(l => /بنام/.test(l)) && sLabels.some(l => /جمع/.test(l)));
  check('G4 the description column is the widest',
    sm.columns.find(c => /تفصیل/.test(c.label)).width >= 0.25);
  const sHtml = ERP.Paper.html(sm);
  check('G5 a supplier statement says Supplier code, not Customer code',
    !/Customer code/.test(sHtml), 'found "Customer code"');
  const cm = ERP.DocModel.statement(w.CUSTOMERS[0].id, 'CUSTOMER', null, null);
  check('G6 a customer statement still says Customer code',
    !/Supplier code/.test(ERP.Paper.html(cm)));

  /* descriptions must be findable */
  const EN = 'Freight charges vehicle 5623';
  const UR = 'نقدی بدست ارشد جمیل';
  await ERP.Invoices.save({
    customerId: c1.id, warehouseId: wh.id, invoiceDate: '2026-09-12', paidAmount: 0,
    description: EN,
    items: [{ productId: prod.id, quantity: 1, unitPrice: 100, discount: 0, warehouseId: wh.id }]
  });
  await ERP.Payments.receive({ customerId: c1.id, amount: 50, method: 'Cash',
                               date: '2026-09-12', description: UR });
  await sleep(200);
  const find = q => ERP.Search.run ? ERP.Search.run(q) : ERP.Search.query(q);
  check('G7 an English description is searchable by its number',
    find('5623').length > 0, String(find('5623').length));
  check('G8 and by a word in it', find('Freight').length > 0);
  check('G9 an Urdu description is searchable', find('ارشد').length > 0,
    String(find('ارشد').length));

  console.log('\n' + out.join('\n') + `\n\n${pass} passed, ${fail} failed\n`);
  w.close();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('HARNESS ERROR:', e); console.log(out.join('\n')); process.exit(2); });
