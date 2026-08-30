import { useEffect, useMemo, useRef, useState } from 'react';
import { SHARE_WIRED_FEATURES, featureDescriptor, type FeatureId } from '@deveye/types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { consumeItemSettings } from '@/stores/settingsRequest';
import { getActiveWorkspaceId, useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';

import NotificationsSection from './sections/NotificationsSection';
import ItemPermissionsSection from './sections/ItemPermissionsSection';
import SharingSection from './sections/SharingSection';
import SideNav, { type SideNavItem } from './SideNav';
import { isModuleShareWired, moduleClient, moduleManifest } from '@/sdk/registry';
import { numericItemId, scopeDescription, scopeTitle, type SettingsScope, type SettingsSectionId } from './scope';
import styles from './FeatureSettings.module.css';

/**
 * La coquille de réglages, une seule pour toutes les fonctionnalités et leurs
 * éléments. Une section n'apparaît que si elle mène à quelque chose
 * d'utilisable, et sans section le bouton lui-même n'existe pas
 * (`FeatureSettingsButton` rend `null`).
 */

interface SectionDef {
    id: SettingsSectionId;
    label: string;
    icon: string;
}

/**
 * Le partage est-il branché ? La même question que le serveur (`isShareWired`) :
 * l'onglet suit ce que le code fait, jamais ce que `shareTier` promet.
 */
function isShareWired(feature: FeatureId): boolean {
    return (SHARE_WIRED_FEATURES as readonly FeatureId[]).includes(feature) || isModuleShareWired(feature);
}

/**
 * Les sections visibles pour cette cible, dans l'ordre. Exporté pour que les
 * appelants décident s'il y a un bouton à rendre.
 */
export function useSettingsSections(scope: SettingsScope): SectionDef[] {
    const permissions = useWorkspacePermissions();
    const active = useActiveWorkspace();
    const canRead = permissions.canFeature(scope.feature, 'read');
    const canRestrict = permissions.can('workspace.roles');
    const isShared = active?.kind === 'shared';

    return useMemo(() => {
        if (!canRead) return [];
        const descriptor = featureDescriptor(scope.feature);
        const sections: SectionDef[] = [];

        // Partage et Permissions : à l'échelle d'un élément seulement. Le
        // branchement (`isShareWired`) et non `shareTier` : le premier dit ce
        // que le code fait, le second ce que le chiffrement autoriserait, et le
        // serveur refuse ce qui n'est pas branché. Permissions derrière
        // `workspace.roles` : restreindre un élément, c'est régler ce qu'un rôle
        // voit, et un espace personnel n'a pas de rôles. « Qui a accès à la
        // fonctionnalité » se règle sur le rôle, dans Gérer l'espace.
        const pushSharingSections = (into: SectionDef[]): void => {
            if (scope.kind !== 'item' || !isShareWired(scope.feature)) return;
            if (permissions.canFeature(scope.feature, 'write') && scope.shareable !== false) {
                into.push({ id: 'sharing', label: 'Partage', icon: 'users' });
            }
            if (canRestrict && isShared) {
                // `shield` et non `lock` : le cadenas est l'icône du
                // chiffrement, et deux entrées de nav au même glyphe se
                // confondent.
                into.push({ id: 'permissions', label: 'Permissions', icon: 'shield' });
            }
        };

        // Un module déclare ses onglets dans son manifest ; la coquille ajoute
        // les siens : Notifications suit `notifies`, Partage et Permissions
        // suivent le branchement au partage.
        const manifest = moduleManifest(scope.feature);
        if (manifest) {
            for (const tab of manifest.settings?.[scope.kind] ?? []) {
                // Général : les réglages ni sources ni notifications ; en tête
                // chez qui le déclare en premier.
                if (tab === 'general') sections.push({ id: 'general', label: 'Général', icon: 'settings' });
                else if (tab === 'sources' && scope.kind === 'feature') {
                    sections.push({ id: 'sources', label: 'Sources', icon: 'key' });
                } else if (tab === 'sync' && scope.kind === 'item') {
                    // Synchronisation : rythme de relève et maintenance d'un élément.
                    sections.push({ id: 'sync', label: 'Synchronisation', icon: 'refresh' });
                } else if (tab === 'encryption' && scope.kind === 'item') {
                    // Chiffrement : sous quelle clé la donnée de l'élément vit.
                    sections.push({ id: 'encryption', label: 'Chiffrement', icon: 'lock' });
                } else if (typeof tab === 'object') {
                    sections.push({ id: tab.id, label: tab.label, icon: tab.icon ?? 'settings' });
                }
            }
            if (descriptor.notifies && (scope.kind === 'feature' || descriptor.hasItems)) {
                sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
            }
            pushSharingSections(sections);
            return sections;
        }

        // Une native n'a que ce que la coquille rend elle-même. Notifications :
        // réservé aux émetteurs, et à l'échelle d'un élément seulement quand la
        // fonctionnalité en a de réglables.
        if (descriptor.notifies && (scope.kind === 'feature' || descriptor.hasItems)) {
            sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
        }

        pushSharingSections(sections);
        return sections;
    }, [scope.feature, scope.kind, canRead, canRestrict, isShared, permissions]);
}

/** Les sections que la coquille rend elle-même, native ou module. */
const GENERIC_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['notifications', 'sharing', 'permissions']);

export interface FeatureSettingsDialogProps {
    open: boolean;
    onClose: () => void;
    scope: SettingsScope;
    /** La section à montrer à l'ouverture : le « + » d'un sélecteur de source
     *  ouvre directement l'onglet Sources. */
    initialSection?: SettingsSectionId;
}

export function FeatureSettingsDialog({ open, onClose, scope, initialSection }: FeatureSettingsDialogProps) {
    const sections = useSettingsSections(scope);
    /** `undefined` = personne n'a choisi, et c'est la première section qui
     *  s'ouvre. Nommer ici une section en dur la ferait gagner partout où elle
     *  existe, quelle que soit sa place dans la nav. */
    const [active, setActive] = useState<SettingsSectionId | undefined>(initialSection);
    /** « Gérer les canaux » d'un élément ouvre les réglages de sa fonctionnalité
     *  par-dessus ; la coquille d'une fonctionnalité ne propose pas ce saut. */
    const [manageChannels, setManageChannels] = useState(false);
    const current = active && sections.some((s) => s.id === active) ? active : sections[0]?.id;

    // À chaque ouverture, revenir à la section demandée : un dialogue réutilisé
    // (celui du « + ») doit retomber sur Sources, pas sur le dernier onglet vu.
    useEffect(() => {
        if (open && initialSection) setActive(initialSection);
    }, [open, initialSection]);

    const items: SideNavItem<SettingsSectionId>[] = sections.map((s) => ({
        id: s.id,
        label: s.label,
        icon: s.icon
    }));

    return (
        <>
            <Dialog
                open={open && sections.length > 0}
                onClose={onClose}
                title={scopeTitle(scope)}
                description={scopeDescription(scope)}
                width={880}
                fill
            >
                <div className={styles.layout}>
                    {/* Toujours visible, même à une seule section : tous les
                        dialogues de réglages ont la même silhouette. */}
                    <SideNav
                        items={items}
                        active={current}
                        onSelect={setActive}
                        label={`Réglages · ${scopeTitle(scope)}`}
                    />
                    <div className={styles.panel}>
                        {/* Sections génériques de la coquille (canaux, partage,
                            restrictions) ; le reste vient des panneaux du module
                            (`settingsPanels`). */}
                        {current === 'notifications' && (
                            <NotificationsSection
                                scope={scope}
                                onManageChannels={scope.kind === 'item' ? () => setManageChannels(true) : undefined}
                            />
                        )}
                        {current === 'permissions' && scope.kind === 'item' && <ItemPermissionsSection scope={scope} />}
                        {current === 'sharing' && <SharingSection scope={scope} />}
                        {current && !GENERIC_SECTIONS.has(current) && (
                            <ModulePanel scope={scope} section={current} onClose={onClose} />
                        )}
                    </div>
                </div>
            </Dialog>
            {/* Les réglages de la fonctionnalité empilés par-dessus ceux de
                l'élément ; la pile de couches route Échap vers le plus haut. */}
            {scope.kind === 'item' && (
                <FeatureSettingsDialog
                    open={manageChannels}
                    onClose={() => setManageChannels(false)}
                    scope={{ kind: 'feature', feature: scope.feature }}
                    initialSection='notifications'
                />
            )}
        </>
    );
}

export interface FeatureSettingsButtonProps {
    scope: SettingsScope;
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    /** Intitulé ; « Réglages » par défaut. */
    label?: string;
    /** La section ouverte par un clic manuel ; la première à défaut. Le « + »
     *  d'un sélecteur ouvre l'onglet qui crée ce qu'il sélectionne. */
    initialSection?: SettingsSectionId;
    /**
     * Ouverture et fermeture (le démontage vaut fermeture), pour le composant
     * qui détient la présence (`useLiveSegment`) : la coquille ne déclare jamais
     * le niveau elle-même, le registre n'admet qu'un déclarant par niveau.
     */
    onOpenChange?: (open: boolean) => void;
}

/** Le bouton qui ouvre les réglages, ou rien : « pas de section, pas de
 *  bouton », tenu en un seul endroit. */
export function FeatureSettingsButton({
    scope,
    variant = 'secondary',
    label = 'Réglages',
    initialSection,
    onOpenChange
}: FeatureSettingsButtonProps) {
    const sections = useSettingsSections(scope);
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState<SettingsSectionId | undefined>(undefined);

    // Une seule voie de sortie pour les trois entrées (clic, intention de
    // téléportation, démontage) : l'appelant voit chaque transition, et
    // l'ouverture consommée d'une intention n'est pas oubliée.
    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => {
        onOpenChangeRef.current = onOpenChange;
    }, [onOpenChange]);
    useEffect(() => {
        onOpenChangeRef.current?.(open);
        return () => onOpenChangeRef.current?.(false);
    }, [open]);

    /**
     * L'intention « ouvrir les réglages de cet élément » posée avant une bascule
     * d'espace, consommée ici pour toutes les features : monter le bouton
     * suffit. Périmée ou visant un autre élément, elle rend `null`.
     */
    const itemId = numericItemId(scope);
    useEffect(() => {
        if (itemId === null) return;
        const wanted = consumeItemSettings(getActiveWorkspaceId(), scope.feature, itemId);
        if (wanted) {
            setSection(wanted as SettingsSectionId);
            setOpen(true);
        }
    }, [scope.feature, itemId]);

    if (sections.length === 0) return null;

    return (
        <>
            <Button
                variant={variant}
                icon='settings'
                onClick={() => {
                    // Une ouverture manuelle repart de la section du bouton :
                    // l'onglet d'une intention passée n'a plus rien de demandé.
                    setSection(initialSection);
                    setOpen(true);
                }}
            >
                {label}
            </Button>
            <FeatureSettingsDialog open={open} onClose={() => setOpen(false)} scope={scope} initialSection={section} />
        </>
    );
}

export type { SettingsScope, SettingsSectionId } from './scope';

/**
 * Le panneau d'un module pour la section courante (`settingsPanels`). Rien à
 * rendre s'il manque : manifest et entrée client peuvent brièvement diverger
 * en développement.
 */
function ModulePanel({
    scope,
    section,
    onClose
}: {
    scope: SettingsScope;
    section: SettingsSectionId;
    onClose: () => void;
}) {
    const permissions = useWorkspacePermissions();
    const client = moduleClient(scope.feature);
    const Panel = client?.settingsPanels?.[section];
    if (!Panel) return null;
    // La phrase de tête des Sources vient du registre (`sources.hint`).
    const hint = section === 'sources' ? featureDescriptor(scope.feature).sources?.hint : undefined;
    return (
        <>
            {hint && <p className={styles.sectionHint}>{hint}</p>}
            <Panel
                // L'id est un nombre ou un texte (un appareil est un UUID) ; le
                // panneau se déclare pour l'un des deux
                // (`SettingsPanelProps<number | string>`).
                scope={
                    scope.kind === 'feature'
                        ? { kind: 'feature' }
                        : { kind: 'item', itemId: scope.itemId as never, itemLabel: scope.itemLabel }
                }
                canWrite={permissions.canFeature(scope.feature, 'write')}
                // Pour le panneau qui supprime l'élément qu'il règle : la portée
                // sur laquelle le dialogue s'est ouvert n'existe plus, et la
                // coquille retomberait sinon sur les onglets de la
                // fonctionnalité, sous le nom de l'élément disparu.
                close={onClose}
            />
        </>
    );
}
