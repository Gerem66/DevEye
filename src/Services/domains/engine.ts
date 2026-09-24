import type { FeatureDomainRow, FeatureDomainVerdict } from '@/db/repos/featureDomains';
import type { WebCheck } from './web';

/**
 * La vérification d'un domaine, en deux étages qui ne disent pas la même chose.
 *
 * Le TXT prouve la **propriété** : seul qui tient la zone peut le poser. La
 * sonde du module prouve le **service** : le nom est réellement câblé sur ce
 * que la fonctionnalité sert. Un domaine n'est vérifié que quand les deux
 * passent.
 */

/**
 * Au-delà, un domaine vérifié retombe. En deçà il tient : un proxy qui
 * redémarre ou un résolveur qui tousse ne doit pas couper tout ce qu'il sert.
 */
export const FAILURES_BEFORE_DROP = 3;

export interface DomainSeam {
    /** Les TXT du nom, morceaux recollés. */
    txt(name: string): Promise<string[]>;
    /**
     * La sonde du module, appelée seulement quand la propriété tient. Une
     * attente (`pending`) échoue comme un échec, mais se montre comme en cours.
     */
    probe(): Promise<WebCheck>;
    okSeconds: number;
    pendingSeconds: number;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Décide de l'état d'un domaine sans rien écrire : c'est ce qui se teste. */
export async function judge(
    row: FeatureDomainRow,
    ownership: { name: string; value: string },
    now: number,
    seam: DomainSeam
): Promise<FeatureDomainVerdict> {
    const failures = row.failures + 1;
    const held = failures >= FAILURES_BEFORE_DROP ? null : row.verified_at;

    let dnsError = '';
    try {
        const records = await seam.txt(ownership.name);
        if (!records.some((record) => record.trim() === ownership.value)) {
            dnsError =
                records.length === 0
                    ? 'Enregistrement TXT introuvable pour l’instant.'
                    : 'Un TXT existe mais ne porte pas le jeton attendu.';
        }
    } catch (error) {
        dnsError = reason(error);
    }
    if (dnsError) {
        return {
            dns_state: 'failed',
            dns_error: dnsError,
            probe_state: 'pending',
            probe_error: '',
            verified_at: held,
            checked_at: now,
            failures,
            next_probe_at: now + seam.pendingSeconds
        };
    }

    let probe: WebCheck;
    try {
        probe = await seam.probe();
    } catch (error) {
        probe = { ok: false, error: reason(error) };
    }
    if (probe.ok) {
        return {
            dns_state: 'ok',
            dns_error: '',
            probe_state: 'ok',
            probe_error: '',
            verified_at: row.verified_at ?? now,
            checked_at: now,
            failures: 0,
            next_probe_at: now + seam.okSeconds
        };
    }
    return {
        dns_state: 'ok',
        dns_error: '',
        probe_state: 'pending' in probe ? 'pending' : 'failed',
        probe_error: probe.error,
        verified_at: held,
        checked_at: now,
        failures,
        next_probe_at: now + seam.pendingSeconds
    };
}

/** Ce qu'un membre voit bouger : de quoi décider d'un battement en direct. */
export function verdictChanged(row: FeatureDomainRow, verdict: FeatureDomainVerdict): boolean {
    return (
        row.dns_state !== verdict.dns_state ||
        row.probe_state !== verdict.probe_state ||
        (row.verified_at === null) !== (verdict.verified_at === null)
    );
}
