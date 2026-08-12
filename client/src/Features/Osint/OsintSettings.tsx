import { useCallback, useEffect, useState } from 'react';
import { OSINT_PROVIDER_META, osintProviderSchema, type OsintProvider } from 'deveye-types';

import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

import { humanizeError } from './api';
import styles from './Osint.module.css';

/**
 * Clés des fournisseurs optionnels.
 *
 * **Aucune n'est requise** : tout l'écran OSINT fonctionne sans. Une clé posée
 * ne fait qu'enrichir une sonde (Pappers ouvre le registre du commerce,
 * Numverify donne l'opérateur réel). C'est pourquoi ce panneau est derrière une
 * icône et non sur le chemin principal.
 *
 * La clé elle-même ne revient **jamais** du serveur — seulement le fait qu'elle
 * existe. Le champ reste donc vide à l'ouverture même quand une clé est posée,
 * et le dire évite de faire croire à un oubli.
 */

interface Props {
    open: boolean;
    onClose: () => void;
}

export function OsintSettings({ open, onClose }: Props): React.ReactElement {
    const [held, setHeld] = useState<Record<string, boolean>>({});
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState<OsintProvider | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await ws.send('osint.keyList', {});
            setHeld(Object.fromEntries(res.providers.map((p) => [p.provider, p.hasKey])));
        } catch (e) {
            setError(humanizeError(e, 'Les clés n’ont pas pu être lues.'));
        }
    }, []);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    const save = useCallback(async (provider: OsintProvider, key: string) => {
        setSaving(provider);
        setError(null);
        try {
            const res = await ws.send('osint.setKey', { provider, key });
            setHeld((prev) => ({ ...prev, [provider]: res.hasKey }));
            setDrafts((prev) => ({ ...prev, [provider]: '' }));
        } catch (e) {
            setError(humanizeError(e, 'La clé n’a pas pu être enregistrée.'));
        } finally {
            setSaving(null);
        }
    }, []);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Clés des fournisseurs'
            description='Toutes facultatives, chaque sonde libre fonctionne déjà. Chaque clé ajoute des informations supplémentaires.'
            width={620}
        >
            {error && <p className={styles.banner}>{error}</p>}

            <div className={styles.providerList}>
                {osintProviderSchema.options.map((provider) => {
                    const meta = OSINT_PROVIDER_META[provider];
                    const has = held[provider] === true;
                    return (
                        <section key={provider} className={styles.provider}>
                            <header className={styles.providerHead}>
                                <strong>{meta.label}</strong>
                                <span className={has ? styles.toneGood : styles.toneNeutral}>
                                    {has ? 'Clé enregistrée' : 'Aucune clé'}
                                </span>
                            </header>
                            <p className={styles.providerWhat}>{meta.enables}</p>
                            <div className={styles.providerRow}>
                                <TextInput
                                    type='password'
                                    enableShowHideButton
                                    value={drafts[provider] ?? ''}
                                    onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: e.target.value }))}
                                    placeholder={has ? 'Remplacer la clé…' : 'Coller la clé…'}
                                />
                                <Button
                                    onClick={() => void save(provider, drafts[provider] ?? '')}
                                    disabled={saving === provider || !(drafts[provider] ?? '').trim()}
                                >
                                    {saving === provider ? '…' : 'Enregistrer'}
                                </Button>
                                {has && (
                                    <Button variant='danger' onClick={() => void save(provider, '')}>
                                        Retirer
                                    </Button>
                                )}
                            </div>
                            <a
                                className={styles.providerLink}
                                href={meta.signupUrl}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                Obtenir une clé
                            </a>
                        </section>
                    );
                })}
            </div>
        </Dialog>
    );
}
