import { useCallback, useEffect, useState } from 'react';
import type { MailBodyRenderMode, MailSettings } from 'deveye-types';

import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import { invalidate, useResourceVersion } from '@/stores/invalidation';

import { humanizeError, withSettingsDefaults, ws } from './api';
import styles from './style.module.css';

/**
 * Les réglages généraux de Mail : le panneau Général de la coquille commune.
 *
 * Remplace l'ancienne popup « Paramètres Mail » qui vivait derrière un
 * engrenage à part : mêmes réglages, même commande (`mail.get/setSettings`),
 * mais dans la coquille que toutes les features partagent.
 *
 * Chaque changement s'applique **immédiatement**, comme les autres panneaux de
 * la coquille : un bouton Enregistrer sur trois réglages n'était qu'une étape
 * de plus. L'invalidation de `mail.getSettings` prévient l'écran Mail (le mode
 * d'affichage sert au prochain message ouvert) et les autres onglets.
 *
 * Nouveauté au passage : un champ pour **ajouter** un domaine approuvé. Il
 * n'existait pas : on ne pouvait approuver que depuis un message reçu, et
 * retirer ici, la moitié d'une liste.
 */
export default function MailGeneralPanel() {
    const version = useResourceVersion('mail.getSettings');
    const [settings, setSettings] = useState<MailSettings | null>(null);
    const [domainDraft, setDomainDraft] = useState('');
    const [status, setStatus] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await ws.send('mail.getSettings', {});
            setSettings(withSettingsDefaults(res.settings));
        } catch (e) {
            setStatus(humanizeError(e, 'Chargement impossible.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, version]);

    const apply = useCallback(
        async (next: MailSettings) => {
            setSettings(next);
            setStatus(null);
            try {
                await ws.send('mail.setSettings', next);
                invalidate('mail.getSettings');
            } catch (e) {
                setStatus(humanizeError(e, 'Enregistrement impossible.'));
                void load();
            }
        },
        [load]
    );

    if (!settings) return <p className={styles.status}>{status ?? 'Chargement…'}</p>;

    const addDomain = () => {
        const domain = domainDraft.trim().toLowerCase();
        if (!domain) return;
        setDomainDraft('');
        if (settings.trustedImageDomains.includes(domain)) return;
        void apply({ ...settings, trustedImageDomains: [...settings.trustedImageDomains, domain] });
    };

    return (
        <div className={styles.form}>
            <p className={styles.sectionLabel}>Affichage des messages</p>
            <div className={styles.tierChoice}>
                {(['embedded', 'raw'] as MailBodyRenderMode[]).map((mode) => (
                    <label key={mode} className={styles.tierOption}>
                        <input
                            type='radio'
                            name='bodyRenderMode'
                            checked={settings.bodyRenderMode === mode}
                            onChange={() => void apply({ ...settings, bodyRenderMode: mode })}
                        />
                        <span>
                            <strong>{mode === 'embedded' ? 'Intégré à DevEye' : 'Mise en forme d’origine'}</strong>
                            <span className={styles.fieldHint}>
                                {mode === 'embedded'
                                    ? 'Le message reprend le thème de DevEye — sobre et cohérent, mais sa mise en forme d’origine (couleurs, polices) est ignorée.'
                                    : 'Le message s’affiche tel qu’il a été conçu, fond blanc, dans un cadre isolé (aucun script n’y est jamais exécuté).'}
                            </span>
                        </span>
                    </label>
                ))}
            </div>

            <p className={styles.sectionLabel}>Images distantes approuvées</p>
            {settings.trustedImageDomains.length === 0 ? (
                <p className={styles.fieldHint}>
                    Aucun domaine approuvé — les images distantes restent bloquées par défaut sur chaque message, avec
                    la possibilité d’en approuver au cas par cas.
                </p>
            ) : (
                <div className={styles.attachments}>
                    {settings.trustedImageDomains.map((domain) => (
                        <span key={domain} className={styles.attachment}>
                            <span className='icon icon-shield' />
                            <span>{domain}</span>
                            <button
                                type='button'
                                className={styles.attachmentRemove}
                                onClick={() =>
                                    void apply({
                                        ...settings,
                                        trustedImageDomains: settings.trustedImageDomains.filter((d) => d !== domain)
                                    })
                                }
                                aria-label={`Retirer ${domain}`}
                            >
                                <span className={`icon icon-x ${styles.attachmentRemoveIcon}`} />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <div className={styles.formRow}>
                <TextInput
                    value={domainDraft}
                    onChange={(e) => setDomainDraft(e.target.value)}
                    placeholder='exemple.fr'
                    aria-label='Approuver un domaine'
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addDomain();
                        }
                    }}
                />
                <Button variant='secondary' icon='plus' onClick={addDomain} disabled={!domainDraft.trim()}>
                    Approuver
                </Button>
                {settings.trustedImageDomains.length > 0 && (
                    <Button variant='secondary' onClick={() => void apply({ ...settings, trustedImageDomains: [] })}>
                        Tout retirer
                    </Button>
                )}
            </div>

            {status && <p className={styles.status}>{status}</p>}
        </div>
    );
}
