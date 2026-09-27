/**
 * Le sort de chaque table dans l'export d'un compte, contre la base du `.env`
 * (ou `DB_DATABASE`) : les fautes des déclarations, puis les tables sans sort.
 * Sortie non nulle s'il y en a.
 */
import 'dotenv/config';

import { INSTALLED_MODULES } from '@/features/_generated/installed';
import { createDbPool, getQueryable } from '@/db/pool';
import { exportCoverage } from '@/Services/accountExport/coverage';

const pool = createDbPool();
const db = getQueryable(pool);
const q = {
    query: async <T extends object>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows,
    execute: async () => ({ affectedRows: 0, insertId: 0 })
};
const report = await exportCoverage(
    q,
    INSTALLED_MODULES.map((m) => ({ id: m.manifest.id, entry: m.server.accountExport }))
);
for (const fault of report.faults) console.log(`faute : ${fault}`);
for (const table of report.uncovered) console.log(`sans sort : ${table}`);
console.log(`${report.faults.length} faute(s), ${report.uncovered.length} table(s) sans sort`);
await pool.end();
process.exit(report.faults.length + report.uncovered.length > 0 ? 1 : 0);
