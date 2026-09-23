import { ReadOnlyNotice, SaveButton, SegmentedControl, settingsStyles as shell, Switch } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { useSettingsDraft } from './settingsDraft';
import styles from './style.module.css';

/**
 * Le seul commutateur qui décide de tout le reste : assujetti à la TVA, ou en
 * franchise en base. Éteint, il fait paraître la mention d'exonération sur chaque
 * document et interdit qu'une ligne porte un taux ; allumé, il demande le taux
 * par défaut d'une ligne neuve.
 */

/**
 * Les quatre taux français, plus le zéro des lignes exonérées. Les valeurs sont
 * des chaînes parce que `SegmentedControl` ne connaît que celles-là ; le contrat
 * reste des points de base.
 */
const RATES = [
    { value: '0', label: '0 %' },
    { value: '210', label: '2,1 %' },
    { value: '550', label: '5,5 %' },
    { value: '1000', label: '10 %' },
    { value: '2000', label: '20 %' }
];

export default function TaxesPanel({ canWrite }: SettingsPanelProps) {
    const { draft, error, patch, save, busy } = useSettingsDraft();

    if (draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const liable = draft.vatRegime === 'standard';

    return (
        <div className={shell.section}>
            <Switch
                checked={liable}
                disabled={!canWrite}
                onChange={(value) =>
                    // Le taux par défaut suit le régime : les garder
                    // indépendants laisserait exister « franchise de TVA, taux
                    // 20 % », que le serveur refuse de toute façon.
                    patch({ vatRegime: value ? 'standard' : 'exempt', defaultVatBp: value ? 2000 : 0 })
                }
                label='Je facture la TVA'
                hint='À éteindre si vous relevez de la franchise en base, le cas d’une micro-entreprise sous les seuils.'
            />

            {liable ? (
                <div className={shell.field}>
                    <span className={shell.fieldLabel}>Taux d’une ligne neuve</span>
                    <SegmentedControl
                        value={String(draft.defaultVatBp)}
                        options={RATES}
                        disabled={!canWrite}
                        onChange={(value) => patch({ defaultVatBp: Number(value) })}
                        aria-label='Taux de TVA par défaut'
                    />
                    <span className={shell.fieldHint}>
                        Chaque document garde son propre taux : celui-ci n’est que le point de départ.
                    </span>
                </div>
            ) : (
                <label className={shell.field}>
                    <span className={shell.fieldLabel}>Mention portée sur vos documents</span>
                    <textarea
                        className={styles.textarea}
                        rows={2}
                        value={draft.wording.exemptionText}
                        disabled={!canWrite}
                        onChange={(e) => patch({ wording: { ...draft.wording, exemptionText: e.target.value } })}
                    />
                    <span className={shell.fieldHint}>
                        La formule usuelle est « TVA non applicable, article 293 B du CGI ». Une exonération d’une autre
                        nature a sa propre phrase, à écrire ici.
                    </span>
                </label>
            )}

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
