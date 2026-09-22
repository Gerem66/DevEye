import {
    NumberInput,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    TextInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { DocumentKind, InvoicingSettings } from '../contracts/domain';
import { useSettingsDraft } from './settingsDraft';
import styles from './style.module.css';

/**
 * La numérotation. Le numéro est attribué **par le serveur à l'émission**, dans
 * une suite continue et sans trou : rien ici ne le calcule, on ne décrit que sa
 * forme.
 */

const PREFIX_FIELDS: { key: 'quotePrefix' | 'invoicePrefix' | 'creditPrefix'; label: string; kind: DocumentKind }[] = [
    { key: 'quotePrefix', label: 'Devis', kind: 'quote' },
    { key: 'invoicePrefix', label: 'Factures', kind: 'invoice' },
    { key: 'creditPrefix', label: 'Avoirs', kind: 'credit' }
];

/** La forme d'un numéro, telle qu'elle paraîtra. Le rang réel, lui, vient du serveur. */
function shapeOf(settings: InvoicingSettings, prefix: string): string {
    const year = settings.numberReset === 'yearly' ? `${new Date().getFullYear()}-` : '';
    return `${prefix}${year}${String(settings.numberStart).padStart(settings.numberPad, '0')}`;
}

export default function NumberingPanel({ canWrite }: SettingsPanelProps) {
    const { draft, error, patch, save, busy } = useSettingsDraft();

    if (draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    return (
        <div className={shell.section}>
            <p className={shell.panelLead}>
                Un numéro est attribué à l’émission, dans une suite continue et sans trou : la loi l’exige, et c’est
                pourquoi un brouillon n’en porte pas encore.
            </p>

            <div className={styles.fieldGrid}>
                {PREFIX_FIELDS.map((field) => (
                    <label key={field.key} className={shell.field}>
                        <span className={shell.fieldLabel}>Préfixe des {field.label.toLowerCase()}</span>
                        <TextInput
                            value={draft[field.key]}
                            disabled={!canWrite}
                            onChange={(e) => patch({ [field.key]: e.target.value })}
                        />
                        <span className={shell.fieldHint}>{shapeOf(draft, draft[field.key])}</span>
                    </label>
                ))}
            </div>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>La suite repart à un</span>
                <SegmentedControl
                    value={draft.numberReset}
                    options={[
                        { value: 'yearly' as const, label: 'Chaque année' },
                        { value: 'never' as const, label: 'Jamais' }
                    ]}
                    disabled={!canWrite}
                    onChange={(value) => patch({ numberReset: value })}
                    aria-label='Remise à zéro de la numérotation'
                />
            </div>

            <label className={shell.field} htmlFor='invoicing-number-start'>
                <span className={shell.fieldLabel}>Premier numéro</span>
                <NumberInput
                    id='invoicing-number-start'
                    value={draft.numberStart}
                    min={1}
                    max={999_999}
                    disabled={!canWrite}
                    onChange={(value) => patch({ numberStart: value ?? 1 })}
                />
                <span className={shell.fieldHint}>
                    Pour reprendre un historique facturé ailleurs : commencer à 43 évite d’inventer quarante-deux
                    documents.
                </span>
            </label>

            <label className={shell.field} htmlFor='invoicing-number-pad'>
                <span className={shell.fieldLabel}>Nombre de chiffres</span>
                <NumberInput
                    id='invoicing-number-pad'
                    value={draft.numberPad}
                    min={1}
                    max={8}
                    disabled={!canWrite}
                    onChange={(value) => patch({ numberPad: value ?? 4 })}
                />
            </label>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={save} disabled={busy} />
                </div>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Facturation.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
