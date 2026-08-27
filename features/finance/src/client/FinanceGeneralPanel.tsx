import { useCallback, useEffect, useState } from 'react';
import { Button, humanizeError, SelectInput, settingsStyles as shell, Switch } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceConfig } from '../contracts/domain';

import { api, refreshFinance } from './api';

/**
 * Les devises proposées.
 *
 * Une liste courte et non les cent soixante codes ISO: le sélecteur sert à
 * choisir la devise de l'espace, une fois, et faire défiler cent soixante lignes
 * pour trouver EUR n'aide personne. Le champ reste un code ISO côté contrat, donc
 * élargir cette liste ne demande rien d'autre qu'une ligne ici.
 */
const CURRENCIES = [
    { code: 'EUR', label: 'Euro (€)' },
    { code: 'USD', label: 'Dollar américain ($)' },
    { code: 'GBP', label: 'Livre sterling (£)' },
    { code: 'CHF', label: 'Franc suisse (CHF)' },
    { code: 'CAD', label: 'Dollar canadien (CA$)' }
];

/**
 * Les réglages de la feature, et le seul commutateur qui la fait passer du foyer
 * à l'entreprise : le panneau Général de la coquille de réglages.
 *
 * Le mode entreprise n'ajoute pas un écran: il fait apparaître la TVA sur les
 * saisies et son récapitulatif sur le tableau de bord. Rien d'autre ne change,
 * parce que rien d'autre n'a besoin de changer: un livre de comptes est le même
 * objet des deux côtés.
 *
 * Autonome, comme tous les panneaux de la coquille : il se charge et se
 * sauvegarde tout seul, la coquille ne lui passe que la portée et le droit
 * d'écriture. Après l'enregistrement il ravive toutes les clés de la feature
 * (`refreshFinance`) : le socle de l'écran porte la devise et le mode
 * entreprise, tout l'écran en dépend, jusqu'au symbole de chaque montant. Sans
 * le droit d'écriture, les champs restent lisibles mais figés : un formulaire
 * que le serveur refuserait est un écran qui ment.
 */
export default function FinanceGeneralPanel({ canWrite }: SettingsPanelProps) {
    const [draft, setDraft] = useState<FinanceConfig | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('finance.config', {});
            setDraft(res.config);
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (busy || !draft) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('finance.configUpdate', { config: draft });
            setDraft(res.config);
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (!draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Devise</span>
                <SelectInput
                    value={draft.currency}
                    disabled={!canWrite}
                    onChange={(e) => setDraft((d) => (d ? { ...d, currency: e.target.value } : d))}
                >
                    {CURRENCIES.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                            {entry.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Une seule devise par espace. Les montants déjà saisis ne sont pas convertis: changer de devise ne
                    fait que changer le symbole affiché.
                </span>
            </div>

            <Switch
                checked={draft.vatEnabled}
                disabled={!canWrite}
                onChange={(value) => setDraft((d) => (d ? { ...d, vatEnabled: value } : d))}
                label='Mode entreprise (TVA)'
                hint='Ajoute la TVA aux saisies et son récapitulatif collectée / déductible au tableau de bord.'
            />

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Finances.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
