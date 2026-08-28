/**
 * `deveye-sdk-client` : LA surface d'import du code client d'un module.
 *
 * Le package d'un module n'importe rien d'autre de l'app : ce barrel est le
 * contrat, et ce qui n'y figure pas est interne (donc libre de bouger). Résolu
 * par alias (vite + tsconfig) quand le module est compilé dans l'app ; pour le
 * typecheck autonome du repo d'un module, le template porte une déclaration du
 * même module basée sur `@deveye/types/sdk/client`.
 */
import { useEffect, useRef, type ChangeEvent } from 'react';

import { ws } from '@/api/ws';
import { useLiveSegment } from '@/live/useLiveSegment';
import { startTeleport, type LiveSegmentKind } from '@/stores/live';
import { getActiveWorkspaceId, useActiveWorkspace } from '@/stores/workspace';
import type { MinimalUser } from '@deveye/types';

export type { LiveSegmentKind };
/** The change event of a text input, for handlers typed by hand. */
export type InputChange = ChangeEvent<HTMLInputElement>;
import type { FeatureManifest, ManifestCommand } from '@deveye/types/sdk';
import type { z, ZodType } from 'zod';

// ── Le kit d'interface ─────────────────────────────────────────────────────
// Imports DIRECTS, jamais le baril `@/Components` : le baril tire TopNavbar,
// qui tire la présence, qui tire le catalogue ; le catalogue s'évaluerait
// alors PENDANT le chargement de la glue des modules, avant leur
// enregistrement. C'est arrivé (Météo absente du marché) ; la paresse du
// catalogue protège désormais aussi, mais un graphe court reste la règle.
export { default as Button } from '@/Components/Button';
export { default as Checkbox } from '@/Components/Checkbox';
export { ConfirmDialog } from '@/Components/ConfirmDialog';
export type { ConfirmRequest } from '@/Components/ConfirmDialog';
export { default as SegmentedControl } from '@/Components/SegmentedControl';
export { default as SelectInput } from '@/Components/SelectInput';
export { StatusBadge } from '@/Components/StatusBadge';
export { default as Switch } from '@/Components/Switch';
export { default as TextInput } from '@/Components/TextInput';
export { Dialog, DialogCancelButton, useDialogClose, useDialogSubmit, useDismissLayer } from '@/Components/Dialog';
// La couche impérative au-dessus de Dialog (OpenPopup → promesse résolue par
// ClosePopup), et l'explicatif « i » commun : les features à formulaires
// (Coffre, Notes) s'en servent, les modules qui en viennent aussi.
export { default as Popup, ClosePopup, OpenPopup } from '@/Components/Popup';
export { openInfo } from '@/Components/InfoPopup';
export { FeatureSettingsButton } from '@/Components/FeatureSettings';
export { DeviceFolderPicker } from '@/Components/DeviceFolderPicker';
export { useDevices } from '@/stores/devices';
// Le comptage des abonnements aux métriques vivantes (le hub abonne par
// socket, le client n'en a qu'une : deux consommateurs du même appareil ne
// doivent pas se désabonner l'un l'autre) et les chemins d'un appareil, tels
// que `DeviceFolderPicker` les manipule : le module Appareils en a besoin
// autant que lui.
export { acquireMetrics } from '@/stores/metricsSubscription';
export { isWinPath, joinPath } from '@/devicePath';
/** Les classes de rangées canoniques des écrans de réglages (channelRow, etc.). */
export { default as settingsStyles } from '@/Components/FeatureSettings/FeatureSettings.module.css';
/** La carte de comptage de l'accueil, et le compte qui la nourrit. */
export { CountWidget, useWorkspaceCount, type CountState } from '@/Components/CountWidget';
/** Le glisser-déposer de réordonnancement, le seul geste de l'app pour ça. */
export { useDragReorder } from '@/dragReorder';

// ── Les données ────────────────────────────────────────────────────────────
export { humanizeError, useResource } from '@/api/useResource';
/** L'erreur d'une commande refusée : son code, son message, ses détails de validation. */
export { WsError } from '@/api/ws';
export { isSocketOpen, onServerEvent, onSocketOpen } from './events';
export { formatBytesFr } from '@/format';
export { invalidate, onResourceChange, useResourceVersion, type ExternalResourceKey } from '@/stores/invalidation';

// ── Le live ────────────────────────────────────────────────────────────────
export { useLiveSegment } from '@/live/useLiveSegment';
export { useLiveOutline, useLiveOutlines } from '@/live/useLiveOutline';
export type { LiveOutlineProps } from '@/live/useLiveOutline';
export { useTypers, useTypingSignal } from '@/live/useTyping';

// ── Les droits et l'espace ─────────────────────────────────────────────────
export { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
export { useFeatureLifecycle } from '@/Features/useFeatureLifecycle';
/**
 * Demander un cadre plus large à la popup de feature tant que le composant
 * appelant est monté (`null` = rien demander) : la vue qui déborde du cadre
 * par défaut, comme un explorateur de tables en mode agrandi.
 */
export { useRequestPopupWidth } from '@/stores/popupWidth';
/** La pastille d'identité d'un membre, commune à toute feature qui nomme quelqu'un. */
export { Avatar } from '@/Components/Avatar/Avatar';
/** La variable CSS d'une couleur de compte, celle dont la présence en direct peint chacun. */
export { userColorVar } from '@/Features/Profile/userColors';
/** Deux bandeaux collants l'un sous l'autre : la mesure du haut, décalage du bas. */
export { useStickyOffset, type StickyOffset } from '@/stickyOffset';
/**
 * Le contrat client qu'un AUTRE module offre (`FeatureClient.providers`) :
 * la composition inter-modules, l'inverse de `providers` du manifest.
 * `undefined` quand ce module n'est pas installé : dégrader, jamais supposer.
 */
export { moduleClientProvider } from '@/sdk/registry';
/** L'utilisateur connecté, `null` tant que la session n'a pas répondu. */
export { useCurrentUser } from '@/stores/currentUser';
/** Une image choisie, ramenée à un carré en data URL bornée : l'icône d'un projet. */
export { ACCEPTED_TYPES, MAX_INPUT_BYTES, fileToSquareDataUrl } from '@/imageResize';

const NO_MEMBERS: readonly MinimalUser[] = [];

/**
 * Les membres de l'espace actif, tels que la session les liste : de quoi
 * mettre un visage sur « qui a déclenché quoi ». Vide tant que la session
 * n'a rien fourni, jamais `null` (une liste se filtre sans garde).
 */
export function useWorkspaceMembers(): readonly MinimalUser[] {
    return useActiveWorkspace()?.users ?? NO_MEMBERS;
}

/**
 * Ouvrir une autre feature de l'espace actif, sur l'un de ses éléments quand
 * `itemId` est donné : la téléportation de l'hôte, la même mécanique que
 * « rejoindre quelqu'un ». Le segment de présence d'un élément est son
 * identifiant nu (`l1:<id>`), pour toutes les features ; le chemin n'est donc
 * jamais écrit par un module. La garde d'accès reste celle de l'hôte, et une
 * cible disparue s'ignore d'elle-même après dix secondes.
 */
export function openFeature(feature: string, itemId?: number): void {
    const workspaceId = getActiveWorkspaceId();
    if (workspaceId === null) return;
    startTeleport(workspaceId, itemId === undefined ? [`view:${feature}`] : [`view:${feature}`, `l1:${itemId}`]);
}

// ── Le chiffrement par mot de passe ────────────────────────────────────────
// L'état de verrou de la session, l'invite globale, et le patron « réessaie
// une fois après déverrouillage ». C'est la surface qu'exige toute feature
// dont une commande peut répondre `locked` (contrats en `'private'` côté
// serveur) ; OSINT est la première migrée à s'en servir.
export {
    ensureUnlocked as ensureSecrecyUnlocked,
    touchSecrecy,
    UnlockCancelledError,
    useSecrecy,
    withSecrecy
} from '@/stores/secrecy';
export type { SecrecyState } from '@/stores/secrecy';

/**
 * L'envoi typé des commandes de VOTRE module.
 *
 * `ws.send` natif est typé par le registre fermé de @deveye/types, que les
 * modules n'étendent pas ; cet enrobage retrouve les types depuis les
 * `commands` du manifest. La validation d'exécution reste celle du serveur,
 * dans les deux sens. `timeoutMs` allonge l'attente d'une commande qui
 * interroge un tiers lent (une sonde OSINT, un relevé distant) ; le délai
 * par défaut reste celui du socket.
 */
export function featureApi<const M extends FeatureManifest>(manifest: M) {
    // Le corps de `commandsApi`, répété plutôt que délégué : passer par
    // `manifest.commands` élargirait le type au contrat générique et
    // perdrait le nom de chaque commande.
    type Commands = M['commands'][number];
    void manifest;
    return {
        send<N extends Commands['command']>(
            name: N,
            input: z.input<Extract<Commands, { command: N }>['input'] & ZodType>,
            opts?: { timeoutMs?: number }
        ): Promise<z.output<Extract<Commands, { command: N }>['output'] & ZodType>> {
            return ws.send(name as never, input as never, opts) as never;
        }
    };
}

/**
 * L'envoi typé d'une liste de contrats, quelle qu'elle soit : les commandes
 * d'un manifest (`featureApi`), ou celles du transport des agents
 * (`commandsApi(agentCommands)`, que chaque consommateur construit avec son
 * propre import de `@deveye/types` : le barrel ne peut pas l'exporter tout
 * fait, l'identité du type diffère selon qui résout le package).
 */
export function commandsApi<const C extends readonly ManifestCommand[]>(commands: C) {
    type Commands = C[number];
    void commands;
    return {
        send<N extends Commands['command']>(
            name: N,
            input: z.input<Extract<Commands, { command: N }>['input'] & ZodType>,
            opts?: { timeoutMs?: number }
        ): Promise<z.output<Extract<Commands, { command: N }>['output'] & ZodType>> {
            return ws.send(name as never, input as never, opts) as never;
        }
    };
}

/**
 * Déclare la position `kind` de la vue ET consomme la téléportation qui la
 * vise : le patron canonique des features à éléments, packagé.
 *
 * `ready` doit rester faux tant que la liste n'est pas chargée : la cible
 * n'est jamais consommée à sa lecture, elle reste posée jusqu'à ce qu'un rendu
 * prêt puisse l'appliquer. `onTarget(null)` signifie « referme l'élément »
 * (l'émetteur est remonté d'un niveau).
 */
export function useLiveItemTarget(
    kind: LiveSegmentKind,
    value: string | null,
    ready: boolean,
    onTarget: (value: string | null) => void
): void {
    const target = useLiveSegment(kind, value);
    const apply = useRef(onTarget);
    apply.current = onTarget;
    useEffect(() => {
        if (!target || !ready) return;
        apply.current(target.value);
    }, [target, ready]);
}
