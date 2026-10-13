import { useState } from 'react';
import { CopyButton, SegmentedControl, Switch } from 'deveye-sdk-client';
import type { AgentServiceScope, DeviceReport } from '@deveye/types';

import type { FleetDevice } from '../../contracts/commands';
import { restartsAt } from '../AgentPanel';
import { reconnectCommands } from './reconnectCommand';
import styles from './style.module.css';

type Rights = 'user' | 'root';

const SCOPE_PHRASE: Record<AgentServiceScope, string> = {
    none: 'lancé à la main',
    user: 'service de session',
    system: 'service système'
};

function knownState(agent: NonNullable<DeviceReport['agent']>, windows: boolean): string {
    const parts = [
        SCOPE_PHRASE[agent.serviceScope],
        agent.privileged ? (windows ? 'administrateur' : 'root') : 'sans privilèges'
    ];
    if (agent.autostart !== undefined) {
        parts.push(agent.autostart ? 'démarrage automatique actif' : 'sans démarrage automatique');
    }
    return `Dernier état connu : ${parts.join(', ')}.`;
}

/**
 * Le corps de la popup « Reconnecter l'agent » : les commandes à lancer sur la
 * machine pour relancer son agent, avec les droits et le démarrage choisis.
 * Les choix partent du dernier rapport, pour que la commande proposée d'emblée
 * remette l'agent comme il était.
 */
export function ReconnectAgent({ device, report }: { device: FleetDevice; report: DeviceReport | null }) {
    const agent = report?.agent ?? null;
    const scope = agent?.serviceScope ?? 'none';
    const windows = device.platform === 'windows';
    const wasRoot = scope === 'system' || (scope === 'none' && agent?.privileged === true);
    const [rights, setRights] = useState<Rights>(wasRoot ? 'root' : 'user');
    const [autostart, setAutostart] = useState(agent?.autostart ?? true);

    const root = rights === 'root';
    const commands = reconnectCommands({ os: device.platform, root, autostart, scope });
    const where = (admin: boolean) =>
        windows
            ? admin
                ? 'Dans PowerShell ouvert en tant qu’administrateur'
                : 'Dans PowerShell, sans élévation'
            : admin
              ? 'Dans un terminal de l’appareil'
              : 'Dans un terminal de l’appareil, sans sudo';

    return (
        <div>
            <p className={`${styles.pairHint} ${styles.reconnectKnown}`}>
                {agent ? knownState(agent, windows) : 'Aucun rapport reçu de cet agent : son état est inconnu.'}
            </p>

            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Droits de l’agent</span>
                <SegmentedControl
                    value={rights}
                    options={[
                        { value: 'user', label: 'Utilisateur' },
                        { value: 'root', label: windows ? 'Administrateur' : 'Root' }
                    ]}
                    onChange={setRights}
                    aria-label='Droits de l’agent'
                />
                <p className={styles.pairHint}>
                    {root
                        ? 'Service système : sondes complètes, mises à jour système et Docker.'
                        : 'Avec les droits du compte : certaines sondes, les mises à jour système et Docker peuvent ne pas répondre.'}
                </p>
            </div>

            <div className={styles.pairOptions}>
                <Switch
                    checked={autostart}
                    onChange={setAutostart}
                    label='Redémarrer avec l’appareil'
                    hint={
                        autostart
                            ? `L’agent repart ${restartsAt(root, device.platform)}.`
                            : 'L’agent tourne jusqu’au prochain redémarrage, puis reste hors ligne jusqu’à un relancement à la main.'
                    }
                />
            </div>

            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Commandes à lancer sur l’appareil</span>
                {commands.map((c, i) => (
                    <div key={c.command} className={styles.reconnectStep}>
                        <p className={styles.pairHint}>
                            {commands.length > 1 && `${i + 1}. `}
                            {where(c.admin)}
                        </p>
                        <div className={styles.commandRow}>
                            <pre className={styles.command}>{c.command}</pre>
                            <CopyButton value={c.command} label='Copier la commande' />
                        </div>
                    </div>
                ))}
                {/* Élevé par réflexe, l'agent lit l'enrôlement du service système. */}
                {!root && commands.some((c) => !c.admin) && (
                    <p className={styles.pairHint}>
                        {windows ? 'Pas en administrateur' : 'Pas sous sudo'} : élevé, l’agent lit l’enrôlement du
                        service système, et non celui du compte.
                    </p>
                )}
                {!root && scope === 'system' && (
                    <p className={styles.pairHint}>
                        Le service système est retiré et l’enrôlement revient au compte qui lance la commande :
                        lancez-la depuis celui qui fera tourner l’agent.
                    </p>
                )}
                {windows && !root && commands.at(-1)?.admin && (
                    <p className={styles.pairHint}>
                        Windows n’enregistre une tâche à l’ouverture de session qu’en administrateur : l’agent tourne
                        ensuite avec les droits du compte.
                    </p>
                )}
            </div>

            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Si l’agent ne repart pas</span>
                <p className={styles.pairHint}>
                    <code>deveye-agent status</code> sur la machine dit s’il est relié et s’il tourne. S’il n’y est plus
                    installé, appairez de nouveau la machine (« Appairer un appareil ») : elle retrouve cette fiche, à
                    approuver.
                </p>
            </div>
        </div>
    );
}
