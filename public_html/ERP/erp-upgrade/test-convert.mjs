/* Client request (2026-09-21): "Taj Mahal → Al Mamoon" — bags are re-printed as another brand, so
   stock of one product must go down and stock of another go up, automatically, in one step.
   A Brand conversion (StockDocs type CONVERT, CNV-…) does exactly that: per line, bags out of
   the source product (CONVERT_OUT) and the same bags into the target (CONVERT_IN), same
   warehouse, atomic; refused if the source is short, the target is missing/same/switched off. */
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
const $ = s => D.querySelector(s);
const $$ = s => Array.from(D.querySelectorAll(s));
const click = el => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const change = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); } };
const type = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); } };
const rejects = async p => { try { await p; return null; } catch (e) { return e; } };

const run = async () => {
  for (let i = 0; i < 600 && !(win.ERP && win.ERP.fullyReady); i++) await sleep(25);
  const ERP = win.ERP, M = win.Money, SD = ERP.StockDocs, INV = ERP.Inventory;
  check('C0 app boots with no console errors', !!ERP && errors.length === 0, errors.slice(0, 2).join(' | '));

  const wh = win.WAREHOUSES[0].id, wh2 = win.WAREHOUSES[1].id;
  const act = win.PRODUCTS.filter(p => p.active !== false);
  const [pA, pB, pC] = act.slice(10, 13);            /* Taj-like source, Al-Mamoon-like target, spare */
  const supplier = win.SUPPLIERS[0].id;

  check('C1 the CONVERT document type is registered (CNV)', SD.TYPES.CONVERT && SD.TYPES.CONVERT.seq === 'CNV');
  check('C2 the new movement kinds have plain-English labels',
    ERP.Movements.label('CONVERT_OUT') !== 'CONVERT_OUT' && ERP.Movements.label('CONVERT_IN') !== 'CONVERT_IN');

  /* stock: 100 bags of A bought at Rs 2,000; B starts empty */
  await ERP.Purchases.save({ supplierId: supplier, warehouseId: wh, purchaseDate: '2026-09-01',
    items: [{ productId: pA.id, quantity: 100, unitPrice: 2000 }] });
  check('C3 setup: A has 100 bags, B has none', INV.available(pA.id, wh) === 100 && INV.available(pB.id, wh) === 0);
  const valueBefore = win.ERP.StockValue.build({ noSell: true }).totals.valueP;

  /* ── refused conversions change nothing ── */
  const snap = () => JSON.stringify([INV.available(pA.id, wh), INV.available(pB.id, wh), INV.available(pC.id, wh),
    ERP.S.movements.length, SD.byType('CONVERT').length]);
  const s0 = snap();
  let e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, quantity: 10 }] }));
  check('C4 no target brand is refused', !!(e && e.validation && /choose the brand/i.test(e.validation.join(' '))), JSON.stringify(e));
  e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, toProductId: pA.id, quantity: 10 }] }));
  check('C5 converting a brand into itself is refused', !!(e && e.validation && /same/i.test(e.validation.join(' '))), JSON.stringify(e));
  e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, toProductId: 'NOPE', quantity: 10 }] }));
  check('C6 a target that does not exist is refused', !!(e && e.validation && /no longer exists/i.test(e.validation.join(' '))), JSON.stringify(e));
  e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, toProductId: pB.id, quantity: 101 }] }));
  check('C7 more bags than the source has is refused', !!(e && e.validation && /Only 100 bags/i.test(e.validation.join(' '))), JSON.stringify(e));
  e = await rejects(SD.convert({ warehouseId: wh, items: [
    { productId: pA.id, toProductId: pB.id, quantity: 60 }, { productId: pA.id, toProductId: pC.id, quantity: 60 }] }));
  check('C8 two lines that together exceed the source are refused (checked against the total)',
    !!(e && e.validation && /Only 100 bags/i.test(e.validation.join(' '))), JSON.stringify(e));
  e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, toProductId: pB.id, quantity: 0 }] }));
  check('C9 zero bags is refused', !!(e && e.validation), JSON.stringify(e));
  const prodB = win.PRODUCTS.find(p => p.id === pB.id); prodB.active = false;
  e = await rejects(SD.convert({ warehouseId: wh, items: [{ productId: pA.id, toProductId: pB.id, quantity: 5 }] }));
  prodB.active = true;
  check('C10 a switched-off target is refused', !!(e && e.validation && /switched off/i.test(e.validation.join(' '))), JSON.stringify(e));
  check('C11 nothing changed after all the refusals', snap() === s0, snap() + ' vs ' + s0);

  /* ── a good conversion ── */
  const opId = 'op-conv-1';
  const rec = await SD.convert({ warehouseId: wh, date: '2026-09-05', clientOpId: opId, reason: 're-printed',
    items: [{ productId: pA.id, toProductId: pB.id, quantity: 40 }] });
  check('C12 the conversion posts with a CNV number', /^CNV-\d{4}-\d{6}$/.test(rec.docNumber) && rec.type === 'CONVERT', rec.docNumber);
  check('C13 the source lost 40 and the target gained 40',
    INV.available(pA.id, wh) === 60 && INV.available(pB.id, wh) === 40,
    INV.available(pA.id, wh) + ' / ' + INV.available(pB.id, wh));
  const mv = ERP.S.movements.filter(m => m.ref === rec.docNumber);
  check('C14 exactly two movements: CONVERT_OUT on A (−40) and CONVERT_IN on B (+40)',
    mv.length === 2 &&
    mv.some(m => m.kind === 'CONVERT_OUT' && m.productId === pA.id && m.qtyDelta === -40) &&
    mv.some(m => m.kind === 'CONVERT_IN' && m.productId === pB.id && m.qtyDelta === 40), JSON.stringify(mv.map(m => [m.kind, m.qtyDelta])));
  check('C15 the totals count the bags once, not twice', rec.totalQty === 40 && rec.lineCount === 1);
  const it = SD.items(rec.id)[0];
  check('C16 the line remembers both brands', it.productId === pA.id && it.toProductId === pB.id &&
    it.toDescriptionEnSnapshot === pB.en && it.descriptionEnSnapshot === pA.en);
  check('C17 the audit log names the conversion', ERP.S.audit.some(a => a.entityId === rec.id && /Brand conversion/.test(a.action) &&
    (a.newValues.conversions || [])[0] === `${pA.en} → ${pB.en} × 40`), JSON.stringify(ERP.S.audit[0]));

  /* the stock value does not jump just because the bag was re-printed */
  const valueAfter = win.ERP.StockValue.build({ noSell: true }).totals.valueP;
  check('C18 the target is carried at the source cost — total stock value unchanged',
    valueAfter === valueBefore && mv.every(m => m.unitCostP === M.toP(2000)), `${valueBefore} → ${valueAfter}; cost ${mv.map(m => m.unitCostP)}`);

  /* a repeat of the same submission does not move stock twice */
  e = await rejects(SD.convert({ warehouseId: wh, date: '2026-09-05', clientOpId: opId,
    items: [{ productId: pA.id, toProductId: pB.id, quantity: 40 }] }));
  check('C19 a double-clicked Save is ignored (stock moves once)', !!(e && e.duplicate) && INV.available(pA.id, wh) === 60 && INV.available(pB.id, wh) === 40, JSON.stringify(e));

  /* several lines at once, and the reverse direction (Al Mamoon back to Taj) */
  const rec2 = await SD.convert({ warehouseId: wh, date: '2026-09-06',
    items: [{ productId: pB.id, toProductId: pA.id, quantity: 10 }, { productId: pA.id, toProductId: pC.id, quantity: 20 }] });
  check('C20 a two-line conversion works, in either direction',
    INV.available(pA.id, wh) === 60 + 10 - 20 && INV.available(pB.id, wh) === 30 && INV.available(pC.id, wh) === 20 && rec2.totalQty === 30,
    [pA, pB, pC].map(p => INV.available(p.id, wh)).join('/'));
  check('C21 the other warehouse is untouched', INV.available(pA.id, wh2) === 0 && INV.available(pB.id, wh2) === 0);

  /* the stock-movement report stays in balance across the conversion */
  const rep = ERP.Analytics.inventory('2026-09-01', '2026-09-30');
  const rowA = rep.rows.find(r => r.productId === pA.id && r.warehouseId === wh);
  const rowB = rep.rows.find(r => r.productId === pB.id && r.warehouseId === wh);
  check('C22 the report shows the conversions as a net figure and closes to the live stock',
    rowA && rowB && rowA.converted === -40 + 10 - 20 && rowB.converted === 40 - 10 &&
    rowA.closing === INV.available(pA.id, wh) && rowB.closing === INV.available(pB.id, wh),
    JSON.stringify([rowA && [rowA.converted, rowA.closing], rowB && [rowB.converted, rowB.closing]]));
  const repLater = ERP.Analytics.inventory('2026-09-06', '2026-09-30');
  const rowA2 = repLater.rows.find(r => r.productId === pA.id && r.warehouseId === wh);
  check('C23 a later period starts from the post-conversion opening', rowA2 && rowA2.opening === 60 && rowA2.closing === INV.available(pA.id, wh),
    JSON.stringify(rowA2 && [rowA2.opening, rowA2.closing]));

  /* ── cost edge cases ── */
  const totalP = () => win.ERP.StockValue.build({ noSell: true }).totals.valueP;
  const [pD, pF, pG, pH, pI] = act.slice(20, 25);
  check('C23a the default reason is recorded on the note', rec2.reason === 'Brand conversion' && rec.reason === 're-printed', rec2.reason + ' / ' + rec.reason);

  /* target already holds bags at its own (dearer) average: the converted bags are blended in, the value does not move */
  await ERP.Purchases.save({ supplierId: supplier, warehouseId: wh, purchaseDate: '2026-09-02',
    items: [{ productId: pD.id, quantity: 60, unitPrice: 3000 }] });
  const vD0 = totalP();
  await SD.convert({ warehouseId: wh, date: '2026-09-07', items: [{ productId: pA.id, toProductId: pD.id, quantity: 40 }] });
  check('C23b a target with its own average is blended: (60 x 3,000 + 40 x 2,000) / 100 = 2,600',
    INV.row(pD.id, wh).avgCostP === M.toP(2600) && INV.available(pD.id, wh) === 100, String(INV.row(pD.id, wh).avgCostP));
  check('C23c …and the total stock value is unchanged', totalP() === vD0, `${vD0} → ${totalP()}`);

  /* 2026-09-28 (§26): Add stock with a typed cost now blends into the recorded average too, the same as a
     purchase — the conversion must still pass that cost on (the Stock value screen shows it) */
  await SD.receive({ warehouseId: wh, reason: 'own production', date: '2026-09-03', items: [{ productId: pF.id, quantity: 50, unitPrice: 1800 }] });
  check('C23d setup: Add stock now blends into the recorded average', INV.row(pF.id, wh).avgCostP === M.toP(1800));
  const vF0 = totalP();
  const recF = await SD.convert({ warehouseId: wh, date: '2026-09-07', items: [{ productId: pF.id, toProductId: pG.id, quantity: 30 }] });
  const mvF = ERP.S.movements.filter(m => m.ref === recF.docNumber);
  check('C23e the cost typed on Add stock travels with the bags (Rs 1,800), not zero',
    mvF.length === 2 && mvF.every(m => m.unitCostP === M.toP(1800)) && INV.row(pG.id, wh).avgCostP === M.toP(1800),
    JSON.stringify(mvF.map(m => m.unitCostP)) + ' / ' + INV.row(pG.id, wh).avgCostP);
  check('C23f …so the stock value is unchanged', totalP() === vF0, `${vF0} → ${totalP()}`);

  /* no cost known anywhere: nothing invented, no average written, and the conversion still works */
  await SD.receive({ warehouseId: wh, reason: 'found', date: '2026-09-03', items: [{ productId: pH.id, quantity: 10 }] });
  const recH = await SD.convert({ warehouseId: wh, date: '2026-09-07', items: [{ productId: pH.id, toProductId: pI.id, quantity: 10 }] });
  check('C23g bags of unknown cost convert without inventing a cost',
    INV.available(pH.id, wh) === 0 && INV.available(pI.id, wh) === 10 && INV.row(pI.id, wh).avgCostP === 0 &&
    ERP.S.movements.filter(m => m.ref === recH.docNumber).every(m => m.unitCostP === 0));

  /* converting back undoes it exactly (the way to reverse a conversion) */
  await SD.convert({ warehouseId: wh, date: '2026-09-08', items: [{ productId: pI.id, toProductId: pH.id, quantity: 10 }] });
  check('C23h converting back restores the original counts', INV.available(pH.id, wh) === 10 && INV.available(pI.id, wh) === 0);

  /* the paper: a real note with both brands on it */
  const model = ERP.DocModel.stockDoc(rec.id);
  check('C24 the note is titled and shows from/to', model.title === 'BRAND CONVERSION NOTE' &&
    model.columns.some(c => c.label === 'Converted from') && model.columns.some(c => c.label === 'Converted to') &&
    model.rows[0].brand === pB.en && model.rows[0].description === pA.en, JSON.stringify(model.rows[0]));

  /* ── the screen: Inventory has the button, the editor has the "Convert to" column, and saving works ── */
  win.go('inventory'); await sleep(80);
  check('C25 Inventory has a Convert Brand button', !!$('[data-fcnew="convert"]'));
  check('C26 the conversions list is shown with a readable summary',
    /Brand conversions/.test(D.body.textContent) && D.body.textContent.includes(`${pA.en} → ${pB.en} × 40`));
  click($('[data-fcnew="convert"]')); await sleep(100);
  check('C27 the button opens the editor in convert mode', win.cur === 'invoiceBuilder' && ERP.Builder.mode === 'convert' && !!$('#fcbuilder'));
  change($('[data-fcb="warehouseId"]'), wh); await sleep(60);
  click($('[data-fcbact="openpicker"]')); await sleep(50);
  click($$('.fcb-res').find(b => b.dataset.fcbadd === pA.id) || $('.fcb-res')); await sleep(80);
  const toSel = $('[data-fcline="to"]');
  check('C28 each line has a "Convert to" brand picker that leaves out its own product',
    !!toSel && toSel.options.length > 100 && ![...toSel.options].some(o => o.value === ERP.Builder.draft.items[0].productId));
  check('C29 the column headings say from / to', /Convert from/.test(D.querySelector('.fcb-table thead').textContent) && /Convert to/.test(D.querySelector('.fcb-table thead').textContent));
  type($('[data-fcline="qty"]'), '5');
  /* save without a target → the page explains, nothing changes */
  const s1 = snap();
  click($('[data-fcbact="save"]')); await sleep(150);
  check('C30 saving without a target shows the reason and changes nothing',
    !!$('.fcb-errs') && /choose the brand/i.test($('.fcb-errs').textContent) && snap() === s1, ($('.fcb-errs') || {}).textContent);
  change($('[data-fcline="to"]'), pB.id); await sleep(60);
  check('C31 picking a target shows how many bags it holds now', /Has\s+30\s+now/.test($('#fcbLines').textContent), $('#fcbLines').textContent.replace(/\s+/g, ' ').slice(0, 200));
  const beforeA = INV.available(pA.id, wh), beforeB = INV.available(pB.id, wh);
  const docsBefore = SD.byType('CONVERT').length;
  click($('[data-fcbact="save"]')); await sleep(300);
  check('C32 Convert Stock moves the bags from the screen', INV.available(pA.id, wh) === beforeA - 5 && INV.available(pB.id, wh) === beforeB + 5,
    `${INV.available(pA.id, wh)} / ${INV.available(pB.id, wh)}`);
  check('C33 it returns to Inventory and opens the note', win.cur === 'inventory' && SD.byType('CONVERT').length === docsBefore + 1);
  await sleep(400);
  check('C34 the note viewer opened', !!$('#fcviewer'));
  check('C35 no console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(out.join('\n'));
  console.log(`\nConvert: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run().catch(e => { console.log(out.join('\n')); console.log('CRASH', e && e.stack || e); process.exit(1); });
