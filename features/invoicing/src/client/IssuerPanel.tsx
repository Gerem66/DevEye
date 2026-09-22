import { useCallback, useEffect, useState } from 'react';
import {
    ACCEPTED_TYPES,
    Button,
    fileToSquareDataUrl,
    humanizeError,
    ReadOnlyNotice,
    SaveButton,
    SelectInput,
    settingsStyles as shell,
    TextInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { InvoicingIssuer } from '../contracts/domain';
import { api } from './api';
import { useSettingsDraft } from './settingsDraft';
import styles from './style.module.css';

/**
 * L'identité de l'émetteur, dans l'ordre où elle se lit en tête d'une facture.
 * Ce sont des mentions obligatoires : les champs sont séparés parce que chacune
 * en est une, et parce qu'un export en données structurées les réclamera un jour
 * telles quelles.
 */

/** Une liste courte plutôt que les cent soixante codes ISO. */
const CURRENCIES = [
    { code: 'EUR', label: 'Euro (€)' },
    { code: 'USD', label: 'Dollar américain ($)' },
    { code: 'GBP', label: 'Livre sterling (£)' },
    { code: 'CHF', label: 'Franc suisse (CHF)' },
    { code: 'CAD', label: 'Dollar canadien (CA$)' }
];

/** Le logo tient dans la ligne scellée des réglages : une vignette, pas une image de presse. */
const LOGO_SIZE = 256;
const LOGO_MAX_LENGTH = 180_000;

const FIELDS: { key: keyof InvoicingIssuer; label: string; hint?: string; wide?: boolean }[] = [
    { key: 'legalName', label: 'Dénomination ou nom', wide: true },
    { key: 'tradeName', label: 'Nom commercial', hint: 'Si vous en utilisez un, différent du nom légal.' },
    { key: 'legalForm', label: 'Forme juridique', hint: 'SASU, EURL, entrepreneur individuel…' },
    { key: 'capital', label: 'Capital social', hint: 'Obligatoire pour une société.' },
    { key: 'address', label: 'Adresse', wide: true },
    { key: 'postalCode', label: 'Code postal' },
    { key: 'city', label: 'Ville' },
    { key: 'country', label: 'Pays' },
    { key: 'siret', label: 'SIRET' },
    { key: 'vatNumber', label: 'Numéro de TVA intracommunautaire' },
    { key: 'rcs', label: 'RCS et ville du greffe' },
    { key: 'email', label: 'Adresse e-mail' },
    { key: 'phone', label: 'Téléphone' },
    { key: 'website', label: 'Site' },
    { key: 'iban', label: 'IBAN', hint: 'Il figure sur vos factures : c’est par là que vos clients vous paient.' },
    { key: 'bic', label: 'BIC' },
    { key: 'insurer', label: 'Assureur professionnel', hint: 'Obligatoire pour un artisan.' },
    { key: 'insuranceScope', label: 'Couverture de l’assurance' }
];

export default function IssuerPanel({ canWrite }: SettingsPanelProps) {
    const { draft, error, patch, save, busy } = useSettingsDraft();
    const [logoError, setLogoError] = useState<string | null>(null);
    const [senders, setSenders] = useState<{ id: number; label: string; address: string }[] | null>(null);

    // Les comptes mail de l'espace. Sans module Mail installé, la commande
    // échoue et l'écran le dit plutôt que de promettre un envoi.
    const loadSenders = useCallback(async () => {
        try {
            setSenders((await api.send('invoicing.mailAccounts', {})).senders);
        } catch {
            setSenders([]);
        }
    }, []);

    useEffect(() => {
        void loadSenders();
    }, [loadSenders]);

    if (draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const issuer = draft.issuer;
    const setIssuer = (change: Partial<InvoicingIssuer>) => patch({ issuer: { ...issuer, ...change } });

    const pickLogo = async (file: File | undefined) => {
        if (!file) return;
        setLogoError(null);
        try {
            setIssuer({ logo: await fileToSquareDataUrl(file, { size: LOGO_SIZE, maxLength: LOGO_MAX_LENGTH }) });
        } catch (e) {
            setLogoError(humanizeError(e, 'Cette image n’a pas pu être préparée.'));
        }
    };

    return (
        <div className={shell.section}>
            <p className={shell.panelLead}>
                Ce que vos devis et vos factures portent en tête. Tant que la dénomination et le SIRET manquent, aucun
                document ne peut être émis : ce sont des mentions obligatoires.
            </p>

            <div className={styles.logoRow}>
                {issuer.logo === '' ? (
                    <span className={`icon ${styles.logoEmpty} icon-invoicing`} />
                ) : (
                    <img src={issuer.logo} alt='' className={styles.logo} />
                )}
                <div className={styles.logoActions}>
                    {canWrite && (
                        <>
                            <label className={styles.logoPick}>
                                <input
                                    type='file'
                                    accept={ACCEPTED_TYPES.join(',')}
                                    onChange={(e) => void pickLogo(e.target.files?.[0])}
                                />
                                <span>{issuer.logo === '' ? 'Choisir un logo' : 'Changer le logo'}</span>
                            </label>
                            {issuer.logo !== '' && (
                                <Button variant='ghost' onClick={() => setIssuer({ logo: '' })}>
                                    Retirer
                                </Button>
                            )}
                        </>
                    )}
                    <span className={shell.fieldHint}>Une vignette carrée, en haut à gauche du document.</span>
                </div>
            </div>
            {logoError && <p className={shell.errorText}>{logoError}</p>}

            <div className={styles.fieldGrid}>
                {FIELDS.map((field) => (
                    <label key={field.key} className={`${shell.field} ${field.wide ? styles.fieldWide : ''}`}>
                        <span className={shell.fieldLabel}>{field.label}</span>
                        <TextInput
                            value={issuer[field.key]}
                            disabled={!canWrite}
                            onChange={(e) => setIssuer({ [field.key]: e.target.value })}
                        />
                        {field.hint && <span className={shell.fieldHint}>{field.hint}</span>}
                    </label>
                ))}
            </div>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>Devise</span>
                <SelectInput
                    value={draft.currency}
                    disabled={!canWrite}
                    onChange={(e) => patch({ currency: e.target.value })}
                >
                    {CURRENCIES.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                            {entry.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Une seule devise par espace. Les documents déjà émis gardent la leur : changer de devise ne
                    convertit rien.
                </span>
            </label>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>Compte qui expédie vos documents</span>
                <SelectInput
                    value={draft.mailSenderId === null ? '' : String(draft.mailSenderId)}
                    disabled={!canWrite || senders === null || senders.length === 0}
                    onChange={(e) => patch({ mailSenderId: e.target.value === '' ? null : Number(e.target.value) })}
                >
                    <option value=''>Aucun</option>
                    {(senders ?? []).map((sender) => (
                        <option key={sender.id} value={String(sender.id)}>
                            {sender.label}
                            {sender.address.length > 0 && ` · ${sender.address}`}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    {senders !== null && senders.length === 0
                        ? 'Aucun compte mail n’est prêt dans cet espace : vos documents se téléchargent et s’envoient à la main.'
                        : 'Vos devis et factures partiront depuis ce compte.'}
                </span>
            </label>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Facturation.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
