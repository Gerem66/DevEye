import { useEffect, useState } from 'react';
import { Button, Dialog, errorNote, ErrorNote, TextInput, type ErrorNoteInput } from 'deveye-sdk-client';
import type { DatabaseKpi } from '../contracts/domain';

import { api } from './api';
import { formatKpiValue } from './format';
import styles from './style.module.css';

interface KpiDialogProps {
    open: boolean;
    databaseId: number;
    /** L'indicateur modifié ; `null` = on en crée un. */
    kpi: DatabaseKpi | null;
    onClose: () => void;
    onSaved: () => void;
    onRemove?: () => void;
}

/**
 * Écrire un indicateur : un nom, une requête qui rend un nombre, une unité.
 * L'essai se fait sans rien enregistrer ; l'enregistrement mesure aussitôt.
 */
export function KpiDialog({ open, databaseId, kpi, onClose, onSaved, onRemove }: KpiDialogProps) {
    const [label, setLabel] = useState('');
    const [sql, setSql] = useState('');
    const [unit, setUnit] = useState('');
    const [test, setTest] = useState<{ value: number | null; error: string | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setTest(null);
        setError(null);
        setConfirmRemove(false);
        setLabel(kpi?.label ?? '');
        setSql(kpi?.sql ?? '');
        setUnit(kpi?.unit ?? '');
    }, [open, kpi]);

    const canSubmit = label.trim() !== '' && sql.trim() !== '';

    const runTest = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.alertTest', {
                databaseId,
                combinator: 'and',
                conditions: [{ sql, comparator: 'gt', threshold: 0, label: 'mesure' }]
            });
            setTest({ value: res.values[0] ?? null, error: res.errors[0] ?? null });
        } catch (e) {
            setError(errorNote(e, 'L’essai n’a pas pu être fait.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('database.kpiSave', { databaseId, kpiId: kpi?.id, label, sql, unit });
            onSaved();
        } catch (e) {
            setError(errorNote(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={kpi ? 'Modifier l’indicateur' : 'Nouvel indicateur'}
            description='Un indicateur garde sous les yeux le résultat d’une requête, sur la fiche de la base.'
            width={640}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !canSubmit}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={styles.section}>
                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.label}>Nom</span>
                            <TextInput
                                value={label}
                                autoFocus
                                placeholder='Commandes'
                                onChange={(e) => setLabel(e.target.value)}
                            />
                        </label>
                        <label className={styles.fieldNarrow}>
                            <span className={styles.label}>Unité</span>
                            <TextInput value={unit} placeholder='€' onChange={(e) => setUnit(e.target.value)} />
                        </label>
                    </div>
                </div>

                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Requête</span>
                    <span className={styles.hint}>
                        Elle doit rendre <strong>un seul nombre</strong> : une ligne, une colonne. Elle est rejouée à
                        chaque relevé de la base.
                    </span>
                    <textarea
                        className={styles.sqlField}
                        value={sql}
                        rows={3}
                        spellCheck={false}
                        aria-label='Requête'
                        placeholder='SELECT COUNT(*) FROM commandes'
                        onChange={(e) => {
                            setSql(e.target.value);
                            setTest(null);
                        }}
                    />
                    <div className={styles.actions}>
                        <Button variant='secondary' onClick={() => void runTest()} disabled={busy || sql.trim() === ''}>
                            {busy ? 'Essai…' : 'Essayer maintenant'}
                        </Button>
                        {test && (
                            <span className={test.error ? styles.error : styles.hint}>
                                {test.error ??
                                    `A rendu ${formatKpiValue(test.value ?? 0)}${unit.trim() ? ` ${unit.trim()}` : ''}`}
                            </span>
                        )}
                    </div>
                </div>

                {onRemove && kpi && (
                    <div className={styles.dangerZone}>
                        <div className={styles.dangerText}>
                            <span className={styles.label}>Supprimer cet indicateur</span>
                            <span className={styles.hint}>Sa tuile quitte la fiche ; les alertes restent.</span>
                        </div>
                        {confirmRemove ? (
                            <div className={styles.actions}>
                                <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={onRemove} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button variant='danger' onClick={() => setConfirmRemove(true)} disabled={busy}>
                                Supprimer
                            </Button>
                        )}
                    </div>
                )}

                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default KpiDialog;
