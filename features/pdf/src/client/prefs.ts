import { useCallback, useEffect, useRef } from 'react';
import { invalidate, useResource } from 'deveye-sdk-client';

import { DEFAULT_PREFS, type Prefs } from '../contracts/prefs';
import { api } from './api';

/** Un choix se change plusieurs fois de suite (une couleur qu'on ajuste) : une seule écriture à la fin. */
const SAVE_DELAY_MS = 400;

/** Les réglages du compte : lus en ressource, écrits après un court délai, les écrans gardant leur propre état entre-temps. */
export function usePrefs(): { prefs: Prefs; save: (patch: Partial<Prefs>) => void } {
    const { data } = useResource(
        'pdf.prefs',
        () => api.send('pdf.prefs', {}).then((r) => r.prefs),
        'Impossible de lire vos réglages PDF.'
    );
    const latest = useRef<Prefs>(DEFAULT_PREFS);
    const timer = useRef<number | null>(null);
    useEffect(() => {
        // Ce qui arrive du serveur ne remplace pas une écriture en attente.
        if (data && timer.current === null) latest.current = data;
    }, [data]);

    const save = useCallback((patch: Partial<Prefs>) => {
        latest.current = { ...latest.current, ...patch };
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            timer.current = null;
            void api
                .send('pdf.prefsSet', { prefs: latest.current })
                .catch(() => undefined)
                .finally(() => invalidate('pdf.prefs'));
        }, SAVE_DELAY_MS);
    }, []);

    return { prefs: data ?? DEFAULT_PREFS, save };
}
