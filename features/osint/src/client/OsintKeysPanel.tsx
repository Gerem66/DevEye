import { useCallback, useEffect, useState } from 'react';
import { OSINT_PROVIDER_META, osintProviderSchema, type OsintProvider } from '../contracts/domain';

import { Button, humanizeError, settingsStyles as shell, TextInput } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from './api';

/**
 * Les clés des fournisseurs OSINT — le panneau Sources de la fonctionnalité.
 *
 * Autonome, comme tous les panneaux de la coquille de réglages : il se charge
 * et s'invalide tout seul, la coquille ne lui passe que la portée et le droit
 * d'écriture. Rangées canoniques des réglages (`settingsStyles`), comme le
 * panneau des clés de la Météo : les deux écrans de sources se lisent pareil.
 *
 * **Aucune clé n'est requise** : tout l'écran OSINT fonctionne sans. Une clé
 * posée ne fait qu'enrichir une sonde (Pappers ouvre le registre du commerce,
 * Numverify donne l'opérateur réel).
 *
 * La clé elle-même ne revient **jamais** du serveur — seulement le fait
 * qu'elle existe. Le champ reste donc vide à l'ouverture même quand une clé
 * est posée. Et sans le droit d'écriture sur OSINT, les champs ne sont pas
 * proposés : un formulaire que le serveur refuserait est un écran qui ment.
 */
export default function OsintKeysPanel({ canWrite }: SettingsPanelProps) {
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState<OsintProvider | null>(null);

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

    const save = useCallback(async (provider: OsintProvider, key: string) => {
        setSaving(provider);
        setError(null);
        try {
            const res = await api.send('osint.setKey', { provider, key });
            setHeld((prev) => ({ ...prev, [provider]: res.hasKey }));
            setDrafts((prev) => ({ ...prev, [provider]: '' }));
        } catch (e) {
            setError(humanizeError(e, 'La clé n’a pas pu être enregistrée.'));
        } finally {
            setSaving(null);
        }
    }, []);

    return (
        <>
            <div className={shell.channelList}>
                {osintProviderSchema.options.map((provider) => {
                    const meta = OSINT_PROVIDER_META[provider];
                    const has = held[provider] === true;
                    return (
                        <div key={provider} className={shell.channelRow}>
                            <span className={`icon icon-key ${shell.channelIcon}`} aria-hidden='true' />
                            <span className={shell.channelText}>
                                <span className={shell.channelLabel}>
                                    {meta.label}
                                    <span className={has ? shell.channelUsage : shell.channelOff}>
                                        {has ? 'clé enregistrée' : 'aucune clé'}
                                    </span>
                                </span>
                                <span className={shell.channelMeta}>
                                    {meta.enables}{' '}
                                    <a href={meta.signupUrl} target='_blank' rel='noopener noreferrer'>
                                        Obtenir une clé
                                    </a>
                                </span>
                            </span>
                        </div>
                    );
                })}
            </div>

            {canWrite ? (
                osintProviderSchema.options.map((provider) => (
                    <div key={provider} className={shell.field}>
                        <span className={shell.fieldLabel}>Clé {OSINT_PROVIDER_META[provider].label}</span>
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
                    Votre rôle ne permet pas de modifier ces clés : elles relèvent de l’écriture sur OSINT.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </>
    );
}
