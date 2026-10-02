import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* §29 (2026-10-02): a "Carriage / transport" box on the purchase invoice. Client: the carriage is part of what the
   product costs. It is typed once for the whole purchase, shared EQUALLY per bag, blended into the stock as its own
   bag-weighted average, shown (and pinnable) on the Prices screen, added to a sale's cost and to Stock value —
   and it never touches the purchase total or what the supplier is owed. */
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
const rejects=async p=>{try{await p;return null;}catch(e){return e;}};

const run=async()=>{
  const store={idb:new FDBFactory()};
  const win=boot(store); const ERP=await ready(win);
  const M=win.Money, D=win.document;
  const wh=win.WAREHOUSES[1].id, wh2=win.WAREHOUSES[0].id, P=win.PRODUCTS.filter(p=>p.active!==false);
  const X=P[3], Y=P[4], Z=P[5], W=P[6];
  const shop=win.CUSTOMERS[0].id, mill=win.SUPPLIERS[0].id, mill2=win.SUPPLIERS[1].id;
  const owed=s=>ERP.Ledger.supplierBalance(s);
  const row=(p,w)=>ERP.S.inventory[p.id+'|'+(w||wh)];

  /* ── 1. one purchase: 100 bags at 6,000 with 5,000 of carriage ── */
  const owed0=owed(mill);
  const pu=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-01',carriage:'5000',
    items:[{productId:X.id,quantity:100,unitPrice:6000}]});
  const li=ERP.Purchases.items(pu.id)[0];
  check('C1 the purchase keeps the whole carriage (5,000) and fixes 50 a bag on the line',
    pu.carriageAmount===M.toP(5000) && li.carriageUnitP===M.toP(50), `${pu.carriageAmount} ${li.carriageUnitP}`);
  check('C2 the purchase total is still just the goods (600,000) — carriage is not on the supplier\'s bill',
    pu.grandTotal===M.toP(600000), M.fmt(pu.grandTotal));
  check('C3 the supplier is owed exactly the goods, nothing for the truck', owed(mill)-owed0===M.toP(600000), String(owed(mill)-owed0));
  check('C4 the stock row carries 50 a bag of carriage; the purchase price average stays 6,000',
    row(X).avgCarriageP===M.toP(50) && row(X).avgCostP===M.toP(6000), `${row(X).avgCarriageP} ${row(X).avgCostP}`);
  const av=ERP.Inventory.averages(X.id);
  check('C5 averages(): carriage 50, not pinned', av.carriage===M.toP(50) && av.carriageOverride===null, JSON.stringify(av));
  check('C6 a sale is costed at purchase + carriage = 6,050', ERP.Inventory.saleCostOf(X.id,wh)===M.toP(6050),
    M.fmt(ERP.Inventory.saleCostOf(X.id,wh)));
  check('C7 Stock stays costOf = 6,000 (the pure purchase price)', ERP.Inventory.costOf(X.id,wh)===M.toP(6000));

  /* ── 2. a sale: profit is after carriage ── */
  const inv=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-10-02',
    items:[{productId:X.id,quantity:10,unitPrice:6300}]});
  const il=ERP.Invoices.items(inv.id)[0];
  check('C8 the invoice line snapshots the split: 6,000 purchase + 50 extra (carriage) = 6,050',
    il.costBuySnapshot===M.toP(6000) && il.costExtraSnapshot===M.toP(50) && il.costSnapshot===M.toP(6050),
    [il.costBuySnapshot,il.costExtraSnapshot,il.costSnapshot].join(' '));
  check('C9 profit on 10 bags at 6,300 is 2,500', ERP.Profit.invoice(inv.id).profit===M.toP(2500), M.fmt(ERP.Profit.invoice(inv.id).profit));
  const pv=ERP.Profit.preview(X.id,wh,10,6300,0);
  check('C10 the live profit line agrees (cost 6,050, profit 2,500)', pv.cost===M.toP(6050) && pv.profit===M.toP(2500));

  /* ── 3. Stock value includes the carriage ── */
  const sv=ERP.StockValue.build({noSell:true});
  const svx=sv.rows.find(r=>r.productId===X.id&&r.warehouseId===wh);
  check('C11 Stock value: 90 bags at 6,050 (purchase + carriage)', svx && svx.costP===M.toP(6050) && svx.valueP===M.mul(M.toP(6050),90) &&
    svx.carriageP===M.toP(50), svx&&[svx.costP,svx.valueP,svx.carriageP].join(' '));
  check('C12 StockValue.costOf (used by conversions) stays the pure 6,000', ERP.StockValue.costOf(X.id,wh).p===M.toP(6000));

  /* ── 4. Add stock dilutes the average at 0 ── */
  await ERP.StockDocs.receive({warehouseId:wh,date:'2026-10-02',reason:'Add',items:[{productId:X.id,quantity:90,unitPrice:6000}]});
  check('C13 Add stock (no carriage) dilutes it: 90 bags at 50 + 90 at 0 = 25',
    row(X).avgCarriageP===M.toP(25), String(row(X).avgCarriageP));

  /* ── 5. edit the purchase: carriage 5,000 -> 3,000 re-prices only its own bags ── */
  const pd=ERP.Purchases.toDraft(ERP.Purchases.byId(pu.id)); pd.id=pu.id;
  check('C14 toDraft gives the carriage back', String(pd.carriage)==='5000', String(pd.carriage));
  pd.carriage='3000';
  await ERP.Purchases.save(pd);
  const li2=ERP.Purchases.items(pu.id)[0];
  /* 190 bags: 100 from the purchase at 30 (was 50) and 90 at 0 -> but 10 were sold: bag-weighted by the row = (100*30)/190 */
  check('C15 editing the carriage moves that purchase\'s bags to 30 and leaves the Add-stock bags alone',
    li2.carriageUnitP===M.toP(30) && row(X).avgCarriageP===Math.round(100*M.toP(30)/180), `${li2.carriageUnitP} ${row(X).avgCarriageP}`);
  check('C16 the supplier balance is still unaffected by an edit of the carriage', owed(mill)-owed0===M.toP(600000));
  check('C17 the old invoice keeps its snapshot (extra 50)', ERP.Invoices.items(inv.id)[0].costExtraSnapshot===M.toP(50));

  /* ── 6. part delivery and a later delivery carry the same per-bag figure ── */
  const pp=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'1000',
    items:[{productId:Y.id,quantity:50,unitPrice:5000,receivedQty:20}]});
  check('C18 a part delivery: 1,000 over 50 ordered bags = 20 a bag, only 20 bags in', row(Y).qty===20 && row(Y).avgCarriageP===M.toP(20),
    `${row(Y).qty} ${row(Y).avgCarriageP}`);
  await ERP.Purchases.receiveMore(pp.id,[{itemId:ERP.Purchases.items(pp.id)[0].id,quantity:30}]);
  check('C19 the later delivery carries the same 20 a bag', row(Y).qty===50 && row(Y).avgCarriageP===M.toP(20), `${row(Y).qty} ${row(Y).avgCarriageP}`);

  /* ── 7. several products on one purchase: the same per-bag figure each ── */
  const mp=await ERP.Purchases.save({supplierId:mill2,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'3000',
    items:[{productId:Z.id,quantity:100,unitPrice:4000},{productId:W.id,quantity:200,unitPrice:9000}]});
  const mit=ERP.Purchases.items(mp.id);
  check('C20 3,000 over 300 bags = 10 a bag on every line (equal per bag, not by value)',
    mit.every(i=>i.carriageUnitP===M.toP(10)) && row(Z).avgCarriageP===M.toP(10) && row(W).avgCarriageP===M.toP(10));

  /* ── 8. transfer and brand conversion take the carriage along ── */
  await ERP.StockDocs.transfer({warehouseId:wh,toWarehouseId:wh2,date:'2026-10-02',items:[{productId:Z.id,quantity:40}]});
  check('C21 a transfer carries the source row\'s carriage to the other warehouse', row(Z,wh2).avgCarriageP===M.toP(10), String(row(Z,wh2)&&row(Z,wh2).avgCarriageP));
  const T=P[7];
  await ERP.StockDocs.convert({warehouseId:wh,items:[{productId:W.id,toProductId:T.id,quantity:50}]});
  check('C22 a brand conversion carries it to the new brand', row(T).avgCarriageP===M.toP(10), String(row(T)&&row(T).avgCarriageP));

  /* ── 9. a pre-existing stock row (no carriage field at all) follows 0 ── */
  const V=P[8];
  await ERP.StockDocs.receive({warehouseId:wh,date:'2026-10-02',reason:'Open',items:[{productId:V.id,quantity:10,unitPrice:3000}]});
  check('C23 stock that never had carriage shows 0, and costs the same as before',
    ERP.Inventory.averages(V.id).carriage===0 && ERP.Inventory.saleCostOf(V.id,wh)===M.toP(3000));

  /* ── 10. pin on the Prices screen ── */
  let r=await ERP.Prices.setCost(X.id,{extra:'0'},{reason:'test'});
  check('C24 typing 0 pins the carriage at 0 (a real pin, not "none")', ERP.Inventory.averages(X.id).carriageOverride===0 &&
    ERP.Inventory.saleCarriageOf(X.id,wh)===0 && ERP.Inventory.saleCostOf(X.id,wh)===M.toP(6000), JSON.stringify(ERP.Inventory.averages(X.id)));
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'9000',
    items:[{productId:X.id,quantity:10,unitPrice:6000}]});
  check('C25 a new purchase with carriage does not move the pinned figure (still 0)', ERP.Inventory.saleCarriageOf(X.id,wh)===0);
  r=await ERP.Prices.setCost(X.id,{},{clearExtraOverride:true});
  check('C26 "Use the average" un-pins it: the live average applies again',
    ERP.Inventory.averages(X.id).carriageOverride===null && ERP.Inventory.saleCarriageOf(X.id,wh)===ERP.Inventory.averages(X.id).carriage &&
    ERP.Inventory.averages(X.id).carriage>0);
  r=await ERP.Prices.setCost(X.id,{extra:'75'},{reason:'test'});
  check('C27 a typed figure pins at that figure (75)', ERP.Inventory.saleCarriageOf(X.id,wh)===M.toP(75));
  const hist=ERP.Prices.history(X.id).filter(h=>h.field==='extra');
  check('C28 each carriage change is written to the price history', hist.length>=3, String(hist.length));
  let e=await rejects(ERP.Prices.setCost(X.id,{extra:'-5'},{}));
  check('C29 a negative carriage is refused', !!(e&&e.validation));
  e=await rejects(ERP.Prices.setCost(X.id,{extra:'abc'},{}));
  check('C30 a non-number carriage is refused', !!(e&&e.validation));
  await ERP.Prices.setCost(X.id,{},{clearExtraOverride:true});

  /* ── 11. a sold-out product falls back to its last purchase's carriage ── */
  const S1=P[9];
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'600',
    items:[{productId:S1.id,quantity:6,unitPrice:2000}]});
  await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-10-02',items:[{productId:S1.id,quantity:6,unitPrice:2500}]});
  check('C31 sold out: the carriage still shows the last purchase\'s 100 a bag', ERP.Inventory.averages(S1.id).bags===0 &&
    ERP.Inventory.averages(S1.id).carriage===M.toP(100), JSON.stringify(ERP.Inventory.averages(S1.id)));

  /* ── 12. the purchase-price-only profit basis leaves carriage out of a sale; stock value keeps it ── */
  await ERP.Settings.save({profitCostBasis:'PURCHASE'});
  check('C32 under "purchase price only" a sale excludes carriage', ERP.Inventory.saleCarriageOf(Z.id,wh)===0 && ERP.Inventory.saleCostOf(Z.id,wh)===M.toP(4000));
  check('C33 Stock value still includes it', ERP.StockValue.build({noSell:true}).rows.find(r=>r.productId===Z.id&&r.warehouseId===wh).costP===M.toP(4010));
  await ERP.Settings.save({profitCostBasis:'LANDED'});

  /* ── 13. validation of the box itself ── */
  e=await rejects(ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'-100',items:[{productId:X.id,quantity:1,unitPrice:1}]}));
  check('C34 a negative carriage on a purchase is refused', !!(e&&e.validation&&/arriage/.test(e.validation.join(' '))), JSON.stringify(e));

  /* ── 14. the screen ── */
  ERP.Builder.start('purchase'); await sleep(120);
  const box=D.querySelector('[data-fcb="carriage"]');
  check('C35 the purchase screen has a Carriage / transport box', !!box);
  ERP.Builder.draft.supplierId=mill; ERP.Builder.draft.warehouseId=wh;
  ERP.Builder.draft.items=[{productId:X.id,quantity:'100',unitPrice:'6000',discount:'',receivedQty:''}];
  if(box){ box.value='5000'; box.dispatchEvent(new win.Event('input',{bubbles:true})); }
  await sleep(120);
  check('C36 typing in it reaches the draft', String(ERP.Builder.draft.carriage)==='5000', String(ERP.Builder.draft.carriage));
  const line=(D.getElementById('fcbCar')||{}).textContent||'';
  check('C37 the live line shows 5,000 ÷ 100 bags = 50 per bag', /100 bags/.test(line) && /50/.test(line), line);
  const grand=(D.querySelector('.fcb-check')||{}).textContent||'';
  check('C38 the screen total is still just the goods', /600,000/.test(grand) && !/605,000/.test(grand), grand);

  /* the Prices panel */
  ERP.openPriceEditor(X.id); await sleep(250);
  const panel=D.getElementById('panel'); const ptxt=panel?panel.textContent:'';
  check('C39 the Prices screen: an average label, ONE Extra cost (carriage / transport) box, no second box, and the worked sum',
    /Average extra cost/.test(ptxt) && !!D.querySelector('#panel [data-f="extra"]') && !D.querySelector('#panel [data-f="carriage"]') &&
    /\+ Extra cost \(carriage \/ transport\)/.test(ptxt), ptxt.slice(0,200));

  /* ── 15. the client's own sum: 6,000 + 200 = 6,200; 5 bags at 6,300 = 31,500; profit 500 ── */
  const Q=P[10], R=P[11];
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',carriage:'1000',
    items:[{productId:Q.id,quantity:5,unitPrice:6000}]});
  check('C41 5 bags at 6,000 with 1,000 carriage: extra 200, total 6,200 a bag',
    ERP.Inventory.saleBuyOf(Q.id,wh)===M.toP(6000) && ERP.Inventory.extraFor(Q.id,wh)===M.toP(200) && ERP.Inventory.saleCostOf(Q.id,wh)===M.toP(6200));
  const iq=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-10-02',items:[{productId:Q.id,quantity:5,unitPrice:6300}]});
  const pq=ERP.Profit.invoice(iq.id);
  check('C42 selling 5 at 6,300 = 31,500 on a cost of 31,000: actual profit 500', pq.revenue===M.toP(31500) && pq.cost===M.toP(31000) && pq.profit===M.toP(500),
    [pq.revenue,pq.cost,pq.profit].map(M.fmt).join(' | '));
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-10-02',items:[{productId:R.id,quantity:5,unitPrice:6000}]});
  await ERP.Prices.setCost(R.id,{extra:'200'},{reason:'typed on the Prices screen'});
  const ir=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-10-02',items:[{productId:R.id,quantity:5,unitPrice:6300}]});
  check('C43 the same 200 typed on the Prices screen instead gives the same profit of 500', ERP.Profit.invoice(ir.id).profit===M.toP(500),
    M.fmt(ERP.Profit.invoice(ir.id).profit));

  check('C40 nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
