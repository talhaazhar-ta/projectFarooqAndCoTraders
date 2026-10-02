# Simplified pricing: Purchases and Add stock, one average each (2026-09-28)

> **Superseded same day by §27, "Fixed document costs, selling price only on the Prices screen" — see the
> section at the bottom of this file.** The design below (three editable averages, `Prices.revalue`) is kept
> for history; the live app no longer works this way for purchase price / extra cost / selling price.

## Why

The client asked to simplify how a product gets its price:

> "From now on to add a product in the system we have only two ways: through purchasing and add stock…
> Extra cost input and selling price input, no Overall discount / Delivery / Loading / Other charges…
> when selling at Sales & Invoices the product's values will be read only… Profit & margin should show:
> Purchase price 6000, Extra cost 200, Total 6200, Selling price 6300, 5×6300=31,500, Actual profit 500."

Before this change, a purchase's Rate/Discount/Overall discount/Delivery/Loading/Other-charges boxes and a
separate "Extra cost per bag" set on the product's Prices screen were two different, easy-to-confuse ways
of getting to a bag's cost, and Add stock's cost never touched the recorded average at all (see the old
CLAUDE.md rule about `avgCostP` only moving on `PURCHASE_IN`/`MILL_RECEIPT_IN` — now superseded).

## The model now

Three numbers per product, each a **bag-weighted moving average of the stock actually on hand**:

- **Purchase price** (`avgCostP`) — what the supplier/mill charged, blended on every purchase or Add-stock
  receipt.
- **Extra cost** (`avgExtraP`) — what we pay ourselves on top (transport, labour, loading), typed once per
  product on the same screen.
- **Selling price** (`avgSellP`) — the rate a new invoice opens with, typed the same way.

All three live on `S.inventory[pid|wid]` rows and are blended by `Inventory.apply` (`02-services.js`):
inbound movements (`PURCHASE_IN`, `MILL_RECEIPT_IN`, and — new — `ADJUSTMENT_IN`/`OPENING_STOCK` **when
`refType==='STOCK_RECEIPT'`**, i.e. Add stock) blend the given figure in by quantity; a reversal or receipt
edit (`PURCHASE_REVERSAL_OUT`, `RECEIPT_EDIT_OUT`, `MILL_RECEIPT_REVERSAL_OUT`) takes bags back out at the
figure they came in with, so re-posting them doesn't re-price the bags already there. A row that never
blended a recorded cost (all its stock came in before this change) follows `Inventory.carriedCost` instead
of an assumed zero.

`Inventory.averages(pid)` is the bag-weighted average **across every warehouse** — what the simplified
Prices screen shows and revalues. `Inventory.sellOf(pid, wid)` / `costOf` / `extraFor` are the per-warehouse
figures a sale line and `saleCostOf` read.

## Where each figure is typed

- **Purchases → Receive stock** and **Inventory → Add stock**: the purchase price is on the line itself
  (required, labelled "Purchase price" with an "i"); Extra cost and Selling price are typed **once per
  product** in a "Charges & prices" card below the items table (`perProductPricingBlock`,
  `05-ui-builder.js`), live-showing "purchase + extra = cost · sell · profit/bag". A selling price below
  cost is refused before Save is even attempted (`ERP.Validate.perProductPricing`, checked both client-side
  in `B.save` and server-side in `Purchases.save`/`StockDocs.receive`).
- **The product Prices screen** (`21-settings.js` `PANELS.prices`, `ERP.Prices.revalue`): three boxes —
  Average purchase price / extra cost / selling price — plus the worked sum and a list of every purchase
  and stock receipt of the product with an **Edit** link (`data-pztxedit`) back to the source document.
  Saving here **revalues the stock on hand** (every warehouse row set to the new figure, a zero-qty
  `REVALUE` movement recorded per row so Stock value / history show it) — it never rewrites an old bill or
  what a supplier is owed. Selling below cost keeps the panel's existing "warn once, Save again to keep it
  anyway" pattern (`PRICE_WARNED`) — same as every other price warning in the app (`Prices.set`,
  `Purchases.doubleCostWarning`); `Prices.revalue` itself never blocks on it, only returns the warning.
- **Sales & Invoices → New invoice**: the line's Purchase/Extra/Selling figures are **read-only**, averaged
  from the line's warehouse (`Inventory.sellOf`/`costOf`/`extraFor`), re-read if the line's warehouse
  changes. An **Edit** button opens the product's Prices screen as a side panel — it does not touch the
  sale draft just by opening; only the panel's own "Edit purchase/receipt" links leave the sale, and they
  warn first if anything is typed but unsaved there.

## Old purchases

A purchase saved before this change keeps its Overall discount / Delivery / Loading / Other charges values
exactly as they were — the boxes are gone from the screen, but editing that purchase shows a banner
("kept exactly as it was") plus the old live cost-per-bag breakdown, and `Cost.allocate` still runs for it.
New purchases have none of those fields, so `landedUnit === goodsUnit === unitPrice` and nothing about the
old machinery fires.

## `17-profit.js`'s averaging fix

The wrapped `Purchases.save` used to overwrite `avgCostP` with `Cost.weightedAverage()` — a recompute from
**every** purchase this product has ever had into that warehouse, ignoring Add stock, bags already sold,
and any Prices-screen revalue since. Now it only **nudges** the average by the charge delta for the bags
just received on THIS purchase (`(useUnit − unitPrice) × qty / row.qty`), which is a no-op for every new
purchase (no charges → `useUnit === unitPrice`) and only matters for an old purchase still carrying
freight/discount. `26-landed-cost.js`'s own `weightedAverage` (the separate, pre-existing Landed-costs
screen) was left untouched — out of scope for this change, and it is a rarer, opt-in workflow.

## Invoice edit no longer re-costs old lines

`Invoices.snapshotItem` now stores the split `costBuySnapshot`/`costExtraSnapshot` alongside `costSnapshot`
(their sum, unchanged for every existing reader). Editing an invoice used to re-snapshot every line at
**today's** average, even a line that already existed unchanged — found while adding the split. A line
whose product+warehouse was already on the invoice now keeps its original cost snapshot; a genuinely new
line still gets today's.

## Not done

- A purchase/receipt's typed extra/sell doesn't write back onto the *product's own* `buyP`/`extraP`/`sellP`
  fields (only the Prices screen's revalue does) — a brand-new product with no stock anywhere still falls
  back to whatever the product record already holds (usually 0 until a Prices-screen save).
- `26-landed-cost.js`'s operational-cost screen (a different, older feature — freight paid separately after
  a purchase) still recomputes its own average from full history; not touched.
- No dedicated new test file beyond fixing the existing suite (`test-add-stock-pricing.mjs`,
  `test-purchase-cost.mjs`, `test-extra-cost.mjs`, `test-extra-cost-profit.mjs`, `test-return-guards.mjs`,
  `test-stock-value.mjs`, `test-convert.mjs`, `test-purchase-edit.mjs` were updated to match).
- Stock receipts and Purchases ("Goods received") lists gained a search box / a searchable purchase number
  (`09-paperwork.js` `docTable`, `farooq-co-erp.html` `PAGES.purchases`), plus `ERP.openReceiptsFor(pid)` /
  `ERP.openPurchasesFor(pid)` prefill helpers — not yet wired to any button, since the Prices screen's own
  purchases/receipts list covers the "come here to change it" flow the client asked for.
- Not seen live — see CLAUDE.md's "Not yet seen by a person on the live site" list.

## §27 — Fixed document costs, selling price only on the Prices screen (same day, 2026-09-28)

### Why

The client, on seeing §26 live: *"when we purchase a product with a specific purchase price and extra cost,
how can we then change the purchase price of all purchased and Add-stock receipts just by editing the Prices
screen?"* — a fair complaint about `Prices.revalue` above, which force-set **every warehouse row's**
`avgCostP`/`avgExtraP` to whatever was typed, silently re-pricing bags that came in on already-issued
purchases and receipts. Their own proposed fix, adopted as-is:

1. Purchase price and extra cost are **fixed to the purchase/receipt document** that typed them — never
   editable afterwards except by editing that document (Edit purchase / Edit stock receipt).
2. The product Prices screen shows them as the **bag-weighted average of stock on hand**
   (`Inventory.averages`), now **read-only text** (`.pz-ro` in `21-settings.js`), with the same worked sum
   and purchases/receipts list (with Edit links) as before.
3. **Selling price is removed from Purchases → Receive stock and Inventory → Add stock entirely** —
   `perProductPricingBlock` (`05-ui-builder.js`) now has only the Extra-cost box. It is set in exactly one
   place: the Prices screen, `Prices.setSell` (replaces `Prices.revalue`).
4. The selling price can never be saved **below what a bag costs** (purchase + extra) — a **hard block, no
   override**, confirmed by the user for everyone including the owner. `PRICE_WARNED` (the old "Save again to
   keep it anyway" pattern) is gone from this panel.

### What changed

- **One selling price per product**, not per warehouse: `avgSellP` on inventory rows is gone.
  `Inventory.sellOf(pid, wid)` is now a thin wrapper over `Inventory.rawSellOf(pid)` (reads `p.sellP`);
  `Inventory.apply` no longer blends a `sellP` on any inbound/undo movement. `Inventory.averages(pid).sell`
  is always `rawSellOf(pid)`, not an average.
- `Inventory.averages(pid)`'s zero-stock fallback used to read only the product's own `p.buy` (which nothing
  writes any more, since `revalue` is gone) — a product that sold all the way out would show cost "—"
  forever. It now tries `Inventory.lastKnownCost(pid)` first: the `unitCostP` of the most recent
  `PURCHASE_IN`/`MILL_RECEIPT_IN`/Add-stock movement for that product, in any warehouse, regardless of
  current qty. (A stock movement record never carried `extraCostP`, only `unitCostP` — the extra side of
  this fallback still falls to `p.extraP`, as it always did.)
- `Prices.revalue` (three editable boxes, one combined write) is replaced by `Prices.setSell` (one input,
  one field, checks the floor itself as well as the panel doing it synchronously). The approval queue
  (`Prices.request`/`approve`) is unchanged plumbing, but `Prices.approve` now **re-checks the floor at
  approval time**, not only at request time — a dearer purchase can land while a salesperson's request sits
  waiting for the owner, and approving it anyway would have slipped a below-cost price past the rule.
- Purchases/Add-stock's `B.save` (`05-ui-builder.js`) no longer runs `ERP.Validate.perProductPricing`
  (deleted — its whole job was the below-cost check that used to live on these screens). After a successful
  save it instead **warns** (`say()`, never blocks) when the receipt just pushed a product's average cost
  above its already-set selling price: *"Note: N product(s) now cost more than their selling price — set a
  new one on the Prices screen."*
- The Workbench "Change many prices" bulk tool (`23-workbench.js`) still allows bulk-editing 'buy'/'extra' —
  unlike the old Prices-screen `revalue`, `Prices.set`'s handling of those fields was **already safe**: 'buy'
  only ever sets the product's own fallback field (never a priced warehouse row), and 'extra' **pins** any
  row that already has its own blended `avgExtraP`, only touching rows still following the product's raw
  figure. A bulk 'sell' change gained the same hard floor the single-product screen enforces.
- Sale line: `05-ui-builder.js`'s rate cell now shows "No selling price set — set it on the Prices screen" in
  red (reusing the existing `.bad` colour class) when the product has none — Save already refused a
  zero-rate line (`Validate.invoice`'s pre-existing `rate === 0` check), this just makes the reason visible.

### Not done

- The general "product master data" editor (`18-master-data.js` PANELS.editproduct, "Default selling price"
  box) still writes `p.sell` through `Master.update` with **no floor check** — a pre-existing gap (predates
  §26/§27), left alone; in practice it only matters for a product that has never gone through
  `Prices.setSell` (`p.sellP` unset), since `rawSellOf` prefers `p.sellP` once it exists.
- No schema change — app-only, `deploy-erp.sh`.
- New test file `test-price-lock.mjs`; `test-add-stock-pricing.mjs`, `test-purchase-cost.mjs`,
  `test-extra-cost.mjs`, `test-extra-cost-profit.mjs`, `test-return-guards.mjs`, `test-ui-kit.mjs` updated to
  match (their `data-f="buy"`/`data-f="extra"` checks, `Prices.revalue` calls and the old "warn twice" panel
  flow no longer apply).
- Not seen live yet.

## §28 — extra cost off Purchases/Add-stock entirely, a pinned chosen purchase price, a free sale rate (2026-09-29)

### Why

The client, wanting the whole flow simpler still:

> "At purchases receiveStock receipt no need to ask for extra costs for any product added, just purchase
> price… remove extra prices of the products in charges&prices section. Next same in inventory addStock…
> no need for extra cost in any product. Now let's talk about inventory editProduct particular product
> pricessButton section — here only write average of all the purchase prices of the product bags available
> in the stock just [as a] label, then the user will decide the new purchase price — change average purchase
> price value to a label, and add an input for the user to add purchase price, by default add average value
> in there, but when user changes the new value will always be there even when new products are added…
> extra cost of the product will be decided [here]… no need of selling price here — remove input from here,
> the selling price will be decided in sales & invoice while selling… while selling you just have to label
> the purchase price set there along with the extraCost — by default extra cost will be zero and
> purchasePrice will be average, but when user changes it then the new will always be there even when new
> products are added… here the selling price can be lower than the purchase price, it is ok, no need to
> restrict the user — user can sell in a loss — remove all restrictions."

### The model now

- **Extra cost** is a single per-product figure (`p.extraP`, read through `Inventory.rawExtraOf`/`extraFor`) —
  typed on the Prices screen only, default 0. The 2026-09-26 design this superseded had each stock ROW carry
  its own moving-average `avgExtraP`, pinned bag-by-bag as new stock arrived at a different figure (item 13
  of CLAUDE.md). That machinery (`Inventory.apply`'s `EXTRA_FRESH_IN`/`EXTRA_UNDO_OUT` blending, `rowExtraP`)
  is left in place — untouched — for movement-history bookkeeping (a stock-receipt edit or reversal still
  needs to know what a specific lot came in at), but `extraFor` no longer reads it for costing a sale: a
  changed extra now reaches every bag immediately, not just new stock.
- **The purchase price a sale is costed at** is `Inventory.saleBuyOf(pid, wid)`: `p.costOverrideP` if one has
  been chosen on the Prices screen, else the live bag-weighted average of the stock on hand
  (`Inventory.averages(pid).cost`, unchanged machinery — still real purchase/receipt document prices blended
  by quantity). Choosing a figure on the Prices screen PINS it — a later purchase or receipt at a different
  price moves the live average but never the chosen figure, until it is changed again on the Prices screen or
  cleared back to "follow the average" (`Prices.setCost(pid, {}, {clearOverride:true})`, the panel's
  "Use the average" button).
- **There is no product-level selling price stored anywhere any more.** `Inventory.rawSellOf`/`sellOf` are
  thin functions that always return 0 (kept so nothing that still calls them crashes). `Prices.setSell` is
  gone. The rate a NEW sale line pre-fills with is `Inventory.lastSoldP(pid)` — the rate this product last
  actually sold at on a live invoice — and the box is fully **editable**, no floor, no restriction: a rate
  below the cost label underneath saves exactly like any other rate.

### Where each figure is typed

- **Purchases → Receive stock** and **Inventory → Add stock**: only the purchase price, on the line. The
  "Charges & prices" card is gone from both screens — Add stock is just "Notes"; Purchases keeps its old
  "kept exactly as it was" banner for pre-§26 purchases plus Payment (amount paid / method / reference).
  `perProductPricingBlock`, `buyOf`, `prodPriceHeadHtml`, `refreshProdPriceLine` (05-ui-builder.js) and the
  `data-fcprod` input handler (06-wiring.js) are deleted; `B.draft.perProduct` is kept as an always-empty
  object so an old saved draft with the field does not break.
- **The product Prices screen** (`21-settings.js` `PANELS.prices`, `ERP.Prices.setCost`): a read-only label
  "Average purchase price (stock on hand)", then two editable boxes — Purchase price (defaults to that
  average) and Extra cost per bag (defaults to 0/whatever is already saved) — and the worked sum (purchase +
  extra = total cost per bag, no selling price / profit / "try N bags" any more). `Prices.setCost` writes
  `p.costOverrideP`/`p.extraP` with the same history-row + approval-queue plumbing `Prices.set` uses;
  `Prices.approve` routes a request whose changes include `costOverride`/`extra` through `setCost` instead of
  the generic engine. No floor of any kind, on the panel, the service, the approval queue or the Workbench
  bulk-price tool (`23-workbench.js` — the old `sell` floor is removed from `bulkPrice`/`previewBulkPrice`).
- **Sales & Invoices → New invoice**: the line's rate is editable, pre-filled from `Inventory.lastSoldP`
  (blank for a never-sold product — Save still refuses a literal 0 rate, a typo guard, not a price rule). The
  purchase price + extra cost are shown underneath as a plain informational label
  (`Inventory.saleBuyOf`/`extraFor`), never read-only, never blocking. The Edit button still opens the
  product's Prices screen as a side panel to change the chosen cost — it does not touch the sale draft just
  by opening.

### Stock value is deliberately unaffected

The client's decision (asked and confirmed while planning this): the chosen purchase price only drives what a
SALE is costed at (`saleCostOf`, invoice `costBuySnapshot`). Stock value (`37-stock-value.js`) keeps reading
`Inventory.costOf`/`carriedCost` — the real recorded/carried document cost — never `p.costOverrideP`.

### Not done

- The removed `allowSaleBelowCost` setting (Settings → Sales & profit → "Selling below cost") was already
  dead — nothing ever enforced it — and is gone from the screen; the underlying settings key is left in place,
  unread, rather than risk a migration.
- No schema change — app-only, `deploy-erp.sh`.
- New/updated tests: `test-price-lock.mjs` rewritten for §28; `test-extra-cost.mjs`, `test-extra-cost-average.mjs`
  (rewritten — its whole premise, row-pinned extra, is superseded), `test-extra-cost-profit.mjs`,
  `test-purchase-cost.mjs`, `test-add-stock-pricing.mjs`, `test-price-screen.mjs`, `test-ui-kit.mjs` updated to
  match (no more `data-fcprod`, `Prices.setSell`, read-only sale rate, or below-cost floor).
- Not seen live yet.

## §29 — Carriage / transport on the purchase = the product's Extra cost (2026-10-02)

### Why

Client: *"we need a separate option in the purchase invoice, Carriage/transport input"*, then, after the first
build: *"extra cost means Carriage/transport only — one input for this"* (their sum: purchase 6,000 + extra 200 =
6,200; sell 5 × 6,300 = 31,500; profit 500). So there is **one** figure, not two.

### The model

- **Purchases → Receive stock** has a **Carriage / transport** box for the whole purchase (`draft.carriage`,
  `purchases.carriageAmount`). It is shared **equally per ordered bag** (`purchaseItems.carriageUnitP` =
  carriage ÷ total bags, fixed on the line so a part/later delivery carries the same figure). It raises the cost
  of the bags only — **not** in `grandTotal`, **no** payment voucher, the supplier's balance is unchanged.
- The stock row blends it as its own bag-weighted average, `inventory.avgCarriageP` (`Inventory.apply`; bags that
  come in with no carriage — Add stock, opening stock, mill receipts, the warehouse app — blend in at **0**;
  transfer / brand conversion carry the source row's figure; a purchase edit/reversal takes bags out at the
  figure they came in with, and an Add-stock receipt edit / mill reversal take theirs out at 0).
- **Extra cost == carriage.** `Inventory.effectiveExtra(pid)` = the figure pinned on the Prices screen
  (`p.carriageOverrideP`; 0 is a valid pin; a product that already had an Extra cost saved counts as pinned at it)
  else the live carriage average of the stock on hand. `extraFor`/`saleCarriageOf` both return it;
  `saleCostOf` = chosen purchase price + effective extra. The invoice snapshot stays `costBuySnapshot` +
  `costExtraSnapshot` (= the carriage); there is no separate carriage snapshot.
- **Prices screen**: read-only "Average extra cost — carriage / transport", the Purchase price box, and ONE
  **Extra cost per bag (carriage / transport)** box (defaults to the average, pins once changed, "Use the
  average extra cost" un-pins via `Prices.setCost(pid, {}, {clearExtraOverride:true})`, which also zeroes any
  older saved `extraP`). `Prices.setCost` writes `carriageOverrideP` + mirrors `extraP`.
- **Stock value now includes the carriage** (`37-stock-value.js`: row cost = purchase cost + `avgCarriageP`;
  `StockValue.costOf` — used by brand conversion — stays the pure purchase cost so carriage isn't carried twice).
  This reverses §28's "stock value never carries the extra" for the carriage average only; a *pinned* figure
  still drives sale profit only.

### Traps

- A new input on the purchase screen must also be in the `input` allowlist in `06-wiring.js` (item 26's trap).
- Any NEW code that adds bags must pass `carriageCostP` (or be a fresh-cost kind) through `Inventory.apply`.
- Carriage typed here AND the same transport under Expenses / Landed costs counts twice in "After expenses".
- No schema change (new fields live in the JSON `doc`) → `deploy-erp.sh` only. Tests: `test-carriage.mjs`.
