import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* §28, 2026-09-29 (client): "at purchases receiveStock receipt no need to ask for extra costs for any
   product… just purchase price… remove extra prices of the products in charges&prices section… same in
   inventory addStock… on the Prices screen only write average of all the purchase prices of the product
   bags available in stock as a LABEL, then the user decides the new purchase price — change average purchase
   price value to a label, and add an input for the user to add purchase price, by default the average value,
   but when the user changes it the new value will always be there even when new products are added… extra
   cost of the product will be decided [here]… no need of selling price here — remove that input, it will be
   decided while selling… while selling, label the purchase price + extra cost set there, by default extra is
   0 and purchase price is the average, but when the user changes it the new value stays… the selling price
   can be lower than the purchase price, it is ok — no need to restrict the user, user can sell in a loss —
   remove all restrictions". Supersedes test-price-lock's old §27 contract (the selling-price floor and the
   read-only sale rate are both gone). See docs/AVG_PRICING.md §28. */
const HTML=fs.readFileSync('dist/farooq-co-erp.html','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const out=[];
const check=(n,c,d)=>{if(c){pass++;out.push('  ✔ '+n);}else{fail++;out.push('  ✘ '+n+(d?'   → '+d:''));}};
const errors=[];
function boot(store){
  const vc=new VirtualConsole(); vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(HTML,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
   url:'https://x.local/e',beforeParse(w){
    w.indexedDB=store.idb; w.IDBKeyRange=FDBKeyRange; w.print=()=>{}; w.confirm=()=>true;
    w.prompt=()=>'not needed'; w.scrollTo=()=>{}; w.open=()=>null;
    w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
    w.HTMLElement.prototype.scrollIntoView=function(){};
    w.matchMedia=q=>({media:q,matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
   }});
  return dom.window;
}
async function ready(w){for(let i=0;i<400&&!(w.ERP&&w.ERP.ready);i++)await sleep(25);await sleep(350);return w.ERP;}

const run=async()=>{
  const store={idb:new FDBFactory()};
  const win=boot(store); const ERP=await ready(win);
  const M=win.Money, D=win.document;
  const $=s=>D.querySelector(s), $$=s=>Array.from(D.querySelectorAll(s));
  const click=el=>el&&el.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const type=(el,v)=>{if(el){el.value=v;el.dispatchEvent(new win.Event('input',{bubbles:true}));}};
  const wh=win.WAREHOUSES.filter(w0=>w0.active!==false)[0].id;
  const mill=win.SUPPLIERS[0].id, shop=win.CUSTOMERS[0].id;
  const P=win.PRODUCTS.filter(p=>p.active!==false);
  const A=P[20], B=P[21], C=P[22], E=P[23];

  /* ── (a) Purchases → Receive stock and Inventory → Add stock have NO extra-cost box any more ── */
  ERP.Builder.start('purchase'); await sleep(150);
  ERP.BuilderUI.addLine(B.id); await sleep(80);
  check('a1 the purchase screen has no per-product extra-cost box, no "Charges & prices" card',
    !$('[data-fcprod]') && !/Charges .{0,3}amp.{0,3}. prices|Charges & prices/.test(D.querySelector('.fcb-card h3')?D.querySelector('.fcb-card h3').textContent:''));
  check('a2 the purchase price on the line is still asked for', !!$('[data-fcline="rate"]'));
  ERP.Builder.start('receive'); await sleep(150);
  ERP.BuilderUI.addLine(C.id); await sleep(80);
  check('a3 Add stock also has no per-product extra-cost box', !$('[data-fcprod]'));

  /* ── (b) a purchase and a later receipt: the Prices screen shows the bag-weighted average as a LABEL,
     plus an editable purchase-price box (defaults to that average) and an extra-cost box (defaults to 0) ── */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:A.id,quantity:10,unitPrice:6000}]});
  await ERP.StockDocs.receive({warehouseId:wh,reason:'More stock',
    items:[{productId:A.id,quantity:10,unitPrice:6400}]});
  /* 10 @ 6,000 + 10 @ 6,400 = 6,200 average */
  check('b1 the stock\'s own average blends the purchase and the receipt: 6,200',
    ERP.Inventory.averages(A.id).cost===M.toP(6200), String(ERP.Inventory.averages(A.id).cost));
  ERP.openPriceEditor(A.id); await sleep(300);
  const roVals=()=>Array.from(D.querySelectorAll('#panel .pz-ro')).map(el=>el.textContent.trim());
  check('b2 the average purchase price is a plain read-only LABEL: 6,200', roVals()[0]==='PKR 6,200', roVals().join(' / '));
  check('b3 there is an editable Purchase price box, defaulting to the average', $('#panel [data-f="buy"]')?.value===String(6200), $('#panel [data-f="buy"]')?.value);
  check('b4 there is an editable Extra cost box, defaulting to 0 (nothing chosen yet)', $('#panel [data-f="extra"]')?.value==='', $('#panel [data-f="extra"]')?.value);
  check('b5 there is no Selling price box at all on this screen', !$('#panel [data-f="sell"]'));
  click($('#panel [data-close]')); await sleep(120);

  /* ── (c) choosing a purchase price on the Prices screen PINS it — it stays even when new stock comes in
     at a different price — until it is changed again here ── */
  ERP.openPriceEditor(A.id); await sleep(250);
  const saved1=win.PANELS.prices.save({buy:'6800',extra:'150',reason:'owner decided'});
  check('c1 a synchronous "Saving…" object is returned', saved1 && typeof saved1==='object' && !!saved1.msg, JSON.stringify(saved1));
  await sleep(300);
  check('c2 the chosen purchase price is now what a sale is costed at, not the live average',
    ERP.Inventory.saleBuyOf(A.id,wh)===M.toP(6800), String(ERP.Inventory.saleBuyOf(A.id,wh)));
  check('c3 the extra cost is stored too', ERP.Inventory.extraFor(A.id,wh)===M.toP(150), String(ERP.Inventory.extraFor(A.id,wh)));
  /* a THIRD purchase lands at yet another price — the live average moves, but the chosen figure does not */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:A.id,quantity:5,unitPrice:9000}]});
  check('c4 the live average has moved', ERP.Inventory.averages(A.id).cost!==M.toP(6800));
  check('c5 but the CHOSEN purchase price still sticks at 6,800, even though new stock came in at a different price',
    ERP.Inventory.saleBuyOf(A.id,wh)===M.toP(6800), String(ERP.Inventory.saleBuyOf(A.id,wh)));

  /* ── (d) "Use the average" clears the chosen figure and goes back to following the live average ── */
  ERP.openPriceEditor(A.id); await sleep(250);
  check('d1 the panel offers a "Use the average" button once a price is chosen', !!$('[data-pzuseavg]'));
  await ERP.Prices.setCost(A.id,{},{clearOverride:true});
  check('d2 the chosen price is cleared — saleBuyOf now follows the live average again',
    ERP.Inventory.saleBuyOf(A.id,wh)===ERP.Inventory.averages(A.id).cost);
  click($('#panel [data-close]')); await sleep(120);

  /* ── (e) no restriction of any kind: a below-cost purchase price, a below-cost extra cost figure or a
     below-cost SELLING price at the sale are all accepted — "remove all restrictions" ── */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:B.id,quantity:20,unitPrice:1000}]});
  await ERP.Prices.setCost(B.id,{buy:'100',extra:'0'},{reason:'deliberately cheap'});
  check('e1 a purchase price can be set below what was ever actually paid — no floor', ERP.Inventory.saleBuyOf(B.id,wh)===M.toP(100));
  ERP.Builder.start('sale'); await sleep(150);
  $('[data-fcb="customerId"]').value=shop; $('[data-fcb="customerId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  $('[data-fcb="warehouseId"]').value=wh; $('[data-fcb="warehouseId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  ERP.BuilderUI.addLine(B.id); await sleep(80);
  check('e2 the sale rate is EDITABLE, not read-only', !$('[data-fcline="rate"]').readOnly && $('[data-fcline="rate"]').style.pointerEvents!=='none');
  type($('[data-fcline="rate"]'),'50');    // 50 < the 100 cost — a loss on every bag
  type($('[data-fcline="qty"]'),'2');
  await sleep(80);
  const said=[]; win.say=m=>said.push(m);
  const invBefore=ERP.Invoices.all().length;
  click($('[data-fcbact="save"]')); await sleep(300);
  check('e3 a below-cost sale SAVES — nothing refuses it any more', ERP.Invoices.all().length===invBefore+1,
    ERP.Invoices.all().length+' vs '+(invBefore+1));

  /* ── (f) the sale line pre-fills from the LAST rate this product actually sold at, not a stored product
     figure — and typing a new rate is free to go anywhere, including a loss ── */
  ERP.Builder.start('sale'); await sleep(120);
  $('[data-fcb="customerId"]').value=shop; $('[data-fcb="customerId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  $('[data-fcb="warehouseId"]').value=wh; $('[data-fcb="warehouseId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  ERP.BuilderUI.addLine(B.id); await sleep(80);
  check('f1 a NEW sale line opens pre-filled at the LAST rate this product sold at (50)',
    $('[data-fcline="rate"]').value===String(50), $('[data-fcline="rate"]').value);
  check('f2 the cost label underneath shows the chosen purchase price + extra cost, purely informational',
    /cost/i.test($('.fcb-costline')?$('.fcb-costline').textContent:''));

  /* ── (g) a product never sold and never priced: the sale line opens blank, Save still refuses a 0 rate
     (a typo guard, not a price rule) but there is no more "set it on the Prices screen" wording ── */
  ERP.BuilderUI.addLine(E.id); await sleep(80);
  const eIx=win.ERP.Builder.draft.items.findIndex(i=>i.productId===E.id);
  check('g1 the line for a never-sold product opens with no rate typed', (win.ERP.Builder.draft.items[eIx].unitPrice||'')==='');
  const saveErr=await new Promise(res=>{
    D.querySelector('[data-fcbact="save"]').dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
    setTimeout(()=>res($('.fcb-errs')?$('.fcb-errs').textContent:''),300);
  });
  check('g2 Save refuses a sale with a 0 rate (typo guard only)', /rate/i.test(saveErr), saveErr);

  /* ── (h) the Prices screen's "Edit" link changes the average only by editing the document itself,
     never by typing on this screen ── */
  ERP.openPriceEditor(A.id); await sleep(300);
  const txRow=$$('#panel .pz-h').find(r=>/PUR-/.test(r.textContent));
  check('h1 the purchase that priced this product is listed', !!txRow);
  let opened=null; const realEdit=win.ERP.actions.editPurchase; win.ERP.actions.editPurchase=id=>{opened=id;};
  click(txRow.querySelector('[data-pztxedit="purchase"]'));
  win.ERP.actions.editPurchase=realEdit;
  check('h2 pressing Edit hands off to the purchase editor — the average is never typed directly',
    !!opened && !!ERP.Purchases.byId(opened));

  /* ── (i) an already-issued invoice keeps its own snapshot even after the chosen cost later changes ── */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:C.id,quantity:20,unitPrice:2000}]});
  const inv1=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-28',
    items:[{productId:C.id,quantity:2,unitPrice:9999}]});
  const snap1=ERP.Invoices.items(inv1.id)[0].costBuySnapshot;
  await ERP.Prices.setCost(C.id,{buy:'55555',extra:'0'},{reason:'later change'});
  check('i1 an already-issued invoice keeps its own cost snapshot — it is never rewritten by a later choice',
    ERP.Invoices.items(inv1.id)[0].costBuySnapshot===snap1, String(ERP.Invoices.items(inv1.id)[0].costBuySnapshot));

  /* ── (j) approval queue: a change routed through setCost still gets held for approval when it is on,
     and re-lands against whatever is current when the owner approves it — no floor to re-check any more ── */
  await ERP.Settings.save({priceApproval:true});
  const owner=ERP.Users.all()[0];
  const sales=await ERP.Users.save({name:'Test Sales 2',role:'SALES'});
  await ERP.Session.signIn(sales.id,'');
  const reqJ=await ERP.Prices.setCost(E.id,{buy:'3000',extra:'0'},{reason:'requested'});
  check('j1 with approval on, a salesperson\'s cost change waits, not applied yet',
    reqJ.pending===true && !(ERP.Inventory.averages(E.id).override>0), JSON.stringify(reqJ));
  await ERP.Session.signIn(owner.id,'');
  const pendingJ=ERP.Prices.pending(E.id)[0];
  check('j2 the request is waiting', !!pendingJ);
  const approved=await ERP.Prices.approve(pendingJ.id);
  check('j3 approving it applies it — no floor blocks it any more',
    approved && approved.applied===true && ERP.Inventory.averages(E.id).override===M.toP(3000), JSON.stringify(approved));
  await ERP.Settings.save({priceApproval:false});

  /* ── (k) Stock value is unaffected by a chosen purchase price — it keeps reading the real document costs
     (client's decision: the chosen figure drives sale profit only, never the stock valuation) ── */
  const svRow=(ERP.StockValue.build({}).rows||[]).find(r=>r.productId===A.id && r.warehouseId===wh);
  check('k1 Stock value still uses the recorded/carried document cost, not the chosen override',
    svRow && svRow.costP===ERP.Inventory.row(A.id,wh).avgCostP, svRow&&JSON.stringify(svRow));

  check('Z nothing threw during the session', errors.length===0, errors.slice(0,3).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
