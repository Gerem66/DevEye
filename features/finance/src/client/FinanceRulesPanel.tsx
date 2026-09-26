import { useCallback, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    humanizeError,
    ReadOnlyNotice,
    SegmentedControl,
    SelectInput,
    settingsStyles as shell,
    TextInput,
    useResource,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceCategory } from '../contracts/domain';
import type { FinanceRule, StatementDirection } from '../contracts/statement';

import { api, refreshFinance } from './api';
import { VAT_RATES } from './format';
import { colorVar } from './shared';

interface Draft {
    id: number | null;
    contains: string;
    direction: StatementDirection;
    categoryId: number | null;
    vatRate: string;
}

const DIRECTIONS: { value: StatementDirection; label: string }[] = [
    { value: 'out', label: 'Une sortie' },
    { value: 'in', label: 'Une entrée' }
];

const VAT_OPTIONS = VAT_RATES.map((rate) => ({
    value: String(rate),
    label: rate === 0 ? 'Aucune' : `${String(rate).replace('.', ',')} %`
}));

/**
 * Les règles qui rangent les lignes de relevé sans rien demander : un texte
 * du libellé, une catégorie. Elles naissent surtout en rapprochant une ligne à
 * la main ; ici, on les relit, on les corrige, on les retire. La première qui
 * reconnaît une ligne l'emporte.
 */
export default function FinanceRulesPanel({ canWrite }: SettingsPanelProps) {
    const [editing, setEditing] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
        const [rules, categories, config] = await Promise.all([
            api.send('finance.ruleList', {}),
            api.send('finance.categoryList', {}),
            api.send('finance.config', {})
        ]);
        return { rules: rules.rules, categories: categories.categories, vatEnabled: config.config.vatEnabled };
    }, []);
    const { data, error: loadError, loading } = useResource('finance.ruleList', load, 'Chargement impossible.');
    const rules = data?.rules ?? [];
    const categories = data?.categories ?? [];
    const categoryOf = (id: number | null): FinanceCategory | undefined => categories.find((c) => c.id === id);

    const openForm = (rule: FinanceRule | null) => {
        setFormError(null);
        setEditing(
            rule
                ? {
                      id: rule.id,
                      contains: rule.contains,
                      direction: rule.direction ?? (categoryOf(rule.categoryId)?.flow === 'income' ? 'in' : 'out'),
                      categoryId: rule.categoryId,
                      vatRate: String((rule.vatRateBp ?? 0) / 100)
                  }
                : { id: null, contains: '', direction: 'out', categoryId: null, vatRate: '0' }
        );
    };

    const submit = async () => {
        if (editing === null || busy) return;
        const contains = editing.contains.trim();
        if (contains.length < 2 || editing.categoryId === null) return;
        setBusy(true);
        setFormError(null);
        try {
            await api.send('finance.ruleSave', {
                id: editing.id,
                rule: {
                    contains,
                    direction: editing.direction,
                    categoryId: editing.categoryId,
                    vatRateBp: editing.vatRate === '0' ? null : Math.round(Number(editing.vatRate) * 100)
                }
            });
            refreshFinance();
            setEditing(null);
        } catch (e) {
            setFormError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const askRemove = (rule: FinanceRule) =>
        setConfirm({
            title: `Retirer la règle « ${rule.contains} » ?`,
            description: 'Ce qu’elle a déjà rangé reste au livre. Les prochaines lignes attendront un choix.',
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await api.send('finance.ruleRemove', { id: rule.id });
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

    if (loading && !data) return <p className={shell.empty}>Chargement…</p>;

    const flow = editing?.direction === 'in' ? 'income' : 'expense';
    const choices = categories.filter((category) => category.flow === flow);

    return (
        <div className={shell.section}>
            <div className={shell.section}>
                <span className={shell.sectionLabel}>Règles</span>
                {rules.length === 0 ? (
                    <p className={shell.empty}>
                        Aucune règle. En rapprochant une ligne, cochez « Ranger ainsi, à l’avenir » : DevEye s’en
                        souviendra pour les suivantes.
                    </p>
                ) : (
                    <div className={shell.channelList}>
                        {rules.map((rule) => {
                            const category = categoryOf(rule.categoryId);
                            const vat = rule.vatRateBp
                                ? `, TVA ${String(rule.vatRateBp / 100).replace('.', ',')} %`
                                : '';
                            return (
                                <div key={rule.id} className={shell.channelRow}>
                                    <span
                                        className={`icon icon-${category?.icon ?? 'list'} ${shell.channelIcon}`}
                                        style={{ color: category ? colorVar(category.color) : undefined }}
                                        aria-hidden='true'
                                    />
                                    <span className={shell.channelText}>
                                        <span className={shell.channelLabel}>
                                            « {rule.contains} » dans {category?.name ?? 'une catégorie retirée'}
                                        </span>
                                        <span className={shell.channelMeta}>
                                            {rule.hits === 0
                                                ? `Rien rangé encore${vat}`
                                                : `${rule.hits} ligne${rule.hits > 1 ? 's' : ''} rangée${rule.hits > 1 ? 's' : ''}${vat}`}
                                        </span>
                                    </span>
                                    {canWrite && (
                                        <span className={shell.channelActions}>
                                            <button
                                                type='button'
                                                className={shell.rowAction}
                                                title='Modifier'
                                                aria-label={`Modifier la règle « ${rule.contains} »`}
                                                disabled={busy}
                                                onClick={() => openForm(rule)}
                                            >
                                                <span className='icon icon-edit' />
                                            </button>
                                            <button
                                                type='button'
                                                className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                                title='Retirer'
                                                aria-label={`Retirer la règle « ${rule.contains} »`}
                                                disabled={busy}
                                                onClick={() => askRemove(rule)}
                                            >
                                                <span className='icon icon-trash' />
                                            </button>
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                {canWrite && (
                    <div className={shell.sectionActions}>
                        <Button variant='secondary' icon='plus' disabled={busy} onClick={() => openForm(null)}>
                            Règle
                        </Button>
                    </div>
                )}
            </div>

            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier les règles : elles relèvent de l’écriture sur Finances.
                </ReadOnlyNotice>
            )}

            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.id === null ? 'Nouvelle règle' : 'Modifier la règle'}
                width={480}
                onSubmit={() => void submit()}
                footer={
                    <>
                        <DialogCancelButton>Annuler</DialogCancelButton>
                        <Button
                            onClick={() => void submit()}
                            disabled={
                                busy || (editing?.contains.trim().length ?? 0) < 2 || editing?.categoryId === null
                            }
                        >
                            {busy ? 'Enregistrement…' : editing?.id === null ? 'Ajouter' : 'Enregistrer'}
                        </Button>
                    </>
                }
            >
                {editing && (
                    <div className={shell.section}>
                        <label className={shell.field}>
                            <span className={shell.fieldLabel}>Le libellé contient</span>
                            <TextInput
                                data-autofocus
                                placeholder='ex. ovh'
                                maxLength={80}
                                value={editing.contains}
                                onChange={(e) => setEditing((d) => (d ? { ...d, contains: e.target.value } : d))}
                            />
                            <span className={shell.fieldHint}>
                                Sans égard aux majuscules ni aux accents : « ovh » reconnaît « PRLV SEPA OVH SAS ».
                            </span>
                        </label>

                        <div className={shell.field}>
                            <span className={shell.fieldLabel}>Pour</span>
                            <SegmentedControl
                                aria-label='Sens de la ligne'
                                options={DIRECTIONS}
                                value={editing.direction}
                                onChange={(direction) =>
                                    setEditing((d) =>
                                        d
                                            ? {
                                                  ...d,
                                                  direction,
                                                  categoryId: direction === d.direction ? d.categoryId : null
                                              }
                                            : d
                                    )
                                }
                            />
                        </div>

                        <label className={shell.field}>
                            <span className={shell.fieldLabel}>Range dans</span>
                            <SelectInput
                                value={editing.categoryId ?? ''}
                                onChange={(e) =>
                                    setEditing((d) =>
                                        d
                                            ? {
                                                  ...d,
                                                  categoryId: e.target.value === '' ? null : Number(e.target.value)
                                              }
                                            : d
                                    )
                                }
                            >
                                <option value=''>Choisir…</option>
                                {choices.map((category) => (
                                    <option key={category.id} value={category.id}>
                                        {category.name}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>

                        {data?.vatEnabled && (
                            <div className={shell.field}>
                                <span className={shell.fieldLabel}>TVA</span>
                                <SegmentedControl
                                    aria-label='Taux de TVA'
                                    options={VAT_OPTIONS}
                                    value={VAT_OPTIONS.some((o) => o.value === editing.vatRate) ? editing.vatRate : '0'}
                                    onChange={(vatRate) => setEditing((d) => (d ? { ...d, vatRate } : d))}
                                />
                            </div>
                        )}

                        {formError && <p className={shell.notice}>{formError}</p>}
                    </div>
                )}
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
