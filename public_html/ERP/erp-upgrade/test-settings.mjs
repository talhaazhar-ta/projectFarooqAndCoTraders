import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
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
  let win=boot(store); let ERP=await ready(win);
  const M=win.Money, D=win.document;
  const $=s=>D.querySelector(s), $$=s=>Array.from(D.querySelectorAll(s));
  const click=el=>el&&el.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const type=(el,v)=>{if(el){el.value=v;el.dispatchEvent(new win.Event('input',{bubbles:true}));}};
  const change=(el,v)=>{if(el){el.value=v;el.dispatchEvent(new win.Event('change',{bubbles:true}));}};
  const P=win.PRODUCTS.filter(p=>p.active!==false);
  const rice=P[1];

  /* ── prices ── */
  await ERP.Prices.set(rice.id,{buy:2000,sell:2400},{reason:'Opening prices'});
  let info=ERP.Prices.of(rice.id);
  check('S1 a purchase and selling price can be set',
    info.buy===M.toP(2000) && info.sell===M.toP(2400));
  check('S2 profit, margin and markup follow from them',
    info.profit===M.toP(400) && info.margin===16.7 && info.markup===20,
    `${M.fmt(info.profit)} ${info.margin}% / ${info.markup}%`);
  await ERP.Prices.set(rice.id,{buy:2200,sell:2600},{reason:'Market price increase'});
  info=ERP.Prices.of(rice.id);
  check('S3 prices can be changed again as the market moves',
    info.buy===M.toP(2200) && info.sell===M.toP(2600));

  const hist=ERP.Prices.history(rice.id);
  check('S4 the old prices are kept, not overwritten', hist.length===4, String(hist.length));
  const sellChange=hist.filter(h=>h.field==='sell')[0];
  check('S5 each entry records what it was, what it became, who and why',
    sellChange.oldValue===M.toP(2400) && sellChange.newValue===M.toP(2600) &&
    sellChange.reason==='Market price increase' && !!sellChange.changedBy && !!sellChange.changedAt,
    JSON.stringify({o:M.toR(sellChange.oldValue),n:M.toR(sellChange.newValue),by:sellChange.changedBy}));
  check('S6 a change with no reason is accepted — a reason is optional (2026-09-26: a required one made a Save look done when it was not)',
    await ERP.Prices.set(rice.id,{sell:2700},{}).then(r=>r.applied===true).catch(()=>false));
  await ERP.Prices.set(rice.id,{sell:2600},{reason:'back to the test price'});
  check('S7 nonsense prices are refused',
    await ERP.Prices.set(rice.id,{sell:-5},{reason:'x'}).then(()=>false)
      .catch(e=>e.validation.some(m=>/negative/i.test(m))));
  await ERP.Prices.set(rice.id,{min:2300},{reason:'floor'});
  check('S8 a selling price under the product minimum is refused',
    await ERP.Prices.set(rice.id,{sell:2100},{reason:'too low'}).then(()=>false)
      .catch(e=>e.validation.some(m=>/minimum/i.test(m))));
  const belowCost=ERP.Prices.validate(rice.id,{sell:2100,buy:2200});
  check('S9 selling below cost is flagged with what it would lose',
    belowCost.warnings.some(w=>/lose/.test(w)), belowCost.warnings.join('|'));
  check('S10 saving the same price twice changes nothing',
    (await ERP.Prices.set(rice.id,{sell:2600},{reason:'same'})).unchanged===true);
  check('S11 wholesale, retail, discount, tax and the alert level are all editable',
    (await ERP.Prices.set(rice.id,{wholesale:2500,retail:2700,discountPct:2,taxPct:1,reorder:40},
      {reason:'full set'})).changes.length===5);
  info=ERP.Prices.of(rice.id);
  check('S12 and they are stored', info.wholesale===M.toP(2500) && info.retail===M.toP(2700) &&
    info.discountPct===2 && info.taxPct===1 && info.reorder===40);

  /* the rest of the ERP uses the new price */
  const wh=win.WAREHOUSES[1].id;
  await ERP.Purchases.save({supplierId:win.SUPPLIERS[0].id,warehouseId:wh,
    items:[{productId:rice.id,quantity:100,unitPrice:2200}]});
  ERP.Builder.start('sale'); await sleep(120);
  ERP.BuilderUI.addLine(rice.id); await sleep(80);
  /* §28, 2026-09-29: there is no more product-level "selling price" field — a new invoice line starts
     blank (or at the LAST rate this product actually sold at, Inventory.lastSoldP) and is typed fresh at
     the sale every time, never read from Prices.set's 'sell' field any more. */
  check('S13 a new invoice line for a product never sold before starts blank — it is typed fresh at the sale',
    (ERP.Builder.draft.items[0].unitPrice||'')==='', String(ERP.Builder.draft.items[0].unitPrice));
  ERP.Builder.draft=null;
  check('S14 the stock alert level comes from the product, then the setting',
    ERP.reorderLevelOf(rice.id)===40 && ERP.reorderLevelOf(P[7].id)===ERP.Settings.get().defaultReorderLevel);

  /* ── client-reported: "when we add product in stock it gives 100% margin" ──
     a brand-new product with no purchase behind it, added only through Add stock with a cost
     typed, must not be costed at zero everywhere else that cost is used. */
  const newP=P[10];
  await ERP.StockDocs.receive({warehouseId:wh, reason:'New line', opening:true,
    items:[{productId:newP.id,quantity:20,unitPrice:1500}]});
  check('S14b a product only ever added through Add stock carries that typed cost, not zero',
    ERP.Inventory.costOf(newP.id,wh)===M.toP(1500), M.fmt(ERP.Inventory.costOf(newP.id,wh)));
  await ERP.Prices.set(newP.id,{sell:1800},{reason:'First sale price'});
  const newInfo=ERP.Prices.of(newP.id);
  check('S14c …so its margin is worked from that cost, not a false 100%',
    newInfo.buy===M.toP(1500) && newInfo.margin===16.7,
    `buy ${M.fmt(newInfo.buy)} margin ${newInfo.margin}%`);

  /* ── approval workflow, with real accounts ── */
  await ERP.Settings.save({priceApproval:true});
  const ownerAcct=ERP.Users.all()[0];
  const salesAcct=await ERP.Users.save({name:'Kamran Sales',role:'SALES'});
  await ERP.Session.signIn(salesAcct.id,'');
  check('S15 with approval on, a salesperson\'s change waits',
    (await ERP.Prices.set(rice.id,{sell:2800},{reason:'customer pressure'})).pending===true);
  check('S16 the price has not moved yet', ERP.Prices.of(rice.id).sell===M.toP(2600));
  check('S17 the request is queued with its reason',
    ERP.Prices.pending(rice.id).length===1 &&
    ERP.Prices.pending(rice.id)[0].reason==='customer pressure');
  check('S18 a salesperson cannot approve their own request',
    await ERP.Prices.approve(ERP.Prices.pending(rice.id)[0].id).then(()=>false)
      .catch(e=>/owner or a manager|someone else/i.test(e.validation[0])));
  await ERP.Session.signIn(ownerAcct.id,'');
  const req=ERP.Prices.pending(rice.id)[0];
  await ERP.Prices.approve(req.id);
  check('S19 the owner approves and the price takes effect',
    ERP.Prices.of(rice.id).sell===M.toP(2800) && ERP.Prices.pending(rice.id).length===0);
  check('S20 the history names the person who asked and the person who approved',
    ERP.Prices.history(rice.id).some(h=>h.newValue===M.toP(2800) &&
      h.changedBy==='Kamran Sales' && h.changedByRole==='SALES' &&
      h.approvedBy===ownerAcct.name && h.approvedByRole==='OWNER'),
    JSON.stringify(ERP.Prices.history(rice.id).slice(0,1)));
  await ERP.Session.signIn(salesAcct.id,'');
  await ERP.Prices.set(rice.id,{sell:3000},{reason:'chancing it'});
  await ERP.Session.signIn(ownerAcct.id,'');
  await ERP.Prices.reject(ERP.Prices.pending(rice.id)[0].id,'too high for the area');
  check('S21 a rejected change leaves the price alone',
    ERP.Prices.of(rice.id).sell===M.toP(2800) && ERP.Prices.pending(rice.id).length===0);
  check('S22 both decisions are on the audit log',
    ERP.S.audit.some(a=>a.action==='Price change approved') &&
    ERP.S.audit.some(a=>a.action==='Price change rejected'));
  await ERP.Settings.save({priceApproval:false});
  check('S23 with approval off, an owner\'s change applies at once',
    (await ERP.Prices.set(rice.id,{sell:2900},{reason:'settled'})).applied===true &&
    ERP.Prices.of(rice.id).sell===M.toP(2900));

  /* ── lists ── */
  await ERP.Lists.add('categories','دالیں');
  check('S24 a category can be added without touching code',
    ERP.Lists.get('categories').indexOf('دالیں')>-1);
  check('S25 a duplicate is refused',
    await ERP.Lists.add('categories','دالیں').then(()=>false).catch(e=>!!e.validation));
  await ERP.Lists.remove('categories','دالیں');
  check('S26 an unused category can be removed',
    ERP.Lists.get('categories').indexOf('دالیں')===-1);
  check('S27 a category still in use cannot be removed',
    await ERP.Lists.remove('categories',rice.cat).then(()=>false)
      .catch(e=>/still use/.test(e.validation[0])));
  await ERP.Lists.add('units','50 KG Bag');
  check('S28 units and brands are editable too', ERP.Lists.get('units').indexOf('50 KG Bag')>-1);

  /* ── the settings panel ── */
  win.go('settings'); await sleep(300);
  check('S29 settings is one panel with a sidebar', $$('[data-stsection]').length>=11);
  check('S30 it has a search box', !!$('[data-stq]'));
  click($('[data-stsection="pricing"]')); await sleep(250);
  check('S31 the pricing section shows the rules, lists and history',
    /Pricing rules/.test($('#view').textContent) && !!$('[data-stlistadd="categories"]') &&
    /Recent price changes/.test($('#view').textContent));
  const before=ERP.Settings.get().lowStockAlerts;
  click($('[data-stsection="inventory"]')); await sleep(250);
  check('S32 inventory rules are toggles', $$('[data-sttoggle]').length>=4);
  click($('[data-sttoggle="lowStockAlerts"]')); await sleep(250);
  check('S33 a toggle saves immediately', ERP.Settings.get().lowStockAlerts===!before);
  check('S34 and is written to the audit log',
    ERP.S.audit.some(a=>a.action==='Setting changed: lowStockAlerts'));
  click($('[data-stsection="sales"]')); await sleep(250);
  change($('[data-stfield="defaultPaymentTermDays"]'),'15'); await sleep(250);
  check('S35 a numeric setting saves', ERP.Settings.get().defaultPaymentTermDays===15);
  click($('[data-stsection="data"]')); await sleep(250);
  check('S36 the other modules\' cards are filed into the right section',
    /Database/.test($('#view').textContent) && !!$('[data-fcbact="backup"]'));
  click($('[data-stsection="general"]')); await sleep(250);
  check('S37 the business profile lands in General',
    !!$('[data-fcset="businessName"]'));
  type($('[data-stq]'),'backup'); await sleep(400);
  check('S38 searching settings finds the card wherever it lives',
    /Backup|backup/.test($('#view').textContent));
  type($('[data-stq]'),''); await sleep(400);

  /* ── access ── */
  const store2=await ERP.Users.save({name:'Godown Hand',role:'INVENTORY'});
  await ERP.Session.signIn(store2.id,'');
  win.go('settings'); await sleep(250);
  check('S39 warehouse staff cannot open settings',
    /not open to you/i.test($('#view').textContent));
  await ERP.Session.signIn(ownerAcct.id,'');
  win.go('settings'); await sleep(250);
  check('S40 the owner can', !!$('[data-stsection]'));

  /* ── persistence ── */
  await ERP.flush(); await sleep(400);
  const state={sell:ERP.Prices.of(rice.id).sell,hist:ERP.Prices.history(rice.id).length,
    terms:ERP.Settings.get().defaultPaymentTermDays,units:ERP.Lists.get('units').length};
  win.close();
  win=boot(store); ERP=await ready(win);
  for(let i=0;i<60 && !(ERP.S.priceHistory||[]).length;i++) await sleep(50);
  for(let i=0;i<80 && ERP.Prices.of(rice.id).sell!==state.sell;i++) await sleep(50);   /* the product list lands a moment after the history */
  check('S41 prices survive a restart', ERP.Prices.of(rice.id).sell===state.sell,
    M.fmt(ERP.Prices.of(rice.id).sell)+' vs '+M.fmt(state.sell));
  check('S42 the price history survives', ERP.Prices.history(rice.id).length===state.hist,
    ERP.Prices.history(rice.id).length+' vs '+state.hist);
  check('S43 the settings survive',
    ERP.Settings.get().defaultPaymentTermDays===state.terms &&
    ERP.Lists.get('units').length===state.units);
  check('S44 nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
