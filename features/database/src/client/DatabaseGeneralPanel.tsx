import { useCallback, useEffect, useState } from 'react';
import { SaveButton, humanizeError, invalidate, SelectInput, settingsStyles as shell, Switch } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { Database } from '../contracts/domain';

import { api } from './api';
import { formatInterval } from './format';

/** Cadences offertes, dans les bornes du contrat (une minute à un jour). */
const INTERVALS: { value: number; label: string }[] = [
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 heure' },
    { value: 21600, label: '6 heures' },
    { value: 86400, label: '1 jour' }
];

interface Tuning {
    monitorEnabled: boolean;
    intervalSeconds: number;
    autoLoadTables: boolean;
}

function tuningOf(database: Database): Tuning {
    return {
        monitorEnabled: database.monitorEnabled,
        intervalSeconds: database.intervalSeconds,
        autoLoadTables: database.autoLoadTables
    };
}

/**
 * Le panneau Général d'une base : relevé périodique, cadence, chargement des
 * tables. Autonome : il charge la base et se sauvegarde par `database.update`,
 * dont le contrat prend la base entière (identité recomposée, secrets non
 * envoyés donc conservés). Une base projetée se lit ici mais se règle chez elle.
 */
export default function DatabaseGeneralPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [database, setDatabase] = useState<Database | null>(null);
    const [draft, setDraft] = useState<Tuning | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (itemId === null) return;
        try {
            const res = await api.send('database.get', { databaseId: itemId });
            setDatabase(res.database);
            setDraft(tuningOf(res.database));
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, [itemId]);

    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (busy || !database || !draft) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.update', {
                databaseId: database.id,
                name: database.name,
                host: database.host,
                port: database.port,
                database: database.database,
                username: database.username,
                // Ni `password` ni `access.secret` : absents, le serveur garde
                // ceux en place.
                access: {
                    kind: database.access.kind,
                    host: database.access.host,
                    port: database.access.port,
                    username: database.access.username,
                    auth: database.access.auth
                },
                ...draft
            });
            setDatabase(res.database);
            setDraft(tuningOf(res.database));
            invalidate('database.detail', 'database.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    };

    if (!database || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    if (database.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette base vient d’un autre espace : son relevé et son exploration se règlent depuis là-bas.
            </p>
        );
    }

    const set = <K extends keyof Tuning>(key: K, value: Tuning[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
    const editable = canWrite && !busy;

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
            <Switch
                checked={draft.monitorEnabled}
                disabled={!editable}
                onChange={(v) => set('monitorEnabled', v)}
                label='Relever cette base régulièrement'
                hint='Éteint (le réglage par défaut), rien ne se connecte : la base ne se joint qu’au moment où vous le demandez. Allumé, DevEye relève sa taille et son état, et c’est ce qui rend ses alertes vivantes.'
            />

            {draft.monitorEnabled && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Fréquence de relève</span>
                    <SelectInput
                        value={draft.intervalSeconds}
                        disabled={!editable}
                        onChange={(e) => set('intervalSeconds', Number(e.target.value))}
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
                onChange={(v) => set('autoLoadTables', v)}
                label='Charger les tables à l’ouverture de la fiche'
                hint='Éteint (le réglage par défaut), ouvrir la fiche de cette base ne joint aucun serveur : c’est « Charger les tables » qui va voir. Allumé, l’inventaire des tables est lu dès l’affichage de la fiche, ce qui fait gagner un clic sur une base qu’on consulte souvent et coûte une connexion à chaque ouverture.'
            />

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={submit} disabled={busy} />
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Bases de données.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
