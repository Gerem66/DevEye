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
import type { LiveSegmentKind } from '@/stores/live';

export type { LiveSegmentKind };
/** The change event of a text input, for handlers typed by hand. */
export type InputChange = ChangeEvent<HTMLInputElement>;
import type { FeatureManifest } from '@deveye/types/sdk';
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
export { Dialog, useDialogClose, useDialogSubmit, useDismissLayer } from '@/Components/Dialog';
export { FeatureSettingsButton } from '@/Components/FeatureSettings';
export { DeviceFolderPicker } from '@/Components/DeviceFolderPicker';
export { useDevices } from '@/stores/devices';
/** Les classes de rangées canoniques des écrans de réglages (channelRow, etc.). */
export { default as settingsStyles } from '@/Components/FeatureSettings/FeatureSettings.module.css';

// ── Les données ────────────────────────────────────────────────────────────
export { humanizeError, useResource } from '@/api/useResource';
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

// ── Le chiffrement par mot de passe ────────────────────────────────────────
// L'état de verrou de la session, l'invite globale, et le patron « réessaie
// une fois après déverrouillage ». C'est la surface qu'exige toute feature
// dont une commande peut répondre `locked` (contrats en `'private'` côté
// serveur) ; OSINT est la première migrée à s'en servir.
export { ensureUnlocked as ensureSecrecyUnlocked, useSecrecy, withSecrecy } from '@/stores/secrecy';
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
