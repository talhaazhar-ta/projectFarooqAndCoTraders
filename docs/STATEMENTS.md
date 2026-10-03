# Statements (2026-10-03)

One statement, `ERP.Statement` (in `public_html/ERP/erp-upgrade/16-khata.js`), now sits behind every place a
customer or supplier statement appears: the shop account page (khata), Finance → Statement of Account, the
"Statement" panels, the printed / PDF / Word sheet, WhatsApp text and both Excel files.

## Rules

- **The period decides opening and closing, nothing else.** `Statement.build(type, id, {from, to})` takes the figures
  from `ERP.Ledger.customer/supplier(id, from, to)`. A stored OPENING line is part of the Opening figure, so
  `opening + debit − credit = closing` always.
- **Type / method / search are view filters.** `Statement.view()` only chooses which lines are listed; a balance is
  never recomputed from them. The page says "Showing N of M" and its totals row covers only the lines shown.
- **Paper and Excel always cover the whole period** (the screen filters are not applied; a message says so).
- **Printed statements never read the khata page's state** (they used to take sort order and period label from it).
  Always oldest first, with a "Balance brought forward" line when a From date is set.
- **Balances say Dr / Cr** (shop: Dr = owes us; supplier: Cr = we owe). Not colour alone.
- **Same-day order** is total: `Ledger.rowOrder` = date, entry time, reference, id. Refund, supplier-payment and
  supplier-return rows now carry `createdAt`.
- Ledger wrappers (adjustments in 16, milling in 32) copy every row field (`Object.assign`) instead of picking some.

## Screens

- The Statement of Account screen never pre-selects a party ("— Choose a shop —"); pages 50 rows at a time;
  lists inactive suppliers that still have history (marked "(inactive)").
- Phone (≤760 px): each entry is a card (date + type, words, then Debit / Credit / Balance on one line); the totals
  row becomes a block under the list.

## Traps

- Existing tests rely on the heading text in `table.kh-table thead th` (module 25 rewrites them) and on `Current balance`
  on the khata card for "All time".
- The paper CSS for statements is scoped by `.fc-stmt` so invoices are untouched.
- Not changed (they would move balances; ask first): the supplier ledger counts DRAFT purchases and ignores money a
  supplier pays back (`direction:'IN'`).
- Not in this pass: payroll salary statement, Reports module's own statement sheets, per-mill goods statement.
- Not seen live: real-Chrome rendering and print of the new layout (jsdom has no layout).

Tests: `test-statements.mjs` (new), plus updated `test-statement-of-account.mjs` (S9/S11: +1 for the placeholder line).
