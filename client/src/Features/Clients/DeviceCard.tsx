import { StatusBadge } from '@/Components/StatusBadge';
import type { Device } from 'deveye-types';
import { agentVersionInfo, APP_VERSION } from '../agentVersion';
import { Switch } from './Switch';
import { statusMeta, formatLastSeen } from './format';
import type { DeviceActions } from './useDeviceActions';
import styles from './Clients.module.css';

/** One device card (header + info + persistence/privileges + actions). */
export function DeviceCard({ device, actions }: { device: Device; actions: DeviceActions }) {
    const pendingDeletion = device.status === 'pending_deletion';
    const version = agentVersionInfo(device.agentVersion);
    const agent = device.report?.agent ?? null;
    const scope = agent?.serviceScope ?? 'none';

    return (
        <>
            <div className={styles.deviceHeader}>
                <span className={styles.deviceName}>{device.name}</span>
                <StatusBadge tone={device.online ? 'online' : 'offline'}>
                    {device.online ? 'En ligne' : 'Hors ligne'}
                </StatusBadge>
            </div>

            <div className={styles.deviceInfo}>
                <div className={styles.infoRow}>
                    <span className='icon icon-cpu' />
                    <span>{device.platform}</span>
                </div>
                <div className={styles.infoRow}>
                    <span className='icon icon-shield' />
                    <StatusBadge tone={statusMeta(device.status).tone} dot={false}>
                        {statusMeta(device.status).label}
                    </StatusBadge>
                </div>
                <div className={styles.infoRow}>
                    <span className='icon icon-clock' />
                    <span>{device.online ? 'En ligne' : formatLastSeen(device.lastSeen)}</span>
                </div>
                {version && (
                    <div
                        className={`${styles.infoRow} ${version.mismatch ? styles.versionWarn : ''}`}
                        title={
                            version.mismatch
                                ? `Interface en v${APP_VERSION} — une mise à jour de l’agent est disponible.`
                                : undefined
                        }
                    >
                        <span className={`icon ${version.mismatch ? 'icon-error' : 'icon-info'}`} />
                        <span>
                            Agent v{version.version}
                            {version.mismatch && <span className={styles.versionTag}>Mise à jour disponible</span>}
                        </span>
                    </div>
                )}
            </div>

            {device.online && agent && !pendingDeletion && (
                <div className={styles.deviceInfo}>
                    <div className={styles.infoRow}>
                        <span className={`icon ${agent.privileged ? 'icon-shield' : 'icon-cpu'}`} />
                        <span>
                            {agent.privileged ? 'root' : agent.user}
                            {' · '}
                            {scope === 'system'
                                ? 'Service système'
                                : scope === 'user'
                                  ? 'Démarrage auto (utilisateur)'
                                  : 'Démarrage manuel'}
                        </span>
                    </div>
                    <div className={styles.deviceActions}>
                        <Switch
                            checked={scope !== 'none'}
                            onChange={(v) => actions.setAutostart(device.id, v)}
                            label='Démarrage auto'
                        />
                        {scope !== 'system' ? (
                            <button
                                className={styles.actionBtn}
                                disabled={actions.serviceBusyId === device.id}
                                onClick={() => actions.elevateDevice(device.id)}
                                title='Élever en service système (root)'
                            >
                                <span className='icon icon-shield' /> Élever en root
                            </button>
                        ) : (
                            <button
                                className={styles.actionBtn}
                                disabled={actions.serviceBusyId === device.id}
                                onClick={() => actions.dropPrivilegesDevice(device.id)}
                                title='Rétrograder en service utilisateur'
                            >
                                <span className='icon icon-arrow-left' /> Rétrograder
                            </button>
                        )}
                    </div>
                </div>
            )}

            {device.deleteError && (
                <p className={styles.deleteErrorHint}>
                    <span className='icon icon-x-circle' /> Échec de la suppression : {device.deleteError}
                </p>
            )}

            {pendingDeletion ? (
                <p className={styles.pendingHint}>
                    Suppression demandée. L’agent s’auto-détruira à sa prochaine connexion, puis l’appareil sera archivé
                    (ses données restent consultables dans Monitoring).
                </p>
            ) : (
                device.status === 'pending' && (
                    <p className={styles.pendingHint}>
                        Approuvez cet appareil pour autoriser la collecte de métriques.
                    </p>
                )
            )}

            {pendingDeletion ? (
                <div className={styles.pendingActions}>
                    <button
                        className={`${styles.pendingBtn} ${styles.pendingCancel}`}
                        onClick={() => actions.cancelDeleteDevice(device.id)}
                    >
                        <span className='icon icon-x-circle' /> Annuler la suppression
                    </button>
                    <button
                        className={`${styles.pendingBtn} ${styles.pendingForce}`}
                        onClick={() => actions.setForceTarget({ id: device.id, name: device.name })}
                    >
                        <span className='icon icon-trash' /> Supprimer sans attendre
                    </button>
                </div>
            ) : (
                <div className={styles.deviceActions}>
                    {device.status === 'pending' && (
                        <button
                            className={`${styles.actionBtn} ${styles.actionPrimary}`}
                            onClick={() => actions.confirmDevice(device.id)}
                            title='Approuver'
                        >
                            <span className='icon icon-check-circle' /> Approuver
                        </button>
                    )}
                    {device.status === 'revoked' && (
                        <button
                            className={`${styles.actionBtn} ${styles.actionPrimary}`}
                            onClick={() => actions.reactivateDevice(device.id)}
                            title='Réactiver'
                        >
                            <span className='icon icon-check-circle' /> Réactiver
                        </button>
                    )}
                    {device.online && (
                        <button
                            className={styles.actionBtn}
                            onClick={() => actions.setPackagesTarget({ id: device.id, name: device.name })}
                            title='Mises à jour système'
                        >
                            <span className='icon icon-refresh' /> Mises à jour
                        </button>
                    )}
                    {device.online && device.agentUpdateAvailable && (
                        <button
                            className={`${styles.actionBtn} ${styles.actionPrimary}`}
                            onClick={() => actions.updateAgent(device.id)}
                            disabled={actions.updatingId === device.id}
                            title={
                                device.latestAgentVersion
                                    ? `Mettre à jour l’agent vers la v${device.latestAgentVersion}`
                                    : 'Mettre à jour l’agent'
                            }
                        >
                            <span className='icon icon-cloud' />{' '}
                            {actions.updatingId === device.id ? 'Mise à jour…' : 'Mettre à jour'}
                        </button>
                    )}
                    <button
                        className={styles.actionBtn}
                        onClick={() => actions.openRename(device.id, device.name)}
                        title='Renommer'
                    >
                        <span className='icon icon-edit' />
                    </button>
                    {device.status === 'active' && (
                        <button
                            className={`${styles.actionBtn} ${styles.actionDanger}`}
                            onClick={() => actions.revokeDevice(device.id)}
                            title='Révoquer'
                        >
                            <span className='icon icon-x-circle' />
                        </button>
                    )}
                    <button
                        className={`${styles.actionBtn} ${styles.actionDanger}`}
                        onClick={() => actions.setDeleteTarget({ id: device.id, name: device.name })}
                        title='Supprimer'
                    >
                        <span className='icon icon-trash' />
                    </button>
                </div>
            )}
        </>
    );
}
