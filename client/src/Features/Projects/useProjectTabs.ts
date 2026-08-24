import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectLinkCounts } from '@deveye/types';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import {
    PROJECT_FEATURE_TABS,
    visibleProjectTabs,
    type ProjectFeatureTab,
    type ProjectFeatureTabId,
    type ProjectTab,
    type ProjectTabAddAction
} from './tabs';

/** Un projet sans aucune liaison — l'état de départ, et celui d'un projet gardé. */
const NONE: ProjectLinkCounts = { git: 0, database: 0, audience: 0, deploy: 0 };

/** Une ligne du menu « + » : le geste, et l'onglet qu'il fait naître. */
export interface ProjectTabAddable {
    tab: ProjectFeatureTab;
    action: ProjectTabAddAction;
}

export interface ProjectTabsState {
    /** Les onglets de la barre, dans l'ordre. */
    visible: ProjectTab[];
    /** Ce que le « + » propose : les gestes dont l'onglet est absent de la barre. */
    addable: ProjectTabAddable[];
    /** Faux tant que les compteurs n'ont pas été lus une première fois. */
    ready: boolean;
    /**
     * Compte un ajout **avant** sa relecture.
     *
     * L'onglet doit être là à l'instant où on l'ouvre. Sans cette avance, le
     * temps d'un aller-retour la barre ne le connaît pas encore, et le repli qui
     * ramène vers le tableau un onglet inexistant se déclencherait aussitôt.
     * La relecture qui suit remet de toute façon la vérité du serveur.
     */
    reveal: (id: ProjectFeatureTabId) => void;
}

/**
 * Ce que le projet ouvert a de quoi montrer, et ce qu'il reste à lui ajouter.
 *
 * Les compteurs sont la **seule** source de la barre d'onglets : un onglet
 * paraît dès son premier élément et disparaît avec le dernier, sans état
 * intermédiaire à réconcilier. Ils se relisent sur `project.board`, la clé que
 * toutes les liaisons invalident déjà en écrivant — c'est aussi celle que les
 * onglets eux-mêmes écoutent, donc la barre et son contenu ne divergent jamais.
 */
export function useProjectTabs(project: Project, canWrite: boolean): ProjectTabsState {
    const permissions = useWorkspacePermissions();
    const version = useResourceVersion('project.board');
    const guarded = project.securityTier === 'guarded';

    /*
     * Les compteurs **et** le projet auxquels ils appartiennent : passer d'un
     * projet à l'autre ne doit pas afficher un instant les onglets du
     * précédent, et remettre à zéro à chaque relecture ferait clignoter la
     * barre à chaque écriture.
     */
    const [loaded, setLoaded] = useState<{ projectId: number; counts: ProjectLinkCounts } | null>(null);
    const counts = loaded?.projectId === project.id ? loaded.counts : null;

    /*
     * Le numéro de la lecture qui fait foi.
     *
     * Une réponse plus vieille que ce qu'on sait ne doit jamais l'écraser : deux
     * relectures rapprochées peuvent revenir dans le désordre, et surtout un
     * ajout est compté d'avance (voir `reveal`) alors qu'une lecture partie
     * juste avant est encore en vol — elle rapporterait un zéro périmé, l'onglet
     * qu'on vient d'ouvrir disparaîtrait sous les doigts. D'où un compteur, que
     * la lecture, le démontage et l'avance font tous avancer.
     */
    const latest = useRef(0);

    useEffect(() => {
        const mine = ++latest.current;
        void (async () => {
            try {
                const res = await ws.send('project.linkCounts', { projectId: project.id });
                if (latest.current === mine) setLoaded({ projectId: project.id, counts: res.counts });
            } catch {
                // Une panne ne doit pas escamoter des onglets qui ont du
                // contenu : on garde ce qu'on savait, et à défaut on s'en tient
                // aux permanents. L'erreur, elle, se dira dans l'onglet ouvert
                // — la barre n'est pas l'endroit où l'annoncer.
                if (latest.current === mine) setLoaded((prev) => prev ?? { projectId: project.id, counts: NONE });
            }
        })();
        return () => {
            latest.current += 1;
        };
    }, [project.id, version]);

    const visible = useMemo(() => visibleProjectTabs(counts), [counts]);

    const reveal = useCallback((id: ProjectFeatureTabId) => {
        latest.current += 1;
        setLoaded((prev) =>
            prev === null ? prev : { ...prev, counts: { ...prev.counts, [id]: prev.counts[id] || 1 } }
        );
    }, []);

    /*
     * Ajoutable = onglet absent de la barre, geste à la portée de l'appelant.
     * Le droit d'écriture sur le projet ne suffit pas : le dialogue qui s'ouvre
     * travaille dans la feature visée, et sans ce droit-là il ne mènerait nulle
     * part. Un onglet à plusieurs gestes (Déploiement) peut n'en proposer qu'un
     * si l'autre feature échappe au rôle courant — mieux vaut une ligne de
     * moins qu'une ligne qui mène à un refus.
     *
     * Un projet confidentiel n'admet **aucune** des liaisons (PROJECTS.md
     * §1.4) : le serveur les refuse, le « + » n'a donc rien à proposer. Ses
     * compteurs se lisent quand même — un tel projet peut porter des services
     * surveillés, rattachés avant sa conversion, et l'onglet Déploiement reste
     * le seul endroit d'où les atteindre.
     */
    const addable: ProjectTabAddable[] =
        canWrite && !guarded && counts !== null
            ? PROJECT_FEATURE_TABS.filter((tab) => counts[tab.id] === 0).flatMap((tab) =>
                  tab.add
                      .filter((action) => permissions.canFeature(action.requires.feature, action.requires.level))
                      .map((action) => ({ tab, action }))
              )
            : [];

    return { visible, addable, ready: counts !== null, reveal };
}
