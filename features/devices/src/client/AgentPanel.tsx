import { Switch, useCurrentUser } from 'deveye-sdk-client';
import type { AgentPolicy, AgentServiceScope, DeviceReport } from '@deveye/types';

import type { FleetDevice } from '../contracts/commands';
import { agentUpdatable } from './agentVersion';
import {
    ADMIN_ONLY,
    agentReach,
    ARCHIVED,
    firstReason,
    FOREIGN,
    LOCAL_POLICY,
    NO_WRITE,
    type Unavailable
} from './availability';
import type { DeviceActions } from './manage/useDeviceActions';
import type { useAgentUpdate } from './useAgentUpdate';
import styles from './style.module.css';

const SCOPE_LABEL: Record<AgentServiceScope, string> = {
    none: 'Aucun : l’agent ne survit pas à un redémarrage',
    user: 'À l’ouverture de session',
    system: 'Au démarrage de la machine (service système)'
};

const POLICY_LABEL: Record<keyof AgentPolicy, string> = {
    terminal: 'terminal',
    filesWrite: 'écriture de fichiers',
    power: 'commandes système',
    pkgUpgrade: 'mises à jour système',
    serviceElevate: 'élévation en root',
    destroy: 'auto-destruction',
    dockerDeploy: 'déploiements'
};

interface AgentAction {
    key: string;
    icon: string;
    label: string;
    desc: string;
    onClick: () => void;
    unavailable?: Unavailable;
    danger?: boolean;
    busy?: boolean;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className={styles.hwRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

/**
 * Une entrée de la popup. Inerte plutôt que masquée quand quelque chose
 * l'empêche, et le motif se lit en toutes lettres sous elle : c'est lui qui dit
 * quoi faire (se faire accorder le droit, rallumer la machine).
 */
function ActionRow({ action }: { action: AgentAction }) {
    const inert = action.unavailable !== undefined || action.busy === true;
    return (
        <button
            type='button'
            className={`${styles.powerRow} ${action.danger ? styles.powerRowDanger : ''}`}
            aria-disabled={inert}
            title={action.unavailable?.reason}
            onClick={() => {
                if (!inert) action.onClick();
            }}
        >
            <span
                className={`icon ${action.busy ? `icon-spinner ${styles.spinning}` : action.icon} ${styles.powerIcon}`}
            />
            <span className={styles.powerText}>
                <span className={styles.powerLabel}>{action.label}</span>
                <span className={styles.powerDesc}>{action.desc}</span>
                {action.unavailable && (
                    <span className={styles.agentReason}>
                        <span className={`icon ${action.unavailable.icon}`} />
                        {action.unavailable.reason}
                    </span>
                )}
            </span>
        </button>
    );
}

export interface AgentPanelProps {
    device: FleetDevice;
    report: DeviceReport | null;
    actions: DeviceActions;
    canWrite: boolean;
    updater: ReturnType<typeof useAgentUpdate>;
    onShowPrivilegeInfo: () => void;
}

/**
 * La popup « Agent » d'un appareil : ce que l'agent est (version, compte,
 * privilèges, démarrage, transport, politique locale), et tout ce qui se fait
 * sur lui : démarrage automatique, élévation, mise à jour, redémarrage,
 * interruption, approbation d'un réappairage, révocation de son accès. Le
 * démarrage automatique, l'élévation et la mise à jour relèvent de
 * l'administrateur global (`access.admin` côté serveur).
 */
export function AgentPanel({ device, report, actions, canWrite, updater, onShowPrivilegeInfo }: AgentPanelProps) {
    const isAdmin = useCurrentUser()?.role === 'admin';
    const agent = report?.agent ?? null;
    const target = { id: device.id, name: device.name };
    const scope = agent?.serviceScope ?? 'none';
    const busy = actions.serviceBusy?.id === device.id ? actions.serviceBusy.kind : null;
    const note = actions.deviceNote?.id === device.id ? actions.deviceNote : null;

    const reach = agentReach(device);
    const fleet = firstReason(!canWrite && NO_WRITE, device.foreign && FOREIGN);
    const adminOnly = firstReason(!isAdmin && ADMIN_ONLY, fleet, reach);
    const refused = agent ? (Object.keys(POLICY_LABEL) as (keyof AgentPolicy)[]).filter((k) => !agent.policy[k]) : [];

    const elevated = agent?.privileged === true && scope === 'system';
    const privilege: AgentAction = {
        key: elevated ? 'drop' : 'elevate',
        icon: elevated ? 'icon-lock' : 'icon-shield',
        label: elevated ? 'Rétrograder en service utilisateur' : 'Élever en service système (root)',
        desc: elevated
            ? 'L’agent redevient un service de session, sans privilèges : certaines sondes, les mises à jour système et Docker peuvent ne plus répondre.'
            : 'Sondes complètes, mises à jour système et Docker, relance au démarrage de la machine. Une fenêtre d’autorisation s’ouvre sur l’appareil, sinon la commande à y lancer s’affiche.',
        onClick: () => void (elevated ? actions.dropPrivilegesDevice(device.id) : actions.elevateDevice(device.id)),
        unavailable: firstReason(adminOnly, agent?.policy.serviceElevate === false && LOCAL_POLICY),
        busy: busy === 'privilege'
    };

    const lifecycle: AgentAction[] = [
        ...(device.status === 'pending'
            ? [
                  {
                      key: 'approve',
                      icon: 'icon-check-circle',
                      label: 'Approuver l’appareil',
                      desc: 'La machine a été reliée à nouveau : l’approuver la remet en service.',
                      onClick: () => actions.askApprove(target),
                      unavailable: fleet
                  }
              ]
            : []),
        ...(agentUpdatable(device)
            ? [
                  {
                      key: 'update',
                      icon: 'icon-cloud',
                      label: device.latestAgentVersion
                          ? `Mettre à jour vers la v${device.latestAgentVersion}`
                          : 'Mettre à jour l’agent',
                      desc: 'L’agent télécharge la version signée, la vérifie, puis se relance.',
                      onClick: () => void updater.update(device.id),
                      unavailable: firstReason(!isAdmin && ADMIN_ONLY, reach),
                      busy: updater.isBusy(device.id)
                  }
              ]
            : []),
        {
            key: 'restart',
            icon: 'icon-restart',
            label: 'Redémarrer l’agent',
            desc: 'Il se relance proprement : l’appareil est hors ligne quelques secondes.',
            onClick: () => void actions.restartAgent(device.id),
            unavailable: firstReason(fleet, reach),
            busy: actions.restartingId === device.id
        },
        {
            key: 'stop',
            icon: 'icon-power',
            label: 'Interrompre l’agent',
            desc:
                scope === 'none'
                    ? 'Il se ferme, et l’appareil reste hors ligne jusqu’à un relancement sur la machine.'
                    : 'Il se ferme, puis son service le relance.',
            onClick: () => actions.setStopTarget(target),
            unavailable: firstReason(fleet, reach)
        },
        {
            key: 'revoke',
            icon: 'icon-x-circle',
            label: 'Révoquer l’accès',
            desc: 'L’agent est coupé et son jeton détruit : l’appareil passe dans les archivés.',
            onClick: () => actions.askRevoke(target),
            unavailable: firstReason(fleet, device.status === 'archived' && ARCHIVED),
            danger: true
        }
    ];

    return (
        <div className={styles.hwContent}>
            <section className={styles.hwGroup}>
                <h4 className={styles.hwGroupTitle}>État</h4>
                {report && agent ? (
                    <dl className={styles.hwRows}>
                        <Row
                            label='Version'
                            value={
                                !device.agentVersion ? (
                                    'inconnue'
                                ) : agentUpdatable(device) ? (
                                    <span className={styles.agentVersionWarn}>
                                        <span className='icon icon-cloud' />v{device.agentVersion} · mise à jour
                                        disponible
                                    </span>
                                ) : (
                                    `v${device.agentVersion}`
                                )
                            }
                        />
                        <Row label='Compte' value={agent.user || 'inconnu'} />
                        <Row
                            label='Privilèges'
                            value={
                                agent.privileged
                                    ? device.platform === 'windows'
                                        ? 'élevé (administrateur)'
                                        : 'root'
                                    : 'limité'
                            }
                        />
                        <Row label='Démarrage' value={SCOPE_LABEL[scope]} />
                        <Row label='Transport' value={agent.insecureTransport ? 'en clair (http)' : 'chiffré (TLS)'} />
                        <Row
                            label='Politique locale'
                            value={
                                refused.length === 0
                                    ? 'tout est permis'
                                    : `refuse : ${refused.map((k) => POLICY_LABEL[k]).join(', ')}`
                            }
                        />
                        <Row label='Relevé le' value={new Date(report.collectedAt).toLocaleString('fr-FR')} />
                    </dl>
                ) : (
                    <p className={styles.powerHint}>
                        Aucun bilan reçu pour le moment : l’état de l’agent s’affichera dès son premier rapport.
                    </p>
                )}
            </section>

            <section className={styles.hwGroup}>
                <h4 className={styles.hwGroupTitle}>Démarrage automatique</h4>
                {scope === 'system' ? (
                    <p className={styles.powerDesc}>
                        Service système : l’agent est relancé à chaque démarrage de la machine. Pour revenir à un
                        démarrage de session, rétrogradez-le ci-dessous.
                    </p>
                ) : (
                    <>
                        <Switch
                            checked={scope === 'user'}
                            onChange={(enabled) => void actions.setAutostart(device.id, enabled)}
                            disabled={adminOnly !== undefined || busy !== null}
                            label='Relancer l’agent à l’ouverture de session'
                            hint={
                                busy === 'autostart'
                                    ? 'Application sur l’appareil…'
                                    : 'Sans cela, l’agent s’arrête avec la session et l’appareil reste hors ligne jusqu’à un relancement à la main.'
                            }
                        />
                        {adminOnly && (
                            <span className={styles.agentReason}>
                                <span className={`icon ${adminOnly.icon}`} />
                                {adminOnly.reason}
                            </span>
                        )}
                    </>
                )}
            </section>

            <section className={styles.hwGroup}>
                <div className={styles.agentGroupHead}>
                    <h4 className={styles.hwGroupTitle}>Privilèges</h4>
                    <button type='button' className={styles.agentInfoLink} onClick={onShowPrivilegeInfo}>
                        <span className='icon icon-info' />
                        Ce que ça change
                    </button>
                </div>
                <div className={styles.powerList}>
                    <ActionRow action={privilege} />
                </div>
            </section>

            <section className={styles.hwGroup}>
                <h4 className={styles.hwGroupTitle}>Cycle de vie</h4>
                <div className={styles.powerList}>
                    {lifecycle.map((a) => (
                        <ActionRow key={a.key} action={a} />
                    ))}
                </div>
            </section>

            {note && <p className={note.tone === 'ok' ? styles.powerOk : styles.powerErr}>{note.message}</p>}
            {actions.actionError && <p className={styles.powerErr}>{actions.actionError}</p>}
        </div>
    );
}
