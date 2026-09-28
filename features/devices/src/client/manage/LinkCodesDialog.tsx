import { useId, useState } from 'react';
import {
    Button,
    Checkbox,
    ChoiceCards,
    copyText,
    Dialog,
    NumberInput,
    SegmentedControl,
    Switch
} from 'deveye-sdk-client';
import { LINK_CODE_MAX_USES } from '@deveye/types';

import { POLICY_KEYS, POLICY_LABEL, type PolicyKey } from '../policy';
import { formatExpiry } from './format';
import { installCommand, linkCommand, osOf, type InstallOs } from './installCommand';
import { TTL_PRESETS, type LinkCodes } from './useLinkCodes';
import styles from './style.module.css';

type Rights = 'full' | 'monitor' | 'custom';
type Variant = 'install' | 'link';

const OS_OPTIONS: readonly { value: InstallOs; label: string }[] = [
    { value: 'linux', label: 'Linux' },
    { value: 'macos', label: 'macOS' },
    { value: 'windows', label: 'Windows' }
];

const RIGHTS_OPTIONS: readonly { value: Rights; label: string; icon: string; description: string }[] = [
    {
        value: 'full',
        label: 'Contrôle complet',
        icon: 'icon-unlock',
        description:
            'Terminal, fichiers, alimentation, mises à jour, Docker : tout ce que DevEye sait faire à distance.'
    },
    {
        value: 'monitor',
        label: 'Surveillance seule',
        icon: 'icon-eye-open',
        description: 'Mesures, rapports et alertes. Rien ne se pilote à distance, pas même la lecture des fichiers.'
    },
    {
        value: 'custom',
        label: 'Sur mesure',
        icon: 'icon-settings',
        description: 'Vous choisissez ce que DevEye pourra faire sur cette machine.'
    }
];

const VARIANT_OPTIONS: readonly { value: Variant; label: string }[] = [
    { value: 'install', label: 'Installer l’agent' },
    { value: 'link', label: 'Agent déjà installé' }
];

function browserPlatform(): string {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return nav.userAgentData?.platform || nav.platform || nav.userAgent;
}

/** « 3 appareils actifs sur 5 », ou ce que l'offre refuse d'emblée. */
function quotaLine({ used, limit }: { used: number; limit: number }): string {
    if (limit === 0) return 'L’offre de l’espace n’admet aucun appareil actif.';
    return `Offre de l’espace : ${used} appareil${used > 1 ? 's' : ''} actif${used > 1 ? 's' : ''} sur ${limit}.`;
}

/**
 * The pairing dialog: how the machine will run the agent (system, rights,
 * start), the command to paste on it, and the link codes that command uses.
 */
export function LinkCodesDialog({ links, onDownload }: { links: LinkCodes; onDownload: () => void }) {
    const [os, setOs] = useState<InstallOs>(() => osOf(browserPlatform()));
    const [rights, setRights] = useState<Rights>('full');
    const [custom, setCustom] = useState<PolicyKey[]>([]);
    const [autostart, setAutostart] = useState(true);
    const [admin, setAdmin] = useState(false);
    const [shuffleId, setShuffleId] = useState(false);
    const [variant, setVariant] = useState<Variant>('install');
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const usesId = useId();

    const selected = links.selected;
    const serves = selected ? selected.maxUses > 1 : false;
    const denied = rights === 'full' ? [] : rights === 'monitor' ? POLICY_KEYS : custom;
    const command =
        selected && links.server
            ? (variant === 'install' ? installCommand : linkCommand)({
                  os,
                  server: links.server,
                  code: selected.code,
                  denied,
                  autostart,
                  admin,
                  shuffleId: serves && shuffleId
              })
            : null;
    const free = links.quota ? Math.max(0, links.quota.limit - links.quota.used) : null;
    const plaintext = links.server?.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(links.server);

    const copyCommand = async () => {
        if (!command) return;
        if (!(await copyText(command))) {
            setCopyError(true);
            return;
        }
        setCopyError(false);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    };

    const toggleCustom = (key: PolicyKey, allowed: boolean) =>
        setCustom((prev) => (allowed ? prev.filter((k) => k !== key) : [...prev, key]));

    return (
        <Dialog
            open={links.showLinkModal}
            onClose={links.closeModal}
            width={620}
            title='Appairer des appareils'
            description='Choisissez comment la machine accueille l’agent, puis lancez la commande sur elle.'
            headerAction={
                <button
                    className={styles.iconBtn}
                    onClick={links.showLinkInfo}
                    title='Comment lier un appareil ?'
                    aria-label='Aide'
                >
                    <span className='icon icon-info' />
                </button>
            }
            footer={
                <>
                    <Button variant='secondary' icon='cpu' onClick={onDownload}>
                        Télécharger l’agent
                    </Button>
                    <Button variant='secondary' onClick={links.closeModal}>
                        Fermer
                    </Button>
                </>
            }
        >
            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Système</span>
                <SegmentedControl value={os} options={OS_OPTIONS} onChange={setOs} aria-label='Système' />
            </div>

            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Droits de DevEye sur la machine</span>
                <ChoiceCards value={rights} options={RIGHTS_OPTIONS} onChange={setRights} aria-label='Droits' />
                {rights === 'custom' && (
                    <div className={styles.policyGrid}>
                        {POLICY_KEYS.map((key) => (
                            <Checkbox
                                key={key}
                                checked={!custom.includes(key)}
                                onChange={(allowed) => toggleCustom(key, allowed)}
                            >
                                {POLICY_LABEL[key].charAt(0).toUpperCase() + POLICY_LABEL[key].slice(1)}
                            </Checkbox>
                        ))}
                    </div>
                )}
                <p className={styles.pairHint}>
                    Ces droits se décident sur la machine : DevEye ne pourra jamais les élargir. Pour les changer plus
                    tard, <code>deveye-agent policy</code> sur la machine.
                </p>
            </div>

            <div className={styles.pairOptions}>
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
                        os === 'windows'
                            ? 'Ouvrez PowerShell en tant qu’administrateur : l’agent sert toute la machine.'
                            : 'Avec sudo : l’agent sert toute la machine, dès son démarrage.'
                    }
                />
                {serves && (
                    <Checkbox checked={shuffleId} onChange={setShuffleId}>
                        Machines clonées d’une même image : leur donner chacune une identité
                    </Checkbox>
                )}
            </div>

            <div className={styles.pairSection}>
                <div className={styles.pairHead}>
                    <span className={styles.pairLabel}>Commande à lancer sur l’appareil</span>
                    <SegmentedControl
                        value={variant}
                        options={VARIANT_OPTIONS}
                        onChange={setVariant}
                        aria-label='Agent présent ou non'
                    />
                </div>
                {command ? (
                    <>
                        <pre className={styles.command}>{command}</pre>
                        <div className={styles.commandActions}>
                            {variant === 'link' && (
                                <span className={styles.pairHint}>
                                    Binaire téléchargé à la main : remplacez <code>deveye-agent</code> par son chemin.
                                </span>
                            )}
                            <Button variant='secondary' icon='copy' onClick={() => void copyCommand()}>
                                {copied ? 'Copié' : 'Copier la commande'}
                            </Button>
                        </div>
                        {copyError && (
                            <p className={styles.genError}>Copie impossible : sélectionnez la commande à la main.</p>
                        )}
                        {plaintext && (
                            <p className={styles.genError}>
                                Ce serveur n’est pas en HTTPS : l’agent refusera de s’y relier sans{' '}
                                <code>--insecure-plaintext</code>.
                            </p>
                        )}
                    </>
                ) : (
                    <p className={styles.noCodes}>Générez un code ci-dessous : la commande apparaîtra ici.</p>
                )}
            </div>

            <div className={styles.pairSection}>
                <span className={styles.pairLabel}>Codes de liaison</span>
                {links.codesError ? (
                    // « Aucun code actif » se lit comme une certitude : ne l'affirmer
                    // que quand le serveur a répondu.
                    <p className={styles.genError}>{links.codesError}</p>
                ) : links.codes.length > 0 ? (
                    <table className={styles.codeTable}>
                        <thead>
                            <tr>
                                <th>Code</th>
                                <th>Appareils</th>
                                <th>Validité</th>
                                <th aria-label='Actions' />
                            </tr>
                        </thead>
                        <tbody>
                            {links.codes.map((c) => (
                                <tr
                                    key={c.code}
                                    className={c.code === selected?.code ? styles.codeRowSelected : undefined}
                                >
                                    <td>
                                        {/* Le code choisi est celui de la commande. */}
                                        <button
                                            type='button'
                                            className={styles.codePick}
                                            onClick={() => links.setSelectedCode(c.code)}
                                            aria-pressed={c.code === selected?.code}
                                            title='Utiliser ce code dans la commande'
                                        >
                                            <code className={styles.codeCell}>{c.code}</code>
                                        </button>
                                    </td>
                                    <td className={styles.validityCell}>
                                        {c.uses} / {c.maxUses}
                                    </td>
                                    <td className={styles.validityCell}>{formatExpiry(c.expiresAt)}</td>
                                    <td className={styles.codeRowActions}>
                                        <button
                                            className={`${styles.iconBtn} ${links.copiedCode === c.code ? styles.copied : ''}`}
                                            onClick={() => links.copyCode(c.code)}
                                            title={links.copiedCode === c.code ? 'Copié' : 'Copier le code'}
                                        >
                                            <span
                                                className={`icon ${links.copiedCode === c.code ? 'icon-check-circle' : 'icon-copy'}`}
                                            />
                                        </button>
                                        <button
                                            className={`${styles.iconBtn} ${styles.iconDanger}`}
                                            onClick={() => links.deleteCode(c.code)}
                                            title='Invalider ce code'
                                        >
                                            <span className='icon icon-trash' />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <p className={styles.noCodes}>Aucun code actif.</p>
                )}

                <div className={styles.genRow}>
                    <SegmentedControl
                        value={links.ttlPreset}
                        options={TTL_PRESETS}
                        onChange={links.setTtlPreset}
                        aria-label='Durée de validité'
                    />
                    <div className={styles.usesField}>
                        <label htmlFor={usesId}>Appareils</label>
                        <NumberInput
                            id={usesId}
                            value={links.maxUses}
                            onChange={links.setMaxUses}
                            min={1}
                            max={LINK_CODE_MAX_USES}
                        />
                    </div>
                    <Button onClick={links.generateLinkCode} disabled={links.generatingCode}>
                        {links.generatingCode ? 'Génération…' : 'Nouveau code'}
                    </Button>
                </div>
                {links.genError && <p className={styles.genError}>{links.genError}</p>}
                {links.quota && (
                    <p className={styles.pairHint}>
                        {quotaLine(links.quota)}
                        {free !== null && free < (links.maxUses ?? 1) && links.quota.limit > 0 && (
                            <>
                                {' '}
                                Au-delà de {free} nouvel{free > 1 ? 's' : ''} appareil{free > 1 ? 's' : ''}, les
                                liaisons seront refusées, et le code restera valable.
                            </>
                        )}
                    </p>
                )}
            </div>
        </Dialog>
    );
}
