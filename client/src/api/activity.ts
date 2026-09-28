import { SESSION_ACTIVE_COMMAND } from '@deveye/types';

import { ws } from './ws';

/** Assez pour que le serveur sache qu'on est là, sans trame à chaque geste. */
const EVERY_MS = 60_000;

const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Dit aux serveurs, au plus une fois par minute, que la personne se sert de la
 * page : un onglet oublié peut céder sa place à qui attend, pas un onglet dont
 * on se sert. Les requêtes des widgets, qui partent seules, n'en disent rien.
 */
export function startActivityBeacon(): () => void {
    let last = 0;
    const beat = (): void => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - last < EVERY_MS) return;
        last = now;
        ws.postEverywhere(SESSION_ACTIVE_COMMAND, {});
    };
    for (const type of INPUTS) window.addEventListener(type, beat, { passive: true, capture: true });
    document.addEventListener('visibilitychange', beat);
    return () => {
        for (const type of INPUTS) window.removeEventListener(type, beat, { capture: true });
        document.removeEventListener('visibilitychange', beat);
    };
}
