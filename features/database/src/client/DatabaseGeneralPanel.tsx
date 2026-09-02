import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SelectInput,
    settingsStyles as shell,
    Switch,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { Database, DatabaseProbe } from '../contracts/domain';

import { api } from './api';
import {
    AccessFields,
    ConnectionFields,
    connectionComplete,
    connectionOf,
    connectionTarget,
    type ConnectionForm
} from './ConnectionFields';
import { ENGINE_LABELS, formatInterval } from './format';
import { ProbeLine } from './ProbeLine';
import styles from './style.module.css';

/** Cadences offertes, dans les bornes du contrat (une minute à un jour). */
const INTERVALS: { value: number; label: string }[] = [
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 heure' },
    { value: 21600, label: '6 heures' },
    { value: 86400, label: '1 jour' }
];

/** Tout ce que `database.update` prend, hors l'identifiant. */
interface Draft extends ConnectionForm {
    monitorEnabled: boolean;
    intervalSeconds: number;
    autoLoadTables: boolean;
}

function draftOf(database: Database): Draft {
    return {
        ...connectionOf(database),
        monitorEnabled: database.monitorEnabled,
        intervalSeconds: database.intervalSeconds,
        autoLoadTables: database.autoLoadTables
    };
}

function sameDraft(a: Draft, b: Draft): boolean {
    return (Object.keys(a) as (keyof Draft)[]).every((key) => a[key] === b[key]);
}

/**
 * La base elle-même : sa connexion, son accès (direct, tunnel SSH ou proxy
 * SOCKS), son relevé et sa suppression. L'onglet Général de ses réglages, là
 * où le bouton commun mène. Le dialogue, lui, ne sert qu'à AJOUTER une base :
 * ce geste n'a pas d'élément à viser.
 *
 * Un seul enregistrement : `database.update` prend la base entière. Les
 * secrets ne redescendent jamais : laissés vides, ceux qui sont enregistrés
 * restent en place, et « Tester » les reprend chez le serveur. Le moteur ne se
 * change pas : le relevé conservé serait celui de l'autre dialecte.
 */
export default function DatabaseGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [database, setDatabase] = useState<Database | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** L'essai en cours, et son résultat ; distinct de l'enregistrement. */
    const [testing, setTesting] = useState(false);
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (itemId === null) return;
        void api
            .send('database.get', { databaseId: itemId })
            .then((res) => {
                setDatabase(res.database);
                setDraft(draftOf(res.database));
            })
            .catch((e) => setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.')));
    }, [itemId]);

    if (!database || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    // Le serveur refuse d'ici la modification comme la suppression : la ligne
    // serait réécrite sous la clé de cet espace, illisible chez elle.
    if (database.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette base vient d’un autre espace : sa connexion, son relevé et sa suppression se règlent depuis
                là-bas.
            </p>
        );
    }

    const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
    const editable = canWrite && !busy;
    const complete = connectionComplete(draft);
    const unchanged = sameDraft(draft, draftOf(database));
    const projects =
        database.projectCount > 0
            ? `les ${database.projectCount} projet${database.projectCount > 1 ? 's' : ''} qui l’utilisent perdent leur lien`
            : 'les projets qui l’utiliseraient perdraient leur lien';

    /** Vide, le mot de passe n'est pas envoyé : le serveur garde celui en place. */
    const password = draft.password ? { password: draft.password } : {};

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.update', {
                databaseId: database.id,
                name: draft.name.trim(),
                ...connectionTarget(draft),
                ...password,
                monitorEnabled: draft.monitorEnabled,
                intervalSeconds: draft.intervalSeconds,
                autoLoadTables: draft.autoLoadTables
            });
            setDatabase(res.database);
            setDraft(draftOf(res.database));
            invalidate('database.list', 'database.detail', 'database.count');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (testing || !complete) return;
        setTesting(true);
        setProbe(null);
        setError(null);
        try {
            const res = await api.send('database.testDraft', {
                // Avec l'identifiant, le serveur reprend les secrets non ressaisis.
                databaseId: database.id,
                engine: database.engine,
                ...connectionTarget(draft),
                ...password
            });
            setProbe(res.probe);
        } catch (e) {
            setError(humanizeError(e, 'L’essai de connexion a échoué.'));
        } finally {
            setTesting(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('database.remove', { databaseId: database.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait une base qui n'existe plus.
            gone();
            invalidate('database.list', 'database.count', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    // Une cadence hors liste reste affichée telle quelle : un déroulant sans
    // la valeur courante montrerait la première.
    const intervals = INTERVALS.some((i) => i.value === draft.intervalSeconds)
        ? INTERVALS
        : [
              { value: draft.intervalSeconds, label: `${formatInterval(draft.intervalSeconds)} (réglage actuel)` },
              ...INTERVALS
          ];

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Moteur</span>
                <span className={shell.fieldLabel}>{ENGINE_LABELS[database.engine]}</span>
                <span className={shell.fieldHint}>
                    Le moteur ne se change pas après coup : le relevé conservé serait celui de l’autre dialecte. Pour en
                    viser un autre, ajoutez une base.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Connexion</span>
                <div className={styles.form}>
                    <ConnectionFields form={draft} onChange={patch} disabled={!editable} existing={database} />
                </div>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Accès</span>
                <div className={styles.form}>
                    <AccessFields form={draft} onChange={patch} disabled={!editable} existing={database} />
                </div>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Relevé</span>
                <Switch
                    checked={draft.monitorEnabled}
                    disabled={!editable}
                    onChange={(monitorEnabled) => patch({ monitorEnabled })}
                    label='Relever cette base régulièrement'
                    hint='Éteint (le réglage par défaut), rien ne se connecte : la base ne se joint qu’au moment où vous le demandez. Allumé, DevEye relève sa taille et son état, et c’est ce qui rend ses alertes vivantes.'
                />
            </div>

            {draft.monitorEnabled && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Fréquence de relève</span>
                    <SelectInput
                        value={draft.intervalSeconds}
                        disabled={!editable}
                        onChange={(e) => patch({ intervalSeconds: Number(e.target.value) })}
                    >
                        {intervals.map((i) => (
                            <option key={i.value} value={i.value}>
                                {i.label}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={shell.fieldHint}>
                        Chaque relevé ouvre une connexion, lit l’inventaire (version, taille, tables) et évalue les
                        alertes de la base. Rien de vos tables n’est copié.
                    </span>
                </div>
            )}

            <Switch
                checked={draft.autoLoadTables}
                disabled={!editable}
                onChange={(autoLoadTables) => patch({ autoLoadTables })}
                label='Charger les tables à l’ouverture de la fiche'
                hint='Éteint (le réglage par défaut), ouvrir la fiche de cette base ne joint aucun serveur : c’est « Charger les tables » qui va voir. Allumé, l’inventaire des tables est lu dès l’affichage de la fiche, ce qui fait gagner un clic sur une base qu’on consulte souvent et coûte une connexion à chaque ouverture.'
            />

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={save} disabled={busy || !complete || unchanged} />
                    <Button variant='secondary' disabled={busy || testing || !complete} onClick={() => void test()}>
                        {testing ? 'Essai…' : 'Tester la connexion'}
                    </Button>
                </div>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier une base : cela relève de l’écriture sur Bases de données.
                </ReadOnlyNotice>
            )}

            <ProbeLine testing={testing} probe={probe} />

            {error && <p className={shell.notice}>{error}</p>}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer cette base</span>
                    <span className={shell.fieldHint}>
                        Ses alertes et son historique de relevé sont perdus, et {projects}. Le serveur distant, lui,
                        n’est pas touché.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${database.name} » ?`,
                                    description: `Ses alertes et son historique de relevé sont perdus, et ${projects}. Le serveur distant n’est pas touché.`,
                                    confirmLabel: 'Supprimer la base',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer la base
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
