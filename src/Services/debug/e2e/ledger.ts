export interface CleanupReport {
    ok: boolean;
    failures: string[];
}

/**
 * Ce qu'un scénario a créé et devra défaire : défait en ordre inverse, et
 * jusqu'au bout malgré un échec, pour qu'un ménage raté ne laisse pas le
 * reste en place.
 */
export function createLedger() {
    const undo: { label: string; fn: () => Promise<void> }[] = [];
    return {
        defer(label: string, fn: () => Promise<void>): void {
            undo.push({ label, fn });
        },
        async cleanup(): Promise<CleanupReport> {
            const failures: string[] = [];
            for (let entry = undo.pop(); entry; entry = undo.pop()) {
                try {
                    await entry.fn();
                } catch (e) {
                    failures.push(`${entry.label} : ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return { ok: failures.length === 0, failures };
        }
    };
}

export type Ledger = ReturnType<typeof createLedger>;
