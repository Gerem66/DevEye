import type { AgentServiceScope, DevicePlatform } from '@deveye/types';

/**
 * Les commandes qui relancent l'agent depuis la machine quand il ne répond
 * plus, avec les droits et le démarrage choisis : `service install` refait le
 * service de zéro et le démarre, quel que soit celui qui était en place.
 */

export interface ReconnectChoice {
    os: DevicePlatform;
    /** Un service système : root, ou SYSTEM sous Windows. */
    root: boolean;
    /** Repartir au démarrage de la machine (ou à l'ouverture de session). */
    autostart: boolean;
    /** Le service qui portait l'agent à son dernier rapport. */
    scope: AgentServiceScope;
}

/** Ce qui se colle d'un bloc, et s'il faut l'administrateur (PowerShell élevé sous Windows). */
export interface ReconnectCommand {
    command: string;
    admin: boolean;
}

function steps({ os, root, autostart, scope }: ReconnectChoice): ReconnectCommand[] {
    const windows = os === 'windows';
    // Installé pour un compte, l'agent est dans son dossier (~/.local/bin), hors du PATH de sudo.
    const sudo = scope === 'system' ? 'sudo deveye-agent' : 'sudo "$(command -v deveye-agent)"';
    const admin = (args: string) => ({ command: `${windows ? 'deveye-agent' : sudo} ${args}`, admin: true });
    const plain = (args: string) => ({ command: `deveye-agent ${args}`, admin: false });
    const noBoot = autostart ? '' : ' --no-autostart';

    if (root) return [admin(`service install --system${noBoot}`)];
    // Retiré, le service système rend l'enrôlement au compte qui lance la commande.
    const before = scope === 'system' ? [admin('service uninstall')] : [];
    // Sans démarrage automatique ni service à refaire, l'agent se relance à la main.
    if (!autostart && scope !== 'user') return [...before, plain('run --detach')];
    // Windows n'enregistre une tâche d'ouverture de session qu'en administrateur.
    const install = `service install${noBoot}`;
    return [...before, windows ? admin(install) : plain(install)];
}

/**
 * Les blocs à coller sur la machine, dans l'ordre. Un seul sous Linux et macOS,
 * où `sudo` se trouve dans la ligne ; sous Windows, un par niveau de droits,
 * Windows PowerShell n'ayant pas de `&&`.
 */
export function reconnectCommands(choice: ReconnectChoice): ReconnectCommand[] {
    const windows = choice.os === 'windows';
    const blocks: ReconnectCommand[] = [];
    for (const step of steps(choice)) {
        const last = blocks.at(-1);
        if (last && (!windows || last.admin === step.admin)) {
            last.command += windows ? `\n${step.command}` : ` && ${step.command}`;
            last.admin ||= step.admin;
        } else {
            blocks.push({ ...step });
        }
    }
    return blocks;
}
