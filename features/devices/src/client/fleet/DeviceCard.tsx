import { StatusBadge } from 'deveye-sdk-client';
import type { Device } from '@deveye/types';

import { agentUpdatable } from '../agentVersion';
import { statusMeta, formatLastSeen } from './format';
import type { DeviceActions } from './useDeviceActions';
import styles from './style.module.css';

/** One device card (header + info + persistence/privileges + actions). */
export function DeviceCard({ device, actions }: { device: Device; actions: DeviceActions }) {
    const pendingDeletion = device.status === 'pending_deletion';
    const agent = device.report?.agent ?? null;
    const scope = agent?.serviceScope ?? 'none';
    const updating = actions.isUpdating(device.id);
    const serviceActive = actions.serviceBusy?.id === device.id;
    const autostartBusy = serviceActive && actions.serviceBusy?.kind === 'autostart';
    const rootBusy = serviceActive && actions.serviceBusy?.kind === 'privilege';
    const note = actions.deviceNote?.id === device.id ? actions.deviceNote : null;
    // An update is worth offering when the agent runs an older build than this
    // interface (or the server advertises a newer signed binary).
    const updatable = device.online && agentUpdatable(device);
    // Combien d'espaces voient cette machine. Toujours au moins un (l'espace
    // d'appairage) : le compte ne s'affiche donc qu'à partir de deux, où il
    // apprend quelque chose.
    const shareCount = device.workspaceIds.length;

    return (
        <>
            <div className={styles.deviceHeader}>
                <div className={styles.deviceNameRow}>
                    <span className={styles.deviceName}>{device.name}</span>
                    <button
                        className={styles.nameEditBtn}
                        onClick={() => actions.openRename(device.id, device.name)}
                        title='Renommer'
                    >
                        <span className='icon icon-edit' />
                    </button>
                </div>
                <StatusBadge tone={device.online ? 'online' : 'offline'}>
                    {device.online ? 'En ligne' : 'Hors ligne'}
                </StatusBadge>
            </div>

            <div className={styles.deviceInfo}>
                <div className={styles.infoRow}>
                    <span className='icon icon-cpu' />
                    <span>
                        {device.platform}
                        {agent && ` · ${agent.privileged ? 'root' : agent.user}`}
                    </span>
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
                {device.agentVersion && (
                    <div className={styles.infoRow}>
                        <span className={`icon ${updatable ? 'icon-cloud' : 'icon-info'}`} />
                        <span>
                            Agent v{device.agentVersion}
                            {updatable && (
                                <span className={styles.updateNote}>
                                    {' · '}
                                    {device.latestAgentVersion
                                        ? `mise à jour disponible (v${device.latestAgentVersion})`
                                        : 'mise à jour disponible'}
                                </span>
                            )}
                        </span>
                    </div>
                )}
            </div>

            {agent && !pendingDeletion && (
                <div className={styles.serviceBox}>
                    {/* Each toggle's "on" colour reflects the agent's *reported* scope
                        (the confirmed state), never the action that was requested.
                        Offline: the toggles stay (last-known state) but are disabled. */}
                    <div className={styles.toggleRow}>
                        <button
                            className={`${styles.iconBtn} ${scope !== 'none' ? styles.iconApprove : ''}`}
                            aria-pressed={scope !== 'none'}
                            disabled={serviceActive || !device.online}
                            onClick={() => actions.setAutostart(device.id, scope === 'none')}
                            title={
                                !device.online
                                    ? 'Appareil hors ligne — dernière configuration connue'
                                    : scope === 'none'
                                      ? 'Activer le démarrage automatique'
                                      : 'Désactiver le démarrage automatique'
                            }
                        >
                            {autostartBusy ? (
                                <span className={`icon icon-spinner ${styles.spinning}`} />
                            ) : (
                                <span className={`icon ${scope !== 'none' ? 'icon-check-circle' : 'icon-x-circle'}`} />
                            )}
                        </button>
                        <span className={styles.toggleLabel}>Démarrage auto</span>
                    </div>
                    <div className={styles.toggleRow}>
                        <button
                            className={`${styles.iconBtn} ${scope === 'system' ? styles.iconApprove : ''}`}
                            aria-pressed={scope === 'system'}
                            disabled={serviceActive || !device.online}
                            onClick={() =>
                                scope === 'system'
                                    ? actions.dropPrivilegesDevice(device.id)
                                    : actions.elevateDevice(device.id)
                            }
                            title={
                                !device.online
                                    ? 'Appareil hors ligne — dernière configuration connue'
                                    : scope === 'system'
                                      ? 'Rétrograder en service utilisateur'
                                      : 'Élever en service système (root)'
                            }
                        >
                            {rootBusy ? (
                                <span className={`icon icon-spinner ${styles.spinning}`} />
                            ) : (
                                <span
                                    className={`icon ${scope === 'system' ? 'icon-check-circle' : 'icon-x-circle'}`}
                                />
                            )}
                        </button>
                        <span className={styles.toggleLabel}>Service système (root)</span>
                    </div>
                    {!device.online && (
                        <span className={styles.serviceOfflineHint}>Hors ligne — dernière configuration connue</span>
                    )}
                    {/* Le verdict de l'agent, là où on vient de cliquer. */}
                    {note && (
                        <span className={note.tone === 'ok' ? styles.serviceNoteOk : styles.serviceNoteError}>
                            <span className={`icon ${note.tone === 'ok' ? 'icon-check-circle' : 'icon-x-circle'}`} />{' '}
                            {note.message}
                        </span>
                    )}
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
                    {updatable && (
                        <button
                            className={`${styles.actionBtn} ${styles.actionUpdate}`}
                            onClick={() => actions.updateAgent(device.id)}
                            disabled={updating}
                            title={
                                device.latestAgentVersion
                                    ? `Mettre à jour l’agent vers la v${device.latestAgentVersion}`
                                    : 'Mettre à jour l’agent'
                            }
                        >
                            <span className={`icon ${updating ? `icon-spinner ${styles.spinning}` : 'icon-cloud'}`} />
                        </button>
                    )}
                    {/* Agent process lifecycle — online only. Restart is offered only
                        without autostart: supervised, an interrupt already comes back
                        by itself, so a dedicated restart would be redundant. */}
                    {device.online && device.status === 'active' && scope === 'none' && (
                        <button
                            className={styles.actionBtn}
                            onClick={() => actions.restartAgent(device.id)}
                            disabled={actions.restartingId === device.id}
                            title='Redémarrer l’agent (hors ligne quelques secondes, puis relancé proprement)'
                        >
                            <span
                                className={`icon ${actions.restartingId === device.id ? `icon-spinner ${styles.spinning}` : 'icon-restart'}`}
                            />
                        </button>
                    )}
                    {device.online && device.status === 'active' && (
                        <button
                            className={styles.actionBtn}
                            onClick={() => actions.setStopTarget({ id: device.id, name: device.name })}
                            title='Interrompre l’agent'
                        >
                            <span className='icon icon-pause' />
                        </button>
                    )}
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
                        className={styles.actionBtn}
                        onClick={() => actions.setShareTarget({ id: device.id, name: device.name })}
                        title={shareCount > 1 ? `Espaces ayant accès (${shareCount})` : 'Espaces ayant accès'}
                    >
                        <span className='icon icon-users' />
                        {shareCount > 1 && <span className={styles.actionCount}>{shareCount}</span>}
                    </button>
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
