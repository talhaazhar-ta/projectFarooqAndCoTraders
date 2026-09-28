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
