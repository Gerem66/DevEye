import { useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import { humanizeError, withSettingsDefaults, ws } from './api';
import styles from './style.module.css';

import type { MailBodyRenderMode, MailSettings } from 'deveye-types';

export const MAIL_SETTINGS_POPUP = 'popup-mail-settings';

/** Everything the popup needs is fetched on open — `OpenPopup` is called with no input. */
export function MailSettingsPopup() {
    const [settings, setSettings] = useState<MailSettings | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function handleOpen(input: unknown): void {
        if (input === null) return;
        setError(null);
        setLoading(true);
        ws.send('mail.getSettings', {})
            .then((res) => setSettings(withSettingsDefaults(res.settings)))
            .catch((e) => setError(humanizeError(e, 'Chargement impossible.')))
            .finally(() => setLoading(false));
    }

    function close(saved: boolean): void {
        ClosePopup(MAIL_SETTINGS_POPUP, saved);
    }

    function set<K extends keyof MailSettings>(key: K, value: MailSettings[K]): void {
        setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    }

    async function save(): Promise<void> {
        if (!settings) return;
        setSaving(true);
        setError(null);
        try {
            await ws.send('mail.setSettings', settings);
            close(true);
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Popup
            id={MAIL_SETTINGS_POPUP}
            title='Paramètres Mail'
            width={520}
            onInputChange={handleOpen}
            onClosePopup={() => close(false)}
        >
            {loading || !settings ? (
                <p className={styles.status}>Chargement…</p>
            ) : (
                <div className={styles.form}>
                    <p className={styles.sectionLabel}>Affichage des messages</p>
                    <div className={styles.tierChoice}>
                        {(['embedded', 'raw'] as MailBodyRenderMode[]).map((mode) => (
                            <label key={mode} className={styles.tierOption}>
                                <input
                                    type='radio'
                                    name='bodyRenderMode'
                                    checked={settings.bodyRenderMode === mode}
                                    onChange={() => set('bodyRenderMode', mode)}
                                />
                                <span>
                                    <strong>
                                        {mode === 'embedded' ? 'Intégré à DevEye' : 'Mise en forme d’origine'}
                                    </strong>
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
                            Aucun domaine approuvé — les images distantes restent bloquées par défaut sur chaque
                            message, avec la possibilité d’en approuver au cas par cas.
                        </p>
                    ) : (
                        <>
                            <div className={styles.attachments}>
                                {settings.trustedImageDomains.map((domain) => (
                                    <span key={domain} className={styles.attachment}>
                                        <span className='icon icon-shield' />
                                        <span>{domain}</span>
                                        <button
                                            type='button'
                                            className={styles.attachmentRemove}
                                            onClick={() =>
                                                set(
                                                    'trustedImageDomains',
                                                    settings.trustedImageDomains.filter((d) => d !== domain)
                                                )
                                            }
                                            aria-label={`Retirer ${domain}`}
                                        >
                                            <span className={`icon icon-x ${styles.attachmentRemoveIcon}`} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <Button
                                variant='secondary'
                                onClick={() => set('trustedImageDomains', [])}
                                className={styles.settingsResetBtn}
                            >
                                Tout retirer
                            </Button>
                        </>
                    )}

                    {error && <p className={styles.status}>{error}</p>}
                </div>
            )}

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                </div>
                <Button disabled={saving || loading || !settings} onClick={() => void save()}>
                    {saving ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
            </div>
        </Popup>
    );
}

export default MailSettingsPopup;
