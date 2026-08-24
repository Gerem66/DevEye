import { useEffect, useState } from 'react';
import type { FinanceConfig } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import Switch from '@/Components/Switch';

import { humanizeError } from './api';
import styles from './style.module.css';

interface SettingsDialogProps {
    open: boolean;
    config: FinanceConfig;
    onClose: () => void;
    onSaved: () => void;
    onOpenCategories: () => void;
}

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
 * à l'entreprise.
 *
 * Le mode entreprise n'ajoute pas un écran: il fait apparaître la TVA sur les
 * saisies et son récapitulatif sur le tableau de bord. Rien d'autre ne change,
 * parce que rien d'autre n'a besoin de changer: un livre de comptes est le même
 * objet des deux côtés.
 */
export function SettingsDialog({ open, config, onClose, onSaved, onOpenCategories }: SettingsDialogProps) {
    const [draft, setDraft] = useState<FinanceConfig>(config);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(config);
        setError(null);
    }, [open, config]);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await ws.send('finance.configUpdate', { config: draft });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} title='Réglages des finances' width={480} onSubmit={() => void submit()}>
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Devise</span>
                    <SelectInput
                        value={draft.currency}
                        onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
                    >
                        {CURRENCIES.map((entry) => (
                            <option key={entry.code} value={entry.code}>
                                {entry.label}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={styles.fieldHint}>
                        Une seule devise par espace. Les montants déjà saisis ne sont pas convertis: changer de devise
                        ne fait que changer le symbole affiché.
                    </span>
                </label>

                <Switch
                    checked={draft.vatEnabled}
                    onChange={(value) => setDraft((d) => ({ ...d, vatEnabled: value }))}
                    label='Mode entreprise (TVA)'
                    hint='Ajoute la TVA aux saisies et son récapitulatif collectée / déductible au tableau de bord.'
                />

                <div className={styles.settingsLink}>
                    <span>Catégories de dépenses et de recettes</span>
                    <Button variant='secondary' onClick={onOpenCategories}>
                        Gérer
                    </Button>
                </div>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                </div>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
            </div>
        </Dialog>
    );
}

export default SettingsDialog;
