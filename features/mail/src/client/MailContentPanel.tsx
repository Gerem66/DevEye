import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useResourceVersion
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError, withSettingsDefaults } from './api';
import styles from './style.module.css';

import type { MailBodyRenderMode, MailSettings } from '../contracts/domain';

const RENDER_MODE_OPTIONS: readonly { value: MailBodyRenderMode; label: string }[] = [
    { value: 'embedded', label: 'Intégré à DevEye' },
    { value: 'raw', label: 'Mise en forme d’origine' }
];

const RENDER_MODE_HINT: Record<MailBodyRenderMode, string> = {
    embedded:
        'Le message reprend le thème de DevEye — sobre et cohérent, mais sa mise en forme d’origine (couleurs, polices) est ignorée.',
    raw: 'Le message s’affiche tel qu’il a été conçu, fond blanc, dans un cadre isolé (aucun script n’y est jamais exécuté).'
};

/**
 * Les réglages généraux de Mail : le panneau Général de la coquille commune, aux
 * deux échelles. Ce sont les réglages de l'ESPACE, que la coquille soit ouverte
 * sur la fonctionnalité ou sur une de ses boîtes : `scope` n'y change rien,
 * l'onglet étant offert depuis les réglages d'un compte pour que le bouton en
 * haut à droite porte tout d'un coup.
 *
 * Chaque changement s'applique immédiatement, comme les autres panneaux de la
 * coquille. L'invalidation de `mail.getSettings` prévient l'écran Mail (le mode
 * d'affichage sert au prochain message ouvert) et les autres onglets.
 *
 * Sans le droit d'écriture, tout reste lisible mais rien ne se change : un
 * réglage que le serveur refuserait est un écran qui ment.
 */
export default function MailGeneralPanel({ canWrite }: SettingsPanelProps) {
    const version = useResourceVersion('mail.getSettings');
    const [settings, setSettings] = useState<MailSettings | null>(null);
    const [domainDraft, setDomainDraft] = useState('');
    const [status, setStatus] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('mail.getSettings', {});
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
                await api.send('mail.setSettings', next);
                invalidate('mail.getSettings');
            } catch (e) {
                setStatus(humanizeError(e, 'Enregistrement impossible.'));
                void load();
            }
        },
        [load]
    );

    if (!settings) return <p className={shell.notice}>{status ?? 'Chargement…'}</p>;

    const addDomain = () => {
        const domain = domainDraft.trim().toLowerCase();
        if (!domain) return;
        setDomainDraft('');
        if (settings.trustedImageDomains.includes(domain)) return;
        void apply({ ...settings, trustedImageDomains: [...settings.trustedImageDomains, domain] });
    };

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Affichage des messages</span>
                <SegmentedControl
                    aria-label='Affichage des messages'
                    value={settings.bodyRenderMode}
                    disabled={!canWrite}
                    options={RENDER_MODE_OPTIONS}
                    onChange={(mode) => void apply({ ...settings, bodyRenderMode: mode })}
                />
                <span className={shell.fieldHint}>{RENDER_MODE_HINT[settings.bodyRenderMode]}</span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Images distantes approuvées</span>
                {settings.trustedImageDomains.length === 0 ? (
                    <p className={shell.fieldHint}>
                        Aucun domaine approuvé — les images distantes restent bloquées par défaut sur chaque message,
                        avec la possibilité d’en approuver au cas par cas.
                    </p>
                ) : (
                    <div className={styles.attachments}>
                        {settings.trustedImageDomains.map((domain) => (
                            <span key={domain} className={styles.attachment}>
                                <span className='icon icon-shield' />
                                <span>{domain}</span>
                                {canWrite && (
                                    <button
                                        type='button'
                                        className={styles.attachmentRemove}
                                        onClick={() =>
                                            void apply({
                                                ...settings,
                                                trustedImageDomains: settings.trustedImageDomains.filter(
                                                    (d) => d !== domain
                                                )
                                            })
                                        }
                                        aria-label={`Retirer ${domain}`}
                                    >
                                        <span className={`icon icon-x ${styles.attachmentRemoveIcon}`} />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                )}
                {canWrite && (
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
                            <Button
                                variant='secondary'
                                onClick={() => void apply({ ...settings, trustedImageDomains: [] })}
                            >
                                Tout retirer
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {!canWrite && (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Mail.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}
        </div>
    );
}
