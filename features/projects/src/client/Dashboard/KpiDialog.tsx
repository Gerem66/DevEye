import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, humanizeError, SearchSelect, TextInput, type SearchSelectOption } from 'deveye-sdk-client';

import { api } from '../api';
import {
    DASHBOARD_KPI_SQL_MAX_LENGTH,
    DASHBOARD_KPI_TITLE_MAX_LENGTH,
    DASHBOARD_KPI_UNIT_MAX_LENGTH,
    type DashboardComparator,
    type DashboardKpi,
    type DashboardTile
} from '../../contracts/domain';
import styles from '../style.module.css';

const COMPARATOR_LABELS: Record<DashboardComparator, string> = {
    gt: 'dépasse',
    gte: 'atteint ou dépasse',
    lt: 'descend sous',
    lte: 'atteint ou descend sous',
    eq: 'vaut',
    ne: 'diffère de'
};

const COMPARATOR_OPTIONS: readonly SearchSelectOption<DashboardComparator | ''>[] = [
    { value: '', label: 'jamais' },
    ...(Object.keys(COMPARATOR_LABELS) as DashboardComparator[]).map((value) => ({
        value,
        label: COMPARATOR_LABELS[value]
    }))
];

interface KpiDialogProps {
    open: boolean;
    projectId: number;
    /** La tuile en cours d'édition ; `null` = création. */
    editing: DashboardTile | null;
    /** Les bases reliées au projet, nommées : la seule surface qu'un indicateur mesure. */
    databases: readonly { id: number; name: string }[];
    onClose: () => void;
    onSaved: (tiles: DashboardTile[]) => void;
}

/**
 * Un indicateur sur mesure : une requête de lecture contre une base reliée au
 * projet, qui rend un seul nombre. Le sélecteur ne propose que les bases
 * reliées, ce que le serveur exige de toute façon : une base non reliée n'est
 * pas offerte puis refusée.
 */
export function KpiDialog({ open, projectId, editing, databases, onClose, onSaved }: KpiDialogProps) {
    const [title, setTitle] = useState('');
    const [databaseId, setDatabaseId] = useState('');
    const [sql, setSql] = useState('');
    const [unit, setUnit] = useState('');
    const [comparator, setComparator] = useState<DashboardComparator | ''>('');
    const [threshold, setThreshold] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Ce qu'a rendu le dernier essai ; `null` = aucun depuis l'ouverture. */
    const [tried, setTried] = useState<{ value: number | null; error: string | null } | null>(null);

    /*
     * Les bases ne sont lues qu'à l'ouverture : elles changent d'identité quand
     * un résumé arrive, et les mettre en dépendance remettrait le formulaire à
     * zéro sous les doigts.
     */
    const databasesRef = useRef(databases);
    databasesRef.current = databases;

    useEffect(() => {
        if (!open) return;
        const kpi: DashboardKpi | null = editing?.kpi ?? null;
        setTitle(kpi?.title ?? '');
        setDatabaseId(kpi ? String(kpi.databaseId) : String(databasesRef.current[0]?.id ?? ''));
        setSql(kpi?.sql ?? '');
        setUnit(kpi?.unit ?? '');
        setComparator(kpi?.comparator ?? '');
        setThreshold(kpi?.threshold === null || kpi === null ? '' : String(kpi.threshold));
        setError(null);
        setTried(null);
    }, [open, editing]);

    const draft = () => ({
        title: title.trim(),
        sql: sql.trim(),
        unit: unit.trim(),
        comparator: comparator === '' ? null : comparator,
        threshold: comparator === '' || threshold.trim() === '' ? null : Number(threshold)
    });

    const ready = title.trim() !== '' && sql.trim() !== '' && databaseId !== '';

    const test = () => {
        setBusy(true);
        setError(null);
        void api
            .send('projects.dashboardKpiTest', { projectId, databaseId: Number(databaseId), sql: sql.trim() })
            .then(setTried)
            .catch((e: unknown) => setError(humanizeError(e, 'L’essai a échoué.')))
            .finally(() => setBusy(false));
    };

    const submit = () => {
        if (!ready || busy) return;
        setBusy(true);
        setError(null);
        void api
            .send('projects.dashboardKpiSave', {
                projectId,
                ...(editing === null ? {} : { tileKey: editing.key }),
                databaseId: Number(databaseId),
                kpi: draft()
            })
            .then((res) => onSaved(res.tiles))
            .catch((e: unknown) => setError(humanizeError(e, 'L’enregistrement a échoué.')))
            .finally(() => setBusy(false));
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={editing === null ? 'Ajouter un indicateur' : 'Modifier l’indicateur'}
            description='Une requête de lecture contre une base reliée à ce projet, qui rend un seul nombre.'
            width={620}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button variant='secondary' onClick={test} disabled={busy || !ready}>
                        Tester
                    </Button>
                    <Button onClick={submit} disabled={busy || !ready}>
                        Enregistrer
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Intitulé</span>
                    <TextInput
                        data-autofocus
                        value={title}
                        maxLength={DASHBOARD_KPI_TITLE_MAX_LENGTH}
                        placeholder='Commandes payées aujourd’hui'
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Base</span>
                    <SearchSelect
                        value={databaseId}
                        onChange={setDatabaseId}
                        options={databases.map((d) => ({ value: String(d.id), label: d.name }))}
                        placeholder={databases.length === 0 ? 'Aucune base reliée à ce projet' : 'Choisir une base…'}
                        aria-label='Base'
                    />
                    <span className={styles.hint}>
                        Seules les bases reliées à ce projet se mesurent. Reliez-en une dans l’onglet Bases de données.
                    </span>
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Requête</span>
                    <textarea
                        className={styles.textarea}
                        value={sql}
                        rows={4}
                        maxLength={DASHBOARD_KPI_SQL_MAX_LENGTH}
                        placeholder='SELECT COUNT(*) FROM orders WHERE paid_at IS NOT NULL'
                        onChange={(e) => setSql(e.target.value)}
                    />
                    <span className={styles.hint}>
                        Une seule instruction de lecture (SELECT, WITH, SHOW, EXPLAIN), qui rend une seule ligne et une
                        seule colonne.
                    </span>
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Unité</span>
                    <TextInput
                        value={unit}
                        maxLength={DASHBOARD_KPI_UNIT_MAX_LENGTH}
                        placeholder='commandes'
                        onChange={(e) => setUnit(e.target.value)}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Teinter quand le nombre…</span>
                    <div className={styles.row}>
                        <SearchSelect
                            value={comparator}
                            onChange={setComparator}
                            options={COMPARATOR_OPTIONS}
                            aria-label='Teinter quand le nombre…'
                        />
                        {comparator !== '' && (
                            <TextInput
                                value={threshold}
                                inputMode='decimal'
                                placeholder='0'
                                onChange={(e) => setThreshold(e.target.value)}
                            />
                        )}
                    </div>
                </label>

                {tried && (
                    <p className={tried.error === null ? styles.hint : styles.error}>
                        {tried.error ?? `La requête rend ${tried.value}.`}
                    </p>
                )}
                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default KpiDialog;
