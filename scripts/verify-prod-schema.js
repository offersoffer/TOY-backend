'use strict';

/**
 * Read-only check that the branch/retention migration actually landed.
 *
 * Why this exists: `migrate.js` prints a "Patched existing tables:" line only
 * when it *changed* something. A database that is already up to date and a
 * database where nothing was applied therefore look identical from the
 * outside - both print just "Applied 75 statements". That is not a difference
 * worth guessing about when the next step deploys code that 500s on every
 * authenticated request if one column is missing.
 *
 * Runs through the same tunnel as the migration, reads nothing but
 * information_schema and a few counts, and writes nothing at all.
 *
 *   node scripts/verify-prod-schema.js
 */

const readline = require('node:readline');
const mysql = require('mysql2/promise');

const CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 13306),
  user: process.env.DB_USER || 'offers_migrate_prod',
  database: process.env.DB_NAME || 'offers_production',
};

/** Hidden prompt. `read -p` is a bashism, and this avoids the shell entirely. */
function askPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout;
    const onData = () => {
      // Keep the prompt on screen but never the characters.
      readline.clearLine(stdout, 0);
      readline.cursorTo(stdout, 0);
      stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      stdout.write('\n');
      resolve(answer);
    });
  });
}

const pass = (label, detail) => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail) => {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
};
const note = (label, detail) => console.log(`  note  ${label}${detail ? ` — ${detail}` : ''}`);

async function main() {
  // `!== undefined`, not `||`: an empty password is a legitimate value for a
  // local root and `||` would fall through to a prompt that nothing answers.
  const password =
    process.env.DB_PASSWORD !== undefined
      ? process.env.DB_PASSWORD
      : await askPassword(`${CONFIG.user} password: `);
  const connection = await mysql.createConnection({ ...CONFIG, password });
  // Match the application's convention so dates and comparisons agree.
  await connection.query("SET time_zone = '+00:00'");

  const q = async (sql, params = []) => (await connection.query(sql, params))[0];

  console.log(`\nChecking ${CONFIG.database} (read-only)\n`);
  const [{ version }] = await q('SELECT VERSION() AS version');
  note('server', `MySQL ${version}`);

  // ---- The three columns the deploy depends on -------------------------
  const wanted = [
    ['shop_members', 'is_branch_restricted', 'tinyint(1)', 'NO', '0'],
    ['shop_branches', 'contact_person_name', 'varchar(160)', 'YES', null],
    ['shop_branches', 'contact_person_email', 'varchar(190)', 'YES', null],
  ];
  console.log('\nColumns the deploy requires:');
  const present = new Set();
  for (const [table, column, type, nullable, dflt] of wanted) {
    const rows = await q(
      `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [CONFIG.database, table, column],
    );
    if (!rows.length) {
      fail(`${table}.${column}`, 'MISSING — do not deploy');
      continue;
    }
    const row = rows[0];
    const ok =
      row.COLUMN_TYPE === type &&
      row.IS_NULLABLE === nullable &&
      String(row.COLUMN_DEFAULT ?? 'null') === String(dflt ?? 'null');
    present.add(`${table}.${column}`);
    if (ok) pass(`${table}.${column}`, `${row.COLUMN_TYPE} ${nullable === 'NO' ? 'NOT NULL' : 'NULL'} default ${row.COLUMN_DEFAULT ?? 'NULL'}`);
    else
      fail(
        `${table}.${column}`,
        `present but ${row.COLUMN_TYPE} / nullable ${row.IS_NULLABLE} / default ${row.COLUMN_DEFAULT} — expected ${type} / ${nullable} / ${dflt}`,
      );
  }

  // ---- Nobody was confined by accident --------------------------------
  //
  // Skipped rather than attempted when the column is absent: querying it would
  // throw and abandon the rest of the report, turning a clear "three columns
  // missing" into a stack trace.
  if (!present.has('shop_members.is_branch_restricted')) {
    console.log('\nExisting members were not silently confined:');
    note('skipped', 'the column is not there yet');
    console.log('\nRESULT: not safe to deploy — the required columns are missing.\n');
    await connection.end();
    return;
  }

  console.log('\nExisting members were not silently confined:');
  const [confined] = await q(
    'SELECT COUNT(*) AS n FROM shop_members WHERE is_branch_restricted = 1',
  );
  const [attached] = await q(
    'SELECT COUNT(*) AS n FROM shop_members WHERE branch_id IS NOT NULL',
  );
  if (Number(confined.n) === 0) {
    pass('no member is branch-restricted', `${attached.n} are attached to a branch but unconfined`);
  } else {
    note(
      'some members are branch-restricted',
      `${confined.n} of them — expected 0 immediately after the migration, so check these were set on purpose`,
    );
  }

  // ---- The partitioning, which is optional for the deploy -------------
  console.log('\nvisibility_events (optional for the deploy):');
  const parts = await q(
    `SELECT PARTITION_NAME AS name FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'visibility_events' AND PARTITION_NAME IS NOT NULL`,
    [CONFIG.database],
  );
  const [fks] = await q(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'visibility_events' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [CONFIG.database],
  );
  if (parts.length) {
    pass('partitioned', `${parts.length} partitions, ${fks.n} foreign keys (0 is expected — InnoDB forbids them here)`);
    if (Number(fks.n) !== 0) fail('foreign keys on a partitioned table', 'this should be impossible');
  } else {
    note('not partitioned', `${fks.n} foreign keys intact — retention falls back to batched deletes, which is safe`);
  }

  // ---- Nothing was destroyed ------------------------------------------
  console.log('\nBusiness data still present:');
  for (const table of ['shops', 'shop_branches', 'shop_members', 'offers', 'users']) {
    const [row] = await q(`SELECT COUNT(*) AS n FROM \`${table}\``);
    note(table, `${row.n} rows`);
  }

  console.log(
    process.exitCode
      ? '\nRESULT: not safe to deploy — see the FAIL lines above.\n'
      : '\nRESULT: the three required columns are present. Safe to deploy.\n',
  );
  await connection.end();
}

main().catch((error) => {
  console.error(`\nverify failed: ${error.message}\n`);
  process.exit(2);
});
