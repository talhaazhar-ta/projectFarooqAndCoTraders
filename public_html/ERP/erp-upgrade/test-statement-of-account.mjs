/* Client change request (2026-09-16, clientNewReq/):
   1. The "Receive payment" panel should offer an Area filter, the same way
      the invoice builder already does, so only that area's shops appear.
   2. A "Statement of Account" screen under Finance should let the owner
      pick either a Customer or a Supplier and see the full ledger, with
      dates — reusing the same figures the per-shop/per-supplier Statement
      buttons already print, never a second calculation of them. */
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
  const ERP = w.ERP, D = w.document, M = w.Money;
  const $ = q => D.querySelector(q);
  const $$ = q => [...D.querySelectorAll(q)];
  const click = el => el && el.dispatchEvent(new w.Event('click', { bubbles: true }));
  const change = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); } };

  await ERP.Settings.save({ allowNegativeStock: true });

  /* ── data: two shops in different areas, and a supplier ── */
  const wh = w.WAREHOUSES[0], prod = w.PRODUCTS[0], sup = w.SUPPLIERS[0];
  const withRegion = w.CUSTOMERS.filter(c => c.region);
  const c1 = withRegion[0];
  const c2 = withRegion.find(c => c.region !== c1.region) || withRegion[1];

  async function sell(c, amount) {
    return ERP.Invoices.save({
      customerId: c.id, warehouseId: wh.id, invoiceDate: '2026-09-10', paidAmount: 0,
      items: [{ productId: prod.id, quantity: 1, unitPrice: amount, discount: 0, warehouseId: wh.id }]
    });
  }
  await sell(c1, 12000);
  await ERP.Payments.receive({ customerId: c1.id, amount: 5000, method: 'Cash', date: '2026-09-11' });
  await sell(c2, 7000);
  await ERP.Purchases.save({
    supplierId: sup.id, warehouseId: wh.id, purchaseDate: '2026-09-10',
    items: [{ productId: prod.id, quantity: 2, unitPrice: 4000 }]
  });

  /* ══════════════════════════════════════════════════════════════════════
     FEATURE 1 — Area filter on "Receive payment"
     ══════════════════════════════════════════════════════════════════════ */
  ERP.setPayFor && ERP.setPayFor(null);
  w.openPanel('payment'); await sleep(120);
  check('F1 the payment panel opens with an Area selector', !!$('#fcPayArea'));
  check('F2 with no shop pre-chosen, Area defaults to "All areas"', $('#fcPayArea').value === '');
  const allShopCount = $('#fcPayCust').options.length;
  check('F3 the Shop list starts with every shop, after a blank "Choose a shop" line',
    allShopCount === w.CUSTOMERS.length + 1 && $('#fcPayCust').options[0].value === '' && $('#fcPayCust').value === '', String(allShopCount));

  change($('#fcPayArea'), c1.region); await sleep(60);
  const expectAreaCount = w.CUSTOMERS.filter(c => (c.region || '') === c1.region).length;
  const gotAreaCount = $('#fcPayCust').options.length;
  check('F4 choosing an Area narrows the Shop list to that area only',
    gotAreaCount === expectAreaCount + 1, `${gotAreaCount} vs ${expectAreaCount} + the blank line`);
  check('F5 every option left is actually in that area',
    $$('#fcPayCust option').filter(o => o.value).every(o => (w.custBy(o.value).region || '') === c1.region));
  check('F6a until a shop is picked the banner asks for one, not a balance', /Choose the shop/.test($('#fcPayBal').textContent), $('#fcPayBal').textContent);
  change($('#fcPayCust'), $$('#fcPayCust option').filter(o => o.value)[0].value); await sleep(40);
  check('F6 the outstanding-balance banner matches the newly selected shop',
    $('#fcPayBal').textContent.includes(M.fmt(ERP.Ledger.customerBalance($('#fcPayCust').value))),
    $('#fcPayBal').textContent);

  change($('#fcPayArea'), ''); await sleep(60);
  check('F7 clearing the Area filter shows every shop again',
    $('#fcPayCust').options.length === w.CUSTOMERS.length + 1);

  const cb1 = $('#panel .x') || $('[data-close]') || $('#scrim'); if (cb1) click(cb1);
  await sleep(80);

  /* opening the panel from a specific shop's own page pre-fills that shop's area */
  ERP.setPayFor && ERP.setPayFor(c2.id);
  w.openPanel('payment'); await sleep(120);
  check('F8 opening "Receive payment" for a specific shop pre-selects that shop\'s own area',
    $('#fcPayArea').value === (c2.region || ''), $('#fcPayArea').value + ' vs ' + c2.region);
  check('F9 and that shop is the one selected',
    $('#fcPayCust').value === c2.id);
  const cb2 = $('#panel .x') || $('[data-close]') || $('#scrim'); if (cb2) click(cb2);
  await sleep(80);
  ERP.setPayFor && ERP.setPayFor(null);

  /* ══════════════════════════════════════════════════════════════════════
     FEATURE 2 — Statement of Account, under Finance, either party
     ══════════════════════════════════════════════════════════════════════ */
  check('S1 a nav entry is added', w.NAV.some(n => n.id === 'soa'));
  check('S2 it sits in the Finance group',
    w.NAVGROUPS.some(g => g[0] === 'Finance' && g[1].includes('soa')));

  w.go('soa'); await sleep(150);
  check('S3 the screen opens', /Statement of Account/.test($('#view').textContent));
  check('S4 it defaults to a Customer ledger', $('[data-soaf="type"]').value === 'CUSTOMER');
  check('S5 an Area filter is offered for customers', !!$('[data-soaf="regionId"]'));

  /* pick the customer we gave activity to, and reconcile against the ledger */
  change($('[data-soaf="partyId"]'), c1.id); await sleep(100);
  const L1 = ERP.Ledger.customer(c1.id, null, null);
  const closingCard1 = $$('.kh-card').map(x => x.textContent).find(t => /^Closing balance/.test(t)) || '';
  check('S6 the closing balance on screen matches the customer ledger',
    closingCard1.includes(M.fmt(L1.closing)), closingCard1);
  check('S7 every ledger entry for this shop is listed on screen',
    $$('.kh-table tbody tr').length === L1.rows.length, `${$$('.kh-table tbody tr').length} vs ${L1.rows.length}`);
  check('S8 Print/PDF and Excel are offered', !!$('[data-soaprint]') && !!$('[data-soaexcel]'));

  /* area filter narrows the party list here too */
  change($('[data-soaf="regionId"]'), c1.region); await sleep(100);
  const areaPartyCount = $('[data-soaf="partyId"]').options.length;
  const expectAreaParty = w.CUSTOMERS.filter(c => (c.region || '') === c1.region).length;
  check('S9 the Area filter narrows the party list on the statement screen too',
    /* + the "— Choose a shop —" line: the screen never picks a shop for the reader */
    areaPartyCount === expectAreaParty + 1, `${areaPartyCount} vs ${expectAreaParty} + placeholder`);

  /* switch to Supplier — same screen, the other ledger */
  change($('[data-soaf="type"]'), 'SUPPLIER'); await sleep(100);
  check('S10 switching party type hides the (customer-only) Area filter', !$('[data-soaf="regionId"]'));
  check('S11 the party list now lists suppliers',
    $('[data-soaf="partyId"]').options.length === w.SUPPLIERS.filter(s => s.active !== false).length + 1);

  change($('[data-soaf="partyId"]'), sup.id); await sleep(100);
  const L2 = ERP.Ledger.supplier(sup.id, null, null);
  const closingCard2 = $$('.kh-card').map(x => x.textContent).find(t => /^Closing balance/.test(t)) || '';
  check('S12 the supplier ledger reconciles with ERP.Ledger.supplier()',
    closingCard2.includes(M.fmt(L2.closing)), closingCard2);
  check('S13 "Total purchased" is shown for a supplier, not "Total invoiced"',
    /Total purchased/.test($('#view').textContent) && !/Total invoiced/.test($('#view').textContent));

  /* the on-screen figures must never disagree with the printed statement */
  const doc = ERP.DocModel.statement(sup.id, 'SUPPLIER', null, null);
  check('S14 the printable statement agrees with the same closing balance',
    doc.meta.some(m => m[0] === 'Closing balance' && m[1] === M.fmt(L2.closing)));

  /* Excel export exercises ERP.XLSX.build without throwing */
  let downloaded = null;
  const origCreate = D.createElement.bind(D);
  D.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'a') { el.click = () => { downloaded = el.download; }; }
    return el;
  };
  click($('[data-soaexcel]')); await sleep(150);
  D.createElement = origCreate;
  check('S15 the Excel export downloads a .xlsx file', /\.xlsx$/.test(downloaded || ''), String(downloaded));

  /* ══════════════════════════════════════════════════════════════════════
     EDGE CASES found on review (2026-09-16) — each guards a real regression
     ══════════════════════════════════════════════════════════════════════ */

  /* an area with genuinely zero shops must show an explicit empty state,
     not silently fall back to listing every shop while the Area dropdown
     still shows the (empty) area selected */
  const emptyRegionId = 'rg-empty-test-region';
  w.REGIONS.push({ id: emptyRegionId, en: 'Empty Test Region', ur: '', active: true });
  ERP.setPayFor && ERP.setPayFor(null);
  w.openPanel('payment'); await sleep(120);
  change($('#fcPayArea'), emptyRegionId); await sleep(60);
  check('F10 an area with zero shops shows an explicit empty state, not every shop',
    $('#fcPayCust').options.length === 1 && $('#fcPayCust').options[0].disabled,
    `${$('#fcPayCust').options.length} options, disabled=${$('#fcPayCust').options[0] && $('#fcPayCust').options[0].disabled}`);
  check('F11 the Shop select itself is disabled in that state', $('#fcPayCust').disabled);
  check('F12 the balance banner switches to a warning, not a stale balance',
    $('#fcPayBal').className.includes('warn') && /No shops in this area/.test($('#fcPayBal').textContent));
  const cbEmpty = $('#panel .x') || $('[data-close]') || $('#scrim'); if (cbEmpty) click(cbEmpty);
  await sleep(80);

  w.go('soa'); await sleep(120);
  change($('[data-soaf="type"]'), 'CUSTOMER'); await sleep(60);
  change($('[data-soaf="regionId"]'), emptyRegionId); await sleep(100);
  check('S16 the statement screen also shows an explicit empty state for a zero-shop area',
    /No shops on file/.test($('#view').textContent) && /in this area/.test($('#view').textContent),
    $('#view').textContent.slice(0, 200));

  /* a region that's been switched off must stay visible in the dropdown if
     a pre-filled shop still belongs to it — otherwise the picker silently
     shows "All areas" while the Shop list stays filtered to just one shop */
  const regionToDisable = w.REGIONS.find(r => r.id !== emptyRegionId && r.active !== false);
  const custInThatRegion = w.CUSTOMERS.find(c => c.region === regionToDisable.id);
  regionToDisable.active = false;
  ERP.setPayFor && ERP.setPayFor(custInThatRegion.id);
  w.openPanel('payment'); await sleep(120);
  check('F13 a pre-filled shop\'s own (now inactive) area still shows as selected, not "All areas"',
    $('#fcPayArea').value === regionToDisable.id, $('#fcPayArea').value);
  check('F14 that inactive area is still present as a real option, marked inactive',
    $$('#fcPayArea option').some(o => o.value === regionToDisable.id && /inactive/.test(o.textContent)));
  const cbInactive = $('#panel .x') || $('[data-close]') || $('#scrim'); if (cbInactive) click(cbInactive);
  await sleep(80);
  ERP.setPayFor && ERP.setPayFor(null);
  regionToDisable.active = true;

  /* a customer pointing at a region id that no longer exists at all must not
     crash the Statement of Account page (every other call site in the app
     guards ERP.regionOf()'s possible null return; this screen didn't) */
  const orphanCust = w.CUSTOMERS.find(c => c.id !== custInThatRegion.id);
  const savedRegion = orphanCust.region;
  orphanCust.region = 'rg-does-not-exist-anywhere';
  w.go('soa'); await sleep(100);
  change($('[data-soaf="regionId"]'), ''); await sleep(60);
  change($('[data-soaf="partyId"]'), orphanCust.id); await sleep(100);
  check('S17 a shop with an orphaned region id renders without throwing',
    /Statement of Account/.test($('#view').textContent) && !!$('.kh-card'));
  orphanCust.region = savedRegion;

  /* an inverted From/To range must be refused, not silently produce a wrong
     balance (Ledger._roll treats From-after-To as "drop everything after
     To, fold everything before From into opening" with no warning) */
  w.go('soa'); await sleep(100);
  change($('[data-soaf="partyId"]'), c1.id); await sleep(60);
  change($('[data-soaf="from"]'), '2026-09-20'); await sleep(40);
  change($('[data-soaf="to"]'), '2026-09-01'); await sleep(60);
  check('S18 an inverted date range shows a warning instead of a ledger',
    /From.*is after.*To/i.test($('#view').textContent) && !$('.kh-table'));
  const toastBefore = $('#toast') ? $('#toast').textContent : '';
  click($('[data-soaprint]')); await sleep(100);
  check('S19 Print is refused too, with a message, instead of opening a wrongly-scoped statement',
    !$('#fcviewer.on') && $('#toast') && $('#toast').textContent !== toastBefore &&
    /after.*To/i.test($('#toast').textContent));

  console.log('\n' + out.join('\n') + `\n\n${pass} passed, ${fail} failed\n`);
  w.close();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('HARNESS ERROR:', e); console.log(out.join('\n')); process.exit(2); });
