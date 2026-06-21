import type { DeviceReport } from 'deveye-types';
import styles from './Monitoring.module.css';

/** Common remote ports → service label, to make a connection's purpose legible. */
const WELL_KNOWN: Record<number, string> = {
    20: 'FTP',
    21: 'FTP',
    22: 'SSH',
    23: 'Telnet',
    25: 'SMTP',
    53: 'DNS',
    80: 'HTTP',
    110: 'POP3',
    143: 'IMAP',
    443: 'HTTPS',
    465: 'SMTPS',
    587: 'SMTP',
    993: 'IMAPS',
    995: 'POP3S',
    3306: 'MySQL',
    5432: 'PostgreSQL',
    6379: 'Redis',
    8080: 'HTTP-alt',
    8443: 'HTTPS-alt',
    27017: 'MongoDB'
};

/** `addr:port`, bracketing IPv6 hosts so the port stays unambiguous. */
function endpoint(addr: string, port: number): string {
    const host = addr.includes(':') ? `[${addr}]` : addr;
    return `${host}:${port}`;
}

/**
 * Body of the "Connexions TCP établies" dialog (opened from the Connexions KPI).
 * Lists the established TCP sockets the agent captured in its latest report —
 * local and remote endpoint of each. The live KPI counts connections every ~10 s
 * while this detail comes with the (slower) report, so the two counts can differ
 * slightly; the caption states the report's own time and count.
 */
export function Connections({ report }: { report: DeviceReport | null }) {
    if (!report) {
        return <p>Aucun bilan reçu pour le moment.</p>;
    }
    const conns = report.connections;
    if (conns === null) {
        return (
            <p className={styles.hwLegacyNote}>
                Le détail des connexions n&apos;est pas disponible sur ce rapport (agent antérieur à cette
                fonctionnalité). Il sera renseigné au prochain bilan.
            </p>
        );
    }

    return (
        <div className={styles.connContent}>
            <p className={styles.focusCaption}>
                {conns.length} connexion{conns.length > 1 ? 's' : ''} établie{conns.length > 1 ? 's' : ''} · relevé du{' '}
                {new Date(report.collectedAt).toLocaleString('fr-FR')}
            </p>
            {conns.length === 0 ? (
                <p className={styles.waitingMsg}>Aucune connexion TCP établie à ce moment.</p>
            ) : (
                <table className={styles.connTable}>
                    <thead>
                        <tr>
                            <th>Locale</th>
                            <th>Distante</th>
                        </tr>
                    </thead>
                    <tbody>
                        {conns.map((c, i) => {
                            const service = WELL_KNOWN[c.remotePort];
                            return (
                                <tr key={`${c.localAddress}:${c.localPort}-${c.remoteAddress}:${c.remotePort}-${i}`}>
                                    <td className={styles.connAddr}>{endpoint(c.localAddress, c.localPort)}</td>
                                    <td className={styles.connAddr}>
                                        {endpoint(c.remoteAddress, c.remotePort)}
                                        {service && <span className={styles.connService}> {service}</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
