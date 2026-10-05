import { NumberInput, ReadOnlyNotice, SaveButton, settingsStyles as shell } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { InvoicingWording } from '../contracts/domain';
import { useSettingsDraft } from './settingsDraft';
import styles from './style.module.css';

/**
 * Les phrases et les délais que chaque document reprend. Tout est saisissable :
 * une mention qui change de loi doit rester une correction de formulaire, jamais
 * une modification de code.
 */

const TEXTS: { key: keyof InvoicingWording; label: string; hint?: string; rows?: number }[] = [
    { key: 'paymentTerms', label: 'Conditions de règlement' },
    {
        key: 'lateFeeText',
        label: 'Pénalités de retard',
        hint: 'Mention obligatoire entre professionnels.'
    },
    {
        key: 'recoveryFeeText',
        label: 'Indemnité de recouvrement',
        hint: 'Obligatoire entre professionnels, et son montant est fixé par la loi.'
    },
    { key: 'discountText', label: 'Escompte' },
    { key: 'quoteTerms', label: 'Conditions propres aux devis' },
    {
        key: 'signatureText',
        label: 'Accord sur un devis',
        hint: 'Sert deux fois : le cadre à signer sur le papier, et la question posée au client sur sa page en ligne. Il disparaît dès qu’il a répondu.'
    },
    { key: 'footer', label: 'Pied de page', hint: 'Ce qui se répète en bas de chaque page.', rows: 2 }
];

export default function WordingPanel({ canWrite }: SettingsPanelProps) {
    const { draft, error, patch, save, busy } = useSettingsDraft();

    if (draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const wording = draft.wording;
    const setWording = (change: Partial<InvoicingWording>) => patch({ wording: { ...wording, ...change } });

    return (
        <div className={shell.section}>
            <label className={shell.field} htmlFor='invoicing-terms-days'>
                <span className={shell.fieldLabel}>Délai de règlement, en jours</span>
                <NumberInput
                    id='invoicing-terms-days'
                    value={draft.paymentTermsDays}
                    min={0}
                    max={365}
                    disabled={!canWrite}
                    onChange={(value) => patch({ paymentTermsDays: value ?? 0 })}
                />
                <span className={shell.fieldHint}>
                    Zéro pour un paiement comptant. Une facture neuve propose d’être payée avant aujourd’hui plus ce
                    délai, ou celui de son client.
                </span>
            </label>

            <label className={shell.field} htmlFor='invoicing-validity-days'>
                <span className={shell.fieldLabel}>Validité d’un devis, en jours</span>
                <NumberInput
                    id='invoicing-validity-days'
                    value={draft.quoteValidityDays}
                    min={1}
                    max={365}
                    disabled={!canWrite}
                    onChange={(value) => patch({ quoteValidityDays: value ?? 30 })}
                />
                <span className={shell.fieldHint}>
                    Un devis neuf propose d’être valable jusqu’à aujourd’hui plus ce délai.
                </span>
            </label>

            <label className={shell.field} htmlFor='invoicing-deposit-percent'>
                <span className={shell.fieldLabel}>Acompte demandé sur un devis, en pourcentage</span>
                <NumberInput
                    id='invoicing-deposit-percent'
                    value={draft.defaultDepositBp / 100}
                    min={0}
                    max={100}
                    disabled={!canWrite}
                    onChange={(value) => patch({ defaultDepositBp: Math.round((value ?? 0) * 100) })}
                />
                <span className={shell.fieldHint}>
                    Le devis l’annonce sous son total, avec son montant. Zéro pour ne rien annoncer ; chaque devis peut
                    en demander un autre.
                </span>
            </label>

            {TEXTS.map((field) => (
                <label key={field.key} className={shell.field}>
                    <span className={shell.fieldLabel}>{field.label}</span>
                    <textarea
                        className={styles.textarea}
                        rows={field.rows ?? 2}
                        value={wording[field.key]}
                        disabled={!canWrite}
                        onChange={(e) => setWording({ [field.key]: e.target.value })}
                    />
                    {field.hint && <span className={shell.fieldHint}>{field.hint}</span>}
                </label>
            ))}

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
