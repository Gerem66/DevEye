import type { AgentInfo, DevicePlatform } from 'deveye-types';

/**
 * Explainer shown from the "Privilèges agent" chip (via openInfo). Tells the user
 * how the agent runs, which signals its privilege level limits, what running with
 * privileges would add, and how to relaunch elevated — honestly per platform.
 */
export function PrivilegeInfo({ agent, platform }: { agent: AgentInfo | null; platform: DevicePlatform }) {
    if (!agent) {
        return (
            <p>
                Le niveau de privilèges de l&apos;agent n&apos;est pas encore connu (rapport antérieur à cette
                fonctionnalité). Il sera renseigné au prochain bilan de sécurité (toutes les heures, ou via le bouton
                rafraîchir).
            </p>
        );
    }

    const elevatedWord = platform === 'windows' ? 'administrateur (élevé)' : 'root';
    const relaunch = relaunchCommand(platform);

    return (
        <div>
            <h4>Comment tourne l&apos;agent</h4>
            <p>
                L&apos;agent s&apos;exécute sous le compte <b>{agent.user || 'inconnu'}</b>,{' '}
                {agent.privileged ? <b>avec privilèges ({elevatedWord})</b> : <b>sans privilèges</b>}. Les sondes de
                sécurité « shell-out » vers des outils système : selon les droits, certaines réussissent, d&apos;autres
                renvoient « Inconnu ».
            </p>

            {!agent.privileged && (
                <>
                    <h4>Ce que {elevatedWord} apporterait</h4>
                    {platform === 'linux' && (
                        <ul>
                            <li>
                                <b>Pare-feu</b> : sans privilèges, l&apos;état est déduit du service systemd (
                                <code>ufw</code>/<code>firewalld</code>/<code>nftables</code>). En root, lecture directe
                                des règles (<code>ufw status</code>, <code>nft list ruleset</code>) même si le pare-feu
                                n&apos;est pas géré par systemd — donc plus de cas « Inconnu ».
                            </li>
                            <li>
                                <b>Ports ouverts</b> : la liste des ports est complète sans privilèges ; root
                                permettrait d&apos;y associer le <i>processus propriétaire</i> de chaque port.
                            </li>
                            <li>Chiffrement disque, MAJ en attente, processus : déjà disponibles sans privilèges.</li>
                        </ul>
                    )}
                    {platform === 'macos' && (
                        <ul>
                            <li>
                                Sur macOS, l&apos;essentiel (pare-feu, FileVault, SIP, ports) fonctionne{' '}
                                <b>sans root</b>.
                            </li>
                            <li>
                                La <b>température CPU</b> sur Apple Silicon reste indisponible : c&apos;est bloqué par
                                SIP / entitlements, pas par un simple manque de root.
                            </li>
                        </ul>
                    )}
                    {platform === 'windows' && (
                        <ul>
                            <li>
                                <b>Chiffrement disque (BitLocker)</b> : <code>manage-bde -status</code> exige un
                                terminal
                                <b> élevé</b> — sans cela l&apos;état reste « Inconnu ».
                            </li>
                            <li>Pare-feu et ports sont lisibles sans élévation.</li>
                        </ul>
                    )}

                    <h4>Relancer avec privilèges</h4>
                    <p>
                        Pour des raisons de sécurité, l&apos;agent <b>ne peut pas s&apos;élever lui-même</b> à distance
                        depuis DevEye (ce serait une porte d&apos;escalade de privilèges). L&apos;élévation se fait sur
                        la machine : arrêtez l&apos;agent puis relancez-le ainsi —
                    </p>
                    <pre>
                        <code>{relaunch}</code>
                    </pre>
                    <p>
                        Idéalement, installez-le en service système lancé en {elevatedWord} (par ex. une unité systemd
                        sur Linux) pour qu&apos;il démarre élevé au boot.
                    </p>
                </>
            )}

            {agent.privileged && (
                <p>
                    L&apos;agent tourne déjà avec privilèges : toutes les sondes disposent des droits nécessaires. Un «
                    Inconnu » résiduel vient alors d&apos;un outil absent (ex. <code>ufw</code> non installé), pas
                    d&apos;un manque de droits.
                </p>
            )}
        </div>
    );
}

/** Platform-specific command to relaunch the agent elevated. */
function relaunchCommand(platform: DevicePlatform): string {
    switch (platform) {
        case 'windows':
            return 'deveye-agent stop\n# Ouvrez un terminal « En tant qu’administrateur », puis :\ndeveye-agent run --detach';
        default:
            return 'deveye-agent stop\nsudo deveye-agent run --detach';
    }
}
