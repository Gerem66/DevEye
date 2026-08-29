import type { NetInterface, OpenPort } from '@deveye/types';

/**
 * Port naming, address classification and bubble grouping, shared by the
 * listening-ports view and the connections view.
 */

/** Common ports labelled, to make a raw port number readable at a glance. */
const SERVICE_NAMES: Record<number, string> = {
    20: 'FTP-data',
    21: 'FTP',
    22: 'SSH',
    23: 'Telnet',
    25: 'SMTP',
    53: 'DNS',
    67: 'DHCP',
    68: 'DHCP',
    80: 'HTTP',
    110: 'POP3',
    123: 'NTP',
    137: 'NetBIOS',
    139: 'NetBIOS',
    143: 'IMAP',
    161: 'SNMP',
    389: 'LDAP',
    443: 'HTTPS',
    445: 'SMB',
    465: 'SMTPS',
    514: 'Syslog',
    587: 'SMTP',
    631: 'IPP',
    636: 'LDAPS',
    993: 'IMAPS',
    995: 'POP3S',
    1194: 'OpenVPN',
    1433: 'SQL Server',
    1883: 'MQTT',
    2049: 'NFS',
    3000: 'app',
    3306: 'MySQL',
    3389: 'RDP',
    5060: 'SIP',
    5353: 'mDNS',
    5432: 'PostgreSQL',
    5900: 'VNC',
    6379: 'Redis',
    8006: 'Proxmox',
    8080: 'HTTP-alt',
    8443: 'HTTPS-alt',
    9090: 'Cockpit',
    9200: 'Elasticsearch',
    11434: 'Ollama',
    27017: 'MongoDB',
    51820: 'WireGuard'
};

/** Service label for a port, or null when it isn't a well-known one. */
export function serviceName(port: number): string | null {
    return SERVICE_NAMES[port] ?? null;
}

/** How a bind address places the socket on the network. */
export type AddressScope = 'any' | 'public' | 'private' | 'linkLocal' | 'multicast' | 'loopback';

/**
 * Where a listening socket can be reached from, coarser than the scope.
 * `external` means the socket listens on a routable interface: the agent knows
 * nothing about the NAT or firewall in front of it, never present it as
 * verified Internet reachability.
 */
export type Reachability = 'external' | 'lan' | 'local';

function isIPv4(address: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

/** IP family of a bind address; `null` for the `*` wildcard (family-agnostic). */
function addressFamily(address: string): 'v4' | 'v6' | null {
    if (address === '*') return null;
    if (isIPv4(address)) return 'v4';
    return address.includes(':') ? 'v6' : null;
}

/** Classify a bind address by what it is, not by where it can be reached. */
export function classifyAddress(address: string): AddressScope {
    const a = address.toLowerCase();
    if (a === '0.0.0.0' || a === '::' || a === '*' || a === '[::]') return 'any';
    if (a === '::1' || a.startsWith('127.')) return 'loopback';
    // IPv4-mapped IPv6 (`::ffff:192.168.1.10`) classifies on the embedded v4.
    const mapped = a.startsWith('::ffff:') ? a.slice(7) : null;
    if (mapped && isIPv4(mapped)) return classifyAddress(mapped);
    if (a.startsWith('169.254.') || a.startsWith('fe80:')) return 'linkLocal';
    if (a.startsWith('ff') && a.includes(':')) return 'multicast'; // ff00::/8
    if (/^2(2[4-9]|3\d)\./.test(a)) return 'multicast'; // 224.0.0.0/4
    if (a.startsWith('10.') || a.startsWith('192.168.')) return 'private';
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 'private';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 'private'; // CGNAT / Tailscale
    if (/^f[cd]/.test(a) && a.includes(':')) return 'private'; // fc00::/7 ULA
    return 'public';
}

/** Collapse a scope into the three buckets the UI groups by. */
function reachability(scope: AddressScope): Reachability {
    if (scope === 'loopback') return 'local';
    if (scope === 'any' || scope === 'public') return 'external';
    return 'lan';
}

/** Label for a bind address, used in tooltips. */
export const SCOPE_LABEL: Record<AddressScope, string> = {
    any: 'toutes les interfaces',
    public: 'adresse publique',
    private: 'réseau local',
    linkLocal: 'lien local',
    multicast: 'multicast',
    loopback: 'loopback'
};

/** Interface bucket a port bubble belongs to. `null` = every interface. */
export type InterfaceKey = string | null;

/**
 * Which interface a bind address belongs to. The IPv6 scope id (`%eth0`) names
 * it outright; otherwise we match the address against the interfaces the report
 * carries. Wildcard binds belong to no single interface.
 */
function resolveInterface(address: string, zone: string | null, interfaces: NetInterface[]): InterfaceKey {
    if (classifyAddress(address) === 'any') return null;
    if (zone) return zone;
    const target = address.toLowerCase();
    const match = interfaces.find((i) => i.addresses.some((a) => a.toLowerCase() === target));
    return match?.name ?? null;
}

/** One bubble: a port, merged across protocols, IP families and bind addresses. */
export interface PortGroup {
    port: number;
    /** Protocols this port listens on, ascending (`['tcp']`, `['tcp','udp']`). */
    protocols: ('tcp' | 'udp')[];
    /** IP families involved, so the UI can badge a dual-stack listener. */
    families: ('v4' | 'v6')[];
    reachability: Reachability;
    /** Interface the group is bound to; `null` = all interfaces. */
    interfaceName: InterfaceKey;
    /** Every concrete bind address merged into this bubble, for the tooltip. */
    addresses: string[];
    /** Distinct owning programs (empty when none could be attributed). */
    processes: string[];
    /** Owning pids, for the tooltip. */
    pids: number[];
}

function sortUnique<T>(values: T[], compare?: (a: T, b: T) => number): T[] {
    return [...new Set(values)].sort(compare);
}

/**
 * Merge raw listening sockets into display bubbles: the agent reports one entry
 * per bind address (a dual-stack sshd yields `0.0.0.0:22` and `:::22`), so
 * sockets are merged when they share a port, a reachability bucket and an
 * interface; protocols and IP families are unioned.
 */
export function groupPorts(ports: OpenPort[], interfaces: NetInterface[]): PortGroup[] {
    const groups = new Map<string, PortGroup>();
    for (const p of ports) {
        const scope = classifyAddress(p.address);
        const reach = reachability(scope);
        const interfaceName = resolveInterface(p.address, p.zone, interfaces);
        const key = `${p.port}|${reach}|${interfaceName ?? ''}`;
        const group = groups.get(key);
        if (group) {
            group.protocols.push(p.proto);
            group.addresses.push(p.address);
            const family = addressFamily(p.address);
            if (family) group.families.push(family);
            if (p.process) group.processes.push(p.process);
            if (p.pid !== null) group.pids.push(p.pid);
        } else {
            const family = addressFamily(p.address);
            groups.set(key, {
                port: p.port,
                protocols: [p.proto],
                families: family ? [family] : [],
                reachability: reach,
                interfaceName,
                addresses: [p.address],
                processes: p.process ? [p.process] : [],
                pids: p.pid !== null ? [p.pid] : []
            });
        }
    }

    return [...groups.values()]
        .map((g) => ({
            ...g,
            protocols: sortUnique(g.protocols),
            families: sortUnique(g.families),
            addresses: sortUnique(g.addresses),
            processes: sortUnique(g.processes),
            pids: sortUnique(g.pids, (a, b) => a - b)
        }))
        .sort((a, b) => a.port - b.port || a.protocols[0].localeCompare(b.protocols[0]));
}

/** Section ordering: the most exposed first, because that's what needs review. */
export const REACHABILITY_ORDER: Reachability[] = ['external', 'lan', 'local'];

export const REACHABILITY_TITLE: Record<Reachability, string> = {
    external: 'Accessible depuis l’extérieur',
    lan: 'Réseau local',
    local: 'Local uniquement'
};

export const REACHABILITY_HINT: Record<Reachability, string> = {
    external:
        'En écoute sur une interface routable. L’accessibilité réelle depuis Internet dépend du NAT et du pare-feu en amont, que l’agent ne connaît pas.',
    lan: 'En écoute sur une adresse du réseau local : joignable depuis le LAN, pas directement depuis Internet.',
    local: 'En écoute sur la boucle locale : joignable uniquement depuis cette machine.'
};
