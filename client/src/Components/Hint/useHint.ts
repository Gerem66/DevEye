import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { UserSettingFlag } from '@deveye/types';

import { ws } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';

export type HintFlag = Extract<
    UserSettingFlag,
    'feedbackHintDismissed' | 'homeLayoutHintDismissed' | 'aboutHintDismissed'
>;

/** Une seule bulle à la fois, la plus importante d'abord. */
const HINT_ORDER: readonly HintFlag[] = ['feedbackHintDismissed', 'homeLayoutHintDismissed', 'aboutHintDismissed'];

/** Les bulles qui voudraient s'afficher en ce moment : éligibles et pas encore écartées. */
const waiting = new Set<HintFlag>();
const listeners = new Set<() => void>();
let revision = 0;

function setWaiting(flag: HintFlag, on: boolean): void {
    if (waiting.has(flag) === on) return;
    if (on) waiting.add(flag);
    else waiting.delete(flag);
    revision++;
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Une bulle de découverte : `show` quand elle est éligible, que le compte ne
 * l'a pas écartée et qu'aucune bulle placée avant elle n'attend son tour.
 *
 * Le drapeau vit sur le compte : la bulle ne revient donc ni au rechargement ni
 * sur une autre machine. L'état local part devant, un serveur qui refuse n'a
 * pas à la faire réapparaître sous les yeux ; la session suivante la reproposera.
 */
export function useHint(flag: HintFlag, eligible: boolean): { show: boolean; dismiss: () => void } {
    const { user, updateUser } = useAuth();
    const wanted = eligible && user != null && !user.settings.includes(flag);

    useEffect(() => {
        setWaiting(flag, wanted);
        return () => setWaiting(flag, false);
    }, [flag, wanted]);

    useSyncExternalStore(
        subscribe,
        () => revision,
        () => revision
    );
    const show = wanted && HINT_ORDER.slice(0, HINT_ORDER.indexOf(flag)).every((f) => !waiting.has(f));

    const dismiss = useCallback((): void => {
        if (!user || user.settings.includes(flag)) return;
        updateUser({ settings: [...user.settings, flag] });
        void ws.send('user.setSetting', { flag, enabled: true }).then(
            (res) => updateUser({ settings: res.settings }),
            () => {}
        );
    }, [flag, user, updateUser]);

    return { show, dismiss };
}
