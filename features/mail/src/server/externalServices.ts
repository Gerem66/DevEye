import type { SdkExternalService, SdkExternalServicesContext } from '@deveye/types/sdk/server';

import type { MailOAuthProvider } from '../contracts/domain';
import { isOAuthConfigured, probeOAuthClient } from './oauth';
import type { MailRepo } from './repo';

const MEMO_MS = 10 * 60_000;
let memo: { at: number; value: readonly SdkExternalService[] } | null = null;

const PROVIDERS: readonly { provider: MailOAuthProvider; name: string; env: string }[] = [
    { provider: 'google', name: 'Connexion Google (Gmail)', env: 'OAUTH_GOOGLE_CLIENT_ID' },
    { provider: 'microsoft', name: 'Connexion Microsoft (Outlook)', env: 'OAUTH_MICROSOFT_CLIENT_ID' }
];

async function read(repo: MailRepo): Promise<readonly SdkExternalService[]> {
    const counts = await repo.accounts.countOAuth();
    return Promise.all(
        PROVIDERS.map(async ({ provider, name, env }): Promise<SdkExternalService> => {
            const base = { id: `oauth-${provider}`, name };
            const linked = counts.find((c) => c.authMethod === `oauth_${provider}`);
            const facts = [
                { label: 'Boîtes reliées', value: String(linked?.boxes ?? 0) },
                { label: 'Comptes qui les ont reliées', value: String(linked?.users ?? 0) }
            ];
            if (!isOAuthConfigured(provider)) {
                return {
                    ...base,
                    state: 'inactive',
                    summary: `Sans ${env}, la connexion en un clic n’est pas proposée.`,
                    facts: linked ? facts : undefined
                };
            }
            try {
                const verdict = await probeOAuthClient(provider);
                return verdict === 'accepted'
                    ? { ...base, state: 'ok', summary: 'Le fournisseur reconnaît l’application.', facts }
                    : {
                          ...base,
                          state: 'down',
                          summary: 'Le fournisseur refuse les identifiants de l’application.',
                          facts
                      };
            } catch {
                return { ...base, state: 'down', summary: 'Le fournisseur ne répond pas.', facts };
            }
        })
    );
}

export async function mailExternalServices({
    repo,
    refresh
}: SdkExternalServicesContext<MailRepo>): Promise<readonly SdkExternalService[]> {
    if (refresh || !memo || Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), value: await read(repo) };
    return memo.value;
}
