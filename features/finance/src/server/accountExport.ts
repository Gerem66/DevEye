import type { FeatureAccountExport, SdkWorkspaceExportContext } from '@deveye/types/sdk/server';

import type { FinanceConnectionRow } from '../contracts/banking';
import { readConnection } from './banking';
import type { FinanceRepo } from './repo';

const iso = (seconds: number | null): string | null =>
    seconds === null ? null : new Date(Number(seconds) * 1000).toISOString();

/** Une connexion sans ses accès à la banque : ceux-là ne sortent jamais. */
async function* connectionRows(
    ctx: SdkWorkspaceExportContext<FinanceRepo>,
    rows: FinanceConnectionRow[]
): AsyncGenerator<unknown> {
    for (const row of rows) {
        const stored = await readConnection(ctx, row);
        yield {
            id: row.id,
            provider: row.provider,
            status: row.status,
            error: row.error,
            valid_until: iso(row.valid_until),
            last_sync_at: iso(row.last_sync_at),
            created: iso(row.created),
            content:
                stored === null
                    ? null
                    : {
                          label: stored.label,
                          bankName: stored.bankName,
                          country: stored.country ?? null,
                          psuType: stored.psuType ?? null,
                          accounts: stored.accounts.map(({ id, name, ibanEnd, currency }) => ({
                              id,
                              name,
                              ibanEnd,
                              currency
                          }))
                      }
        };
    }
}

export const financeAccountExport: FeatureAccountExport<FinanceRepo> = {
    tables: {
        finance_config: { file: 'reglages.json', where: 'workspace_id = ?', key: ['workspace_id'] },
        finance_accounts: {
            file: 'comptes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        finance_categories: {
            file: 'categories.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        finance_recurring: {
            file: 'operations-recurrentes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        finance_transactions: {
            file: 'operations.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's', updated: 's' }
        },
        ft_finance_imports: {
            file: 'imports.json',
            where: 'workspace_id = ?',
            key: ['id'],
            dates: { created: 's' }
        },
        ft_finance_statement_lines: {
            file: 'lignes-de-releve.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        ft_finance_rules: {
            file: 'regles.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        ft_finance_bank_links: {
            file: 'comptes-relies.json',
            where: 'workspace_id = ?',
            key: ['account_id'],
            dates: { created: 's' }
        },
        ft_finance_connections: 'custom',
        ft_finance_reminders: {
            skip: 'Le registre des rappels de déclaration ne sert qu’à ne pas envoyer deux fois le même.'
        }
    },
    async workspace(ctx) {
        const rows = await ctx.repo.listConnections(ctx.workspace.id);
        await ctx.out.rows('connexions-bancaires.json', connectionRows(ctx, rows));
    }
};
