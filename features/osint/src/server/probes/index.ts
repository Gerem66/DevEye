import { OSINT_PROBES_BY_KIND, type OsintProbeId, type OsintTargetKind } from '../../contracts/domain';

import { crtshProbe } from './crtsh';
import { dnsProbe } from './dns';
import { dorksProbe } from './dorks';
import { emailProbe } from './email';
import { httpProbe } from './http';
import { blocklistProbe, geoipProbe, ptrProbe } from './ip';
import { pappersProbe } from './pappers';
import { phoneProbe } from './phone';
import { rdapIpProbe, rdapProbe } from './rdap';
import { tlsProbe } from './tls';
import { usernameProbe } from './username';
import { whoisProbe } from './whois';
import type { OsintProbeAdapter } from './shared';

export * from './shared';

/**
 * Le registre des sondes. Une entrée par sonde, et c'est tout ce qu'il faut
 * pour en ajouter une : le contrat partagé porte déjà son identifiant, le
 * moteur l'exécute, et le client la rend sans savoir ce qu'elle fait.
 */
export const PROBES: Record<OsintProbeId, OsintProbeAdapter> = {
    dns: dnsProbe,
    rdap: rdapProbe,
    whois: whoisProbe,
    tls: tlsProbe,
    http: httpProbe,
    crtsh: crtshProbe,
    ptr: ptrProbe,
    rdapIp: rdapIpProbe,
    geoip: geoipProbe,
    blocklist: blocklistProbe,
    phone: phoneProbe,
    email: emailProbe,
    username: usernameProbe,
    pappers: pappersProbe,
    dorks: dorksProbe
};

/**
 * Les sondes applicables à cette nature de cible.
 *
 * La table partagée (`OSINT_PROBES_BY_KIND`) fait foi — c'est elle que le client
 * lit aussi — mais on la filtre ici par ce que le registre déclare réellement
 * supporter. Les deux ne peuvent donc pas diverger silencieusement : une sonde
 * listée pour une nature qu'elle ne gère pas disparaît au lieu d'échouer à
 * l'exécution.
 */
export function probesFor(kind: OsintTargetKind): OsintProbeId[] {
    return OSINT_PROBES_BY_KIND[kind].filter((id) => PROBES[id].appliesTo.includes(kind));
}

/** Cette sonde accepte-t-elle cette nature de cible ? Garde du dispatcheur. */
export function probeAccepts(probe: OsintProbeId, kind: OsintTargetKind): boolean {
    return PROBES[probe].appliesTo.includes(kind);
}
