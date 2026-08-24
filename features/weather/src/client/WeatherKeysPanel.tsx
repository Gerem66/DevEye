import { useCallback, useEffect, useState } from 'react';
import { weatherProviderSchema, type WeatherProvider } from '../contracts/domain';

import { Button, featureApi, settingsStyles as shell, TextInput, useWorkspacePermissions } from 'deveye-sdk-client';

import { manifest } from '../manifest';

const api = featureApi(manifest);

/**
 * Les clés d'API des fournisseurs météo — le panneau Sources de la Météo.
 *
 * Autonome, comme tous les panneaux de la coquille : il se charge tout seul.
 * La clé posée ici vaut pour tout l'espace ; un lieu peut porter la sienne
 * dans son propre dialogue, et sans elle il retombe sur celle-ci
 * (`resolveLocationKey` côté serveur). C'est le premier point d'entrée de
 * cette clé d'espace : `weather.setKey` existait sans aucun écran pour
 * l'appeler.
 *
 * La clé ne revient jamais du serveur, seulement le fait qu'elle existe.
 */

/** Ce que chaque fournisseur attend. Le registre est court et fermé. */
const PROVIDER_META: Record<WeatherProvider, { label: string; needsKey: boolean; hint: string }> = {
    'open-meteo': {
        label: 'Open-Meteo',
        needsKey: false,
        hint: 'Gratuit et sans clé : le fournisseur par défaut, rien à régler.'
    },
    openweathermap: {
        label: 'OpenWeatherMap',
        needsKey: true,
        hint: 'Exige une clé d’API (gratuite à créer sur openweathermap.org).'
    }
};

export default function WeatherKeysPanel() {
    // Depuis le rapatriement, poser une clé exige la permission déclarée
    // `manageKeys` (voir le manifest), pas seulement l'écriture.
    const canManage = useWorkspacePermissions().canExtra('weather', 'manageKeys');
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<string | null>(null);
    const [saving, setSaving] = useState<WeatherProvider | null>(null);

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

    const save = useCallback(async (provider: WeatherProvider, key: string) => {
        setSaving(provider);
        setStatus(null);
        try {
            const res = await api.send('weather.setKey', { provider, key });
            setHeld((prev) => ({ ...prev, [provider]: res.hasKey }));
            setDrafts((prev) => ({ ...prev, [provider]: '' }));
        } catch {
            setStatus('La clé n’a pas pu être enregistrée.');
        } finally {
            setSaving(null);
        }
    }, []);

    return (
        <>
            <div className={shell.channelList}>
                {weatherProviderSchema.options.map((provider) => {
                    const meta = PROVIDER_META[provider];
                    const has = held[provider] === true;
                    return (
                        <div key={provider} className={shell.channelRow}>
                            <span className={`icon icon-cloud ${shell.channelIcon}`} aria-hidden='true' />
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    {meta.label}
                                    {meta.needsKey && (
                                        <span className={has ? shell.channelUsage : shell.channelOff}>
                                            {has ? 'clé enregistrée' : 'aucune clé'}
                                        </span>
                                    )}
                                </span>
                                <span className={shell.channelMeta}>{meta.hint}</span>
                            </span>
                        </div>
                    );
                })}
            </div>

            {canManage ? (
                weatherProviderSchema.options
                    .filter((p) => PROVIDER_META[p].needsKey)
                    .map((provider) => (
                        <div key={provider} className={shell.field}>
                            <span className={shell.fieldLabel}>Clé {PROVIDER_META[provider].label}</span>
                            <div className={shell.sectionActions}>
                                <TextInput
                                    type='password'
                                    enableShowHideButton
                                    value={drafts[provider] ?? ''}
                                    onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: e.target.value }))}
                                    placeholder={held[provider] === true ? 'Remplacer la clé…' : 'Coller la clé…'}
                                />
                                <Button
                                    onClick={() => void save(provider, (drafts[provider] ?? '').trim())}
                                    disabled={saving === provider || !(drafts[provider] ?? '').trim()}
                                >
                                    {saving === provider ? '…' : 'Enregistrer'}
                                </Button>
                                {held[provider] === true && (
                                    <Button variant='danger' onClick={() => void save(provider, '')}>
                                        Retirer
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces clés : leur gestion se confie dans les permissions de la
                    Météo.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}
        </>
    );
}
