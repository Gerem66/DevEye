import { useCallback, useEffect, useState } from 'react';
import { OSINT_PROVIDER_META, osintProviderSchema, type OsintProvider } from '../contracts/domain';

import { humanizeError, ProviderKeys, settingsStyles as shell, type ProviderKeyRow } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from './api';

/**
 * Le panneau Sources : les clés des fournisseurs OSINT. Aucune n'est requise,
 * une clé ne fait qu'enrichir une sonde. La clé ne revient jamais du serveur,
 * seulement le fait qu'elle existe.
 *
 * La liste et le dialogue de saisie viennent de la coquille (`ProviderKeys`) :
 * ce panneau n'apporte que le catalogue des fournisseurs et les deux commandes.
 */
export default function OsintKeysPanel({ canWrite }: SettingsPanelProps) {
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('osint.keyList', {});
            setHeld(Object.fromEntries(res.providers.map((p) => [p.provider, p.hasKey])));
        } catch (e) {
            setError(humanizeError(e, 'Les clés n’ont pas pu être lues.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const save = useCallback(async (provider: string, key: string) => {
        setError(null);
        const res = await api.send('osint.setKey', { provider: provider as OsintProvider, key });
        setHeld((prev) => ({ ...prev, [provider]: res.hasKey }));
    }, []);

    const rows: ProviderKeyRow[] = osintProviderSchema.options.map((provider) => ({
        id: provider,
        label: OSINT_PROVIDER_META[provider].label,
        hint: OSINT_PROVIDER_META[provider].enables,
        held: held[provider] === true,
        signupUrl: OSINT_PROVIDER_META[provider].signupUrl,
        icon: 'key'
    }));

    return (
        <>
            <ProviderKeys
                rows={rows}
                canWrite={canWrite}
                onSave={save}
                onRemove={(provider) => save(provider, '')}
                readOnlyHint='Votre rôle ne permet pas de modifier ces clés : elles relèvent de l’écriture sur OSINT.'
            />
            {error && <p className={shell.notice}>{error}</p>}
        </>
    );
}
