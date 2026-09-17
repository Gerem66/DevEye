import { authenticate, type DNSResolver } from 'mailauth';

import type { AuthVerdict } from '../../contracts/domain';
import type { Verdicts } from '../engine/delivery';

/**
 * L'authentification de l'expéditeur d'un message entrant : SPF, DKIM, DMARC.
 * Le verdict décide du dossier (ou du refus) ; les en-têtes rendus sont
 * préfixés au message pour que le client les montre.
 */

export interface InboundCheck {
    verdicts: Verdicts;
    /** `reject`, `quarantine` ou `none` : ce que le domaine de l'expéditeur demande en cas d'échec. */
    policy: string;
    /** `Authentication-Results` et `Received-SPF`, terminés par CRLF. */
    headers: string;
}

export type InboundVerifier = (
    raw: Buffer,
    peer: { ip: string; helo: string; sender: string }
) => Promise<InboundCheck>;

const verdictOf = (result: string | undefined): AuthVerdict =>
    result === 'pass' ? 'pass' : result === undefined || result === 'none' || result === 'neutral' ? 'none' : 'fail';

export function createInboundVerifier(hostname: string, resolver?: DNSResolver): InboundVerifier {
    return async (raw, peer) => {
        const result = await authenticate(raw, {
            ip: peer.ip,
            helo: peer.helo,
            sender: peer.sender,
            mta: hostname,
            trustReceived: false,
            resolver
        });
        const signatures = result.dkim.results ?? [];
        const dkim: AuthVerdict = signatures.some((s) => s.status.result === 'pass')
            ? 'pass'
            : signatures.length === 0
              ? 'none'
              : 'fail';
        return {
            verdicts: {
                spf: result.spf ? verdictOf(result.spf.status.result) : 'none',
                dkim,
                dmarc: result.dmarc ? verdictOf(result.dmarc.status.result) : 'none'
            },
            policy: result.dmarc ? result.dmarc.policy : 'none',
            headers: result.headers.endsWith('\r\n') ? result.headers : `${result.headers}\r\n`
        };
    };
}

/**
 * Le sort d'un message d'après ses verdicts. Un échec DMARC suit la politique
 * publiée par le domaine ; sans DMARC, un SPF en échec sans aucune signature
 * valable suffit à douter.
 */
export function dispositionOf(check: InboundCheck): 'accept' | 'junk' | 'reject' {
    if (check.verdicts.dmarc === 'fail') {
        if (check.policy === 'reject') return 'reject';
        if (check.policy === 'quarantine') return 'junk';
    }
    if (check.verdicts.spf === 'fail' && check.verdicts.dkim !== 'pass') return 'junk';
    return 'accept';
}
