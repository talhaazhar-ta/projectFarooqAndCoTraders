import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* Extra cost per bag on the Product prices panel (module 21): what WE pay to bring a bag in —
   transport, labour, loading — beside the mill's purchase price. It must change the margin and the
   below-cost warning, keep its own history, and never touch a supplier, a payment or stock cost. */
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
  const P=win.PRODUCTS.filter(p=>p.active!==false);
  const rice=P[1], flour=P[2];
  const owner=ERP.Users.all()[0];

  /* ── the numbers ── */
  await ERP.Prices.set(flour.id,{buy:2000,sell:2400},{reason:'No extra cost yet'});
  let f0=ERP.Prices.of(flour.id);
  check('E1 with no extra cost, profit / margin / markup are exactly what they were',
    f0.extra===0 && f0.totalCost===M.toP(2000) && f0.profit===M.toP(400) && f0.margin===16.7 && f0.markup===20,
    `${f0.extra} ${f0.totalCost} ${f0.profit} ${f0.margin} ${f0.markup}`);

  await ERP.Prices.set(rice.id,{buy:2000,extra:100,sell:2400},{reason:'Opening prices with our own cost'});
  let info=ERP.Prices.of(rice.id);
  check('E2 the extra cost is stored beside the purchase price',
    info.buy===M.toP(2000) && info.extra===M.toP(100), `${info.buy} ${info.extra}`);
  check('E3 the cost to us is purchase + extra',
    info.totalCost===M.toP(2100), String(info.totalCost));
  check('E4 profit, margin and markup are worked from the cost to us (300 on 2,400 = 12.5%, 14.3% on cost)',
    info.profit===M.toP(300) && info.margin===12.5 && info.markup===14.3,
    `${M.fmt(info.profit)} ${info.margin}% / ${info.markup}%`);
  const rec=win.prodOf(rice.id);
  check('E5 the product keeps it in paisa and rupees like the other prices',
    rec.extraP===M.toP(100) && rec.extra===100 && rec.buyP===M.toP(2000));

  /* ── the warning ── */
  const between=ERP.Prices.validate(rice.id,{sell:2050});
  check('E6 selling above the mill price but under the cost to us is flagged, and says what is lost',
    between.errors.length===0 && between.warnings.some(w=>/lose/.test(w) && /50/.test(w) && /extra/i.test(w)),
    between.warnings.join('|'));
  const above=ERP.Prices.validate(rice.id,{sell:2150});
  check('E7 selling above the cost to us shows no warning', above.warnings.length===0, above.warnings.join('|'));
  const plain=ERP.Prices.validate(flour.id,{sell:1900});
  check('E8 a product with no extra cost still gets the original "below purchase price" warning',
    plain.warnings.some(w=>/purchase price/.test(w) && /lose/.test(w)), plain.warnings.join('|'));
  const both=ERP.Prices.validate(rice.id,{sell:2300,extra:400});
  check('E9 a warning is judged on the boxes typed together (new extra against the held selling price)',
    both.warnings.some(w=>/lose/.test(w)), both.warnings.join('|'));

  /* ── history, refusals ── */
  await ERP.Prices.set(rice.id,{extra:150},{reason:'Fuel went up'});
  const h=ERP.Prices.history(rice.id).filter(x=>x.field==='extra')[0];
  check('E10 a change to it is kept in the price history with what it was, what it became and why',
    !!h && h.oldValue===M.toP(100) && h.newValue===M.toP(150) && h.reason==='Fuel went up' &&
    h.fieldLabel==='Extra cost per bag' && h.money===true, JSON.stringify(h));
  check('E11 a negative extra cost is refused',
    await ERP.Prices.set(rice.id,{extra:-5},{reason:'x'}).then(()=>false)
      .catch(e=>e.validation.some(m=>/negative/i.test(m))));
  check('E12 a figure that is not a number ("1.2.3") is refused',
    await ERP.Prices.set(rice.id,{extra:'1.2.3'},{reason:'x'}).then(()=>false)
      .catch(e=>e.validation.some(m=>/not a number/i.test(m))));
  check('E13 typing 0 clears it',
    (await ERP.Prices.set(rice.id,{extra:0},{reason:'Supplier now delivers'})).applied===true &&
    ERP.Prices.of(rice.id).extra===0 && ERP.Prices.of(rice.id).totalCost===M.toP(2000));
  await ERP.Prices.set(rice.id,{extra:100},{reason:'Back to our own truck'});

  /* ── it is our own cost: no supplier, payment or stock cost moves ── */
  await ERP.Purchases.save({supplierId:win.SUPPLIERS[0].id,warehouseId:win.WAREHOUSES[1].id,
    items:[{productId:rice.id,quantity:100,unitPrice:2000}]});
  const snap=()=>JSON.stringify({pay:ERP.S.payments.length,pur:ERP.S.purchases.map(p=>p.grandTotal),
    inv:Object.keys(ERP.S.inventory).sort().map(k=>{const r=ERP.S.inventory[k];return [k,r.qty,r.avgCostP,r.lastCostP];}),
    bal:win.SUPPLIERS.map(s=>ERP.Suppliers&&ERP.Suppliers.balance?ERP.Suppliers.balance(s.id):0)});
  const before=snap();
  await ERP.Prices.set(rice.id,{extra:275},{reason:'Labour rate'});
  check('E14 changing it touches no payment, purchase total, supplier balance or stock cost',
    snap()===before);
  check('E15 the price change is on the audit log',
    ERP.S.audit.some(a=>a.action==='Product prices updated' && a.newValues && a.newValues.extra===275));

  /* ── approval: a salesperson's change waits like any other price ── */
  await ERP.Settings.save({priceApproval:true});
  const sales=await ERP.Users.save({name:'Kamran Sales',role:'SALES'});
  await ERP.Session.signIn(sales.id,'');
  const req=await ERP.Prices.set(rice.id,{extra:300},{reason:'Asked for a higher figure'});
  check('E16 with approval on, a salesperson\'s extra-cost change waits and the figure has not moved',
    req.pending===true && ERP.Prices.of(rice.id).extra===M.toP(275));
  await ERP.Session.signIn(owner.id,'');
  await ERP.Prices.approve(ERP.Prices.pending(rice.id)[0].id);
  check('E17 the owner approves it and it takes effect, in the right unit (rupees, not paisa)',
    ERP.Prices.of(rice.id).extra===M.toP(300) && win.prodOf(rice.id).extra===300);
  await ERP.Settings.save({priceApproval:false});
  await ERP.Prices.set(rice.id,{extra:100},{reason:'Reset for the screen checks'});

  /* ── the panel the client actually sees (simplified §26, 2026-09-28: three bag-weighted averages —
     Inventory.averages — not the product's own raw figures; with nothing in stock the two agree exactly,
     since averages() falls back to the product's own buy/extra/sell). ── */
  ERP.openPriceEditor(rice.id); await sleep(300);
  let panel=$('#panel');
  let labels=Array.from(panel.querySelectorAll('label.f > span:first-child')).map(s=>s.textContent);
  check('E18 the panel has an "Average extra cost" box next to "Average purchase price"',
    !!panel.querySelector('[data-f="extra"]') && labels.indexOf('Average extra cost')>-1 &&
    labels.indexOf('Average extra cost')===labels.indexOf('Average purchase price')+1, labels.join(' | '));
  check('E19 it starts with the saved value',
    panel.querySelector('[data-f="extra"]').value==='100');
  check('E20 its hint says what goes in it (transport, labour) and that it is not on the supplier\'s bill',
    /transport/i.test(panel.textContent) && /labour/i.test(panel.textContent) && /supplier/i.test(panel.textContent));
  const live=()=>($('#pzCalcRows')?.textContent||'')+' '+($('#pzCalcTot')?.textContent||'');
  check('E21 a live line shows the cost to us and the profit per bag',
    /2,100/.test(live()) && /Profit per bag/.test(live()) && /300/.test(live()), live());
  type(panel.querySelector('[data-f="extra"]'),'250');
  check('E22 the live line follows the extra-cost box as it is typed',
    /2,250/.test(live()) && /150/.test(live()), live());
  type(panel.querySelector('[data-f="sell"]'),'2200');
  check('E23 and the selling-price box, showing a loss when the price is under the cost to us',
    /2,250/.test(live()) && /(−|-)\s?PKR\s?50|Profit per bag.*50/i.test(live()), live());
  type(panel.querySelector('[data-f="buy"]'),'2100'); type(panel.querySelector('[data-f="extra"]'),'');
  check('E24 a cleared box counts as what the product already holds, like Save does',
    /2,200/.test(live()) && /100/.test(live()), live());
  type(panel.querySelector('[data-f="buy"]'),'2000'); type(panel.querySelector('[data-f="extra"]'),'300');
  type(panel.querySelector('[data-f="sell"]'),'2500');
  panel.querySelector('[data-f="reason"]').value='Transport and labour on the Chitral run';
  click(panel.querySelector('[data-save]')); await sleep(350);
  info=ERP.Prices.of(rice.id);
  check('E25 Save revalues the purchase price, the extra cost and the selling price together',
    info.buy===M.toP(2000) && info.extra===M.toP(300) && info.sell===M.toP(2500) && info.totalCost===M.toP(2300),
    `${info.buy} ${info.extra} ${info.sell}`);
  ERP.openPriceEditor(rice.id); await sleep(250);
  check('E26 it appears in the price history when the panel is opened again',
    /Extra cost per bag/.test($('#panel').textContent));
  click($('#panel [data-close]')); await sleep(150);

  /* ── the bulk price form ── */
  await ERP.MasterEdit.bulkPrice([rice.id,flour.id],{field:'extra',mode:'set',amount:60},'Fuel surcharge');
  check('E27 "Change many prices" can set the extra cost on several products at once',
    ERP.Prices.of(rice.id).extra===M.toP(60) && ERP.Prices.of(flour.id).extra===M.toP(60));
  await ERP.MasterEdit.bulkPrice([rice.id],{field:'extra',mode:'percent',amount:10},'Fuel up 10%');
  check('E28 and by a percentage', ERP.Prices.of(rice.id).extra===M.toP(66), String(ERP.Prices.of(rice.id).extra));
  check('E29 the bulk form offers it', /value="extra"/.test(win.PANELS.bulkprice.f()));

  /* ── edge cases found in review ── */
  const held0=ERP.Prices.of(rice.id).extra;
  check('E34 letters in the extra-cost box are refused, not read as 0 (which would silently clear it)',
    await ERP.Prices.set(rice.id,{extra:'abc'},{reason:'x'}).then(()=>false)
      .catch(e=>e.validation.some(m=>/not a number/i.test(m))) && ERP.Prices.of(rice.id).extra===held0);
  check('E35 so are a lone minus sign and a lone dot, on any price box',
    await ERP.Prices.set(rice.id,{sell:'-'},{reason:'x'}).then(()=>false).catch(e=>/not a number/i.test(e.validation[0])) &&
    await ERP.Prices.set(rice.id,{buy:'.'},{reason:'x'}).then(()=>false).catch(e=>/not a number/i.test(e.validation[0])));
  check('E36 a figure with a comma or a currency word still reads fine ("PKR 2,450.50")',
    (await ERP.Prices.set(rice.id,{sell:'PKR 2,450.50'},{reason:'format'})).applied===true &&
    ERP.Prices.of(rice.id).sell===M.toP(2450.5));
  check('E37 "Change many prices" with a non-number amount is refused rather than doing nothing',
    await ERP.MasterEdit.bulkPrice([rice.id],{field:'extra',mode:'set',amount:'abc'},'x').then(()=>false)
      .catch(e=>/how much/i.test(e.validation[0])));

  /* the same bug lived in the workbench's own number reader: a spreadsheet cell of "abc" wrote 0 into a bag size */
  await ERP.MasterEdit.update('product',rice.id,{kg:25});
  const sheetPlan=ERP.MasterSheet.plan('product','ID,Bag size (KG)\n'+rice.id+',abc\n'+flour.id+','+((win.prodOf(flour.id).kg||0)+1));
  check('E44 a spreadsheet cell of "abc" in a number column is reported as a problem row, not written as 0',
    sheetPlan.problems.length===1 && /should be a number/.test(sheetPlan.problems[0]) && sheetPlan.updates.length===1 &&
    win.prodOf(rice.id).kg===25, JSON.stringify(sheetPlan.problems)+' updates='+sheetPlan.updates.length);

  /* rice has real stock from the "own cost" purchase above — revalue it (not Prices.set, which only
     touches the product's own fields) so the stock row's own average actually resets too, the same way
     the panel's own Save does */
  await ERP.Prices.revalue(rice.id,{buy:2000,extra:100,sell:2400},{reason:'Reset for the panel checks'});
  let calls=0; const realOf=ERP.Prices.of; ERP.Prices.of=function(){calls++;return realOf.apply(this,arguments);};
  ERP.openPriceEditor(rice.id); await sleep(250);
  calls=0;
  const box=k=>$('#panel [data-f="'+k+'"]');
  type(box('extra'),'1'); type(box('extra'),'12'); type(box('extra'),'125'); type(box('sell'),'2300'); type(box('buy'),'2100');
  check('E38 typing in the cost boxes does not recompute the product\'s figures on every key', calls===0, String(calls));
  ERP.Prices.of=realOf;
  click($('#panel [data-close]')); await sleep(150);

  /* the below-cost rule stays the same "warn once, Save again to keep it anyway" pattern on this
     simplified panel (§26, 2026-09-28) — unchanged from before, just re-worded slightly (see G11-G13 in
     test-ui-kit.mjs, which is the fuller check of this exact mechanism) */
  const reasonBox=()=>$('#panel [data-f="reason"]');
  const errBox=()=>$('#panelErr').textContent;
  ERP.openPriceEditor(rice.id); await sleep(250);
  type(box('sell'),'2050'); reasonBox().value='Clearance'; click($('#panel [data-save]')); await sleep(300);
  check('E40 selling under the cost to us stops the first Save and says nothing was saved',
    /below what a bag costs/i.test(errBox()) && /Press Save again/.test(errBox()) && ERP.Prices.of(rice.id).sell===M.toP(2400), errBox());
  click($('#panel [data-save]')); await sleep(300);
  check('E41 pressing Save again keeps it (the person’s call)', ERP.Prices.of(rice.id).sell===M.toP(2050), String(ERP.Prices.of(rice.id).sell));
  ERP.openPriceEditor(rice.id); await sleep(250);   /* the successful save above closed the panel */
  type(box('sell'),'2500'); click($('#panel [data-save]')); await sleep(300);
  check('E42 a corrected selling price saves normally', ERP.Prices.of(rice.id).sell===M.toP(2500), String(ERP.Prices.of(rice.id).sell));
  click($('#panel [data-close]')); await sleep(150);
  await ERP.Prices.set(rice.id,{sell:2500,extra:66},{reason:'Back for the restart checks'});

  /* ── it survives a restart ── */
  await ERP.flush(); await sleep(400);
  const state={extra:ERP.Prices.of(rice.id).extra,total:ERP.Prices.of(rice.id).totalCost,
    hist:ERP.Prices.history(rice.id).filter(x=>x.field==='extra').length};
  win.close();
  win=boot(store); ERP=await ready(win);
  for(let i=0;i<60 && !(ERP.S.priceHistory||[]).length;i++) await sleep(50);
  check('E30 the extra cost survives a restart', ERP.Prices.of(rice.id).extra===state.extra && state.extra===M.toP(66),
    `${ERP.Prices.of(rice.id).extra} vs ${state.extra}`);
  check('E31 so does the cost to us built from it', ERP.Prices.of(rice.id).totalCost===state.total);
  check('E32 and its history', ERP.Prices.history(rice.id).filter(x=>x.field==='extra').length===state.hist,
    `${ERP.Prices.history(rice.id).filter(x=>x.field==='extra').length} vs ${state.hist}`);
  check('E33 nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
