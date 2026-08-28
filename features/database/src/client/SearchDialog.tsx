import { useEffect, useState } from 'react';
import { Button, Dialog, SegmentedControl, SelectInput, TextInput } from 'deveye-sdk-client';
import type {
    DatabaseCombinator,
    DatabaseFilter,
    DatabaseFilterOperator,
    DatabaseStructure
} from '../contracts/domain';

import { FILTER_OPERATOR_LABELS, OPERATOR_NEEDS_VALUE } from './format';
import styles from './style.module.css';

interface SearchDialogProps {
    open: boolean;
    structure: DatabaseStructure;
    filters: DatabaseFilter[];
    combinator: DatabaseCombinator;
    onClose: () => void;
    onApply: (filters: DatabaseFilter[], combinator: DatabaseCombinator) => void;
}

const EMPTY: DatabaseFilter = { column: '', operator: 'contains', value: '' };

/** Les deux façons de relier les critères, en segments : deux choix fixes. */
const COMBINATORS: { value: DatabaseCombinator; label: string; title: string }[] = [
    { value: 'and', label: 'Tous (ET)', title: 'Tous les critères sont remplis' },
    { value: 'or', label: 'Au moins un (OU)', title: 'Au moins un critère est rempli' }
];

/**
 * Chercher dans une table, précisément.
 *
 * Un critère est un triplet **colonne / opérateur / valeur**, et non un morceau
 * de SQL : la colonne est choisie dans celles de la table, l'opérateur dans une
 * liste fermée, et la valeur reste une valeur — liée en paramètre, jamais
 * recollée dans la requête. C'est ce qui permet d'offrir la recherche sans
 * ouvrir une porte, et de la proposer aux mêmes conditions sur les deux moteurs.
 *
 * Les jokers d'un `LIKE` gardent leur sens : `%` remplace n'importe quelle
 * suite, `_` un caractère, `\%` un pourcentage littéral. C'est le comportement
 * de SQL, et l'écran n'a rien à en dire — une phrase pour prévenir du contraire
 * était le signe qu'on avait pris une liberté de trop.
 *
 * Le terminal, lui, est là pour ce que cette grille ne sait pas exprimer.
 */
export function SearchDialog({ open, structure, filters, combinator, onClose, onApply }: SearchDialogProps) {
    const [draft, setDraft] = useState<DatabaseFilter[]>([]);
    const [mode, setMode] = useState<DatabaseCombinator>('and');

    useEffect(() => {
        if (!open) return;
        // Repartir de ce qui est appliqué : on vient souvent affiner, pas
        // recommencer.
        setDraft(filters.length > 0 ? filters : [{ ...EMPTY, column: structure.columns[0]?.name ?? '' }]);
        setMode(combinator);
    }, [open, filters, combinator, structure]);

    const patch = (index: number, change: Partial<DatabaseFilter>) =>
        setDraft((list) => list.map((f, i) => (i === index ? { ...f, ...change } : f)));

    const usable = draft.filter((f) => f.column !== '');

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Rechercher dans ${structure.table}`}
            width={720}
            onSubmit={() => onApply(usable, mode)}
            footer={
                <>
                    <Button
                        variant='secondary'
                        className={styles.footerLead}
                        onClick={() => onApply([], mode)}
                        disabled={filters.length === 0}
                    >
                        Tout afficher
                    </Button>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button onClick={() => onApply(usable, mode)} disabled={usable.length === 0}>
                        Rechercher
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={styles.section}>
                    <div className={styles.field}>
                        <span className={styles.label}>Une ligne est retenue si</span>
                        <SegmentedControl
                            aria-label='Une ligne est retenue si'
                            options={COMBINATORS}
                            value={mode}
                            onChange={setMode}
                        />
                    </div>

                    {draft.map((filter, i) => (
                        <div key={i} className={styles.condition}>
                            <div className={styles.fieldRow}>
                                <label className={styles.field}>
                                    <span className={styles.label}>Colonne</span>
                                    <SelectInput
                                        value={filter.column}
                                        onChange={(e) => patch(i, { column: e.target.value })}
                                    >
                                        {structure.columns.map((c) => (
                                            <option key={c.name} value={c.name}>
                                                {c.name}
                                            </option>
                                        ))}
                                    </SelectInput>
                                </label>
                                <label className={styles.field}>
                                    <span className={styles.label}>Condition</span>
                                    <SelectInput
                                        value={filter.operator}
                                        onChange={(e) =>
                                            patch(i, { operator: e.target.value as DatabaseFilterOperator })
                                        }
                                    >
                                        {(Object.keys(FILTER_OPERATOR_LABELS) as DatabaseFilterOperator[]).map((id) => (
                                            <option key={id} value={id}>
                                                {FILTER_OPERATOR_LABELS[id]}
                                            </option>
                                        ))}
                                    </SelectInput>
                                </label>
                                {OPERATOR_NEEDS_VALUE[filter.operator] && (
                                    <label className={styles.field}>
                                        <span className={styles.label}>Valeur</span>
                                        <TextInput
                                            value={filter.value}
                                            onChange={(e) => patch(i, { value: e.target.value })}
                                        />
                                    </label>
                                )}
                                {draft.length > 1 && (
                                    <button
                                        type='button'
                                        className={styles.conditionRemove}
                                        aria-label='Retirer ce critère'
                                        onClick={() => setDraft((list) => list.filter((_, j) => j !== i))}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}

                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            icon='add'
                            disabled={draft.length >= 8}
                            onClick={() =>
                                setDraft((list) => [...list, { ...EMPTY, column: structure.columns[0]?.name ?? '' }])
                            }
                        >
                            Ajouter un critère
                        </Button>
                    </div>
                </div>
            </div>
        </Dialog>
    );
}

export default SearchDialog;
