/* Stock value (2026-09-20).
   Client request: "how much money's worth of goods is lying in the warehouse".
   The answer is bags on hand x the average cost the ERP already keeps, and it
   has to be right in the awkward cases too: stock that arrived by transfer
   (moves bags but not cost), stock with no cost at all, damaged bags, negative
   counts, and a role that must not see what the goods cost.

   Covers: the engine (real purchases, sales and transfers), the cost-source
   rules, damaged/negative handling, selling-price value, filters, the printable
   document and Excel sheets, the screen, the dashboard card, the Inventory strip
   and the role gate. */
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

process.env.TZ = 'Asia/Karachi';               // the client's zone: local date and UTC date differ from 19:00 to midnight UTC
const HTML = fs.readFileSync(path.resolve('dist/farooq-co-erp.html'), 'utf8');
let pass = 0, fail = 0; const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push(`  ✔ ${name}`); }
  else { fail++; out.push(`  ✘ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = n => Math.round(n * 100);          // rupees → paisa

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
  const ERP = w.ERP, D = w.document, SV = ERP.StockValue;
  const $ = q => D.querySelector(q);
  const click = el => el && el.dispatchEvent(new w.Event('click', { bubbles: true }));

  await ERP.Settings.save({ allowNegativeStock: true });
  const wh = w.WAREHOUSES.filter(x => x.active)[0], wh2 = w.WAREHOUSES.filter(x => x.active)[1];
  const sup = w.SUPPLIERS[0], cust = w.CUSTOMERS[0];
  const P = w.PRODUCTS;
  const pA = P[10], pB = P[11], pC = P[12], pD = P[13], pE = P[14], pF = P[15];
  const buy = (p, qty, rate, wid, date) => ERP.Purchases.save({
    supplierId: sup.id, warehouseId: wid || wh.id, purchaseDate: date || '2026-09-01', paidAmount: 0,
    items: [{ productId: p.id, quantity: qty, unitPrice: rate }] });
  const sell = (p, qty, rate, date) => ERP.Invoices.save({
    customerId: cust.id, warehouseId: wh.id, invoiceDate: date || '2026-09-10', paidAmount: 0,
    items: [{ productId: p.id, quantity: qty, unitPrice: rate, discount: 0, warehouseId: wh.id }] });
  const totalOf = o => SV.build(o).totals;
  const rowOf = (data, p, wid) => data.rows.find(r => r.productId === p.id && (!wid || r.warehouseId === wid));

  /* ═════════════════════════════════════════════════════════════════
     A. THE MODULE IS THERE AND WIRED IN
     ═════════════════════════════════════════════════════════════════ */
  check('A1 the engine and its API exist', !!SV && ['build', 'total', 'docModel', 'sheets'].every(k => typeof SV[k] === 'function'));
  check('A2 the screen is registered', typeof w.PAGES.stockvalue === 'function');
  check('A3 the menu has "Stock value" right after Inventory',
    w.NAV.map(n => n.id).indexOf('stockvalue') === w.NAV.map(n => n.id).indexOf('inventory') + 1);
  const grp = w.NAVGROUPS.find(g => g[0] === 'Inventory & supply');
  check('A4 …and it sits in the Inventory & supply group', grp && grp[1].indexOf('stockvalue') === grp[1].indexOf('inventory') + 1);
  check('A5 it has a page title', !!(w.PAGEMETA.stockvalue && w.PAGEMETA.stockvalue[0] === 'Stock value'));

  /* ═════════════════════════════════════════════════════════════════
     B. NOTHING IN STOCK → NOTHING WORTH ANYTHING
     ═════════════════════════════════════════════════════════════════ */
  const t0 = totalOf({});
  check('B1 an empty warehouse is worth nothing', t0.valueP === 0 && t0.bags === 0 && t0.rows === 0, JSON.stringify(t0));
  check('B2 the screen says so instead of showing a zero table',
    /No stock on hand/.test(w.PAGES.stockvalue()));

  /* ═════════════════════════════════════════════════════════════════
     C. THE MONEY: bags x average cost, through real purchases
     ═════════════════════════════════════════════════════════════════ */
  await buy(pA, 100, 2000);
  await buy(pB, 50, 3000);
  let d = SV.build({});
  check('C1 100 bags at Rs 2,000 + 50 bags at Rs 3,000 = Rs 350,000',
    d.totals.valueP === R(350000) && d.totals.bags === 150, `${d.totals.valueP} / ${d.totals.bags}`);
  check('C2 each line carries bags, cost per bag and its value',
    rowOf(d, pA).qty === 100 && rowOf(d, pA).costP === R(2000) && rowOf(d, pA).valueP === R(200000) && rowOf(d, pA).costSrc === 'recorded');
  check('C3 the biggest value is listed first', d.rows[0].productId === pA.id && d.rows[1].productId === pB.id);

  await buy(pA, 100, 3000);                    // moving average → 2,500
  check('C4 a second purchase at a different price moves the average: 200 bags x Rs 2,500',
    rowOf(SV.build({}), pA).costP === R(2500) && rowOf(SV.build({}), pA).valueP === R(500000));

  const sale1 = await sell(pA, 40, 4000);      // sells at 4,000 but stock leaves at COST
  d = SV.build({});
  check('C5 selling 40 bags takes 40 x Rs 2,500 out of the value (cost, not the sale price)',
    rowOf(d, pA).qty === 160 && rowOf(d, pA).valueP === R(400000), `${rowOf(d, pA).qty} / ${rowOf(d, pA).valueP}`);
  check('C6 the total follows: 160 x 2,500 + 50 x 3,000 = Rs 550,000', d.totals.valueP === R(550000), String(d.totals.valueP));
  check('C7 a fractional paisa never appears — every value is a whole number of paisa',
    d.rows.every(r => Number.isInteger(r.valueP)) && Number.isInteger(d.totals.valueP));

  /* ═════════════════════════════════════════════════════════════════
     D. A TRANSFER MOVES THE BAGS BUT NOT THE COST — the value must not change
     ═════════════════════════════════════════════════════════════════ */
  const before = totalOf({}).valueP;
  await ERP.StockDocs.transfer({ warehouseId: wh.id, toWarehouseId: wh2.id, date: '2026-09-12',
    items: [{ productId: pA.id, quantity: 60 }] });
  d = SV.build({});
  const src = rowOf(d, pA, wh.id), dst = rowOf(d, pA, wh2.id);
  check('D1 moving 60 bags between warehouses does not change what the stock is worth', d.totals.valueP === before, `${d.totals.valueP} vs ${before}`);
  check('D2 the destination has no average of its own, but the transfer carried the source cost in: 60 x Rs 2,500',
    dst && dst.costSrc === 'carried' && dst.costP === R(2500) && dst.valueP === R(150000), JSON.stringify(dst));
  check('D3 the source keeps its recorded cost', src.costSrc === 'recorded' && src.qty === 100 && src.valueP === R(250000));
  check('D4 transferred stock is NOT called an estimate (it is the right cost)', d.totals.estimatedRows === 0 && d.totals.estimatedP === 0);
  check('D5 by warehouse: the two figures add up to the total',
    d.byWarehouse.reduce((a, g) => a + g.valueP, 0) === d.totals.valueP);
  const gA = d.byWarehouse.find(g => g.key === wh.id), gB = d.byWarehouse.find(g => g.key === wh2.id);
  check('D6 …with the right split: source Rs 400,000 (100x2,500 + 50x3,000), destination Rs 150,000',
    gA.valueP === R(400000) && gB.valueP === R(150000), `${gA.valueP} / ${gB.valueP}`);
  check('D7 shares add up to 100%', Math.abs(d.byWarehouse.reduce((a, g) => a + g.share, 0) - 100) < 0.2);
  check('D8 every active warehouse is listed even with no stock',
    w.WAREHOUSES.filter(x => x.active).every(x => d.byWarehouse.some(g => g.key === x.id)));
  check('D9 by category adds up to the total too', d.byCategory.reduce((a, g) => a + g.valueP, 0) === d.totals.valueP);

  /* ═════════════════════════════════════════════════════════════════
     E. STOCK WITH NO COST, AND WITH ONLY A LIST PRICE
     ═════════════════════════════════════════════════════════════════ */
  const set = (p, wid, qty, avg, dmg) => {
    const r = ERP.Inventory.row(p.id, wid); r.qty = qty; r.avgCostP = avg || 0; r.damagedQty = dmg || 0;
  };
  const beforeNone = totalOf({}).valueP;
  set(pC, wh.id, 30, 0);                       // no purchase anywhere, no list price
  let e = SV.build({});
  check('E1 30 bags with no cost anywhere are counted as bags but NOT valued at zero-and-hidden',
    rowOf(e, pC).costSrc === 'none' && e.totals.unvaluedBags === 30 && e.totals.unvaluedRows === 1 && e.totals.unvaluedProducts === 1);
  check('E2 they add nothing to the money', e.totals.valueP === beforeNone);
  check('E3 …and the screen warns, naming how many bags', /no cost recorded/.test(w.PAGES.stockvalue()) && /30 bags/.test(w.PAGES.stockvalue()));

  pD.buy = 1500;                               // the product's own purchase price, no purchase behind it
  set(pD, wh.id, 10, 0);
  e = SV.build({});
  check('E4 with only a product purchase price, that price is used and labelled an estimate',
    rowOf(e, pD).costSrc === 'list' && rowOf(e, pD).costP === R(1500) && rowOf(e, pD).valueP === R(15000));
  check('E5 the estimate is totalled separately so the owner sees how much rests on it',
    e.totals.estimatedP === R(15000) && e.totals.estimatedRows === 1);
  check('E6 the estimated Rs 15,000 IS in the total', e.totals.valueP === beforeNone + R(15000));
  check('E7 the screen says how much is estimated', /uses an estimated cost/.test(w.PAGES.stockvalue()));
  delete pD.buy;

  /* ═════════════════════════════════════════════════════════════════
     F. DAMAGED AND NEGATIVE STOCK
     ═════════════════════════════════════════════════════════════════ */
  const beforeDmg = totalOf({}).valueP;
  set(pE, wh.id, 20, R(1000), 5);              // 20 good bags, 5 damaged, cost Rs 1,000
  e = SV.build({});
  check('F1 damaged bags are kept out of the main figure', e.totals.valueP === beforeDmg + R(20000));
  check('F2 …and reported on their own, at cost', e.totals.damagedQty === 5 && e.totals.damagedValueP === R(5000));
  check('F3 the screen shows the damaged figure', /Damaged stock/.test(w.PAGES.stockvalue()) && /Rs\. 5,000/.test(w.PAGES.stockvalue()));

  set(pF, wh.id, -7, R(800));                  // sold more than was on the shelf (owner allowed it)
  e = SV.build({});
  check('F4 minus bags do not reduce the value', e.totals.valueP === beforeDmg + R(20000) && !rowOf(e, pF));
  check('F5 …but are flagged so someone checks the count', e.totals.negativeRows === 1 && e.negative[0].qty === -7 &&
    /negative bags/.test(w.PAGES.stockvalue()));

  /* ═════════════════════════════════════════════════════════════════
     G. SELLING-PRICE VALUE (secondary)
     ═════════════════════════════════════════════════════════════════ */
  e = SV.build({});
  check('G1 a product with no set price uses the last rate it was invoiced at',
    rowOf(e, pA, wh.id).sellSrc === 'last' && rowOf(e, pA, wh.id).sellP === R(4000) && rowOf(e, pA, wh.id).sellValueP === R(400000));
  check('G2 a product never sold and never priced is "not priced" and adds nothing',
    rowOf(e, pB).sellSrc === 'none' && rowOf(e, pB).sellValueP === 0 && e.totals.unpricedRows >= 1);
  pB.sell = 3600;
  e = SV.build({});
  check('G3 a price set on the product wins: 50 x Rs 3,600', rowOf(e, pB).sellSrc === 'list' && rowOf(e, pB).sellValueP === R(180000));
  await ERP.Invoices.cancel(sale1.id, 'test');
  e = SV.build({});
  check('G4 a cancelled invoice is not a price', rowOf(e, pA, wh.id).sellSrc === 'none', rowOf(e, pA, wh.id).sellSrc);
  check('G5 the selling total only counts products that have a price',
    e.totals.sellValueP === e.rows.reduce((a, r) => a + (r.sellP ? r.sellValueP : 0), 0) &&
    e.totals.pricedBags + e.totals.unpricedBags === e.totals.bags);
  delete pB.sell;
  await sell(pA, 1, 4200, '2026-09-13');       // put a live sale back so G-later screens have a price

  /* ═════════════════════════════════════════════════════════════════
     H. FILTERS
     ═════════════════════════════════════════════════════════════════ */
  const all = SV.build({});
  const w1 = SV.build({ warehouseId: wh2.id });
  check('H1 the warehouse filter narrows rows and totals to that warehouse',
    w1.rows.length > 0 && w1.rows.every(r => r.warehouseId === wh2.id) && w1.totals.valueP === all.byWarehouse.find(g => g.key === wh2.id).valueP);
  check('H2 the category filter narrows to that category',
    SV.build({ category: pB.cat }).rows.every(r => r.cat === pB.cat));
  check('H3 search by English name finds the product', SV.build({ q: pB.en }).rows.some(r => r.productId === pB.id));
  check('H4 search by Urdu name finds it too', !pB.ur || SV.build({ q: pB.ur }).rows.some(r => r.productId === pB.id));
  check('H5 a search nothing matches gives an empty result, not everything',
    SV.build({ q: 'zzzz-no-such-product' }).rows.length === 0 && SV.build({ q: 'zzzz-no-such-product' }).totals.valueP === 0);
  check('H6 filters are additive', SV.build({ warehouseId: wh2.id, q: pB.en }).rows.length === 0);

  /* ═════════════════════════════════════════════════════════════════
     I. THE PRINTABLE DOCUMENT AND THE EXCEL SHEETS
     ═════════════════════════════════════════════════════════════════ */
  const m = SV.docModel({});
  const t = SV.build({}).totals;
  check('I1 the document has one line per stock line', m.rows.length === t.rows);
  check('I2 its big total is the stock value', m.totals[m.totals.length - 1].big && m.totals[m.totals.length - 1].value === w.Money.fmt(t.valueP));
  check('I3 it reads "As at", not a period', m.meta.some(x => x[0] === 'As at') && !m.meta.some(x => x[0] === 'Period'));
  check('I4 its notes say what is not counted (no-cost bags, damaged bags)', /NOT in the total/.test(m.notes) && /Damaged stock/.test(m.notes));
  const sheets = SV.sheets({});
  check('I5 Excel has a Summary and a Products sheet', sheets.map(s => s.name).join() === 'Summary,Products');
  check('I6 the summary carries the total in rupees', sheets[0].rows.some(r => r[0] === 'Total stock value (at cost)' && r[1] === w.Money.toR(t.valueP)));
  check('I7 the products sheet has every line plus a total', sheets[1].rows.length === 1 + t.rows + 2);
  check('I8 the product total ties to the summary', sheets[1].rows[sheets[1].rows.length - 1][7] === w.Money.toR(t.valueP));

  /* ═════════════════════════════════════════════════════════════════
     J. THE SCREEN, FOR A REAL USER
     ═════════════════════════════════════════════════════════════════ */
  await ERP.Settings.save({ currentRole: 'OWNER' });
  w.go('stockvalue'); await sleep(150);
  check('J1 the screen opens from the menu', !!$('#svResults') && /Stock value/.test($('#view').textContent));
  const kp = $('#svResults .sv-main .v');
  check('J2 the headline is the stock value in rupees', kp && kp.textContent.replace(/\s/g, ' ') === 'Rs. ' + (t.valueP / 100).toLocaleString('en-US'),
    kp && kp.textContent);
  check('J3 the by-warehouse and by-category tables are there', $$$('#svResults .sv-two .card').length === 2);
  const nRows = $$$('#svResults tbody tr').length;
  check('J4 the product table lists the stock lines', nRows >= t.rows);

  const q = $('[data-svq]');
  q.value = pB.en; q.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('J5 typing in the search box filters live and keeps focus target intact', $('[data-svq]') === q && /Product/.test($('#svResults').textContent) &&
    $$$('#svResults > .card tbody tr').length < nRows);
  q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
  const sel = $('[data-svf="warehouseId"]');
  sel.value = wh2.id; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('J6 picking a warehouse narrows the screen to it (and drops the by-warehouse table)',
    $$$('#svResults .sv-two .card').length === 1 && $$$('#svResults > .card tbody tr').every(tr => /./.test(tr.textContent)));
  sel.value = ''; sel.dispatchEvent(new w.Event('change', { bubbles: true }));

  let captured = null;
  const origOpen = ERP.Viewer.open; ERP.Viewer.open = mm => { captured = mm; };
  click($('[data-svprint]'));
  ERP.Viewer.open = origOpen;
  check('J7 Print / PDF opens the stock value document', captured && /STOCK VALUE/.test(captured.title));
  let xl = null;
  const origBuild = ERP.XLSX.build; ERP.XLSX.build = (s, o) => { xl = { s, o }; return origBuild(s, o); };
  click($('[data-svexcel]'));
  ERP.XLSX.build = origBuild;
  check('J8 Excel builds the two sheets', xl && xl.s.length === 2 && xl.o.title === 'Stock value');

  /* ═════════════════════════════════════════════════════════════════
     K. DASHBOARD CARD AND INVENTORY STRIP
     ═════════════════════════════════════════════════════════════════ */
  const dash = w.PAGES.dashboard();
  check('K1 the dashboard has a Stock value card', /Stock value \(at cost\)/.test(dash) && dash.includes('data-go="stockvalue"'));
  check('K2 …placed straight after "All bags available"', dash.indexOf('All bags available') < dash.indexOf('Stock value (at cost)') &&
    dash.indexOf('Stock value (at cost)') < dash.indexOf("Today's sales"));
  check('K3 …showing the same figure', dash.includes(w.Money.toR(t.valueP).toLocaleString('en-US')));
  const invHtml = w.PAGES.inventory();
  check('K4 Inventory has the value strip, above the warehouse cards',
    /sv-strip/.test(invHtml) && invHtml.indexOf('sv-strip') < invHtml.indexOf('Warehouse totals'));
  check('K5 the strip shows each warehouse\'s worth', w.WAREHOUSES.filter(x => x.active).every(x => invHtml.includes('<small>' + x.name + '</small>')));
  w.go('dashboard'); await sleep(100);
  click($('.sv-dash'));
  await sleep(100);
  check('K6 clicking the dashboard card opens the report', !!$('#svResults'));


  /* ═════════════════════════════════════════════════════════════════
     M. STOCK THAT CAME IN WITHOUT A PURCHASE — opening stock, "Add stock"
        (Inventory.apply only feeds a row's average from purchases, so the
        cost typed there lives on the movement, not on the row)
     ═════════════════════════════════════════════════════════════════ */
  const pG = P[20], pH = P[21], pI = P[22], pJ = P[23], pK = P[24];
  const receive = (p, qty, cost, opening, date) => ERP.StockDocs.receive({ warehouseId: wh.id, date: date || '2026-09-15',
    reason: 'count', opening: !!opening, items: [{ productId: p.id, quantity: qty, unitPrice: cost }] });
  const beforeM = totalOf({}).valueP;
  await receive(pG, 30, 1800, true);
  d = SV.build({});
  check('M1 opening stock entered with a cost is valued at that cost: 30 x Rs 1,800',
    rowOf(d, pG) && rowOf(d, pG).costP === R(1800) && rowOf(d, pG).valueP === R(54000) && ['carried', 'recorded'].includes(rowOf(d, pG).costSrc),
    JSON.stringify(rowOf(d, pG)));
  check('M2 …so it is in the total and not reported as missing a cost',
    d.totals.valueP === beforeM + R(54000) && !d.rows.some(r => r.productId === pG.id && r.costSrc === 'none'));
  await receive(pH, 10, 1000, true, '2026-09-15');
  await receive(pH, 30, 2000, false, '2026-09-16');
  d = SV.build({});
  check('M3 two lots at different costs are averaged by bags: (10x1,000 + 30x2,000) / 40 = Rs 1,750',
    rowOf(d, pH).qty === 40 && rowOf(d, pH).costP === R(1750) && rowOf(d, pH).valueP === R(70000), JSON.stringify(rowOf(d, pH)));
  const beforeI = totalOf({}).valueP;
  await receive(pI, 12, undefined, true);        // no cost typed, and the product has no price anywhere
  d = SV.build({});
  check('M4 a receipt with no cost typed for a product with no price stays "no cost" and adds nothing',
    rowOf(d, pI).costSrc === 'none' && d.totals.valueP === beforeI);
  /* §26, 2026-09-28: Add stock now blends into the SAME recorded average a purchase does (the client wants
     one average built from both), instead of leaving the purchase-kept figure untouched */
  const pALotsBefore = rowOf(SV.build({}), pA, wh.id);
  await receive(pA, 5, 9999, false);             // a wildly different typed cost on a row that has a purchase-kept average
  const pAAfter = rowOf(SV.build({}), pA, wh.id);
  const expectM5 = Math.round((pALotsBefore.qty * pALotsBefore.costP + 5 * R(9999)) / (pALotsBefore.qty + 5));
  check('M5 a later Add-stock receipt blends into the same recorded average a purchase would',
    pAAfter.costSrc === 'recorded' && pAAfter.costP === expectM5 && pAAfter.qty === pALotsBefore.qty + 5,
    pAAfter.costP + ' vs expected ' + expectM5);
  set(pJ, wh.id, 5, R(700));
  set(pJ, wh2.id, 8, 0);                         // a row with stock but no cost and no movement behind it
  d = SV.build({});
  check('M6 stock with no own cost and no cost on any movement borrows the same product\'s cost elsewhere',
    rowOf(d, pJ, wh2.id).costSrc === 'other' && rowOf(d, pJ, wh2.id).costP === R(700) && rowOf(d, pJ, wh2.id).valueP === R(5600));
  check('M7 …and that is not called an estimate', !d.rows.some(r => r.productId === pJ.id && r.costSrc === 'list'));

  const pL = P[25];
  await buy(pL, 15, 3000, wh2.id);                 // a purchase-kept average, but in the OTHER warehouse
  await receive(pL, 10, 1200, true);                // opening stock with a typed cost, in THIS warehouse
  check('M8 costing a sale in the warehouse that only ever had "Add stock" uses ITS OWN carried cost, ' +
    'not another warehouse\'s recorded average', ERP.Inventory.costOf(pL.id, wh.id) === R(1200));
  check('M9 …the other warehouse still uses its own recorded average', ERP.Inventory.costOf(pL.id, wh2.id) === R(3000));
  check('M10 …and with no warehouse given (e.g. the Prices panel), a recorded average outranks a carried cost',
    ERP.Inventory.costOf(pL.id) === R(3000));

  /* ═════════════════════════════════════════════════════════════════
     N. EDGE CASES
     ═════════════════════════════════════════════════════════════════ */
  set(pK, 'wh-gone', 6, R(500));
  d = SV.build({});
  check('N1 stock in a warehouse that no longer exists is labelled, not shown as a dash',
    d.rows.find(r => r.warehouseId === 'wh-gone').warehouse === 'Unknown warehouse (wh-gone)');
  check('N2 …and is still counted, with the by-warehouse split adding up',
    d.byWarehouse.reduce((a, g) => a + g.valueP, 0) === d.totals.valueP && d.byWarehouse.some(g => /Unknown warehouse/.test(g.label)));

  ERP.Inventory.row(pC.id, wh.id).damagedQty = 4;   // pC has no cost anywhere
  d = SV.build({});
  check('N3 damaged bags with no cost are counted and said to have none', d.totals.damagedUnvalued === 4);
  check('N4 …on the screen too', /4 have no cost/.test(w.PAGES.stockvalue()));

  let priceCalls = 0; const origOf = ERP.Prices.of;
  ERP.Prices.of = function () { priceCalls++; return origOf.apply(this, arguments); };
  const ns = SV.build({ noSell: true }), callsAfterNoSell = priceCalls;
  const fullB = SV.build({});
  ERP.Prices.of = origOf;
  check('N5 noSell does no selling-price work but gives identical cost figures',
    callsAfterNoSell === 0 && priceCalls > 0 && ns.totals.valueP === fullB.totals.valueP && ns.totals.sellValueP === 0);
  const seen = []; const realBuild = SV.build;
  SV.build = function (o) { seen.push(o && o.noSell); return realBuild.apply(this, arguments); };
  w.PAGES.dashboard(); w.PAGES.inventory();
  SV.build = realBuild;
  check('N6 the dashboard card and the Inventory strip use it (they only need cost)', seen.length === 2 && seen.every(x => x === true), JSON.stringify(seen));

  w.go('stockvalue'); await sleep(120);
  const selW = $('[data-svf="warehouseId"]'); selW.value = wh2.id; selW.dispatchEvent(new w.Event('change', { bubbles: true }));
  const whIx = w.WAREHOUSES.indexOf(wh2), removedWh = w.WAREHOUSES.splice(whIx, 1)[0];
  w.go('stockvalue'); await sleep(120);
  check('N7 a warehouse filter whose warehouse was removed resets to "All" instead of hiding everything',
    $('[data-svf="warehouseId"]').value === '' && $$$('#svResults > .card tbody tr').length > 1 && $$$('#svResults .sv-two .card').length === 2);
  w.WAREHOUSES.splice(whIx, 0, removedWh);

  w.go('stockvalue'); await sleep(120);
  const selC = $('[data-svf="category"]'); selC.value = pB.cat; selC.dispatchEvent(new w.Event('change', { bubbles: true }));
  const inCat = P.filter(x => x.cat === pB.cat), oldCat = pB.cat;
  inCat.forEach(x => { x.cat = 'ZZ-renamed'; });
  w.go('stockvalue'); await sleep(120);
  check('N8 a category no product has any more resets too',
    $('[data-svf="category"]').value === '' && $$$('#svResults > .card tbody tr').length > 1);
  inCat.forEach(x => { x.cat = oldCat; });

  w.go('dashboard'); await sleep(100);
  const dcard = $('.sv-dash');
  check('N9 the dashboard card can be reached and used from the keyboard',
    dcard.getAttribute('tabindex') === '0' && dcard.getAttribute('role') === 'link');
  dcard.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true })); await sleep(80);
  check('N10 an unrelated key does nothing', !$('#svResults'));
  dcard.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(120);
  check('N11 Enter opens the report', !!$('#svResults'));

  /* ═════════════════════════════════════════════════════════════════
     L. WHO MAY SEE WHAT THE GOODS COST
     ═════════════════════════════════════════════════════════════════ */
  /* a restarted window, so the role is read the way a real sign-in would set it */
  const w2 = boot(store);
  for (let i = 0; i < 400 && !(w2.ERP && w2.ERP.ready); i++) await sleep(25);
  await (w2.ERP.landedReady || Promise.resolve()).catch(() => {});
  await sleep(250);
  const E2 = w2.ERP;
  check('L0 the restarted window still has the stock (it was saved, not just in memory)', E2.StockValue.build({}).totals.valueP > 0);
  for (const [role, sees] of [['OWNER', true], ['MANAGER', true], ['ACCOUNTANT', true], ['SALES', false], ['INVENTORY', false]]) {
    await E2.Settings.save({ currentRole: role });
    const screen = w2.PAGES.stockvalue(), dsh = w2.PAGES.dashboard(), inv2 = w2.PAGES.inventory();
    const got = { screen: /svResults/.test(screen), lockedMsg: /not open to you/.test(screen), card: /Stock value \(at cost\)/.test(dsh),
                  strip: /sv-strip/.test(inv2), money: /Rs\. /.test(screen) };
    check(`L ${role}: screen ${sees ? 'opens' : 'is locked'}, dashboard card ${sees ? 'shown' : 'hidden'}, Inventory strip ${sees ? 'shown' : 'hidden'}`,
      sees ? (got.screen && got.card && got.strip)
           : (!got.screen && got.lockedMsg && !got.card && !got.strip && !got.money),
      JSON.stringify(got) + ' role=' + E2.RBAC.role());
  }
  await E2.Settings.save({ currentRole: 'SALES' });
  let blocked = false; const ob = E2.StockValue.build;
  E2.StockValue.build = function () { blocked = true; return ob.apply(this, arguments); };
  const lockedScreen = w2.PAGES.stockvalue();
  E2.StockValue.build = ob;
  check('L2 a locked role\'s screen never even builds the numbers, and shows no rupee figure', !blocked && !/Rs\. /.test(lockedScreen));
  await E2.Settings.save({ currentRole: 'OWNER' });

  /* ═════════════════════════════════════════════════════════════════
     O. WHEN NOTHING HAS A COST YET — say so, never "Rs. 0"
     ═════════════════════════════════════════════════════════════════ */
  const savedInv = E2.S.inventory;
  E2.S.inventory = { 'x|y': { id: 'x|y', productId: w2.PRODUCTS[12].id, warehouseId: w2.WAREHOUSES[0].id, qty: 30, damagedQty: 0, avgCostP: 0 } };
  const cardOnly = (w2.PAGES.dashboard().match(/sv-dash[\s\S]*?<\/div><\/div>/) || [''])[0];
  const kpiOnly = (w2.PAGES.stockvalue().match(/sv-main[\s\S]*?<\/div><\/div>/) || [''])[0];
  const stripOnly = (w2.PAGES.inventory().match(/sv-strip-main[\s\S]*?<\/div>/) || [''])[0];
  E2.S.inventory = savedInv;
  check('O1 dashboard card: a dash and "cost not recorded yet", not Rs. 0', /—/.test(cardOnly) && /cost not recorded yet/.test(cardOnly) && !/Rs\./.test(cardOnly), cardOnly.slice(0, 200));
  check('O2 the screen\'s headline says the same', /—/.test(kpiOnly) && /cost not recorded yet/.test(kpiOnly) && !/Rs\./.test(kpiOnly), kpiOnly.slice(0, 200));
  check('O3 and so does the Inventory strip', /—/.test(stripOnly) && /no cost yet/.test(stripOnly) && !/Rs\./.test(stripOnly), stripOnly.slice(0, 200));

  /* ═════════════════════════════════════════════════════════════════
     P. "TODAY" IS THE LOCAL DAY — at 03:30 Pakistan time it is still "yesterday" in UTC
     ═════════════════════════════════════════════════════════════════ */
  const RD = w2.Date, fixed = new RD('2026-09-20T22:30:00Z').getTime();       // 03:30 on 21 Sep in Karachi
  check('P0 the test really runs in Pakistan time', new RD(fixed).getDate() === 21 && new RD(fixed).getUTCDate() === 20);
  class FakeDate extends RD { constructor(...a) { if (a.length === 0) super(fixed); else super(...a); } static now() { return fixed; } }
  w2.Date = FakeDate;
  const asOf = E2.StockValue.build({}).asOf, todayFn = E2.StockValue.today(), model = E2.StockValue.docModel({});
  w2.Date = RD;
  check('P1 "as at" is the local date, 21 Sep — not the UTC one, 20 Sep', asOf === '2026-09-21' && todayFn === '2026-09-21', asOf);
  check('P2 the printed document is dated the same day', model.meta.some(x => x[0] === 'As at' && x[1] === w2.fmtDate('2026-09-21')), JSON.stringify(model.meta));

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { w.close(); w2.close(); } catch (e) {}      // two full app windows: release them rather than leave them to process exit
  process.exit(fail ? 1 : 0);

  function $$$(q) { return [...D.querySelectorAll(q)]; }
}
main().catch(e => { console.error(e); process.exit(2); });
