/**
 * `deveye-sdk-client` : la seule surface d'import du code client d'un module. Ce
 * qui n'y figure pas est interne, donc libre de bouger. Résolu par alias (vite +
 * tsconfig) dans l'app ; pour le typecheck autonome du repo d'un module, le
 * template en porte une déclaration basée sur `@deveye/types/sdk/client`.
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
// Imports directs, jamais le baril `@/Components` : il tire TopNavbar, puis la
// présence, puis le catalogue, qui s'évaluerait alors pendant le chargement de
// la glue des modules, avant leur enregistrement.
export { default as Button } from '@/Components/Button';
export { default as Checkbox } from '@/Components/Checkbox';
export { default as ChoiceCards } from '@/Components/ChoiceCards';
export { default as CountBadge } from '@/Components/CountBadge';
export type { CountBadgeProps } from '@/Components/CountBadge';
export { ConfirmDialog } from '@/Components/ConfirmDialog';
export type { ConfirmRequest } from '@/Components/ConfirmDialog';
export { default as SegmentedControl } from '@/Components/SegmentedControl';
export { default as NumberInput } from '@/Components/NumberInput';
export { default as SearchSelect } from '@/Components/SearchSelect';
export type { SearchSelectOption } from '@/Components/SearchSelect';
export { default as SelectInput } from '@/Components/SelectInput';
export { default as Slider } from '@/Components/Slider';
export { StatusBadge } from '@/Components/StatusBadge';
export { default as Switch } from '@/Components/Switch';
export { default as TextInput } from '@/Components/TextInput';
export { Dialog, DialogCancelButton, useDialogClose, useDialogSubmit, useDismissLayer } from '@/Components/Dialog';
// La couche impérative au-dessus de Dialog (OpenPopup, promesse résolue par
// ClosePopup), et l'explicatif « i » commun.
export { default as Popup, ClosePopup, OpenPopup } from '@/Components/Popup';
export { openInfo } from '@/Components/InfoPopup';
// Un terme technique dans une phrase, qui ouvre sa définition du glossaire.
export { default as Term } from '@/Components/Term';
export type { GlossaryTermId } from '@/Components/Term';
export { FeatureSettingsButton } from '@/Components/FeatureSettings';
export { flashSettings } from '@/Components/FeatureSettings/flash';
// La liste des fournisseurs d'une feature et la clé qu'ils demandent : l'état et
// le geste sur la même rangée, la saisie dans un dialogue.
export { ProviderKeys } from '@/Components/FeatureSettings/sections/ProviderKeys';
export type { ProviderKeyRow } from '@/Components/FeatureSettings/sections/ProviderKeys';
export { DeviceFolderPicker } from '@/Components/DeviceFolderPicker';
/**
 * Les appareils de l'espace actif, tels que le module Appareils les offre à l'app
 * (`DEVICES_CLIENT_PROVIDER`). Vide, chargée et sans erreur quand le module n'est
 * pas installé.
 */
export { useDevices } from '@/devicesProvider';
// Le comptage des abonnements aux métriques vivantes (le hub abonne par socket,
// le client n'en a qu'une : deux consommateurs du même appareil ne doivent pas se
// désabonner l'un l'autre) et les chemins d'un appareil.
export { acquireMetrics } from '@/stores/metricsSubscription';
export { isWinPath, joinPath } from '@/devicePath';
export { safeHref } from '@/safeHref';
// `crypto.randomUUID` n'existe qu'en contexte sécurisé : un module qui s'en
// sert directement casse sur une instance servie en clair.
export { randomUuid } from '@/randomUuid';
// Même raison pour `navigator.clipboard`, absent hors contexte sécurisé : le
// helper porte le repli, et dit si la copie a pris.
export { copyText } from '@/copyText';
/**
 * La version de DevEye dont cette interface est bâtie (package.json racine,
 * injectée au build) : ce à quoi un module compare la version qu'un agent
 * rapporte, pour offrir une mise à jour.
 */
export const APP_VERSION: string = __APP_VERSION__;
/**
 * Les deux gestes HTTP qu'un module peut avoir à faire, la socket ne portant pas
 * de binaire : un GET validé sur une route de l'app (le cookie de session voyage,
 * un jeton périmé est renouvelé et l'appel rejoué une fois), et le renouvellement
 * explicite du cookie d'accès avant un `fetch` brut qui échappe au client.
 */
export { get as httpGet, httpFetch } from '@/api/http';
/** Le refus d'un droit dans un panneau : une seule silhouette pour toutes les
 *  fonctionnalités, cadenas compris. */
export { default as ReadOnlyNotice } from '@/Components/FeatureSettings/ReadOnlyNotice';
/** Le bandeau d'un refus : la phrase, les gestes de réparation passés en
 *  enfants, et le signalement quand l'erreur n'est pas de celles qui se
 *  réparent seules. */
export { default as ErrorNote, type ErrorNoteInput, type ErrorNoteProps } from '@/Components/ErrorNote';
/** Ouvrir le formulaire de signalement, amorcé par ce qui a échoué. */
export { requestOpenReport as openReport } from '@/stores/reportRequest';
/** Les classes de rangées canoniques des écrans de réglages (channelRow, etc.). */
export { default as SaveButton } from '@/Components/FeatureSettings/SaveButton';
export { default as settingsStyles } from '@/Components/FeatureSettings/FeatureSettings.module.css';
/** La carte de comptage de l'accueil, et le compte qui la nourrit. */
export { CountWidget, useWorkspaceCount, type CountState } from '@/Components/CountWidget';
/** Le glisser-déposer de réordonnancement, le seul geste de l'app pour ça. */
export { useDragReorder } from '@/dragReorder';

// ── Les données ────────────────────────────────────────────────────────────
export { humanizeError, useResource } from '@/api/useResource';
/** L'offre du compte, et l'ouverture d'une vue de compte (`manifest.accountEntry`). */
export { useAccountPlan } from '@/stores/accountPlan';
export { openAccountView } from '@/stores/accountView';
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
export { useDomains } from './useDomains';
export { useFeatureLifecycle } from '@/Features/useFeatureLifecycle';
/**
 * Demander un cadre plus large à la popup de feature tant que le composant
 * appelant est monté (`null` = rien demander).
 */
export { useRequestPopupWidth } from '@/stores/popupWidth';
/** La pastille d'identité d'un membre, commune à toute feature qui nomme quelqu'un. */
export { Avatar } from '@/Components/Avatar/Avatar';
/** La variable CSS d'une couleur de compte, celle dont la présence en direct peint chacun. */
export { userColorVar } from '@/Features/Profile/userColors';
/** Deux bandeaux collants l'un sous l'autre : la mesure du haut, décalage du bas. */
export { useStickyOffset, type StickyOffset } from '@/stickyOffset';
/**
 * Le contrat client qu'un autre module offre (`FeatureClient.providers`), soit
 * l'inverse de `providers` du manifest. `undefined` quand ce module n'est pas
 * installé : dégrader, jamais supposer.
 */
export { moduleClientProvider } from '@/sdk/registry';
/** L'utilisateur connecté, `null` tant que la session n'a pas répondu. */
export { useCurrentUser } from '@/stores/currentUser';
/** Les features en préversion que ce compte ne voit pas : ni tuile, ni lien, ni ligne. */
export { useHiddenFeatures } from '@/stores/maintenance';
/** Une image choisie, ramenée à un carré en data URL bornée : l'icône d'un projet. */
export { ACCEPTED_TYPES, MAX_INPUT_BYTES, fileToSquareDataUrl } from '@/imageResize';

const NO_MEMBERS: readonly MinimalUser[] = [];

/**
 * Les membres de l'espace actif, tels que la session les liste. Vide tant qu'elle
 * n'a rien fourni, jamais `null`.
 */
export function useWorkspaceMembers(): readonly MinimalUser[] {
    return useActiveWorkspace()?.users ?? NO_MEMBERS;
}

/**
 * Ouvrir une autre feature de l'espace actif, sur l'un de ses éléments quand
 * `itemId` est donné, par la téléportation de l'hôte. La garde d'accès reste
 * celle de l'hôte, et une cible disparue s'ignore après dix secondes.
 */
export function openFeature(feature: string, itemId?: number | string): void {
    const workspaceId = getActiveWorkspaceId();
    if (workspaceId === null) return;
    startTeleport(workspaceId, itemId === undefined ? [`view:${feature}`] : [`view:${feature}`, `l1:${itemId}`]);
}

// ── Le chiffrement par mot de passe ────────────────────────────────────────
// L'état de verrou de la session, l'invite globale, et le patron « réessaie une
// fois après déverrouillage » : ce qu'exige toute feature dont une commande peut
// répondre `locked` (contrats en `'private'` côté serveur).
export {
    ensureUnlocked as ensureSecrecyUnlocked,
    touchSecrecy,
    UnlockCancelledError,
    useSecrecy,
    withSecrecy
} from '@/stores/secrecy';
export type { SecrecyState } from '@/stores/secrecy';

/**
 * L'envoi typé des commandes de votre module. `ws.send` natif est typé par le
 * registre fermé de @deveye/types, que les modules n'étendent pas ; cet enrobage
 * retrouve les types depuis les `commands` du manifest, la validation d'exécution
 * restant celle du serveur. `timeoutMs` allonge l'attente d'une commande qui
 * interroge un tiers lent ; par défaut c'est le délai du socket.
 */
export function featureApi<const M extends FeatureManifest>(manifest: M) {
    // Le corps de `commandsApi`, répété plutôt que délégué : passer par
    // `manifest.commands` élargirait le type au contrat générique et perdrait le
    // nom de chaque commande.
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
 * L'envoi typé d'une liste de contrats quelconque : les commandes d'un manifest
 * (`featureApi`) ou celles du transport des agents. Chaque consommateur la
 * construit avec son propre import de `@deveye/types` ; le barrel ne peut pas
 * l'exporter tout fait, l'identité du type dépendant de qui résout le package.
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
 * Déclare la position `kind` de la vue et consomme la téléportation qui la vise.
 *
 * `ready` doit rester faux tant que la liste n'est pas chargée : la cible n'est
 * jamais consommée à sa lecture, elle reste posée jusqu'à ce qu'un rendu prêt
 * puisse l'appliquer. `onTarget(null)` signifie « referme l'élément ».
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
