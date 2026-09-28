# Farooq & Co Traders — Project Reference

Auto-loaded every session. Keep this file to **rules, current state and actions**. Feature history, per-feature
design notes, test counts and old deploy logs live in `docs/CLAUDE_HISTORY_2026-09-21.md` (the full previous
version of this file) and in the docs listed at the bottom. **Keep this file under 150k chars — target < 30k.
When you finish a task, add at most 2–3 lines here (only a rule, a trap or a pending decision); put the story in `docs/`.**

## What this is

Two live sites on ONE Hostinger account (owner: theumairzero7@gmail.com, GitHub `talhaazhar-ta`):

- `farooqandcotraders.online` → `public_html/index.html` (homepage, single file).
- `erp.farooqandcotraders.online` → `public_html/ERP/` — the ERP. Sign-in is mandatory; business data (incl. the
  Warehouse tile) lives on the company MySQL database since 2026-09-20/21 (`docs/SERVER_DATA.md` = the guide).
  Each browser's old IndexedDB copy is frozen and unused.

**A separate rebuild is being planned/built in parallel at `D:\farooq-erp-next` (new repo `talhaazhar-ta/farooq-erp-next`,
not deployed).** Whenever you change anything under `public_html/ERP/`, append one line to
`D:\farooq-erp-next\docs\PARITY.md` (commit hash + what changed + affected module) and commit+push that file alone in
that repo. It never affects this project's build/deploy/rules.

Server layout: `/home/u943531942/domains/farooqandcotraders.online/public_html/` (homepage) and `.../public_html/ERP/`
(ERP doc root — there is no separate filesystem for `erp.*`). `ERP/_app/` holds the three served app files
(`index.html`, `farooq-co-erp.html`, `farooq-erp-data.js`); the public URLs are rewritten to `api/gate.php`.
`ERP/app/` on the server is an orphaned legacy duplicate (denied by its own `.htaccess`, nothing serves it; deploy no longer uploads to it or backs it up — the repo's `app/` is the build input and stays).
`private/erp-config.php` is at `domains/farooqandcotraders.online/private/` (NOT under `public_html`).
DNS: `@` and `erp` are ALIAS records to Hostinger's CDN. Read `public_html/ERP/README.md` and
`public_html/ERP/database/SCHEMA.md` for how the ERP itself is built (numbered modules injected into one HTML file).

## Hard rules (follow exactly)

1. **Scope.** Every action stays on `farooqandcotraders.online` + its `ERP` subdomain. The account hosts ~20 unrelated
   domains — never touch them. Double-check every SSH/SCP path (both sites share one filesystem).
2. **Confirm with the user first** before: DNS changes, deleting anything on the server not created this session,
   anything outside the two domains, or anything hard to reverse.
3. **Git: no branches, no PRs.** Work on `main`, commit, push to `origin main`. Nothing left uncommitted/unpushed/on a side
   branch at the end of a task. **No Claude attribution in commit messages** (GitHub identity is the user's own).
4. **Shared working tree.** Other Claude sessions or the user may have uncommitted edits. Run `git status` before
   `git add`; if files you didn't touch are listed, stage only your own (`git add <paths>`), never `git add -A`, and say
   what you left alone. `deploy-erp.sh` refuses to run with ANY uncommitted change → deploy from a clean clone:
   `git clone --no-hardlinks <repo> <tmp>`, copy `erp-upgrade/node_modules` in, run the script from the clone.
5. **Never edit live files over SSH/FTP as a way of making a change.** Edit locally → build/test → commit → push → deploy.
   The server is a deploy target, not a workspace.
6. **Production-changing commands** (`deploy-api.sh`, `deploy-erp.sh`, `gate-rollout.sh`, `data-backend.sh`, DB DDL) are often
   blocked by the permission layer. If blocked, hand the user the exact command with the `!` prefix at once; don't retry.
7. **Never copy secrets into the repo.** The `dbhub-facotraders-*` MCP DSN (global `~/.claude.json`) and
   `private/erp-config.php` hold passwords; `private/erp-config.sample.php` is the committed template.
8. **Schema changes:** a new/changed store needs its table applied to the live database AND `scripts/deploy-api.sh` run
   BEFORE `scripts/deploy-erp.sh`, or saves to it are refused ("NOT saved"). Regenerate with
   `scripts/gen-mariadb-schema.mjs` → `database/schema-mariadb.sql`. Never break existing data: use the app's migration
   path (`01-db.js`, `20-integrity.js`).
9. **A NEW runtime file the app needs** must be added to `.htaccess` + `api/gate.php`'s `GATE_FILES`, or it is public/unreachable.
10. **Test before you say it works.** jsdom has no layout/CSS — visual work needs real headless Chrome (memory note on CDP)
    or the user's signed-in Chrome. Say plainly what was NOT seen live.

## Access (project scope only)

- **SSH:** `ssh -p 65002 u943531942@31.97.219.57` (key auth). Prefer SSH/SCP over FTP.
  The host throttles rapid new SSH logins (a burst of ~18 `scp` connections was reset, then refused for minutes): never loop
  retries; pause a few minutes; for one changed file, upload just that file (`scp` → `.uploading`, `php -l`, atomic `mv`).
- **Hostinger MCP** (`mcp__hostinger-hosting__*` etc.) — authenticated. After every ERP deploy call
  `hosting_clearWebsiteCacheV1` for `erp.farooqandcotraders.online` (or clear in hPanel if the MCP is disconnected).
- **`gh`** authenticated as `talhaazhar-ta`. **DB MCP** `mcp__dbhub-facotraders-theumairzero7_gmail_com__execute_sql` (MariaDB 11.8).
- **Chrome extension = the user's own signed-in browser** — the only authoritative way to test the live ERP.

## Testing the live site — how to read results

- Unauthenticated `curl` to the ERP → **401 = healthy and gated**. Gzip-accepting `curl` gets **403 from the Hostinger CDN
  even on the original static site** — meaningless; use a real browser. The homepage answers `200`.
- **The edge drops ~1 in 3 TLS handshakes from the dev machine** (curl exit 35) — retry connection failures only, never an
  HTTP answer. A deploy that rolls back with `000`/`curl failed` in its probes = this, not the code (`deploy-api.sh` uses `pcurl`).
- **`503` from the ERP** = the gate cannot reach its database (fails closed). See "Connection cap" below.
- Git Bash on Windows: an argument shaped `key=/path` is rewritten to `key=C:/Program Files/Git/path` — percent-encode the
  slash (`%2F`); do NOT use `MSYS_NO_PATHCONV=1` (it breaks `/dev/null` for Windows curl → exit 23 under `set -e`). Any deploy
  script that uploads first must restore on ANY unexpected exit (EXIT trap). Heredocs with tricky quotes are unreliable —
  write a file with the editor tool and run it.

## MySQL / server data

- Business DB `u943531942_facotraders` (host `srv1774.hstgr.io:3306`; 46 tables, one per store: `doc` JSON + generated indexed
  columns). Auth DB `u943531942_erpauth` — accounts/sessions/audit only, **never business data**.
- **Switch:** `'data_backend' => 'server'` in the server's `private/erp-config.php`; `scripts/data-backend.sh status|on|off`
  (`off` = each browser keeps its own data again, instantly). The server is the only copy of the business data.
- Design rules: revision-checked atomic saves; "NOT saved — reload" on failure; per-browser keys stay local; never fall back to the
  browser copy. Full runbook: `docs/OPERATIONS.md` → "Server-side business data" and `docs/SERVER_DATA.md`.
- **Backups:** nightly verified backups (Hostinger cron `65drF1UNgJ`, 02:00 Pakistan → `~/backups/nightly/`, same account —
  keep an occasional off-site copy). Each deploy also backs up to `~/backups/erp-deploy-<ts>/` / `~/backups/api-<ts>/`.
- **Test data wiped 2026-09-25 (client wanted a clean start):** every transaction table, the audit log, the number counters, `supplier_products` and product P-139 "testing"
  were deleted; shops/products/suppliers/regions/warehouses/settings kept (cached `bal/tot/due/paid` zeroed). The pre-wipe snapshot is
  `~/backups/nightly/business-20260925-175016-v710-f893.json` (plus a copy in `D:\projectFarooqAndCoTraders-backups\`); it will be pruned from the server after 30 days.
- **Trap found by that wipe:** each browser's old `farooqco_erp_v1` localStorage copy fed the base screens (stock map, movement history, Documents/audit) and
  `mergeMasterFromDb` only merged, so deleted rows showed and got written BACK to the server. Since then server mode REPLACES those lists from the server
  (`02-services.js` mergeMasterFromDb/Mirror.refresh; `test-server-db.mjs` W1–W10). Deleting data server-side is only safe with that code deployed.
- Re-import (rare): `scripts/empty-business-db.php` then `scripts/import-backup.php` (refuses a non-empty DB).
- **Connection cap (outage 2026-09-21):** Hostinger allows 500 DB connections/hour per user; every request opens one. Open tabs poll:
  stale-window check `POLL_MS` = 90 s (`01b-server-db.js`), sign-in heartbeat `HEARTBEAT_MS` = 180 s (`31-auth.js`;
  `test-auth-client.mjs` H11b fails if under 2 min). Never shorten these. If it recurs it heals within the hour; diagnose with a
  `php -r` connect test; do NOT use `enforce-off`. Idea not done: persistent PDO connections in `_bootstrap.php`/`_data.php`.

## Authentication gate (live and ENFORCING since 2026-09-20)

- App files in `ERP/_app/` are served only via `api/gate.php` (signed out → 401 sign-in page; DB down or broken config → 503, never the app).
  Sign-in page is a real HTML form post to `api/auth/login.php` (303 back to a vetted local `next`; cross-site posts refused).
- **Kill-switch:** `'enforce_login' => true` in `private/erp-config.php` (only a real boolean `true` enforces). Flip with
  `scripts/gate-rollout.sh enforce-off` (emergency "let everyone back in") / `enforce-on`. Also `status|migrate|finalize|rollback`.
  Other config: `idle_ttl_min` = 0 (no idle sign-out; owner's request), `absolute_ttl_min` = 720 (12 h cap).
- **PHP is NOT shipped by `deploy-erp.sh`** — use `scripts/deploy-api.sh` (backs up, lints on the server, probes anonymously,
  self-restores on any failure; `rollback` argument undoes it). It uploads ~18 files with back-to-back `scp` — see SSH throttle above.
- Accounts: Admin → Company accounts (owner only manages staff; everyone has "My account" for their own password). Two server
  accounts exist: `owner` and `test` (Manager, never signed in). Everyone from the old PIN accounts is locked out until added.
- Roles are enforced in the browser; the server enforces sign-in, CSRF, revisions and an append-only audit log but NOT per-store role
  rules (`docs/SERVER_DATA.md` §6). `LANDED_COST_*` and `EXPENSE_MANAGE` stay OWNER-only (confirmed by the user).
- Known limits, deliberately not fixed: 5 wrong passwords lock an account 15 min from any IP (`owner` is guessable → a stranger can
  lock the owner out; `enforce-off` is the escape); the Warehouse page has no session watch (its next save says "sign in again");
  reloading a gated page with no signal fails; the Hostinger CDN must never cache authenticated responses (`Cache-Control: no-store`).

## How to build the ERP locally

`erp-upgrade/mod/`, `erp-upgrade/dist/` and 5 input files are gitignored on purpose (disposable build staging). Rebuild:

```bash
cd public_html/ERP/erp-upgrade
mkdir -p mod
cp [0-9]*.js mod/                                    # 00a-preboot.js .. 43-remember-page.js (incl. 01b, 39)
cp ../app/farooq-co-erp.html ../app/index.html \
   ../app/farooq-co-warehouse-pwa.html ../app/farooq-and-co-homepage.html \
   ../app/farooq-erp-data.js .
python3 build.py                                     # writes dist/
npm install jsdom fake-indexeddb --no-save           # once per machine
for f in test-*.mjs; do node "$f"; done              # each: "N passed, 0 failed"
```

- `build.py` strips the previous payload before re-injecting (marker comment), so feeding it the already-built `app/` files is correct.
- **Never `git mv` anything into `mod/`** (it force-tracks a gitignored dir). Plain `cp` only.
- **Run ONE test loop at a time.** Several loops at once made a 10-minute suite take over an hour. A test-gate flake
  (`test-ui-kit` "promise never settled" under load) is machine load — rerun on a quiet machine.
- `test-gate.mjs` skips itself (exit 0) without `php` (none on this machine; CI has it). Not covered by any test: `.htaccess` rewrites
  under real Apache/CDN, and the real MySQL API — those are verified live.
- CI (`.github/workflows/erp-build-test.yml`) builds and tests every push touching `erp-upgrade/` or `app/`. Red = don't deploy.

## Deploy flow

**Homepage** (single file): edit, commit, push, back up the live file (`cp index.html index.html.bak-$(date +%Y%m%d%H%M%S)` over
SSH), then `scp -P 65002 public_html/index.html u943531942@31.97.219.57:/home/u943531942/domains/farooqandcotraders.online/public_html/index.html`.

**ERP app** — `./scripts/deploy-erp.sh` (from the repo root or a clean clone):
1. refuses if the tree is dirty; 2. rebuilds; 3. runs every `test-*.mjs` (aborts on any failure — nothing broken is uploaded);
4. backs up live files to `~/backups/erp-deploy-<ts>/`; 5. uploads atomically (`*.uploading` → rename) to `ERP/_app/` only (why, and the guards against deploying to an unserved folder: `docs/OPERATIONS.md` → "Why deploys go to `_app/` only")
   (refuses if `_app/` is missing; takes a lock in `.git/deploy-erp.lock`); 6. curls the live URLs.
Then: **clear the Hostinger cache**, and verify `_app/*` md5s equal the build's `dist/`.
- Takes 10–15 min → run it **detached** (a wrapper started with `Start-Process`) so the tool's 10-min timeout can't kill it mid-upload;
  watch its log (`pgrep` can't see it from Git Bash). Never start a second run (the lock refuses it, correctly).
- **Usual way:** `scripts/deploy-erp-from-clean-clone.sh` (`--check` = read-only pre-flight) does the clean clone + `node_modules` copy + deploy + md5 check in one go; the detached `Start-Process`
  line is in its header. Trap: `-ArgumentList '-c','"cmd && cmd"'` needs the embedded double quotes or bash silently runs nothing. Windows `md5sum` prints `hash *file` — strip the `*` before comparing.
- The script's last "Verifying" curl can fail on a dropped handshake AFTER a good upload — check md5s before assuming a bad deploy.
- **Rollback (app):** copy the three files from the newest `~/backups/erp-deploy-<ts>/` back into `ERP/_app/`, clear cache.
  **Rollback (API):** `scripts/deploy-api.sh rollback`.
- A `503` in the final probe = DB unreachable (connection cap), not a bad upload.

**API (PHP under `public_html/ERP/api/`)** — `scripts/deploy-api.sh` (needs only `public_html/ERP/api` clean). New table first (rule 8).

## Rules that keep code changes safe (learned the hard way)

- **Stock cost (fixed 2026-09-22 — client: "when we add product in stock it gives 100% margin"):** `Inventory.apply`'s `avgCostP` still only moves on
  `PURCHASE_IN`/`MILL_RECEIPT_IN`; a cost typed on Add stock / opening stock / a transfer / brand conversion still lives on the movement only. But
  `Inventory.costOf` (used by Prices.of's margin, Cost.forSale, invoice `costSnapshot`) now falls back to `Inventory.carriedCost` — the same qty-weighted
  "carried" cost Stock value already computed for itself — before falling to the product's list price, so a brand-new product priced only through Add
  stock no longer costs 0 (false 100% margin) elsewhere. Don't touch `avgCostP` itself for those movement kinds — `test-stock-value.mjs` M5 relies on a
  purchase-kept average NOT being overridden by a later typed Add-stock cost. `costOf` also now prefers a warehouse's OWN
  carried cost over another warehouse's recorded average (else costing a sale in the Add-stock-only warehouse silently used
  a different warehouse's price) — but with no warehouse given (Prices panel) a recorded average still outranks a carried one.
- **Money screens never pre-select a party.** Shop / supplier / employee choice starts on a blank "— Choose … —" line and Save refuses
  without one (Receive payment, Pay a shop, Pay supplier, Change shop, Pay salary). Start payments via `data-fcpayopen` (clears stale
  `PAY_FOR`/`REFUND_FOR`/`WATARGET`; `WATARGET` is a lexical `let` in the base script — not reachable as `window.WATARGET`).
- **Correcting a paid-out voucher amount** (2026-09-23, client request; extended same day to Supplier payments): an "Edit amount"
  button (gated `TRANSACTION_CORRECT`, same as Change shop) on a Paid-to-shops or Supplier-payments voucher opens `PANELS.editpayamt`
  → `Payments.editAmount`, which corrects the figure in place (no cancel-and-redo). Refused for a reversed voucher, one with
  allocations (a supplier voucher tied to a purchase — "Paid with purchase …" — refuses this way), or the cash side of a customer
  return's REFUND treatment — that amount is duplicated onto `customerReturns.creditAmount` and the two must stay equal for the
  shop's ledger to net to zero; correct the return instead (not built; no supplier-side equivalent — `Returns.toSupplier` never
  writes a payment). Deliberately does not touch Receive-payment vouchers.
- **Names are written into pages unescaped** by the base `u()` helper and `data-row="…"` attributes — refuse `< > "` in any new name field.
- **Icons:** the base exposes `window.I` (and `window.P` via module 40), NOT `window.icon`. Modules 30/32 still read `window.icon`
  (Payroll "Excel" button and some Milling icons blank) — fix when touched.
- **Module 24 (`24-client-changes.js`) rewrites labels on every repaint** — changing a label in a panel alone won't stick; check its `LABELS` map.
- **`PAGES.payments` is replaced wholesale by module 38** (`38-payment-search.js`); `06-wiring.js`'s `paidToShopsSection` and its `PAGES.payments`
  wrapper are dead code. Keep hooks `data-fcpayopen`, `#fcPaidToShops`, `data-fcreceipt` there.
- **Test pitfall:** `document.body.textContent` includes inlined `<script>` source — assert on rendered text only (clone body, drop
  `script`/`style`; see `shownIn(win)` in `test-milling-atmill.mjs`). Older tests checking body text may pass falsely.
- **Never hard-delete a master record that the base app re-seeds** (areas/regions): a deleted area is a hidden marker
  `{deleted:true, active:false}` in the same record, or it reappears from any other device (`18-master-data.js`, `Areas.remove`).
- **Dates:** never build a date from `toISOString()` (UTC) — in Pakistan it says yesterday until 05:00. Use local date parts.
  (Other `toISOString()` date builders were not audited.)
- **UI kit (`36-ui-kit.js`):** the real control stays in the page; `data-fc-plain` opts a field out. `confirm/prompt/alert` are Promises.
  A test host that replaces `window.confirm` with a non-native function bypasses the dialog. A `panel.save()` must answer synchronously.
- **Theme:** use theme tokens; field fallback styles are `:where()` (zero specificity) so screen rules still win. Print documents keep
  fixed paper colours on purpose. **No emoji** in UI text (`test-shell.mjs` fails on one).
- **The whole logo is shown, never cropped/zoomed** (`object-fit:contain`, no transform); `test-shell.mjs` B15/F5 fail on a crop.
- **Long lists:** any `[data-row]` list > 48 is paged by module 42 via class `fc-lim` (never inline `display`, or CSV export would skip rows).
- **A reload stays on the screen** (module 43, per-tab `sessionStorage`); builders/panels/half-typed forms are not restored; permissions still apply.
- **Payroll:** staff pay goes through Payroll, never the Expenses screen (would count twice; `Profit.totals.salaries` feeds "After expenses").
  Gate `PAYROLL_MANAGE` (owner only unless granted). Reverse, never delete.
- **Milling / Stock at mills** (`32-milling.js`): jobs default `AT_MILL` on screen (stored job without `receiveMode` = `DELIVERED`). Arrivals move
  goods, not money. Concurrent-window safety uses `meta` guard rows (`millguard:<millId>`, `salguard:<employeeId>`). Goods at mills are shown
  BESIDE the stock value, never inside it. Story/forms: `docs/MILLING_WORKFLOW.md`.
- **Purchase edit** (`Purchases.save` edit branch): money is only ever added (no lowering "Paid"); line ids are stable; stock guard is on the
  NET change. There is still no cancel/delete of a purchase, and no "Change supplier" action.
- **Stock receipt edit** (Inventory → Stock receipts → Edit, 2026-09-25, `StockDocs.editReceive`, `docs/STOCK_RECEIPT_EDIT.md`): old lines reversed as
  `RECEIPT_EDIT_OUT` at their OLD cost (`carriedCost`/Stock value subtract it, so a corrected cost replaces the old one), new lines re-posted, same RCV number,
  guard on the NET change. The movement report's "adjusted" is now a signed net (it used to raise closing on an Adjust OUT). No DB change → `deploy-erp.sh` only.
- **Change shop** (`Invoices.changeCustomer`) moves the shop and nothing else; posted invoices can't change shop through `save`. Needs `TRANSACTION_CORRECT`.
- **Stock value** (`37-stock-value.js`) needs `FINANCIAL_REPORT_VIEW`; reads cost from the movement, not just the row average.
- **Warehouse app** (`app/farooq-co-warehouse-pwa.html` + `39-warehouse-server.js`): a warehouse receipt adds bags — if the office also enters the supplier
  bill with bags received they are counted twice; enter the bill with **Received = 0**. `test-warehouse-server.mjs` is the drift guard vs the office `StockDocs`.
- **Brand conversion** (Inventory → Convert Brand; stock doc type `CONVERT`, `CNV-…`; `docs/BRAND_CONVERSION.md`): bags out of one product, same bags into another, one atomic save, 1:1, source's Stock-value cost
  blended into the target's average (`Inventory.apply` `CONVERT_IN`; list-price estimates are not passed on). No DB change (free-text `type`/`kind`) → `deploy-erp.sh` only. Raising/lowering stock already exists as **Adjust**; not built: editing a posted receipt.
- **Sidebar collapse** (`10-mobile.js`): 901–1200 px expands/collapses the rail via `body.fc-wide`; >1200 px is base behaviour; ≤900 px hidden.
- **Top bar** owns `#fcUserChip`, `#fcDbChip`, `#fcCompanyLink`, `#fcSignOutLink`: **never wrap the text of the Company/Sign-out links in child
  elements** (module 31 recognises the click by `e.target.id`).
- **Invoice search** (33) and **Payment search** (38) share `ERP.InvoiceSearch.util`; numeric dates are day-first. Receipt numbers are deliberately
  not in the invoice list's "Everything" scope (tail collisions with invoice numbers).
- **Only ONE draft invoice can exist** (unique `invoiceNumber` index, drafts save with `''`) — pre-existing bug, not fixed.

## Open items — decisions/actions still pending

1. **Opening balances** — legacy Total Sales/Collection/Balance are reference-only; needs a cutover date from the user.
2. 68 route-corridor shops flagged `region_assumed` need a definite region.
3. Five blank catalogue rows (101, 103, 108, 111, 132), 11 zero-value products, 2 duplicate-name groups — waiting on the user.
4. Suppliers 204/494/575/614 — account type to confirm; 575 is switched off.
5. SMS/WhatsApp are configured but not connected to a provider.
6. **Milling — decided 2026-09-21 (recommended answers, kept until the client says otherwise):** wheat comes from our own books (record the wheat
   purchase first, then the job); goods at the mills are shown beside stock value; arrivals recorded by `PURCHASE_CREATE` roles; job carries the agreed
   rates; one job per handover; 1–8 % loss band is a warning only. Recommended next, not built: dated running in/out/balance statement per mill.
7. `PAYMENT_CREATE` (Sales role has it) doesn't gate the Pay-a-shop / Pay-supplier panels — anyone can record cash paid OUT; gate `Payments.refund` if wanted.
8. Settings has lost its **Warehouses card** (same root cause as the old Regions card; handlers `data-whedit/whdel/whadd` still exist). Not asked for.
9. Payroll: ask the client whether they want "pay everyone for the month" in one go. Not built: tax, attendance, overtime, instalment loans, payslips by message.
10. **Owner to do:** a signed-OUT sign-in test in a private window with a real password; add real staff under Company accounts (switch off/delete `test`);
    decide on the lockout-DoS limit; keep an off-site backup copy occasionally; check Hostinger hPanel → Backups is enabled (no MCP tool shows it).
11. Not done by design/for later: undo for an area delete; bulk "move all shops"; notification "mark all read"; Documents/Audit lists paged;
    persistent PDO connections; base `<title>` still says "Warehouse ERP".
12. The business-logic of the ERP modules has not had a dedicated audit — scope it separately if the user wants one.
13. **Extra cost per bag now feeds sale-time profit** (2026-09-25, client: "purchase 3000 + extra 200 = 3200, profit still showed 200 more"): `Inventory.saleCostOf` = `costOf` + product
    `extraP` → invoice `costSnapshot`, `Cost.forSale`, live invoice note. Stock value / `avgCostP` never carry it; skipped under `profitCostBasis:'PURCHASE'`; old invoices keep their
    snapshot. Trap: a purchase with freight also entered on the Landed costs screen counts that transport twice — tell the owner to use one or the other. `docs/EXTRA_COST_PROFIT.md`.
    **Since 2026-09-26 the extra is an AVERAGE carried by the stock** (client: "bags already in stock keep the old extra"): each `inventory` row has `avgExtraP`, blended in by bags on hand when
    NEW bags arrive (purchase, Add stock, opening, mill receipt); `saleCostOf` uses the row's figure, not the product's current one. `Prices.set` pins old rows when the extra changes; the first extra
    typed on a product with none covers stock already held. Purchase/receipt lines keep `extraUnitP` so edits don't re-price. Trap: any NEW code that adds bags must pass through `Inventory.apply`
    (or copy the blend, as `39-warehouse-server.js` does). App-only deploy, no schema change; not yet seen live.

14. **Product prices screen** (2026-09-26, client saw profit 1500 not 500 — the extra cost was never saved; `docs/PRICE_SCREEN.md`): reason is now optional; the screen opens with saved values
    (+ last sold rate), shows purchase + extra = cost / profit and a "try N bags" line. **Trap:** a base-app `panel.save()` that returns an object CLOSES the panel and says "Saving…" — refuse every
    bad input by returning a STRING there, never later in a promise (it looked like a finished save). **Add stock's Cost box used to open with the product's SELLING price** (`lastRate` in 05-ui-builder.js) — the
    client kept it → stock cost 6300 → a sale at 6300 showed a loss; now it offers the saved purchase price. Test data wiped a 2nd time 2026-09-26 (transaction tables + 2 return tables, masters kept; copy in
    `D:\projectFarooqAndCoTraders-backups\test-entries-before-wipe-20260926.json`; the wipe needs the DB MCP allow-rule — the auto-mode classifier blocks bulk DELETEs otherwise).
    Returns (same day): receiving-warehouse box defaults to the invoice's; return quantity checked inside the panel; an invoice with a live return can NOT be edited (edit recreates lines under new ids and
    orphans the return); a REFUND can only return money actually paid on that invoice (`Returns.refundLimitError`; before, an unpaid invoice refunded cash never received). A double-pressed "Post return" showed 10 bags instead of 5 until reload (2nd save refused by the server but already applied to the page's memory) → `RETURN_IN_FLIGHT`. **Explanations live behind a small round "i"** (`ERP.info.pair(html, label)` in 21-settings.js → `{btn, box}`; box = `.fc-info`, shown by `.on`; the glyph is CSS `::before` so label text stays clean; warnings and live numbers stay visible). **Trap:** `.banner b` is `display:block` — give a banner sentence that contains bold words `<p class="pz-inline">` or it breaks into lines (seen only in a real-Chrome screenshot, not jsdom). Purchase screen: charges are WHOLE-purchase totals shared over the bags (200 ÷ 5 = 40/bag); the OVERALL discount used to lower the bill but not the bag cost — `Cost.allocate(lines, charges, overallDiscount)` now spreads it by value; the screen explains every box and shows "each bag costs …" live (`#fcbCpb`), the prices screen includes the purchase's per-bag charges in its cost (`chargeP`). Owner-facing guide: `docs/PURCHASE_GUIDE_FOR_THE_OWNER.md`. Invoice row **Pay back N** button (`Invoices.refundDue`, `PANELS.payback`, voucher carries `refundOfInvoiceId`) hands back what a shop paid before returning goods — capped at what is owed. `Invoices.outstanding` is clamped ≥ 0 (a returned+refunded invoice showed −3,200; the shop's credit lives on `Ledger.customer`), and dashboard Receivables sums only positive balances. Charges typed on a purchase AND a product Extra cost = the same transport twice → `Purchases.doubleCostWarning` (confirmable) + a breakdown banner on the prices screen. **Trap:** the base app's
    `TODAY_ISO` is frozen at '2026-09-06' (dashboard "Today" tiles use `FC_TODAY`; list filters / `PERIODS` / CSV names use `realToday()`; never use `TODAY_ISO` for anything live). `savePanel` ignores a click once the panel has closed (a quick double click used to save twice). Dashboard/report profit is now after returns. ~20 other panels still refuse only after closing (list in `docs/PRICE_SCREEN.md`). 2nd wipe done later the same day (prices kept); nothing pending in the DB.
    **Old note (cleared by the 2nd wipe):** stray rows from the client's newer test — an inventory row `PRD-0002|undefined`, INV-2026-000001 (cost 6,500 from the 6300 slip), RCV-2026-000001 (cost 6300) and audit row "Document viewed INV-2026-000003".

## Not yet seen by a person on the live site / a physical phone

The whole recent UI batch: Payments screen + Pay-a-shop/Pay-supplier panels, Payroll, Milling / Stock at mills / "Lying at mills" card, Edit purchase (no real
purchase edited yet — try a harmless note edit first), themed dropdowns/calendar/dialogs, sidebar collapse at ~1100 px, the bell panel, reload-keeps-screen,
themed Landed-cost boxes, the Warehouse tile's receive/dispatch (no live write was made on purpose), Edit stock receipt, Firefox / iOS Safari / Android,
the 2026-09-28 simplified Purchases/Add-stock/Prices screens and read-only sale line (item 27, `docs/AVG_PRICING.md`).
Tell the user when a change belongs to this list.

## Where to look for more detail

- **`docs/CLAUDE_HISTORY_2026-09-21.md` — the full previous CLAUDE.md: every feature's design notes, edge cases, test counts and deploy logs. Grep it before re-deriving anything.**
- `docs/SERVER_DATA.md` — the current guide to the server-side data system (start here for anything about where data lives).
- `docs/OPERATIONS.md` — access inventory, exact commands, deploy checklist, Phase 3 rollout.
- `docs/MILLING_WORKFLOW.md` — how Milling and Stock at mills work in real life.
- `docs/MYSQL_MIGRATION_PLAN.md` — design record of the IndexedDB → MySQL migration.
- `scripts/deploy-erp.sh`, `scripts/deploy-api.sh`, `scripts/gate-rollout.sh`, `scripts/data-backend.sh` — the operational scripts.
- `public_html/ERP/README.md`, `public_html/ERP/database/SCHEMA.md`, `public_html/ERP/docs/FINAL_ERP_REPORT.md` — the ERP itself.
25. **Sales Invoice Price Lock** (2026-09-27): Sales invoice prices (rate, discount, extra charges) are strictly read-only at the POS. To change a selling price or cost, the user must edit the source Purchase. Editing a Purchase from a Sale warns before dropping the unsaved Sale draft to prevent data loss.
26. **2026-09-28 review of the above (built by another model while Claude's limit was hit):** the sale-screen "edit the purchase" pencil rendered with no click handler anywhere; Add stock's new "Extra charges / bag" and "Selling price / bag" boxes were not even in the `input`-event allowlist (06-wiring.js) so typing in them never reached the draft; `costPerBagHtml` was declared twice — the surviving copy blended every product on a purchase into one average, wrong the moment a purchase has more than one priced product; and a full second, dead-code copy of the whole Builder UI (chargesBlock/lineRows/B.save/the click handler) had been hand-written into `app/farooq-co-erp.html` itself, which `05-ui-builder.js` silently overwrites at boot — never touch that file directly, all Builder UI work belongs in the numbered modules. All fixed and covered by `test-add-stock-pricing.mjs` (new) plus the existing suite. Add stock's extra-per-bag now warns before double-counting against a product's own "Extra cost per bag", same as `Purchases.doubleCostWarning`.
27. **Purchase/Add-stock/Prices simplified 2026-09-28** (client: only two ways to add a product — Purchases and Add stock; superseded item 164's "avgCostP only moves on PURCHASE_IN/MILL_RECEIPT_IN" — Add stock now blends it too, see `docs/AVG_PRICING.md`): both screens dropped Overall discount/Delivery/Loading/Other charges and the line Discount box (old purchases keep their saved values, shown read-only); "Rate"→"Purchase price"; Extra cost/Selling price are typed ONCE PER PRODUCT below the items table and blend straight into `Inventory.apply`'s new `avgCostP`(Add stock too)/`avgExtraP`/`avgSellP` moving averages — never folded into the line's cost. `Inventory.averages(pid)` is the bag-weighted {cost,extra,sell} the simplified Prices screen (3 boxes + a purchases/receipts list with Edit links, `Prices.revalue`) and a read-only sale line (Edit button → opens Prices as a side panel, sale draft untouched) both read; sale rate = `Inventory.sellOf`, re-read on warehouse change. `17-profit.js`'s wrapped `Purchases.save` no longer recomputes `avgCostP` from ALL purchase history (ignored Add stock/consumption) — it nudges by the charge delta only, since new purchases have none. An invoice edit now keeps a kept line's ORIGINAL cost snapshot (`costBuySnapshot`/`costExtraSnapshot`) instead of re-costing at today's average. Not done: auto-syncing a purchase/receipt's typed figures back onto the product's own buy/extra/sell (only the Prices screen does that); `26-landed-cost.js`'s own `weightedAverage` recompute (a different, pre-existing feature) untouched.
