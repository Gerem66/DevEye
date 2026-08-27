import { useCallback, useState } from 'react';
import {
    Button,
    humanizeError,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useResource
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { FINANCE_COLORS, FINANCE_NAME_MAX_LENGTH } from '../contracts/domain';
import type { FinanceCategory, FinanceColor, FinanceFlow } from '../contracts/domain';

import { api, refreshFinance } from './api';
import { CATEGORY_ICONS, DEFAULT_CATEGORIES } from './format';
import { colorVar } from './shared';
import styles from './style.module.css';

/** Ce qu'on règle sur une catégorie. Le sens ne se change pas après coup. */
interface Draft {
    id: number | null;
    name: string;
    flow: FinanceFlow;
    color: FinanceColor;
    icon: string;
}

const EMPTY: Draft = { id: null, name: '', flow: 'expense', color: 'blue', icon: 'other' };

const FLOWS: { value: FinanceFlow; label: string }[] = [
    { value: 'expense', label: 'Dépense' },
    { value: 'income', label: 'Recette' }
];

/**
 * La grille de lecture: les catégories de dépenses et de recettes, le panneau
 * Catégories de la coquille de réglages.
 *
 * Un panneau de réglages et non un onglet: on y vient deux fois par an, et lui
 * donner une place permanente dans la barre pousserait vers le bas ce qu'on
 * ouvre tous les jours. Les fiches d'opération et de budget ne font que
 * **choisir** dans la liste ; quand il n'y a rien à choisir, elles mènent ici
 * par le bouton commun, au moment exact où on en a besoin (patron des sources).
 *
 * Autonome, comme tous les panneaux de la coquille : il se charge et
 * s'invalide tout seul. Sa liste est lue sur la clé `finance.accountList`,
 * celle du socle de l'écran (réglages, comptes, catégories, chargés en une
 * requête groupée) : une catégorie changée ici ravive les deux d'un coup, par
 * `refreshFinance`, et l'écran resté ouvert derrière suit sans re-cliquer.
 *
 * **Le sens d'une catégorie ne se change pas.** Le basculer rendrait fausses
 * toutes les opérations déjà classées dessous, et la répartition compterait une
 * sortie comme une entrée. Le formulaire ne le propose donc qu'à la création, et
 * le serveur refuse le changement de son côté.
 */
export default function FinanceCategoriesPanel({ canWrite }: SettingsPanelProps) {
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => (await api.send('finance.categoryList', {})).categories, []);
    const { data, error: loadError, loading } = useResource('finance.accountList', load, 'Chargement impossible.');
    const categories = data ?? [];

    const run = async (action: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            refreshFinance();
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
                    ? api.send('finance.categoryAdd', { category: payload })
                    : api.send('finance.categoryUpdate', { categoryId: draft.id, category: payload }),
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
    const seed = () =>
        run(async () => {
            for (const entry of DEFAULT_CATEGORIES) {
                await api.send('finance.categoryAdd', { category: entry });
            }
        }, 'Création impossible.');

    const edit = (category: FinanceCategory) =>
        setDraft({
            id: category.id,
            name: category.name,
            flow: category.flow,
            color: category.color,
            icon: category.icon
        });

    const remove = (category: FinanceCategory) =>
        run(() => api.send('finance.categoryRemove', { categoryId: category.id }), 'Suppression impossible.');

    const group = (flow: FinanceFlow, title: string) => {
        const rows = categories.filter((category) => category.flow === flow);
        return (
            <div className={shell.section}>
                <span className={shell.sectionLabel}>{title}</span>
                {rows.length === 0 ? (
                    <p className={shell.empty}>Aucune catégorie de {flow === 'income' ? 'recettes' : 'dépenses'}.</p>
                ) : (
                    <div className={shell.channelList}>
                        {rows.map((category) => (
                            <div key={category.id} className={shell.channelRow}>
                                <span
                                    className={`icon icon-${category.icon} ${shell.channelIcon}`}
                                    style={{ color: colorVar(category.color) }}
                                    aria-hidden='true'
                                />
                                <span className={shell.channelText}>
                                    <span className={shell.channelLabel}>{category.name}</span>
                                </span>
                                {canWrite && (
                                    <span className={shell.channelActions}>
                                        <button
                                            type='button'
                                            className={shell.rowAction}
                                            title='Modifier'
                                            aria-label={`Modifier ${category.name}`}
                                            disabled={busy}
                                            onClick={() => edit(category)}
                                        >
                                            <span className='icon icon-edit' />
                                        </button>
                                        <button
                                            type='button'
                                            className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                            title='Supprimer: les opérations classées ici retombent dans « Sans catégorie »'
                                            aria-label={`Supprimer ${category.name}`}
                                            disabled={busy}
                                            onClick={() => void remove(category)}
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    if (loading && !data) return <p className={shell.empty}>Chargement…</p>;

    return (
        <div className={shell.section}>
            {categories.length === 0 && canWrite && (
                <div className={shell.emptyRow}>
                    <span>
                        Aucune catégorie. Un jeu courant (logement, courses, salaire…) vous évite de tout créer à la
                        main, et reste modifiable ensuite.
                    </span>
                    <Button variant='secondary' disabled={busy} onClick={() => void seed()}>
                        {busy ? 'Création…' : 'Ajouter les catégories courantes'}
                    </Button>
                </div>
            )}

            {group('expense', 'Dépenses')}
            {group('income', 'Recettes')}

            {canWrite ? (
                <div className={shell.section}>
                    <span className={shell.sectionLabel}>
                        {draft.id === null ? 'Nouvelle catégorie' : 'Modifier la catégorie'}
                    </span>

                    <div className={styles.formRow}>
                        <div className={`${shell.field} ${styles.fieldWide}`}>
                            <span className={shell.fieldLabel}>Nom</span>
                            <TextInput
                                placeholder='ex. Logement'
                                maxLength={FINANCE_NAME_MAX_LENGTH}
                                value={draft.name}
                                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                            />
                        </div>

                        <div className={shell.field}>
                            <span className={shell.fieldLabel}>Sens</span>
                            {draft.id === null ? (
                                <SegmentedControl
                                    aria-label='Sens'
                                    options={FLOWS}
                                    value={draft.flow}
                                    onChange={(flow) => setDraft((d) => ({ ...d, flow }))}
                                />
                            ) : (
                                <span className={styles.fieldStatic}>
                                    {draft.flow === 'expense' ? 'Dépense' : 'Recette'}
                                    <span className={shell.fieldHint}>ne se change pas après coup</span>
                                </span>
                            )}
                        </div>
                    </div>

                    <div className={shell.field}>
                        <span className={shell.fieldLabel}>Couleur</span>
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

                    <div className={shell.field}>
                        <span className={shell.fieldLabel}>Icône</span>
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

                    <div className={shell.sectionActions}>
                        <Button onClick={() => void submit()} disabled={busy || draft.name.trim() === ''}>
                            {draft.id === null ? 'Ajouter' : 'Enregistrer'}
                        </Button>
                        {draft.id !== null && (
                            <Button variant='ghost' onClick={() => setDraft(EMPTY)}>
                                Annuler la modification
                            </Button>
                        )}
                    </div>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier les catégories : elles relèvent de l’écriture sur Finances.
                </p>
            )}

            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}
        </div>
    );
}
