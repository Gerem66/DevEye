import { useEffect, useState } from 'react';
import type { FinanceCategory, FinanceColor, FinanceFlow } from 'deveye-types';
import { FINANCE_COLORS, FINANCE_NAME_MAX_LENGTH } from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';

import { humanizeError } from './api';
import { CATEGORY_ICONS, DEFAULT_CATEGORIES } from './format';
import { colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface CategoriesDialogProps {
    open: boolean;
    base: FinanceBase;
    onClose: () => void;
    onChanged: () => void;
}

/** Ce qu'on règle sur une catégorie. Le sens ne se change pas après coup. */
interface Draft {
    id: number | null;
    name: string;
    flow: FinanceFlow;
    color: FinanceColor;
    icon: string;
}

const EMPTY: Draft = { id: null, name: '', flow: 'expense', color: 'blue', icon: 'other' };

/**
 * La grille de lecture: les catégories de dépenses et de recettes.
 *
 * Un dialogue et non un onglet: on y vient deux fois par an, et lui donner une
 * place permanente dans la barre pousserait vers le bas ce qu'on ouvre tous les
 * jours. Il s'ouvre aussi depuis le sélecteur d'une saisie quand il n'y a rien à
 * choisir, c'est-à-dire au moment exact où on en a besoin.
 *
 * **Le sens d'une catégorie ne se change pas.** Le basculer rendrait fausses
 * toutes les opérations déjà classées dessous, et la répartition compterait une
 * sortie comme une entrée. Le formulaire ne le propose donc qu'à la création, et
 * le serveur refuse le changement de son côté.
 */
export function CategoriesDialog({ open, base, onClose, onChanged }: CategoriesDialogProps) {
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(EMPTY);
        setError(null);
    }, [open]);

    const run = async (action: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            onChanged();
            return true;
        } catch (e) {
            setError(humanizeError(e, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        const name = draft.name.trim();
        if (name === '' || busy) return;
        const payload = { name, flow: draft.flow, color: draft.color, icon: draft.icon };
        const ok = await run(
            () =>
                draft.id === null
                    ? ws.send('finance.categoryAdd', { category: payload })
                    : ws.send('finance.categoryUpdate', { categoryId: draft.id, category: payload }),
            'Enregistrement impossible.'
        );
        // Le formulaire se vide après un ajout réussi, comme partout ailleurs
        // dans l'application, pour enchaîner sans avoir à effacer.
        if (ok) setDraft({ ...EMPTY, flow: draft.flow });
    };

    /**
     * Le jeu de départ, posé en une fois.
     *
     * Séquentiel et non en parallèle: chaque création prend son rang en bout de
     * liste, et les lancer ensemble les ferait toutes viser le même.
     */
    const seed = async () => {
        setBusy(true);
        setError(null);
        try {
            for (const entry of DEFAULT_CATEGORIES) {
                await ws.send('finance.categoryAdd', { category: entry });
            }
            onChanged();
        } catch (e) {
            setError(humanizeError(e, 'Création impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const list = (flow: FinanceFlow) => base.categories.filter((category) => category.flow === flow);

    const section = (flow: FinanceFlow, title: string) => (
        <section className={styles.categoryGroup}>
            <h4 className={styles.categoryGroupHead}>{title}</h4>
            {list(flow).length === 0 ? (
                <p className={styles.placeholder}>Aucune.</p>
            ) : (
                <ul className={styles.categoryList}>
                    {list(flow).map((category: FinanceCategory) => (
                        <li key={category.id} className={styles.categoryRow}>
                            <button
                                type='button'
                                className={styles.categoryPick}
                                disabled={!base.canWrite}
                                onClick={() =>
                                    setDraft({
                                        id: category.id,
                                        name: category.name,
                                        flow: category.flow,
                                        color: category.color,
                                        icon: category.icon
                                    })
                                }
                            >
                                <span
                                    className={`icon icon-${category.icon} ${styles.shareIcon}`}
                                    style={{ color: colorVar(category.color) }}
                                />
                                <span className={styles.shareName}>{category.name}</span>
                            </button>
                            {base.canWrite && (
                                <button
                                    type='button'
                                    className={styles.categoryRemove}
                                    aria-label={`Supprimer ${category.name}`}
                                    title='Supprimer: les opérations classées ici retombent dans « Sans catégorie »'
                                    disabled={busy}
                                    onClick={() =>
                                        void run(
                                            () => ws.send('finance.categoryRemove', { categoryId: category.id }),
                                            'Suppression impossible.'
                                        )
                                    }
                                >
                                    <span className='icon icon-trash' />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Catégories'
            width={620}
            tall
            onSubmit={() => void submit()}
            footer={
                <div className={styles.popupActions}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                </div>
            }
        >
            <div className={styles.categoriesBody}>
                {base.categories.length === 0 && base.canWrite && (
                    <div className={styles.seedBand}>
                        <span>
                            Aucune catégorie. Un jeu courant (logement, courses, salaire…) vous évite de tout créer à la
                            main, et reste modifiable ensuite.
                        </span>
                        <Button variant='secondary' disabled={busy} onClick={() => void seed()}>
                            {busy ? 'Création…' : 'Ajouter les catégories courantes'}
                        </Button>
                    </div>
                )}

                <div className={styles.categoryColumns}>
                    {section('expense', 'Dépenses')}
                    {section('income', 'Recettes')}
                </div>

                {base.canWrite && (
                    <div className={styles.categoryForm}>
                        <h4 className={styles.categoryGroupHead}>
                            {draft.id === null ? 'Nouvelle catégorie' : 'Modifier la catégorie'}
                        </h4>

                        <div className={styles.formRow}>
                            <label className={styles.fieldWide}>
                                <span className={styles.fieldLabel}>Nom</span>
                                <TextInput
                                    data-autofocus='true'
                                    placeholder='ex. Logement'
                                    maxLength={FINANCE_NAME_MAX_LENGTH}
                                    value={draft.name}
                                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                                />
                            </label>

                            <div className={styles.field}>
                                <span className={styles.fieldLabel}>Sens</span>
                                {draft.id === null ? (
                                    <div className={styles.segmented} role='tablist' aria-label='Sens'>
                                        <button
                                            type='button'
                                            role='tab'
                                            aria-selected={draft.flow === 'expense'}
                                            className={draft.flow === 'expense' ? styles.segmentActive : styles.segment}
                                            onClick={() => setDraft((d) => ({ ...d, flow: 'expense' }))}
                                        >
                                            Dépense
                                        </button>
                                        <button
                                            type='button'
                                            role='tab'
                                            aria-selected={draft.flow === 'income'}
                                            className={draft.flow === 'income' ? styles.segmentActive : styles.segment}
                                            onClick={() => setDraft((d) => ({ ...d, flow: 'income' }))}
                                        >
                                            Recette
                                        </button>
                                    </div>
                                ) : (
                                    <span className={styles.fieldStatic}>
                                        {draft.flow === 'expense' ? 'Dépense' : 'Recette'}
                                        <span className={styles.fieldHint}>ne se change pas après coup</span>
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Couleur</span>
                            <div className={styles.swatches}>
                                {FINANCE_COLORS.map((color) => (
                                    <button
                                        key={color}
                                        type='button'
                                        aria-label={color}
                                        aria-pressed={draft.color === color}
                                        className={draft.color === color ? styles.swatchActive : styles.swatch}
                                        style={{ background: colorVar(color) }}
                                        onClick={() => setDraft((d) => ({ ...d, color }))}
                                    />
                                ))}
                            </div>
                        </div>

                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Icône</span>
                            <div className={styles.iconGrid}>
                                {CATEGORY_ICONS.map((icon) => (
                                    <button
                                        key={icon}
                                        type='button'
                                        aria-label={icon}
                                        aria-pressed={draft.icon === icon}
                                        className={draft.icon === icon ? styles.iconPickActive : styles.iconPick}
                                        onClick={() => setDraft((d) => ({ ...d, icon }))}
                                    >
                                        <span className={`icon icon-${icon}`} />
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className={styles.categoryFormActions}>
                            {draft.id !== null && (
                                <Button variant='ghost' onClick={() => setDraft(EMPTY)}>
                                    Annuler la modification
                                </Button>
                            )}
                            <Button onClick={() => void submit()} disabled={busy || draft.name.trim() === ''}>
                                {draft.id === null ? 'Ajouter' : 'Enregistrer'}
                            </Button>
                        </div>
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default CategoriesDialog;
