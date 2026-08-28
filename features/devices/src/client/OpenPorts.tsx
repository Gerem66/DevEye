import {
    classifyAddress,
    REACHABILITY_HINT,
    REACHABILITY_ORDER,
    REACHABILITY_TITLE,
    SCOPE_LABEL,
    serviceName,
    type PortGroup,
    type Reachability
} from './ports';
import styles from './style.module.css';

interface OpenPortsProps {
    /** Grouped by the parent, so the header count can't drift from the sections. */
    groups: PortGroup[] | null;
    /** False when the agent isn't root: process attribution is then partial. */
    privileged: boolean;
}

const CHIP_CLASS: Record<Reachability, string> = {
    external: styles.portWorld,
    lan: styles.portBound,
    local: styles.portLocal
};

/** Tooltip listing every real socket merged into one bubble. */
function groupTitle(g: PortGroup): string {
    const protos = g.protocols.map((p) => p.toUpperCase()).join(' + ');
    const binds = g.addresses.map((a) => `${a}:${g.port} (${SCOPE_LABEL[classifyAddress(a)]})`).join('\n');
    const owners = g.processes.length
        ? `\nProcessus : ${g.processes.join(', ')}${g.pids.length ? ` (pid ${g.pids.join(', ')})` : ''}`
        : '';
    const iface = g.interfaceName ? `\nInterface : ${g.interfaceName}` : '';
    return `${protos} · port ${g.port}${iface}\n${binds}${owners}`;
}

function PortChip({ group }: { group: PortGroup }) {
    const svc = serviceName(group.port);
    const dualStack = group.families.length > 1;
    return (
        <span className={`${styles.portChip} ${CHIP_CLASS[group.reachability]}`} title={groupTitle(group)}>
            <span className={styles.portNum}>{group.port}</span>
            <span className={styles.portMeta}>
                {group.protocols.join('/')}
                {svc ? ` · ${svc}` : ''}
            </span>
            {group.processes.length > 0 && <span className={styles.portProc}>{group.processes.join(', ')}</span>}
            {dualStack && <span className={styles.portFamily}>IPv4+IPv6</span>}
        </span>
    );
}

/** One reachability section, optionally split per interface. */
function PortSection({ reach, groups }: { reach: Reachability; groups: PortGroup[] }) {
    // Only introduce an interface level when there is actually more than one to
    // tell apart — a single-NIC machine gets no useless nesting.
    const byInterface = new Map<string, PortGroup[]>();
    for (const g of groups) {
        const key = g.interfaceName ?? '';
        byInterface.set(key, [...(byInterface.get(key) ?? []), g]);
    }
    const split = byInterface.size > 1;

    return (
        <div className={styles.portSection}>
            <h5 className={styles.portSectionTitle} title={REACHABILITY_HINT[reach]}>
                {REACHABILITY_TITLE[reach]}
                <span className={styles.portSectionCount}>{groups.length}</span>
            </h5>
            {split ? (
                [...byInterface.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([iface, list]) => (
                        <div key={iface || '*'} className={styles.portIfaceBlock}>
                            <span className={styles.portIfaceLabel}>{iface || 'Toutes les interfaces'}</span>
                            <div className={styles.portGrid}>
                                {list.map((g) => (
                                    <PortChip key={`${g.port}-${g.interfaceName ?? '*'}`} group={g} />
                                ))}
                            </div>
                        </div>
                    ))
            ) : (
                <div className={styles.portGrid}>
                    {groups.map((g) => (
                        <PortChip key={`${g.port}-${g.interfaceName ?? '*'}`} group={g} />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Listening ports, grouped into what can actually be reached from where.
 *
 * The agent reports one entry per bind address; rendering those raw produced
 * visually identical chips for one service (a dual-stack listener binds both
 * `0.0.0.0` and `::`). Grouping (in `ports.ts`) turns each port into a single
 * bubble per reachability bucket and interface, merging protocols and families.
 *
 * `null` = the agent predates port collection; `[]` = collected and none found.
 */
export function OpenPorts({ groups, privileged }: OpenPortsProps) {
    if (groups === null) {
        return <p className={styles.waitingMsg}>Ports non collectés (agent à mettre à jour).</p>;
    }
    if (groups.length === 0) {
        return <p className={styles.waitingMsg}>Aucun port en écoute.</p>;
    }

    const sections = REACHABILITY_ORDER.map((reach) => ({
        reach,
        groups: groups.filter((g) => g.reachability === reach)
    })).filter((s) => s.groups.length > 0);

    // Attribution is privilege-gated: say so rather than leaving silent blanks.
    const missingOwners = groups.some((g) => g.processes.length === 0);

    return (
        <>
            {sections.map((section) => (
                <PortSection key={section.reach} reach={section.reach} groups={section.groups} />
            ))}
            {missingOwners && !privileged && (
                <p className={styles.portsNote}>
                    Processus propriétaires masqués : l’agent n’est pas privilégié et ne voit que ses propres sockets.
                </p>
            )}
        </>
    );
}
