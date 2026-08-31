import { useCallback, useEffect, useState } from 'react';

import {
    onResourceChange,
    ProviderKeys,
    settingsStyles as shell,
    useWorkspacePermissions,
    type ProviderKeyRow
} from 'deveye-sdk-client';

import { cveProviderSchema, type CveProvider } from '../contracts/domain';
import { api } from './api';
import { cveError } from './errors';

/**
 * Le panneau Sources : la clé d'API du NVD, à l'échelle de l'espace. Elle ne
 * revient jamais du serveur, seulement le fait qu'elle existe.
 */

const PROVIDER_META: Record<CveProvider, { label: string; hint: string; signupUrl: string }> = {
    nvd: {
        label: 'NVD (NIST)',
        hint: 'Facultative : sans elle le catalogue se remplit quand même, elle ne fait que relever le quota de requêtes.',
        signupUrl: 'https://nvd.nist.gov/developers/request-an-api-key'
    }
};

export default function CveKeysPanel() {
    // Poser une clé exige la permission déclarée `manageKeys`, pas seulement l'écriture.
    const canManage = useWorkspacePermissions().canExtra('cve', 'manageKeys');
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [status, setStatus] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('cve.keyList', {});
            setHeld(Object.fromEntries(res.keys.map((k) => [k.provider, k.hasKey])));
        } catch (e) {
            setStatus(cveError(e, 'La clé n’a pas pu être lue.').text);
        }
    }, []);

    useEffect(() => {
        void load();
        // La clé est un réglage de l'espace : qu'un autre membre la pose ou
        // l'efface se voit ici sans rouvrir le panneau.
        return onResourceChange('cve.keyList', () => void load());
    }, [load]);

    const save = useCallback(async (provider: string, key: string) => {
        setStatus(null);
        const res = await api.send('cve.setKey', { provider: provider as CveProvider, key });
        setHeld(Object.fromEntries(res.keys.map((k) => [k.provider, k.hasKey])));
    }, []);

    const rows: ProviderKeyRow[] = cveProviderSchema.options.map((provider) => ({
        id: provider,
        label: PROVIDER_META[provider].label,
        hint: PROVIDER_META[provider].hint,
        held: held[provider] === true,
        signupUrl: PROVIDER_META[provider].signupUrl,
        icon: 'bug'
    }));

    return (
        <>
            <ProviderKeys
                rows={rows}
                canWrite={canManage}
                onSave={save}
                onRemove={(provider) => save(provider, '')}
                readOnlyHint='Votre rôle ne permet pas de modifier cette clé : sa gestion se confie dans les permissions de la Veille CVE.'
            />
            {status && <p className={shell.notice}>{status}</p>}
        </>
    );
}
