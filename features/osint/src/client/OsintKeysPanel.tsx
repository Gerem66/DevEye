import { useCallback, useEffect, useState } from 'react';
import { OSINT_PROVIDER_META, osintProviderSchema, type OsintProvider } from '../contracts/domain';

import { Button, humanizeError, settingsStyles as shell, TextInput } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from './api';

/**
 * Le panneau Sources : les clés des fournisseurs OSINT. Aucune n'est requise,
 * une clé ne fait qu'enrichir une sonde. La clé ne revient jamais du serveur,
 * seulement le fait qu'elle existe : le champ reste vide même quand une clé est
 * posée. Sans droit d'écriture, les champs ne sont pas proposés.
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
        <div className={shell.section}>
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
                                    <a
                                        className={shell.link}
                                        href={meta.signupUrl}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                    >
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
                        <span className={shell.sectionLabel}>Clé {OSINT_PROVIDER_META[provider].label}</span>
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
        </div>
    );
}
