import { useCallback, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    humanizeError,
    ReadOnlyNotice,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useResource,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { FINANCE_NAME_MAX_LENGTH } from '../contracts/domain';
import type { FinanceCategory, FinanceColor, FinanceFlow } from '../contracts/domain';

import ColorPicker from './ColorPicker';
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

const FLOWS: { value: FinanceFlow; label: string }[] = [
    { value: 'expense', label: 'Dépense' },
    { value: 'income', label: 'Recette' }
];

/**
 * Les catégories, onglet de la coquille de réglages : le seul endroit où elles
 * se créent, se corrigent et se retirent. La liste suit la clé du socle de
 * l'écran (`finance.accountList`) : une catégorie changée ici ravive les deux
 * d'un coup par `refreshFinance`. Le sens ne se change pas : toutes les
 * opérations classées dessous deviendraient fausses.
 */
export default function FinanceCategoriesPanel({ canWrite }: SettingsPanelProps) {
    const [editing, setEditing] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => (await api.send('finance.categoryList', {})).categories, []);
    const { data, error: loadError, loading } = useResource('finance.accountList', load, 'Chargement impossible.');
    const categories = data ?? [];

    const openForm = (flow: FinanceFlow, category: FinanceCategory | null) => {
        setFormError(null);
        setEditing(
            category
                ? {
                      id: category.id,
                      name: category.name,
                      flow: category.flow,
                      color: category.color,
                      icon: category.icon
                  }
                : { id: null, name: '', flow, color: 'blue', icon: 'other' }
        );
    };

    const submit = async () => {
        if (editing === null || busy) return;
        const name = editing.name.trim();
        if (name === '') return;
        const payload = { name, flow: editing.flow, color: editing.color, icon: editing.icon };
        setBusy(true);
        setFormError(null);
        try {
            if (editing.id === null) await api.send('finance.categoryAdd', { category: payload });
            else await api.send('finance.categoryUpdate', { categoryId: editing.id, category: payload });
            refreshFinance();
            setEditing(null);
        } catch (e) {
            setFormError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    /** Séquentiel : chaque création prend son rang en bout de liste, en parallèle elles viseraient le même. */
    const seed = async () => {
        setBusy(true);
        setError(null);
        try {
            for (const entry of DEFAULT_CATEGORIES) {
                await api.send('finance.categoryAdd', { category: entry });
            }
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, 'Création impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const askRemove = (category: FinanceCategory) =>
        setConfirm({
            title: `Retirer « ${category.name} » ?`,
            description: 'Les opérations classées ici retombent dans « Sans catégorie ». Rien d’autre ne change.',
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await api.send('finance.categoryRemove', { categoryId: category.id });
                        refreshFinance();
                    } catch (e) {
                        setError(humanizeError(e, 'Retrait impossible.'));
                    } finally {
                        setBusy(false);
                        setConfirm(null);
                    }
                })();
            }
        });

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
                                            onClick={() => openForm(flow, category)}
                                        >
                                            <span className='icon icon-edit' />
                                        </button>
                                        <button
                                            type='button'
                                            className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                            title='Retirer'
                                            aria-label={`Retirer ${category.name}`}
                                            disabled={busy}
                                            onClick={() => askRemove(category)}
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                {canWrite && (
                    <div className={shell.sectionActions}>
                        <Button variant='secondary' icon='plus' disabled={busy} onClick={() => openForm(flow, null)}>
                            {flow === 'income' ? 'Catégorie de recettes' : 'Catégorie de dépenses'}
                        </Button>
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
                        Aucune catégorie. Le jeu courant d’une activité (prestations, hébergement, logiciels,
                        cotisations…) vous évite de tout créer à la main, et reste modifiable ensuite.
                    </span>
                    <Button variant='secondary' disabled={busy} onClick={() => void seed()}>
                        {busy ? 'Création…' : 'Ajouter le jeu courant'}
                    </Button>
                </div>
            )}

            {group('income', 'Recettes')}
            {group('expense', 'Dépenses')}

            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier les catégories : elles relèvent de l’écriture sur Finances.
                </ReadOnlyNotice>
            )}

            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.id === null ? 'Nouvelle catégorie' : 'Modifier la catégorie'}
                width={480}
                onSubmit={() => void submit()}
                footer={
                    <>
                        <DialogCancelButton>Annuler</DialogCancelButton>
                        <Button onClick={() => void submit()} disabled={busy || !editing?.name.trim()}>
                            {busy ? 'Enregistrement…' : editing?.id === null ? 'Ajouter' : 'Enregistrer'}
                        </Button>
                    </>
                }
            >
                {editing && (
                    <div className={shell.section}>
                        <label className={shell.field}>
                            <span className={shell.fieldLabel}>Nom</span>
                            <TextInput
                                data-autofocus
                                placeholder='ex. Hébergement'
                                maxLength={FINANCE_NAME_MAX_LENGTH}
                                value={editing.name}
                                onChange={(e) => setEditing((d) => (d ? { ...d, name: e.target.value } : d))}
                            />
                        </label>

                        <div className={shell.field}>
                            <span className={shell.fieldLabel}>Sens</span>
                            {editing.id === null ? (
                                <SegmentedControl
                                    aria-label='Sens'
                                    options={FLOWS}
                                    value={editing.flow}
                                    onChange={(flow) => setEditing((d) => (d ? { ...d, flow } : d))}
                                />
                            ) : (
                                <span className={styles.fieldStatic}>
                                    {editing.flow === 'expense' ? 'Dépense' : 'Recette'}
                                    <span className={shell.fieldHint}>
                                        Ne se change pas : les opérations classées ici deviendraient fausses.
                                    </span>
                                </span>
                            )}
                        </div>

                        <div className={shell.field}>
                            <span className={shell.fieldLabel}>Couleur</span>
                            <ColorPicker
                                aria-label='Couleur de la catégorie'
                                value={editing.color}
                                onChange={(color) => setEditing((d) => (d ? { ...d, color } : d))}
                            />
                        </div>

                        <div className={shell.field}>
                            <span className={shell.fieldLabel}>Icône</span>
                            <div className={styles.iconGrid} role='radiogroup' aria-label='Icône de la catégorie'>
                                {CATEGORY_ICONS.map((icon) => (
                                    <button
                                        key={icon.id}
                                        type='button'
                                        role='radio'
                                        aria-label={icon.label}
                                        title={icon.label}
                                        aria-checked={editing.icon === icon.id}
                                        className={editing.icon === icon.id ? styles.iconPickActive : styles.iconPick}
                                        onClick={() => setEditing((d) => (d ? { ...d, icon: icon.id } : d))}
                                    >
                                        <span className={`icon icon-${icon.id}`} aria-hidden='true' />
                                    </button>
                                ))}
                            </div>
                        </div>

                        {formError && <p className={shell.notice}>{formError}</p>}
                    </div>
                )}
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
