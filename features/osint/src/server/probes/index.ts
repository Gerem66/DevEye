import { OSINT_PROBES_BY_KIND, type OsintProbeId, type OsintTargetKind } from '../../contracts/domain';

import { breachesProbe } from './breaches';
import { crtshProbe } from './crtsh';
import { deathsProbe } from './deaths';
import { dnsProbe } from './dns';
import { dorksProbe } from './dorks';
import { emailProbe } from './email';
import { githubProbe } from './github';
import { gravatarProbe } from './gravatar';
import { httpProbe } from './http';
import { blocklistProbe, geoipProbe, ptrProbe } from './ip';
import { keybaseProbe } from './keybase';
import { pgpProbe } from './pgp';
import { phoneProbe } from './phone';
import { portsProbe } from './ports';
import { rdapIpProbe, rdapProbe } from './rdap';
import { registryProbe } from './registry';
import { tlsProbe } from './tls';
import { usernameProbe } from './username';
import { virustotalProbe } from './virustotal';
import { whoisProbe } from './whois';
import { wikidataProbe } from './wikidata';
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
    ports: portsProbe,
    virustotal: virustotalProbe,
    phone: phoneProbe,
    email: emailProbe,
    pgp: pgpProbe,
    breaches: breachesProbe,
    username: usernameProbe,
    registry: registryProbe,
    deaths: deathsProbe,
    wikidata: wikidataProbe,
    github: githubProbe,
    gravatar: gravatarProbe,
    keybase: keybaseProbe,
    dorks: dorksProbe
};

/**
 * La table partagée (`OSINT_PROBES_BY_KIND`) fait foi, filtrée par ce que le
 * registre déclare : une sonde listée pour une nature qu'elle ne gère pas
 * disparaît au lieu d'échouer à l'exécution.
 */
export function probesFor(kind: OsintTargetKind): OsintProbeId[] {
    return OSINT_PROBES_BY_KIND[kind].filter((id) => PROBES[id].appliesTo.includes(kind));
}

/** Cette sonde accepte-t-elle cette nature de cible ? Garde du dispatcheur. */
export function probeAccepts(probe: OsintProbeId, kind: OsintTargetKind): boolean {
    return PROBES[probe].appliesTo.includes(kind);
}
