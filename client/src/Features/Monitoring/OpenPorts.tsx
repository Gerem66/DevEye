import type { OpenPort } from 'deveye-types';
import styles from './Monitoring.module.css';

/** A few common ports labelled, to make the list readable at a glance. */
const WELL_KNOWN: Record<number, string> = {
    22: 'SSH',
    25: 'SMTP',
    53: 'DNS',
    80: 'HTTP',
    110: 'POP3',
    143: 'IMAP',
    443: 'HTTPS',
    465: 'SMTPS',
    587: 'SMTP',
    993: 'IMAPS',
    3000: 'app',
    3306: 'MySQL',
    5432: 'PostgreSQL',
    6379: 'Redis',
    8080: 'HTTP-alt',
    8443: 'HTTPS-alt',
    27017: 'MongoDB'
};

type Exposure = 'world' | 'local' | 'bound';

/** Classify a bind address by reachability. */
function exposure(address: string): Exposure {
    if (address === '0.0.0.0' || address === '::' || address === '*') return 'world';
    if (address === '127.0.0.1' || address === '::1' || address.startsWith('127.')) return 'local';
    return 'bound';
}

const EXPOSURE_LABEL: Record<Exposure, string> = {
    world: 'exposé (toutes interfaces)',
    local: 'local (loopback)',
    bound: 'interface dédiée'
};

/**
 * Listening ports zone. `null` = the agent predates port collection; `[]` = the
 * agent collected and found none. World-exposed ports are highlighted so an
 * unexpectedly public service stands out.
 */
export function OpenPorts({ ports }: { ports: OpenPort[] | null }) {
    if (ports === null) {
        return <p className={styles.waitingMsg}>Ports non collectés (agent à mettre à jour).</p>;
    }
    if (ports.length === 0) {
        return <p className={styles.waitingMsg}>Aucun port en écoute.</p>;
    }
    return (
        <div className={styles.portGrid}>
            {ports.map((p, i) => {
                const exp = exposure(p.address);
                const cls = exp === 'world' ? styles.portWorld : exp === 'local' ? styles.portLocal : styles.portBound;
                const svc = WELL_KNOWN[p.port];
                const title = `${p.proto.toUpperCase()} ${p.address}:${p.port}${svc ? ` · ${svc}` : ''} · ${EXPOSURE_LABEL[exp]}`;
                return (
                    <span
                        key={`${p.proto}-${p.address}-${p.port}-${i}`}
                        className={`${styles.portChip} ${cls}`}
                        title={title}
                    >
                        <span className={styles.portNum}>{p.port}</span>
                        <span className={styles.portMeta}>
                            {p.proto}
                            {svc ? ` · ${svc}` : ''}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}
