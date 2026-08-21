/**
 * `deveye-sdk-client` : LA surface d'import du code client d'un module.
 *
 * Le package d'un module n'importe rien d'autre de l'app : ce barrel est le
 * contrat, et ce qui n'y figure pas est interne (donc libre de bouger). Résolu
 * par alias (vite + tsconfig) quand le module est compilé dans l'app ; pour le
 * typecheck autonome du repo d'un module, le template porte une déclaration du
 * même module basée sur `deveye-types/sdk/client`.
 */
import { useEffect, useRef } from 'react';

import { ws } from '@/api/ws';
import { useLiveSegment } from '@/live/useLiveSegment';
import type { LiveSegmentKind } from '@/stores/live';
import type { FeatureManifest } from 'deveye-types/sdk';
import type { z, ZodType } from 'zod';

// ── Le kit d'interface ─────────────────────────────────────────────────────
export {
    Button,
    Checkbox,
    ConfirmDialog,
    CountWidget,
    Dialog,
    SegmentedControl,
    SelectInput,
    StatusBadge,
    Switch,
    TextInput
} from '@/Components';
export type { ConfirmRequest } from '@/Components';
export { useDialogClose, useDialogSubmit, useDismissLayer } from '@/Components/Dialog';
export { FeatureSettingsButton, useSettingsSections } from '@/Components/FeatureSettings';
/** Les classes de rangées canoniques des écrans de réglages (channelRow, etc.). */
export { default as settingsStyles } from '@/Components/FeatureSettings/FeatureSettings.module.css';

// ── Les données ────────────────────────────────────────────────────────────
export { humanizeError, useResource } from '@/api/useResource';
export { invalidate, useResourceVersion, type ExternalResourceKey, type ResourceKey } from '@/stores/invalidation';

// ── Le live ────────────────────────────────────────────────────────────────
export { useLiveSegment } from '@/live/useLiveSegment';
export { useLiveOutline, useLiveOutlines } from '@/live/useLiveOutline';
export { useTypers, useTypingSignal } from '@/live/useTyping';

// ── Les droits et l'espace ─────────────────────────────────────────────────
export { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
export { useFeatureLifecycle } from '@/Features/useFeatureLifecycle';

/**
 * L'envoi typé des commandes de VOTRE module.
 *
 * `ws.send` natif est typé par le registre fermé de deveye-types, que les
 * modules n'étendent pas ; cet enrobage retrouve les types depuis les
 * `commands` du manifest. La validation d'exécution reste celle du serveur,
 * dans les deux sens.
 */
export function featureApi<const M extends FeatureManifest>(manifest: M) {
    type Commands = M['commands'][number];
    void manifest;
    return {
        send<N extends Commands['command']>(
            name: N,
            input: z.input<Extract<Commands, { command: N }>['input'] & ZodType>
        ): Promise<z.output<Extract<Commands, { command: N }>['output'] & ZodType>> {
            return ws.send(name as never, input as never) as never;
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
