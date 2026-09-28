import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* §27, 2026-09-28 (client): "when we purchase a product with a specific purchase price and extra cost, how
   can we then change the purchase price of ALL purchased/Add-stock receipts just by editing the Prices
   screen?" — a fair question about the old §26 "revalue" mechanism. The fix:
     - purchase price and extra cost are FIXED to the document (purchase / stock receipt) that typed them;
       the Prices screen shows the bag-weighted average of the stock on hand as READ-ONLY text — correcting
       one means editing that purchase or receipt, never this screen;
     - only the selling price is set on the Prices screen, and it can never be saved below what a bag costs
       (purchase + extra) — a hard block, no override, for anyone including the owner;
     - Purchases → Receive stock and Inventory → Add stock no longer have a Selling price box at all;
     - a purchase/receipt that pushes the average cost above an already-set selling price WARNS after
       saving, but is never blocked — a supplier's bill is a fact.
   This file is the dedicated check for that whole rule; test-add-stock-pricing.mjs, test-purchase-cost.mjs,
   test-extra-cost.mjs, test-extra-cost-profit.mjs, test-return-guards.mjs and test-ui-kit.mjs each carry
   one or two pieces of it in context — see docs/AVG_PRICING.md. */
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

  /* ── (a) a purchase and a later receipt: the Prices screen shows the bag-weighted average, read-only ── */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:A.id,quantity:10,unitPrice:6000}]});
  await ERP.StockDocs.receive({warehouseId:wh,reason:'More stock',
    items:[{productId:A.id,quantity:10,unitPrice:6400}]});
  /* 10 @ 6,000 + 10 @ 6,400 = 6,200 average */
  check('a1 the stock\'s own average blends the purchase and the receipt: 6,200',
    ERP.Inventory.averages(A.id).cost===M.toP(6200), String(ERP.Inventory.averages(A.id).cost));
  ERP.openPriceEditor(A.id); await sleep(300);
  const roVals=()=>Array.from(D.querySelectorAll('#panel .pz-ro')).map(el=>el.textContent.trim());
  check('a2 the panel shows 6,200 as plain read-only text, with no purchase-price or extra-cost input at all',
    roVals()[0]==='PKR 6,200' && !$('#panel [data-f="buy"]') && !$('#panel [data-f="extra"]'), roVals().join(' / '));
  click($('#panel [data-close]')); await sleep(120);

  /* ── (b) a selling price typed below cost is refused as a STRING (panel stays open), never as a late
     promise rejection (the "Saving…" trap) — above cost saves normally ── */
  ERP.openPriceEditor(A.id); await sleep(250);
  const before1=win.PANELS.prices.save({sell:'6100',reason:'x'});   // 6100 < 6200
  check('b1 a synchronous string is returned — the panel-close trap is avoided',
    typeof before1==='string' && /below what a bag costs/i.test(before1), String(before1));
  check('b1b nothing was written', ERP.Prices.of(A.id).sell===0, String(ERP.Prices.of(A.id).sell));
  const after1=win.PANELS.prices.save({sell:'6100',reason:'x'});    // pressing Save again changes nothing
  check('b2 pressing Save again with the SAME below-cost figure still refuses — no override, ever',
    typeof after1==='string' && /below what a bag costs/i.test(after1), String(after1));
  const ok1=win.PANELS.prices.save({sell:'6500',reason:'Market price'});
  check('b3 a figure above cost saves — the panel closes ("Saving…")', ok1 && typeof ok1==='object' && !!ok1.msg, JSON.stringify(ok1));
  await sleep(300);
  check('b4 the selling price is stored', ERP.Prices.of(A.id).sell===M.toP(6500), String(ERP.Prices.of(A.id).sell));
  check('b5 the hard block also holds at the service layer directly, not just in the panel',
    await ERP.Prices.setSell(A.id,'6000',{reason:'x'}).then(()=>false).catch(e=>/below what a bag costs/i.test(e.validation[0])));

  /* ── (c) Purchases → Receive stock and Inventory → Add stock have no Selling price box at all ── */
  ERP.Builder.start('purchase'); await sleep(150);
  ERP.BuilderUI.addLine(B.id); await sleep(80);
  check('c1 the purchase screen has an Extra-cost box but no Selling-price box',
    !!$('[data-fcprod="extraPerBag"][data-pid="'+B.id+'"]') && !$('[data-fcprod="sellPerBag"][data-pid="'+B.id+'"]'));
  ERP.Builder.start('receive'); await sleep(150);
  ERP.BuilderUI.addLine(C.id); await sleep(80);
  check('c2 same for Add stock', !!$('[data-fcprod="extraPerBag"][data-pid="'+C.id+'"]') && !$('[data-fcprod="sellPerBag"][data-pid="'+C.id+'"]'));

  /* ── (d) a receipt that pushes the average cost above an already-set selling price WARNS, but the
     receipt still saves — never blocked ── */
  await ERP.Prices.setSell(B.id,'4000',{reason:'baseline'});
  ERP.Builder.start('purchase'); await sleep(150);
  const whSel=$('[data-fcb="warehouseId"]');
  if (whSel) { whSel.value=wh; whSel.dispatchEvent(new win.Event('change',{bubbles:true})); }
  $('[data-fcb="supplierId"]').value=mill; $('[data-fcb="supplierId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  ERP.BuilderUI.addLine(B.id); await sleep(80);
  type($('[data-fcline="qty"]'),'5'); type($('[data-fcline="rate"]'),'5000');   // 5,000 > the 4,000 already set
  const said=[]; win.say=m=>said.push(m);
  const purchasesBefore=ERP.Purchases.all().length;
  click($('[data-fcbact="save"]')); await sleep(300);
  check('d1 the purchase still saves (nothing refused it)', ERP.Purchases.all().length===purchasesBefore+1,
    ERP.Purchases.all().length+' vs '+(purchasesBefore+1));
  check('d2 a warning nudges the owner, but nothing was refused',
    said.some(m=>/now costs more than its selling price/.test(m)), said.join(' | '));
  check('d3 the selling price itself is untouched', ERP.Prices.of(B.id).sell===M.toP(4000), String(ERP.Prices.of(B.id).sell));

  /* ── (e) a sale line's rate is the product's OWN selling price; an already-issued invoice keeps its
     original snapshot even after the price later changes ── */
  await ERP.Prices.setSell(A.id,'6500',{reason:'x'});
  const inv1=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-28',
    items:[{productId:A.id,quantity:2,unitPrice:6500}]});
  check('e1 the invoice line was costed at the price on the day', ERP.Invoices.items(inv1.id)[0].unitPrice===M.toP(6500));
  await ERP.Prices.setSell(A.id,'7000',{reason:'price went up'});
  check('e2 an already-issued invoice keeps its own rate — it is never rewritten by a later price change',
    ERP.Invoices.items(inv1.id)[0].unitPrice===M.toP(6500), String(ERP.Invoices.items(inv1.id)[0].unitPrice));
  ERP.Builder.start('sale'); await sleep(120);
  $('[data-fcb="customerId"]').value=shop; $('[data-fcb="customerId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  $('[data-fcb="warehouseId"]').value=wh; $('[data-fcb="warehouseId"]').dispatchEvent(new win.Event('change',{bubbles:true}));
  ERP.BuilderUI.addLine(A.id); await sleep(80);
  check('e3 a NEW sale line opens at the product\'s current selling price, 7,000',
    $('[data-fcline="rate"]').value===String(7000), $('[data-fcline="rate"]').value);

  /* ── (f) a product with no selling price yet: the sale line says so, and Save refuses it ── */
  ERP.BuilderUI.addLine(E.id); await sleep(80);
  const lines=()=>$$('[data-fcline="rate"]');
  const eIx=win.ERP.Builder.draft.items.findIndex(i=>i.productId===E.id);
  check('f1 the line for a never-priced product has no rate, and says so',
    (win.ERP.Builder.draft.items[eIx].unitPrice||'')==='' && /No selling price set/i.test(D.body.textContent));
  const saveErr=await new Promise(res=>{
    D.querySelector('[data-fcbact="save"]').dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
    setTimeout(()=>res($('.fcb-errs')?$('.fcb-errs').textContent:''),300);
  });
  check('f2 Save refuses the sale (a rate of 0 is not a real price)', /enter a rate/i.test(saveErr)||/rate/i.test(saveErr), saveErr);

  /* ── (g) the Prices screen's "Edit" link changes the average only by editing the document itself,
     never by typing on this screen ── */
  ERP.openPriceEditor(A.id); await sleep(300);
  const txRow=$$('#panel .pz-h').find(r=>/PUR-/.test(r.textContent));
  check('g1 the purchase that priced this product is listed', !!txRow);
  let opened=null; const realEdit=win.ERP.actions.editPurchase; win.ERP.actions.editPurchase=id=>{opened=id;};
  click(txRow.querySelector('[data-pztxedit="purchase"]'));
  win.ERP.actions.editPurchase=realEdit;
  check('g2 pressing Edit hands off to the purchase editor — the average is never typed directly',
    !!opened && !!ERP.Purchases.byId(opened));

  /* ── (h) the below-cost floor is re-checked again at APPROVAL time, not only when the change was first
     requested — a new, dearer purchase can land while the request sits waiting for the owner ── */
  await ERP.Settings.save({priceApproval:true});
  const owner=ERP.Users.all()[0];
  const sales=await ERP.Users.save({name:'Test Sales',role:'SALES'});
  await ERP.Session.signIn(sales.id,'');
  const reqH=await ERP.Prices.setSell(E.id,'3000',{reason:'requested while nothing was known about the cost'});
  check('h1 with approval on, a salesperson\'s selling-price change waits, not applied yet',
    reqH.pending===true && ERP.Prices.of(E.id).sell===0, JSON.stringify(reqH));
  await ERP.Session.signIn(owner.id,'');
  /* a purchase lands WHILE the request is still pending, above the 3,000 that was requested */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-28',
    items:[{productId:E.id,quantity:5,unitPrice:3500}]});
  const pendingH=ERP.Prices.pending(E.id)[0];
  check('h2 the request is still there, waiting', !!pendingH);
  const approveErr=await ERP.Prices.approve(pendingH.id).then(()=>null,e=>e);
  check('h3 approving it now is refused — the stock costs more than the requested price today',
    !!approveErr && /stock now costs more/i.test(approveErr.validation[0]), approveErr&&JSON.stringify(approveErr.validation));
  check('h4 the request is still PENDING — nothing was silently lost or wrongly applied',
    ERP.Prices.pending(E.id).some(p=>p.id===pendingH.id) && ERP.Prices.of(E.id).sell===0);
  await ERP.Settings.save({priceApproval:false});

  check('Z nothing threw during the session', errors.length===0, errors.slice(0,3).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
