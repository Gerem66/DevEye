import { useState } from 'react';
import {
    Button,
    copyText,
    ErrorNote,
    errorNote,
    SearchSelect,
    settingsStyles as shell,
    Switch,
    TextInput,
    useRemoteTargets,
    type ErrorNoteInput,
    type RemoteWorkspaceTarget
} from 'deveye-sdk-client';
import type { Device } from '@deveye/types';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from '../api';
import { POLICY_KEYS, POLICY_LABEL, type PolicyKey } from '../policy';
import { useDevices } from '../store';
import { formatExpiry } from './format';
import { isInstanceName, linkCommand, suggestInstanceName } from './installCommand';
import styles from './style.module.css';

/** Le code demandé là-bas vaut un quart d'heure, pour cette machine seule. */
const CODE_TTL_SECONDS = 900;

/**
 * Sous le partage d'un appareil : l'enrôler aussi auprès d'une autre instance
 * du compte (une distante, ou celle-ci quand l'appareil vit sur une distante).
 * Ce navigateur demande un code d'appairage à l'espace choisi, là-bas, et
 * compose la commande qui ajoute à l'agent de la machine une instance nommée
 * pour ce serveur. L'enrôlement actuel ne bouge pas : les deux serveurs
 * suivent la machine, chacun par son agent.
 */
export function DevicesSharingPanel({ scope }: SettingsPanelProps) {
    const { devices } = useDevices();
    const { instances, workspaces } = useRemoteTargets();
    if (scope.kind !== 'item' || instances.length === 0) return null;
    const device = devices.find((d) => d.id === scope.itemId);
    // Projeté ici : il se gère depuis son domicile, comme son déplacement.
    if (!device || device.foreign) return null;
    return <EnrollElsewhere device={device} workspaces={workspaces} />;
}

interface Issued {
    target: RemoteWorkspaceTarget;
    code: string;
    /** Secondes Unix. */
    expiresAt: number;
    /** L'origine publique de l'instance, celle que l'agent joint. */
    server: string;
}

function EnrollElsewhere({ device, workspaces }: { device: Device; workspaces: readonly RemoteWorkspaceTarget[] }) {
    const agent = device.report?.agent ?? null;
    const [choice, setChoice] = useState('');
    const [instance, setInstance] = useState('');
    const [autostart, setAutostart] = useState(true);
    // Un agent privilégié ici le sera là-bas : même machine, même service.
    const [admin, setAdmin] = useState(agent?.privileged === true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [issued, setIssued] = useState<Issued | null>(null);
    const [copied, setCopied] = useState(false);

    const target = workspaces.find((w) => w.key === choice) ?? null;
    const validName = isInstanceName(instance);
    // Les mêmes droits qu'ici : ce que la machine refuse à ce serveur, elle le
    // refuse à l'autre. Ils se changent sur la machine, jamais d'un serveur.
    const denied = POLICY_KEYS.filter((key) => agent?.policy[key] === false);
    const windows = device.platform === 'windows';

    const pick = (key: string) => {
        setChoice(key);
        setIssued(null);
        setError(null);
        const picked = workspaces.find((w) => w.key === key);
        if (picked) setInstance(suggestInstanceName(picked.instanceLabel, picked.instanceOrigin));
    };

    const generate = async () => {
        if (!target || !validName) return;
        setBusy(true);
        setError(null);
        try {
            const at = { instanceId: target.instanceId, workspaceId: target.workspaceId };
            const created = await api.sendTo(at, 'devices.linkCodeCreate', {
                ttlSeconds: CODE_TTL_SECONDS,
                maxUses: 1
            });
            const { server } = await api.sendTo(at, 'devices.linkCodeList', {});
            setIssued({ target, code: created.code, expiresAt: created.expiresAt, server });
        } catch (e) {
            setError(errorNote(e, `Impossible d’obtenir un code d’appairage dans « ${target.workspaceName} ».`));
        } finally {
            setBusy(false);
        }
    };

    // La commande suit les options : changer le nom ou sudo après coup ne
    // redemande pas de code.
    const command =
        issued && issued.target.key === choice && validName
            ? linkCommand({
                  os: device.platform,
                  server: issued.server,
                  code: issued.code,
                  denied,
                  autostart,
                  admin,
                  shuffleId: false,
                  instance
              })
            : null;
    const plaintext =
        issued?.server.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(issued.server);

    const copyCommand = async () => {
        if (!command || !(await copyText(command))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className={shell.field}>
            <span className={shell.fieldLabel}>Enrôler vers un autre espace</span>
            {workspaces.length === 0 ? (
                <span className={shell.fieldHint}>
                    Connectez-vous à vos autres instances depuis le menu des espaces : leurs espaces apparaîtront ici.
                </span>
            ) : (
                <>
                    <div className={shell.fieldWithAction}>
                        <SearchSelect
                            value={choice}
                            disabled={busy}
                            aria-label='Enrôler cet appareil vers'
                            placeholder='Choisir un espace d’une autre instance…'
                            options={workspaces.map((w) => ({
                                value: w.key,
                                label: `${w.workspaceName} · ${w.instanceLabel}`,
                                detail: w.unavailable ?? undefined,
                                disabled: w.unavailable !== null
                            }))}
                            onChange={pick}
                        />
                        <Button
                            variant='secondary'
                            disabled={busy || target === null || !validName}
                            onClick={() => void generate()}
                        >
                            {busy ? 'Demande…' : 'Générer la commande'}
                        </Button>
                    </div>
                    {target && (
                        <div className={styles.pairOptions}>
                            <label className={shell.field}>
                                <span className={shell.sectionLabel}>Nom de l’instance de l’agent</span>
                                <TextInput
                                    value={instance}
                                    onChange={(e) => setInstance(e.target.value.trim())}
                                    spellCheck={false}
                                    autoCapitalize='off'
                                    autoCorrect='off'
                                    error={validName ? undefined : 'invalide'}
                                />
                                {!validName && (
                                    <span className={styles.genError}>
                                        De 1 à 32 minuscules, chiffres et tirets, sans tiret aux extrémités, autre que{' '}
                                        <code>default</code>.
                                    </span>
                                )}
                            </label>
                            <Switch
                                checked={autostart}
                                onChange={setAutostart}
                                label='Démarrer avec la machine'
                                hint='L’agent se relance seul, après un redémarrage aussi.'
                            />
                            <Switch
                                checked={admin}
                                onChange={setAdmin}
                                label='En administrateur'
                                hint={
                                    windows
                                        ? 'Ouvrez PowerShell en tant qu’administrateur : l’agent sert toute la machine.'
                                        : 'Avec sudo : l’agent sert toute la machine, dès son démarrage.'
                                }
                            />
                            <p className={styles.pairHint}>
                                {rightsLine(denied)} Pour les changer plus tard,{' '}
                                <code>deveye-agent --instance {validName ? instance : '<nom>'} policy</code> sur la
                                machine.
                            </p>
                        </div>
                    )}
                    {command && issued && (
                        <>
                            <pre className={styles.command}>{command}</pre>
                            <div className={styles.commandActions}>
                                <span className={styles.pairHint}>
                                    {formatExpiry(issued.expiresAt)}, pour cette machine seule.
                                    {windows && ' Dans PowerShell.'}
                                </span>
                                <Button variant='secondary' icon='copy' onClick={() => void copyCommand()}>
                                    {copied ? 'Copié' : 'Copier la commande'}
                                </Button>
                            </div>
                            {plaintext && (
                                <p className={styles.genError}>
                                    Ce serveur n’est pas en HTTPS : l’agent refusera de s’y relier sans{' '}
                                    <code>--insecure-plaintext</code>.
                                </p>
                            )}
                        </>
                    )}
                </>
            )}
            <span className={shell.fieldHint}>
                L’agent de cette machine reste relié ici. La commande lui ajoute une instance nommée pour l’autre
                serveur, qui verra l’appareil et le gérera de son côté.
            </span>
            <ErrorNote note={error} />
        </div>
    );
}

/** Ce que la machine refuse à ce serveur, qu'elle refusera à l'autre. */
function rightsLine(denied: readonly PolicyKey[]): string {
    if (denied.length === 0) return 'Mêmes droits qu’ici : contrôle complet.';
    if (denied.length === POLICY_KEYS.length) return 'Mêmes droits qu’ici : surveillance seule.';
    return `Mêmes droits qu’ici : refuse ${denied.map((key) => POLICY_LABEL[key]).join(', ')}.`;
}
