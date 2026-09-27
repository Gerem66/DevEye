import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROJECT_LINKED_FEATURES, SHARE_WIRED_FEATURES, featureDescriptor, type FeatureId } from '@deveye/types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { useLiveOutline } from '@/live/useLiveOutline';
import { pushLiveSettings } from '@/stores/live';
import { useOverlayView } from '@/telemetry/useView';
import { viewSegment } from '@/telemetry/views';
import { useCurrentUser } from '@/stores/currentUser';
import { consumeItemSettings } from '@/stores/settingsRequest';
import { getActiveWorkspaceId, useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';

import DomainsSection from './sections/DomainsSection';
import NotificationsSection from './sections/NotificationsSection';
import ItemPermissionsSection from './sections/ItemPermissionsSection';
import ProjectsSection from './sections/ProjectsSection';
import SharingSection from './sections/SharingSection';
import { flashKey, onFlash } from './flash';
import { SettingsFooterContext } from './footer';
import SideNav, { type SideNavItem } from './SideNav';
import { isModuleShareWired, moduleClient, moduleManifest } from '@/sdk/registry';
import {
    isSystemScope,
    liveSettingsValue,
    scopeDescription,
    scopeTitle,
    targetInfo,
    type SettingsScope,
    type SettingsSectionId,
    type ShellScope
} from './scope';
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
export function useSettingsSections(shellScope: ShellScope): SectionDef[] {
    const isAdmin = useCurrentUser()?.role === 'admin';
    const featureSections = useFeatureSections(isSystemScope(shellScope) ? null : shellScope);
    const permissions = useWorkspacePermissions();
    if (!isSystemScope(shellScope)) return featureSections;
    // La cible système n'est au registre d'aucun rôle : un admin la règle dans
    // un espace qu'il possède, comme le serveur l'exige.
    return isAdmin && permissions.isOwner ? SYSTEM_SECTIONS : [];
}

const SYSTEM_SECTIONS: SectionDef[] = [{ id: 'notifications', label: 'Notifications', icon: 'mail' }];

/** Les sections d'une fonctionnalité ou d'un élément ; aucune sans portée. */
function useFeatureSections(scope: SettingsScope | null): SectionDef[] {
    const permissions = useWorkspacePermissions();
    const active = useActiveWorkspace();
    const feature = scope?.feature;
    const canRead = feature !== undefined && permissions.canFeature(feature, 'read');
    // Sur l'élément quand il y en a un : ses droits peuvent différer de ceux de
    // la fonctionnalité, dans les deux sens. C'est aussi ce que `ModulePanel`
    // passe ensuite en `canWrite`, donc un onglet gardé n'est jamais monté sans.
    const canWrite =
        feature !== undefined &&
        permissions.canFeature(feature, 'write', scope?.kind === 'item' ? scope.itemId : undefined);
    const canRestrict = feature !== undefined && permissions.canManageItemGrants(feature);
    const isShared = active?.kind === 'shared';

    return useMemo(() => {
        if (!scope || !canRead) return [];
        const descriptor = featureDescriptor(scope.feature);
        const sections: SectionDef[] = [];

        // Partage et Permissions : à l'échelle d'un élément seulement. Le
        // branchement (`isShareWired`) et non `shareTier` : le premier dit ce
        // que le code fait, le second ce que le chiffrement autoriserait, et le
        // serveur refuse ce qui n'est pas branché. Permissions derrière le droit
        // de régler les permissions par élément de CETTE fonctionnalité (ou la
        // capacité `workspace.roles`, qui l'englobe), et un espace personnel n'a
        // pas de rôles. « Qui a accès à la fonctionnalité » se règle sur le rôle,
        // dans Gérer l'espace.
        /*
         * Projets : ceux, de cet espace et des autres, qui utilisent l'élément.
         * Trois conditions locales : la fonctionnalité est reliable, le module
         * Projets est installé, et l'appelant y a accès ICI. Le droit
         * d'attacher se juge espace par espace, côté serveur : l'onglet s'ouvre
         * en lecture et les cases y sont inertes là où il manque.
         */
        const pushProjectsSection = (into: SectionDef[]): void => {
            if (scope.kind !== 'item') return;
            if (!(PROJECT_LINKED_FEATURES as readonly FeatureId[]).includes(scope.feature)) return;
            if (!moduleManifest('projects') || !permissions.canFeature('projects')) return;
            into.push({ id: 'projects', label: 'Projets', icon: 'projects' });
        };

        const pushSharingSections = (into: SectionDef[]): void => {
            if (scope.kind !== 'item' || !isShareWired(scope.feature)) return;
            // Sur l'élément : un élément dont l'écriture est ouverte par
            // surcharge se projette, comme le serveur l'accepte.
            if (canWrite && scope.shareable !== false) {
                into.push({ id: 'sharing', label: 'Partage', icon: 'users' });
            } else if (canWrite) {
                // Un élément gardé par mot de passe ne se projette ni ne se
                // déplace, mais il se copie : la même section, réduite à ce geste.
                into.push({ id: 'sharing', label: 'Copie', icon: 'copy' });
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
                } else if (tab === 'domains' && scope.kind === 'feature' && manifest.domains) {
                    sections.push({ id: 'domains', label: 'Domaines', icon: 'globe' });
                } else if (tab === 'sync' && scope.kind === 'item') {
                    // Synchronisation : rythme de relève et maintenance d'un élément.
                    sections.push({ id: 'sync', label: 'Synchronisation', icon: 'refresh' });
                } else if (tab === 'encryption' && scope.kind === 'item') {
                    // Chiffrement : sous quelle clé la donnée de l'élément vit.
                    sections.push({ id: 'encryption', label: 'Chiffrement', icon: 'lock' });
                } else if (typeof tab === 'object') {
                    // Un onglet qui ne porte que des gestes disparaît sans
                    // l'écriture, au lieu de s'excuser dans le vide. Celui qui
                    // montre des valeurs reste, en lecture seule : elles valent
                    // d'être lues.
                    if (tab.requiresWrite && !canWrite) continue;
                    sections.push({ id: tab.id, label: tab.label, icon: tab.icon ?? 'settings' });
                }
            }
            if (
                descriptor.notifies &&
                (scope.kind === 'feature' || (descriptor.hasItems && descriptor.notifications?.perItem !== false))
            ) {
                sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
            }
            pushProjectsSection(sections);
            pushSharingSections(sections);
            return sections;
        }

        // Une native n'a que ce que la coquille rend elle-même. Notifications :
        // réservé aux émetteurs, et à l'échelle d'un élément seulement quand la
        // fonctionnalité en a de réglables.
        if (
            descriptor.notifies &&
            (scope.kind === 'feature' || (descriptor.hasItems && descriptor.notifications?.perItem !== false))
        ) {
            sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
        }

        pushProjectsSection(sections);
        pushSharingSections(sections);
        return sections;
    }, [scope?.feature, scope?.kind, canRead, canWrite, canRestrict, isShared, permissions]);
}

/** Les sections que la coquille rend elle-même, native ou module. */
const GENERIC_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
    'notifications',
    'projects',
    'sharing',
    'permissions',
    'domains'
]);

export interface FeatureSettingsDialogProps {
    open: boolean;
    onClose: () => void;
    scope: ShellScope;
    /** La section à montrer à l'ouverture : le « + » d'un sélecteur de source
     *  ouvre directement l'onglet Sources. */
    initialSection?: SettingsSectionId;
    /**
     * L'élément réglé n'est plus ici (supprimé, déplacé vers un autre espace) :
     * la coquille s'est refermée, la fiche qui l'a ouverte doit s'en aller.
     */
    onGone?: () => void;
}

export function FeatureSettingsDialog({ open, onClose, scope, initialSection, onGone }: FeatureSettingsDialogProps) {
    const sections = useSettingsSections(scope);
    // Une seule sortie pour « l'élément n'est plus là », dans cet ordre : la
    // coquille d'abord, la fiche ensuite. Le contraire laisserait un dialogue
    // ouvert au nom d'un élément qui n'existe plus.
    const gone = useCallback(() => {
        onClose();
        onGone?.();
    }, [onClose, onGone]);
    /** `undefined` = personne n'a choisi, et c'est la première section qui
     *  s'ouvre. Nommer ici une section en dur la ferait gagner partout où elle
     *  existe, quelle que soit sa place dans la nav. */
    const [active, setActive] = useState<SettingsSectionId | undefined>(initialSection);
    /**
     * Les réglages généraux, empilés par-dessus ceux d'un élément : ouverts par
     * le fil d'Ariane, ou par « Gérer les canaux » sur leur onglet. La coquille
     * d'une fonctionnalité ne propose pas ce saut, elle est déjà tout en haut.
     */
    const [general, setGeneral] = useState<{ section?: SettingsSectionId } | null>(null);
    const generalSections = useSettingsSections(
        scope.kind === 'item' ? { kind: 'feature', feature: scope.feature } : scope
    );
    const canOpenGeneral = scope.kind === 'item' && generalSections.length > 0;
    const current = active && sections.some((s) => s.id === active) ? active : sections[0]?.id;
    /**
     * Le pied du dialogue, offert aux panneaux par contexte : le bouton qui
     * enregistre tout un onglet s'y projette, au lieu de finir en bas d'un
     * contenu qui défile. Toujours rendu, même vide : un pied qui va et vient
     * d'un onglet à l'autre ferait changer la hauteur du dialogue à chaque clic.
     */
    const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);

    // À chaque ouverture, revenir à la section demandée : un dialogue réutilisé
    // (celui du « + ») doit retomber sur Sources, pas sur le dernier onglet vu.
    useEffect(() => {
        if (open && initialSection) setActive(initialSection);
    }, [open, initialSection]);

    /**
     * Régler n'est pas naviguer : tant que la coquille est ouverte, le chemin
     * diffusé porte un cran de plus, et le curseur sort du groupe de l'écran
     * qu'elle recouvre. La portée suffit à la marque ; l'onglet n'y entre pas,
     * il change trop souvent pour valoir une republication à chaque clic.
     */
    const shown = open && sections.length > 0;
    // La chaîne, jamais l'objet : les appelants passent un littéral, et dépendre
    // de lui reposerait la marque à chaque rendu.
    const settingsValue = liveSettingsValue(scope);
    useEffect(() => {
        if (!shown) return;
        return pushLiveSettings(settingsValue);
    }, [shown, settingsValue]);
    useOverlayView(
        shown && current
            ? `settings/${viewSegment(scope.feature)}${scope.kind === 'item' ? '/item' : ''}/${viewSegment(current)}`
            : null
    );

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
                // Le fil d'Ariane : où l'on est, et d'un clic les réglages
                // généraux qu'un élément surcharge.
                kicker={
                    <nav className={styles.trail} aria-label='Emplacement'>
                        <span>Réglages</span>
                        {scope.kind === 'item' && (
                            <>
                                <span aria-hidden='true'>·</span>
                                {canOpenGeneral ? (
                                    <button
                                        type='button'
                                        className={styles.trailLink}
                                        title='Ouvrir les réglages généraux'
                                        onClick={() => setGeneral({})}
                                    >
                                        {targetInfo(scope.feature).label}
                                    </button>
                                ) : (
                                    <span>{targetInfo(scope.feature).label}</span>
                                )}
                            </>
                        )}
                    </nav>
                }
                title={scopeTitle(scope)}
                description={scopeDescription(scope)}
                width={880}
                fill
                footer={<div ref={setFooterEl} className={styles.footer} />}
            >
                <SettingsFooterContext.Provider value={footerEl}>
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
                                    onManageChannels={
                                        canOpenGeneral ? () => setGeneral({ section: 'notifications' }) : undefined
                                    }
                                />
                            )}
                            {current === 'permissions' && scope.kind === 'item' && (
                                <ItemPermissionsSection scope={scope} />
                            )}
                            {current === 'projects' && scope.kind === 'item' && <ProjectsSection scope={scope} />}
                            {current === 'sharing' && !isSystemScope(scope) && (
                                <SharingSection scope={scope} onGone={gone} />
                            )}
                            {current === 'domains' && scope.kind === 'feature' && !isSystemScope(scope) && (
                                <DomainsSection scope={scope} />
                            )}
                            {current && !GENERIC_SECTIONS.has(current) && !isSystemScope(scope) && (
                                <ModulePanel scope={scope} section={current} close={onClose} gone={gone} />
                            )}
                        </div>
                    </div>
                </SettingsFooterContext.Provider>
            </Dialog>
            {/* Les réglages généraux empilés par-dessus ceux de l'élément ; la
                pile de couches route Échap vers le plus haut. */}
            {scope.kind === 'item' && (
                <FeatureSettingsDialog
                    open={general !== null}
                    onClose={() => setGeneral(null)}
                    scope={{ kind: 'feature', feature: scope.feature }}
                    initialSection={general?.section}
                />
            )}
        </>
    );
}

export interface FeatureSettingsButtonProps {
    scope: ShellScope;
    /**
     * `link` : un mot souligné plutôt qu'un bouton, pour le geste glissé dans une
     * phrase ou dans une cellule trop étroite pour un bouton. Même porte, même
     * dialogue, autre peau.
     */
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
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
    /**
     * L'élément a été supprimé ou déplacé depuis la coquille, qui s'est
     * refermée : la fiche qui monte le bouton s'en va (le même geste que son
     * bouton de retour).
     */
    onGone?: () => void;
}

/** Le bouton qui ouvre les réglages, ou rien : « pas de section, pas de
 *  bouton », tenu en un seul endroit. */
export function FeatureSettingsButton({
    scope,
    variant = 'secondary',
    label = 'Réglages',
    initialSection,
    onOpenChange,
    onGone
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
    const itemId = scope.kind === 'item' ? scope.itemId : null;
    const itemFeature = scope.kind === 'item' ? scope.feature : null;
    useEffect(() => {
        if (itemId === null || itemFeature === null) return;
        const wanted = consumeItemSettings(getActiveWorkspaceId(), itemFeature, itemId);
        if (wanted) {
            setSection(wanted as SettingsSectionId);
            setOpen(true);
        }
    }, [itemFeature, itemId]);

    // Qui règle est un cran plus loin que qui regarde l'écran : son halo se pose
    // donc sur le bouton, et non sur ce que la coquille recouvre.
    const outline = useLiveOutline('settings', liveSettingsValue(scope));

    /* Une action prise hors des réglages montre ce bouton : on y apprend où vit
       ce qui vient de changer. Le bouton canonique seul, celui qui ouvre sur la
       première section : les raccourcis vers un onglet précis partagent la
       même portée, et s'éclaireraient tous ensemble. */
    const myFlashKey = isSystemScope(scope)
        ? null
        : flashKey(
              scope.kind === 'item'
                  ? { kind: 'item', feature: scope.feature, itemId: scope.itemId }
                  : { kind: 'feature', feature: scope.feature }
          );
    const [flashing, setFlashing] = useState(false);
    const canonical = initialSection === undefined;
    useEffect(() => {
        let timer: number | undefined;
        const stop = onFlash((key) => {
            if (key !== myFlashKey || !canonical) return;
            window.clearTimeout(timer);
            // Retomber à faux d'abord relance l'animation si elle jouait déjà.
            setFlashing(false);
            window.requestAnimationFrame(() => setFlashing(true));
            timer = window.setTimeout(() => setFlashing(false), 1600);
        });
        return () => {
            stop();
            window.clearTimeout(timer);
        };
    }, [myFlashKey, canonical]);

    if (sections.length === 0) return null;

    // Une ouverture manuelle repart de la section du bouton : l'onglet d'une
    // intention passée n'a plus rien de demandé.
    const openSettings = (): void => {
        setSection(initialSection);
        setOpen(true);
    };

    return (
        <>
            {variant === 'link' ? (
                /* Le halo de présence appartient au bouton canonique de l'écran :
                   un lien répété sur chaque ligne d'un tableau se mettrait à
                   clignoter en même temps partout. */
                <button type='button' className={styles.settingsLink} onClick={openSettings}>
                    {label}
                </button>
            ) : (
                <Button
                    variant={variant}
                    icon='settings'
                    {...outline}
                    className={flashing ? styles.flash : undefined}
                    onClick={openSettings}
                >
                    {label}
                </Button>
            )}
            <FeatureSettingsDialog
                open={open}
                onClose={() => setOpen(false)}
                scope={scope}
                initialSection={section}
                onGone={onGone}
            />
        </>
    );
}

export type { SettingsScope, SettingsSectionId, ShellScope } from './scope';

/**
 * Le panneau d'un module pour la section courante (`settingsPanels`). Rien à
 * rendre s'il manque : manifest et entrée client peuvent brièvement diverger
 * en développement.
 */
function ModulePanel({
    scope,
    section,
    close,
    gone
}: {
    scope: SettingsScope;
    section: SettingsSectionId;
    close: () => void;
    gone: () => void;
}) {
    const permissions = useWorkspacePermissions();
    const client = moduleClient(scope.feature);
    const Panel = client?.settingsPanels?.[section];
    if (!Panel) return null;
    // La phrase de tête des Sources vient du registre (`sources.hint`).
    const hint = section === 'sources' ? featureDescriptor(scope.feature).sources?.hint : undefined;
    return (
        <>
            {hint && <p className={`${styles.sectionHint} ${styles.panelLead}`}>{hint}</p>}
            <Panel
                scope={
                    scope.kind === 'feature'
                        ? { kind: 'feature' }
                        : { kind: 'item', itemId: scope.itemId, itemLabel: scope.itemLabel }
                }
                // Sur l'élément quand il y en a un : ses droits peuvent différer
                // de ceux de la fonctionnalité, dans les deux sens.
                canWrite={permissions.canFeature(
                    scope.feature,
                    'write',
                    scope.kind === 'item' ? scope.itemId : undefined
                )}
                close={close}
                // Pour le panneau qui supprime l'élément qu'il règle : la portée
                // sur laquelle le dialogue s'est ouvert n'existe plus, et la
                // coquille retomberait sinon sur les onglets de la
                // fonctionnalité, sous le nom de l'élément disparu.
                gone={gone}
            />
        </>
    );
}
