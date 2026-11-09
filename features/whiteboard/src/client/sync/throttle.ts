/**
 * Au plus un appel tous les `ms`, le dernier demandé n'étant jamais perdu :
 * un trait qui s'arrête part en entier, même au milieu d'une fenêtre.
 */
export function throttle(fn: () => void, ms: number, now: () => number = Date.now) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = Number.NEGATIVE_INFINITY;
    const run = (): void => {
        timer = null;
        last = now();
        fn();
    };
    return {
        schedule(): void {
            if (timer !== null) return;
            timer = setTimeout(run, Math.max(0, last + ms - now()));
        },
        /** Tout de suite, s'il y avait quelque chose d'attendu. */
        flush(): void {
            if (timer === null) return;
            clearTimeout(timer);
            run();
        },
        cancel(): void {
            if (timer !== null) clearTimeout(timer);
            timer = null;
        }
    };
}
