import { useMemo } from 'react';

import { errorNote } from '@/api/useResource';
import type { ErrorNoteInput } from '@/Components/ErrorNote';
import { matchRunning, startTask, useTaskRecords, type Task, type TaskContext } from '@/stores/tasks';
import { getActiveInstanceId, getActiveWorkspaceId, useWorkspaceState } from '@/stores/workspace';

/** Ce qu'un écran dit de l'opération longue qu'il lance. */
export interface TaskOptions<T = unknown> {
    /** L'id de la fonctionnalité (`manifest.id`) : l'icône, le nom et « Ouvrir » de sa ligne. */
    feature: string;
    /** Ce qui se fait, en groupe nominal : « Suppression du point de restauration ». */
    title: string;
    /** Le repli de la phrase d'échec, ou la fonction qui rend la note entière. */
    failed: string | ((error: unknown) => ErrorNoteInput);
    /** L'élément visé : « Ouvrir » y mène, `useTasks` filtre dessus. */
    itemId?: string | number;
    /**
     * La sorte d'opération. Deux opérations de même fonctionnalité, espace,
     * élément et clé ne tournent pas ensemble : la seconde rejette `conflict`.
     */
    key?: string;
    /** Sur quoi elle porte, pour distinguer deux lignes de même titre. */
    subject?: string;
    /** Pourquoi il faut attendre : dans le dialogue seulement. */
    description?: string;
    /** La phrase de succès de la zone ; « Terminé. » sans elle. */
    done?: string | ((result: T) => string);
    /** `false` : pas de dialogue, l'opération part dans la zone et l'écran dessine l'avancement chez lui. */
    dialog?: boolean;
    /** `false` : le dialogue ne se réduit pas. Pour une étape dont la suite a besoin de la personne. */
    minimizable?: boolean;
    /** Le travail se fait dans cet onglet, pas sur le serveur : le fermer demande confirmation. */
    local?: boolean;
    /** Offre « Annuler » ; l'opération sort quand `run` rejette. */
    cancel?: () => void;
    /** Appelé une fois, à la première réduction : refermer la fiche d'un élément qui s'en va. */
    onDetach?: () => void;
}

/**
 * Lance une opération longue et la confie à la zone des opérations : un
 * dialogue réductible, puis la puce de la barre et son panneau. La promesse se
 * résout et rejette comme `run`, donc l'écran encore monté garde sa logique.
 *
 * `task.sendOptions` va à LA commande qui fait le travail. Une suite de
 * commandes menée par le navigateur est une opération `local`, qui rapporte
 * son avancement par `task.report`.
 */
export function runTask<T>(options: TaskOptions<T>, run: (task: TaskContext) => Promise<T>): Promise<T> {
    const { failed } = options;
    return startTask<T>(
        {
            feature: options.feature,
            origin: { instanceId: getActiveInstanceId(), workspaceId: getActiveWorkspaceId() },
            title: options.title,
            subject: options.subject,
            description: options.description,
            itemId: options.itemId === undefined ? undefined : String(options.itemId),
            key: options.key,
            dialog: options.dialog ?? true,
            minimizable: options.minimizable ?? true,
            local: options.local ?? false,
            done: options.done,
            failure: typeof failed === 'function' ? failed : (error) => errorNote(error, failed),
            cancel: options.cancel,
            onDetach: options.onDetach
        },
        run
    );
}

/**
 * Les opérations en cours d'une fonctionnalité dans l'espace actif, quel que
 * soit l'écran qui les a lancées : de quoi désactiver les gestes en conflit et
 * dessiner l'avancement en place, y compris après un remontage.
 */
export function useTasks(filter: { feature: string; itemId?: string | number; key?: string }): readonly Task[] {
    const records = useTaskRecords();
    const { activeId, activeInstanceId } = useWorkspaceState();
    const { feature, itemId, key } = filter;
    return useMemo(
        () => matchRunning(records, { feature, itemId, key }, { instanceId: activeInstanceId, workspaceId: activeId }),
        [records, feature, itemId, key, activeId, activeInstanceId]
    );
}
