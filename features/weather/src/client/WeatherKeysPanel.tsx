import { useCallback, useEffect, useState } from 'react';
import { weatherProviderSchema, type WeatherProvider } from '../contracts/domain';

import { ProviderKeys, settingsStyles as shell, useWorkspacePermissions, type ProviderKeyRow } from 'deveye-sdk-client';
import { api } from './api';

/**
 * Le panneau Sources : les clés d'API des fournisseurs, à l'échelle de l'espace.
 * Un lieu peut porter la sienne, et sans elle retombe sur celle-ci
 * (`resolveLocationKey`). La clé ne revient jamais du serveur, seulement le fait
 * qu'elle existe.
 *
 * La liste et le dialogue de saisie viennent de la coquille (`ProviderKeys`) :
 * ce panneau n'apporte que le catalogue des fournisseurs et les deux commandes.
 */

/** Ce que chaque fournisseur attend. Le registre est court et fermé. */
const PROVIDER_META: Record<WeatherProvider, { label: string; needsKey: boolean; hint: string; signupUrl?: string }> = {
    'open-meteo': {
        label: 'Open-Meteo',
        needsKey: false,
        hint: 'Gratuit et sans clé : le fournisseur par défaut, rien à régler.'
    },
    openweathermap: {
        label: 'OpenWeatherMap',
        needsKey: true,
        hint: 'Exige une clé d’API, gratuite à créer.',
        signupUrl: 'https://openweathermap.org/api'
    }
};

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
    }, [load]);

    const save = useCallback(async (provider: string, key: string) => {
        setStatus(null);
        const res = await api.send('weather.setKey', { provider: provider as WeatherProvider, key });
        setHeld((prev) => ({ ...prev, [provider]: res.hasKey }));
    }, []);

    const rows: ProviderKeyRow[] = weatherProviderSchema.options.map((provider) => ({
        id: provider,
        label: PROVIDER_META[provider].label,
        hint: PROVIDER_META[provider].hint,
        held: held[provider] === true,
        needsKey: PROVIDER_META[provider].needsKey,
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
