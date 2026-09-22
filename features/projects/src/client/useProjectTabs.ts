import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResourceVersion, useWorkspacePermissions } from 'deveye-sdk-client';
import { api } from './api';
import type { Project, ProjectLinkCounts } from '../contracts/domain';
import {
    PROJECT_FEATURE_TABS,
    visibleProjectTabs,
    type ProjectFeatureTab,
    type ProjectFeatureTabId,
    type ProjectTab,
    type ProjectTabAddAction
} from './tabs';

/** L'état de départ, et celui d'un projet gardé. */
const NONE: ProjectLinkCounts = { git: 0, database: 0, audience: 0, deploy: 0, uptime: 0 };

/** Une ligne du menu « + » : le geste, et l'onglet qu'il fait naître. */
export interface ProjectTabAddable {
    tab: ProjectFeatureTab;
    action: ProjectTabAddAction;
}

export interface ProjectTabsState {
    visible: ProjectTab[];
    /** Ce que le « + » propose : les gestes dont l'onglet est absent de la barre. */
    addable: ProjectTabAddable[];
    /** Faux tant que les compteurs n'ont pas été lus une première fois. */
    ready: boolean;
    /**
     * Compte un ajout avant sa relecture : l'onglet doit être là à l'instant où
     * on l'ouvre, sinon le repli vers le tableau se déclenche le temps d'un
     * aller-retour. La relecture qui suit remet la vérité du serveur.
     */
    reveal: (id: ProjectFeatureTabId) => void;
}

/**
 * Les compteurs sont la seule source de la barre d'onglets : un onglet paraît
 * dès son premier élément et disparaît avec le dernier. Ils se relisent sur
 * `projects.board`, que les onglets écoutent aussi, donc rien ne diverge.
 */
export function useProjectTabs(project: Project, canWrite: boolean): ProjectTabsState {
    const permissions = useWorkspacePermissions();
    const version = useResourceVersion('projects.board');
    const guarded = project.securityTier === 'guarded';

    /*
     * Les compteurs et le projet auxquels ils appartiennent : passer d'un projet
     * à l'autre ne doit pas afficher un instant les onglets du précédent, et
     * remettre à zéro à chaque relecture ferait clignoter la barre.
     */
    const [loaded, setLoaded] = useState<{ projectId: number; counts: ProjectLinkCounts } | null>(null);
    const counts = loaded?.projectId === project.id ? loaded.counts : null;

    /*
     * Le numéro de la lecture qui fait foi : deux relectures rapprochées peuvent
     * revenir dans le désordre, et un ajout compté d'avance (`reveal`) serait
     * écrasé par le zéro périmé d'une lecture encore en vol.
     */
    const latest = useRef(0);

    useEffect(() => {
        const mine = ++latest.current;
        void (async () => {
            try {
                const res = await api.send('projects.linkCounts', { projectId: project.id });
                if (latest.current === mine) setLoaded({ projectId: project.id, counts: res.counts });
            } catch {
                // Une panne ne doit pas escamoter des onglets qui ont du
                // contenu : on garde ce qu'on savait, l'erreur se dira dans
                // l'onglet ouvert.
                if (latest.current === mine) setLoaded((prev) => prev ?? { projectId: project.id, counts: NONE });
            }
        })();
        return () => {
            latest.current += 1;
        };
    }, [project.id, version]);

    const visible = useMemo(() => visibleProjectTabs(counts, project), [counts, project]);

    const reveal = useCallback((id: ProjectFeatureTabId) => {
        latest.current += 1;
        setLoaded((prev) =>
            prev === null ? prev : { ...prev, counts: { ...prev.counts, [id]: prev.counts[id] || 1 } }
        );
    }, []);

    /*
     * Ajoutable = onglet absent de la barre, et geste à la portée de l'appelant
     * puisque le dialogue travaille dans la feature visée. Ni un projet
     * confidentiel ni un projet projeté n'admettent de liaison, le serveur les
     * refuse ; leurs compteurs se lisent quand même, ils peuvent en porter.
     */
    const addable: ProjectTabAddable[] =
        canWrite && !guarded && !project.foreign && counts !== null
            ? PROJECT_FEATURE_TABS.filter(
                  (tab) =>
                      counts[tab.id] === 0 && permissions.canFeature(tab.add.requires.feature, tab.add.requires.level)
              ).map((tab) => ({ tab, action: tab.add }))
            : [];

    return { visible, addable, ready: counts !== null, reveal };
}
