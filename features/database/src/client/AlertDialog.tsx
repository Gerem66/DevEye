import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, humanizeError, SegmentedControl, SelectInput, TextInput } from 'deveye-sdk-client';
import type { DatabaseAlert, DatabaseCombinator, DatabaseComparator, DatabaseCondition } from '../contracts/domain';

import { api } from './api';
import { COMPARATOR_LABELS } from './format';
import styles from './style.module.css';

interface AlertDialogProps {
    open: boolean;
    databaseId: number;
    /** L'alerte modifiée ; `null` = on en crée une. */
    alert: DatabaseAlert | null;
    /** La surveillance est-elle active sur cette base ? Sinon l'alerte est inerte. */
    monitorEnabled: boolean;
    onClose: () => void;
    onSaved: () => void;
    onRemove?: () => void;
}

const EMPTY_CONDITION: DatabaseCondition = {
    sql: 'SELECT COUNT(*) FROM ',
    comparator: 'gt',
    threshold: 0,
    label: 'mesure'
};

/** Les deux façons de relier les conditions, en segments : deux choix fixes. */
const COMBINATORS: { value: DatabaseCombinator; label: string; title: string }[] = [
    { value: 'and', label: 'Toutes (ET)', title: 'Toutes les conditions sont remplies' },
    { value: 'or', label: 'Au moins une (OU)', title: 'Au moins une condition est remplie' }
];

/** Le résultat d'un essai, condition par condition. */
interface TestResult {
    firing: boolean;
    values: (number | null)[];
    errors: (string | null)[];
    elapsedMs: number;
}

/**
 * Écrire une alerte : des conditions, un opérateur, un message.
 *
 * Le bouton **« Essayer »** est le cœur de cet écran, pas un extra. Une
 * condition est une requête SQL dont on ne connaît pas le résultat avant de
 * l'avoir lancée : sans essai à blanc, on choisirait un seuil à l'aveugle et
 * l'on découvrirait son erreur par une notification, la nuit. L'essai n'écrit
 * rien et ne notifie personne.
 *
 * Ouvert depuis l'onglet Alertes des réglages de la base
 * (`DatabaseAlertsPanel`), et de là seulement : la fiche montre l'état des
 * alertes, la coquille de réglages les écrit. La suppression vit dans la zone
 * danger de ce dialogue, comme pour la base elle-même.
 */
export function AlertDialog({ open, databaseId, alert, monitorEnabled, onClose, onSaved, onRemove }: AlertDialogProps) {
    const [name, setName] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [combinator, setCombinator] = useState<DatabaseCombinator>('and');
    const [conditions, setConditions] = useState<DatabaseCondition[]>([EMPTY_CONDITION]);
    const [message, setMessage] = useState('');
    const [test, setTest] = useState<TestResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setTest(null);
        setError(null);
        setConfirmRemove(false);
        setName(alert?.name ?? '');
        setEnabled(alert?.enabled ?? true);
        setCombinator(alert?.combinator ?? 'and');
        setConditions(alert && alert.conditions.length > 0 ? alert.conditions : [EMPTY_CONDITION]);
        setMessage(alert?.message ?? '');
    }, [open, alert]);

    const patch = (index: number, change: Partial<DatabaseCondition>) =>
        setConditions((list) => list.map((c, i) => (i === index ? { ...c, ...change } : c)));

    const canSubmit = name.trim() !== '' && message.trim() !== '' && conditions.every((c) => c.sql.trim() !== '');

    const runTest = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.alertTest', { databaseId, combinator, conditions });
            setTest(res);
        } catch (e) {
            setError(humanizeError(e, 'L’essai n’a pas pu être fait.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const body = { name: name.trim(), enabled, combinator, conditions, message: message.trim() };
            if (alert) await api.send('database.alertUpdate', { alertId: alert.id, ...body });
            else await api.send('database.alertAdd', { databaseId, ...body });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={alert ? 'Modifier l’alerte' : 'Nouvelle alerte'}
            description='Une alerte compare le résultat de requêtes à des seuils, et prévient sur les canaux de l’espace.'
            width={720}
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
                {!monitorEnabled && (
                    <p className={styles.warn}>
                        La surveillance est éteinte sur cette base : cette alerte sera enregistrée mais{' '}
                        <strong>jamais évaluée</strong>. Activez « Relever cette base régulièrement » dans ses réglages
                        (Général) pour la rendre vivante.
                    </p>
                )}

                <div className={styles.section}>
                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.label}>Nom</span>
                            <TextInput
                                value={name}
                                autoFocus
                                placeholder='Trop d’erreurs'
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                        <div className={styles.field}>
                            <span className={styles.label}>Déclenche si</span>
                            <SegmentedControl
                                aria-label='Déclenche si'
                                options={COMBINATORS}
                                value={combinator}
                                onChange={setCombinator}
                            />
                        </div>
                    </div>

                    <Checkbox checked={enabled} onChange={setEnabled}>
                        <>
                            <span className={styles.label}>Alerte active</span>
                            <span className={styles.hint}>
                                Décochée, elle reste enregistrée avec ses conditions mais n’est plus évaluée.
                            </span>
                        </>
                    </Checkbox>
                </div>

                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Conditions</span>
                    <span className={styles.hint}>
                        Chaque requête doit rendre <strong>un seul nombre</strong> — une ligne, une colonne. C’est ce
                        qui permet de la comparer à un seuil et de la citer dans le message.
                    </span>

                    {conditions.map((condition, i) => (
                        <div key={i} className={styles.condition}>
                            <div className={styles.fieldRow}>
                                <label className={styles.fieldNarrow}>
                                    <span className={styles.label}>Nom court</span>
                                    <TextInput
                                        value={condition.label}
                                        onChange={(e) => patch(i, { label: e.target.value })}
                                    />
                                </label>
                                <label className={styles.fieldNarrow}>
                                    <span className={styles.label}>Comparaison</span>
                                    {/* Six comparateurs : un de trop pour une rangée de
                                        segments, le déroulant reste le bon outil. */}
                                    <SelectInput
                                        value={condition.comparator}
                                        onChange={(e) => patch(i, { comparator: e.target.value as DatabaseComparator })}
                                    >
                                        {(Object.keys(COMPARATOR_LABELS) as DatabaseComparator[]).map((id) => (
                                            <option key={id} value={id}>
                                                {COMPARATOR_LABELS[id]}
                                            </option>
                                        ))}
                                    </SelectInput>
                                </label>
                                <label className={styles.fieldNarrow}>
                                    <span className={styles.label}>Seuil</span>
                                    <TextInput
                                        value={String(condition.threshold)}
                                        inputMode='numeric'
                                        onChange={(e) => patch(i, { threshold: Number(e.target.value) || 0 })}
                                    />
                                </label>
                                {conditions.length > 1 && (
                                    <button
                                        type='button'
                                        className={styles.conditionRemove}
                                        aria-label='Retirer cette condition'
                                        onClick={() => setConditions((list) => list.filter((_, j) => j !== i))}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                )}
                            </div>
                            <textarea
                                className={styles.sqlField}
                                value={condition.sql}
                                rows={2}
                                spellCheck={false}
                                placeholder='SELECT COUNT(*) FROM logs WHERE level = &#39;error&#39;'
                                onChange={(e) => patch(i, { sql: e.target.value })}
                            />
                            {test && (
                                <span className={test.errors[i] ? styles.error : styles.hint}>
                                    {test.errors[i] ?? `A rendu ${test.values[i]}`}
                                </span>
                            )}
                        </div>
                    ))}

                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            icon='add'
                            disabled={conditions.length >= 8}
                            onClick={() => setConditions((list) => [...list, { ...EMPTY_CONDITION }])}
                        >
                            Ajouter une condition
                        </Button>
                        <Button variant='secondary' onClick={() => void runTest()} disabled={busy}>
                            {busy ? 'Essai…' : 'Essayer maintenant'}
                        </Button>
                    </div>

                    {test && (
                        <p className={test.firing ? styles.warn : styles.hint}>
                            {test.firing
                                ? `Dans l’état actuel, cette alerte se déclencherait (essai en ${test.elapsedMs} ms).`
                                : `Dans l’état actuel, cette alerte ne se déclencherait pas (essai en ${test.elapsedMs} ms).`}{' '}
                            Rien n’a été enregistré ni envoyé.
                        </p>
                    )}
                </div>

                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Message envoyé</span>
                    <label className={styles.field}>
                        <textarea
                            className={styles.sqlField}
                            value={message}
                            rows={3}
                            placeholder='Déjà {mesure} erreurs cette heure-ci sur la production.'
                            onChange={(e) => setMessage(e.target.value)}
                        />
                        <span className={styles.hint}>
                            Écrivez <code>{'{nom court}'}</code> pour insérer la valeur mesurée par la condition de ce
                            nom.
                        </span>
                    </label>
                </div>

                {onRemove && alert && (
                    <div className={styles.dangerZone}>
                        <div className={styles.dangerText}>
                            <span className={styles.label}>Supprimer cette alerte</span>
                            <span className={styles.hint}>Ses conditions et son historique sont perdus.</span>
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

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default AlertDialog;
