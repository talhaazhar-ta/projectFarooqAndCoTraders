/* Add stock (Inventory → Add stock, Builder mode "receive") and Purchases → Receive stock were simplified
   2026-09-28 (§26): no more Overall discount / Delivery / Loading / Other charges, and Add stock's cost box
   is "Purchase price" — required. Extra cost and selling price are typed ONCE PER PRODUCT, in a shared
   "Charges & prices" card below the items table (perProductPricingBlock, 05-ui-builder.js), and blend
   straight into the stock's own moving averages (Inventory.apply avgCostP/avgExtraP/avgSellP) instead of
   being folded into the line's cost or pushed onto the product through Prices.set. This file covers:
     - typing in the per-product Extra cost / Selling price boxes reaches ERP.Builder.draft.perProduct;
     - Save keeps the purchase price on the line UNCHANGED (no folding) and blends extra/sell into the row;
     - a selling price typed below what the bag costs is refused before Save is even attempted;
     - the sale screen's rate cell is read-only with an Edit button that opens the product Prices panel
       (data-fcpriceedit) — a side panel, so an unsaved sale is never at risk just from opening it. */
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

const HTML = fs.readFileSync('dist/farooq-co-erp.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push('  ✔ ' + name); }
  else { fail++; out.push('  ✘ ' + name + (detail ? '   → ' + detail : '')); }
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));
vc.on('error', (...a) => errors.push(String(a[0])));

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  url: 'https://farooq.local/erp',
  beforeParse(w) {
    w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
    w.print = () => {}; w.confirm = () => true; w.prompt = () => 'reason'; w.alert = () => {};
    w.scrollTo = () => {}; w.open = () => null;
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.HTMLElement.prototype.scrollIntoView = function () {};
  }
});
const win = dom.window, D = win.document;

function click(el) { if (!el) return false; el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); return true; }
function type(el, value) { if (!el) return false; el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); return true; }
function change(el, value) { if (!el) return false; el.value = value; el.dispatchEvent(new win.Event('change', { bubbles: true })); return true; }
const $ = s => D.querySelector(s);

const run = async () => {
  for (let i = 0; i < 600 && !(win.ERP && win.ERP.fullyReady); i++) await sleep(25);
  const ERP = win.ERP, M = win.Money;
  check('AS0 app boots with no console errors', !!ERP && errors.length === 0, errors.slice(0, 2).join(' | '));

  const wh = win.WAREHOUSES.filter(w0 => w0.active !== false)[0].id;
  const sup = win.SUPPLIERS[0].id;
  const products = win.PRODUCTS.filter(p => p.active !== false);
  const pA = products[30], pB = products[31];

  /* known baselines — the seed catalogue may already carry a saved price */
  await ERP.Prices.set(pA.id, { buy: '1000', min: '' }, { reason: 'test baseline' }).catch(() => {});
  await ERP.Prices.set(pB.id, { buy: '1000', min: '' }, { reason: 'test baseline' }).catch(() => {});

  /* ═══ A. typing reaches B.draft.perProduct (per product, not per box on the draft itself) ═══ */
  ERP.Builder.start('receive'); await sleep(80);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pA.id); await sleep(60);
  type($('[data-fcline="qty"]'), '20');
  type($('[data-fcline="rate"]'), '3000');
  change($('[data-fcb="reason"]'), 'test receipt');
  type($('[data-fcprod="extraPerBag"][data-pid="' + pA.id + '"]'), '100');
  type($('[data-fcprod="sellPerBag"][data-pid="' + pA.id + '"]'), '4000');
  await sleep(60);
  check('AS1 "Extra cost / bag" reaches perProduct', ERP.Builder.draft.perProduct[pA.id].extraPerBag === '100');
  check('AS2 "Selling price / bag" reaches perProduct', ERP.Builder.draft.perProduct[pA.id].sellPerBag === '4000');

  /* ═══ B. saving keeps the purchase price on the LINE, and blends extra/sell into the stock's own averages
     — neither is folded into unitCostP any more (2026-09-28 review found that double-counted the extra
     against saleCostOf) ═══ */
  const before = ERP.StockDocs.all().length;
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS3 the receipt saved (one more stock document)', ERP.StockDocs.all().length === before + 1);
  const doc = ERP.StockDocs.all()[0];
  const line = doc ? ERP.StockDocs.items(doc.id)[0] : null;
  check('AS4 the line keeps the typed purchase price, 3000 — extra is not folded in',
    !!line && line.unitCostP === M.toP(3000), line && String(line.unitCostP));
  check('AS4b the line carries its own extraUnitP (100) and sellUnitP (4000)',
    !!line && line.extraUnitP === M.toP(100) && line.sellUnitP === M.toP(4000),
    line && (line.extraUnitP + ' / ' + line.sellUnitP));
  check('AS5 the stock\'s recorded cost is the purchase price, 3000', ERP.Inventory.costOf(pA.id, wh) === M.toP(3000));
  check('AS6 the stock\'s average extra cost is 100 and average selling price is 4000',
    ERP.Inventory.extraFor(pA.id, wh) === M.toP(100) && ERP.Inventory.sellOf(pA.id, wh) === M.toP(4000),
    ERP.Inventory.extraFor(pA.id, wh) + ' / ' + ERP.Inventory.sellOf(pA.id, wh));
  check('AS6b what a sale is costed at follows: 3000 + 100 = 3100', ERP.Inventory.saleCostOf(pA.id, wh) === M.toP(3100));

  /* ═══ C. a selling price typed below cost is refused before Save is even attempted ═══ */
  ERP.Builder.start('receive'); await sleep(80);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pB.id); await sleep(60);
  type($('[data-fcline="qty"]'), '10');
  type($('[data-fcline="rate"]'), '2000');
  change($('[data-fcb="reason"]'), 'test receipt 2');
  type($('[data-fcprod="extraPerBag"][data-pid="' + pB.id + '"]'), '50');
  type($('[data-fcprod="sellPerBag"][data-pid="' + pB.id + '"]'), '1800');   // below 2000 + 50
  await sleep(60);
  const before2 = ERP.StockDocs.all().length;
  click($('[data-fcbact="save"]')); await sleep(150);
  check('AS7 the selling price below cost is refused — nothing saved',
    ERP.StockDocs.all().length === before2 && /below what a bag costs/i.test(D.body.textContent));
  type($('[data-fcprod="sellPerBag"][data-pid="' + pB.id + '"]'), '2200');
  await sleep(30);
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS8 a corrected selling price saves normally', ERP.StockDocs.all().length === before2 + 1);

  /* ═══ D. the sale screen's rate cell: read-only, with an Edit button that opens the product Prices panel
     (a side panel — it must NOT touch the sale draft just by opening it) ═══ */
  const pu = await ERP.Purchases.save({ supplierId: sup, warehouseId: wh, purchaseDate: '2026-09-20',
    items: [{ productId: pB.id, quantity: 50, unitPrice: 2500 }] });
  const cust = win.CUSTOMERS[0];
  ERP.Builder.start('sale'); await sleep(80);
  change($('[data-fcb="customerId"]'), cust.id); await sleep(30);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pB.id); await sleep(60);
  const rateInput = $('[data-fcline="rate"]');
  const editBtn = $('[data-fcpriceedit]');
  check('D1 the sale rate is read-only', !!rateInput && rateInput.readOnly === true);
  check('D2 the Edit button is on the sale line', !!editBtn && editBtn.dataset.fcpriceedit === pB.id);
  check('D3 the draft is dirty (a fresh unsaved line was just added)', ERP.Builder.dirty === true);

  click(editBtn); await sleep(120);
  check('D4 opening the Prices panel does NOT discard the unsaved sale', ERP.Builder.mode === 'sale' && ERP.Builder.dirty === true);
  check('D5 the Prices panel is actually open, for the right product',
    !!$('#panel.on') && D.body.textContent.indexOf(pB.en || pB.ur) > -1);
  check('D6 the panel shows the three simplified averages, nothing else',
    !!$('#panel [data-f="buy"]') && !!$('#panel [data-f="extra"]') && !!$('#panel [data-f="sell"]') &&
    !$('#panel [data-f="min"]') && !$('#panel [data-f="wholesale"]') && !$('#panel [data-f="reorder"]'));
  const closeBtn = $('#panel [data-close]');
  click(closeBtn); await sleep(60);
  check('D7 closing the panel leaves the sale exactly as it was', ERP.Builder.mode === 'sale' && ERP.Builder.dirty === true);

  check('Z nothing threw during the session', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n' + out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
};
run();
