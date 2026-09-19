import { useCallback, useEffect, useState } from 'react';
import { providerNeedsKey, weatherProviderSchema, type WeatherProvider } from '../contracts/domain';

import {
    invalidate,
    onResourceChange,
    ProviderKeys,
    settingsStyles as shell,
    useWorkspacePermissions,
    type ProviderKeyRow
} from 'deveye-sdk-client';
import { PROVIDER_META } from './providers';
import { api } from './api';

/**
 * Le panneau Sources : les clés d'API des fournisseurs, à l'échelle de l'espace,
 * seul endroit où elles se posent. La clé ne revient jamais du serveur, seulement
 * le fait qu'elle existe.
 *
 * La liste et le dialogue de saisie viennent de la coquille (`ProviderKeys`) :
 * ce panneau n'apporte que le catalogue des fournisseurs et les deux commandes.
 */

export default function WeatherKeysPanel() {
    // Poser une clé exige la permission déclarée `manageKeys`, pas seulement l'écriture.
    const canManage = useWorkspacePermissions().canExtra('weather', 'manageKeys');
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [status, setStatus] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('weather.keyList', {});
            setHeld(Object.fromEntries(res.providers.map((p) => [p.provider, p.hasKey])));
        } catch {
            setStatus('Les clés n’ont pas pu être lues.');
        }
    }, []);

    useEffect(() => {
        void load();
        // La clé est un réglage de l'espace : qu'un autre membre la pose ou
        // l'efface se voit ici sans rouvrir le panneau.
        return onResourceChange('weather.keyList', () => void load());
    }, [load]);

    const save = useCallback(async (provider: string, key: string) => {
        setStatus(null);
        await api.send('weather.setKey', { provider: provider as WeatherProvider, key });
        // Le hub ne renvoie pas sa trame à l'auteur : c'est à lui de raviver ce que
        // le sujet `weather` ravive chez les autres, soit ce panneau, le choix de
        // source de la fiche, et les villes, qu'un retrait de clé change de source.
        invalidate('weather.keyList', 'weather.list');
    }, []);

    const rows: ProviderKeyRow[] = weatherProviderSchema.options.map((provider) => ({
        id: provider,
        label: PROVIDER_META[provider].label,
        hint: PROVIDER_META[provider].hint,
        held: held[provider] === true,
        needsKey: providerNeedsKey(provider),
        signupUrl: PROVIDER_META[provider].signupUrl,
        icon: 'cloud'
    }));

    return (
        <>
            <ProviderKeys
                rows={rows}
                canWrite={canManage}
                onSave={save}
                onRemove={(provider) => save(provider, '')}
                readOnlyHint='Votre rôle ne permet pas de modifier ces clés : leur gestion se confie dans les permissions de la Météo.'
            />
            {status && <p className={shell.notice}>{status}</p>}
        </>
    );
}
