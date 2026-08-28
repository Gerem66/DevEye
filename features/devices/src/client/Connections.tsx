import type { DeviceReport } from '@deveye/types';
import { serviceName } from './ports';
import styles from './style.module.css';

/** `addr:port`, bracketing IPv6 hosts so the port stays unambiguous. */
function endpoint(addr: string, port: number): string {
    const host = addr.includes(':') ? `[${addr}]` : addr;
    return `${host}:${port}`;
}

/**
 * Body of the "Connexions TCP établies" dialog (opened from the Connexions KPI).
 * Lists the established TCP sockets the agent captured in its latest report —
 * local and remote endpoint of each. Both the KPI count and this detail come
 * from the same socket probe, but the KPI rides every collection tick while the
 * report is hourly, so the two can differ; the caption states the report's own
 * time and count.
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
                            const service = serviceName(c.remotePort);
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
