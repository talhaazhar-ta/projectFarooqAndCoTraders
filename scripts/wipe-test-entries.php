<?php
/**
 * wipe-test-entries.php — clear every transaction/test entry, KEEP shops, products (and their prices), suppliers,
 * regions, warehouses, settings, accounts. Zeroes the cached shop/supplier balances. Optionally removes named test shops.
 *
 *   php wipe-test-entries.php [--delete-shop=CUST-0411 ...]            DRY RUN: prints what it would do, changes nothing
 *   php wipe-test-entries.php --yes [--delete-shop=CUST-0411 ...]      really do it (ONE transaction; all-or-nothing)
 *
 * Take a backup first:  php backup-business-db.php   (this script refuses --yes unless a backup < 15 min old exists).
 * CLI only. Never prints the DB password.
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$yes = false; $shops = [];
foreach (array_slice($argv, 1) as $a) {
    if ($a === '--yes') $yes = true;
    elseif (strpos($a, '--delete-shop=') === 0) $shops[] = substr($a, 14);
    else { fwrite(STDERR, "unknown option $a\n"); exit(2); }
}
$cfg = require '/home/u943531942/domains/farooqandcotraders.online/private/erp-config.php';
$b = $cfg['biz_db'];
$pdo = new PDO(sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $b['host'], $b['port'], $b['name']),
    $b['user'], $b['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);

$wipe = ['audit_log','cost_history','price_history','price_approvals','invoices','invoice_items','inventory','stock_movements',
    'payments','payment_allocations','purchases','purchase_items','stock_docs','stock_doc_items','supplier_products',
    'customer_returns','customer_return_items','supplier_returns','supplier_return_items','orders','order_items',
    'account_adjustments','expenses','documents','document_edits','landed_costs','landed_cost_expenses','inventory_cost_adjust',
    'salary_payments','milling_jobs','milling_job_items','milling_arrivals','operations','sync_queue','sequences'];

if ($yes) {
    $fresh = false;
    foreach (glob('/home/u943531942/backups/nightly/business-*.json') ?: [] as $f) if (time() - filemtime($f) < 900) $fresh = true;
    if (!$fresh) { fwrite(STDERR, "No backup newer than 15 min in ~/backups/nightly — run backup-business-db.php first. Nothing changed.\n"); exit(1); }
}
echo ($yes ? "LIVE RUN" : "DRY RUN") . " on " . $b['name'] . "\n";
foreach ($wipe as $t) { $n = (int)$pdo->query("SELECT COUNT(*) FROM `$t`")->fetchColumn(); if ($n) echo sprintf("  delete %-24s %5d rows\n", $t, $n); }
foreach ($shops as $s) {
    $row = $pdo->prepare("SELECT JSON_VALUE(doc,'$.sh') FROM customers WHERE pk=?"); $row->execute([$s]);
    $name = $row->fetchColumn();
    echo "  delete shop $s = " . ($name === false ? '(NOT FOUND)' : json_encode($name)) . "\n";
    if ($name === false) { fwrite(STDERR, "shop $s not found — stopping.\n"); exit(1); }
}
echo "  zero cached bal/tot/due/paid on customers (" . (int)$pdo->query("SELECT COUNT(*) FROM customers")->fetchColumn() . ") and suppliers (" . (int)$pdo->query("SELECT COUNT(*) FROM suppliers")->fetchColumn() . ")\n";
if (!$yes) { echo "Dry run only — nothing changed.\n"; exit(0); }

$pdo->exec('SET SESSION innodb_lock_wait_timeout = 30');
$pdo->beginTransaction();
try {
    foreach ($wipe as $t) $pdo->exec("DELETE FROM `$t`");
    foreach ($shops as $s) { $d = $pdo->prepare('DELETE FROM customers WHERE pk=?'); $d->execute([$s]); }
    foreach (['customers','suppliers'] as $t)   // JSON_REPLACE only touches keys that already exist
        $pdo->exec("UPDATE `$t` SET doc = JSON_REPLACE(doc,'$.bal',0,'$.tot',0,'$.due',0,'$.paid',0), rev = rev + 1");
    $left = 0; foreach ($wipe as $t) $left += (int)$pdo->query("SELECT COUNT(*) FROM `$t`")->fetchColumn();
    if ($left !== 0) throw new RuntimeException("$left rows still there");
    $pdo->commit();
    echo "DONE. Shops left: " . (int)$pdo->query("SELECT COUNT(*) FROM customers")->fetchColumn() . ", products: " .
        (int)$pdo->query("SELECT COUNT(*) FROM products")->fetchColumn() . ", suppliers: " . (int)$pdo->query("SELECT COUNT(*) FROM suppliers")->fetchColumn() . "\n";
} catch (Throwable $e) { $pdo->rollBack(); fwrite(STDERR, "ROLLED BACK: " . $e->getMessage() . "\n"); exit(1); }
