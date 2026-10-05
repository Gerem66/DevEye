import type { SdkExternalService, SdkExternalServicesContext } from '@deveye/types/sdk/server';

import { BankError } from './banks/types';
import { describeApplication, enableBankingApp, enableBankingProblem } from './banks/enableBanking';
import type { FinanceRepo } from './repo';

const MEMO_MS = 10 * 60_000;
let memo: { at: number; value: SdkExternalService } | null = null;

async function enableBanking(repo: FinanceRepo): Promise<SdkExternalService> {
    const base = { id: 'enable-banking', name: 'Enable Banking' };
    const problem = enableBankingProblem();
    const app = enableBankingApp();
    if (!app && !problem) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Sans ENABLE_BANKING_APP_ID, « Autre banque » n’est pas proposée.'
        };
    }
    if (!app) return { ...base, state: 'down', summary: problem ?? 'Configuration illisible.' };
    const connections = await repo.countProviderConnections('enablebanking');
    const facts: { label: string; value: string; tone?: 'warning' }[] = [
        { label: 'Connexions bancaires', value: String(connections.total) }
    ];
    if (connections.failing > 0) {
        facts.push({ label: 'En échec ou expirées', value: String(connections.failing), tone: 'warning' });
    }
    try {
        const described = await describeApplication(app);
        if (described.name) facts.unshift({ label: 'Application', value: described.name });
        if (described.environment) facts.push({ label: 'Environnement', value: described.environment });
        if (described.active === false) {
            return { ...base, state: 'degraded', summary: 'L’application est désactivée chez Enable Banking.', facts };
        }
        return { ...base, state: 'ok', summary: 'Enable Banking reconnaît l’application.', facts };
    } catch (e) {
        return {
            ...base,
            state: 'down',
            summary:
                e instanceof BankError && e.kind === 'auth'
                    ? 'Enable Banking refuse la clé de l’application.'
                    : 'Enable Banking ne répond pas.',
            facts
        };
    }
}

export async function financeExternalServices({
    repo,
    refresh
}: SdkExternalServicesContext<FinanceRepo>): Promise<readonly SdkExternalService[]> {
    if (refresh || !memo || Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), value: await enableBanking(repo) };
    return [memo.value];
}
