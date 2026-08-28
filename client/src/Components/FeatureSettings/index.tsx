import { useEffect, useMemo, useRef, useState } from 'react';
import { SHARE_WIRED_FEATURES, featureDescriptor, type FeatureId } from '@deveye/types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { consumeItemSettings } from '@/stores/settingsRequest';
import { getActiveWorkspaceId, useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';

import EncryptionSection, { ENCRYPTION_WIRED } from './sections/EncryptionSection';
import GeneralSection, { GENERAL_WIRED } from './sections/GeneralSection';
import NotificationsSection from './sections/NotificationsSection';
import ItemPermissionsSection from './sections/ItemPermissionsSection';
import SharingSection from './sections/SharingSection';
import SyncSection, { SYNC_WIRED } from './sections/SyncSection';
import SideNav, { type SideNavItem } from './SideNav';
import { isModuleShareWired, moduleClient, moduleManifest } from '@/sdk/registry';
import { scopeDescription, scopeTitle, type SettingsScope, type SettingsSectionId } from './scope';
import styles from './FeatureSettings.module.css';

/**
 * La coquille de réglages — **une seule pour toutes les fonctionnalités et tous
 * leurs éléments**.
 *
 * ## Le principe qui la gouverne
 *
 * Une section n'apparaît que si elle mène à quelque chose d'utilisable, et
 * **quand il n'en reste aucune, le bouton lui-même n'existe pas**. C'est le
 * prolongement direct de ce que faisaient déjà les onglets de l'écran Espace :
 * construits par l'appelant en fonction des droits, plutôt qu'affichés puis
 * grisés. Un panneau vide et un bouton qui n'ouvre rien sont deux façons de
 * faire perdre un clic.
 *
 * D'où la forme : `FeatureSettingsButton` rend `null` plutôt que de laisser
 * chaque feature décider — sinon la règle serait à retenir cinq fois, et la
 * sixième l'oublierait.
 */

interface SectionDef {
    id: SettingsSectionId;
    label: string;
    icon: string;
}

/**
 * La lecture élargie de cette fonctionnalité est-elle branchée ? Les natives
 * par la liste publiée, les modules par leur manifest : la même question que
 * le serveur pose (`isShareWired`), et c'est ce qui garde l'onglet Partage
 * derrière ce que le code fait, jamais derrière ce que `shareTier` promet.
 */
function isShareWired(feature: FeatureId): boolean {
    return (SHARE_WIRED_FEATURES as readonly FeatureId[]).includes(feature) || isModuleShareWired(feature);
}

/**
 * Les sections visibles pour cette cible, dans l'ordre d'affichage.
 *
 * Exporté : les appelants s'en servent pour décider s'il y a un bouton à rendre,
 * sans avoir à monter le dialogue pour le découvrir.
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

        // Partage : à l'échelle d'un **élément** seulement, on projette une
        // ligne, pas une fonctionnalité entière.
        //
        // Le branchement (`isShareWired`) et non `shareTier` : le premier dit
        // ce que le code fait, le second ce que le chiffrement autoriserait.
        // Se fier au second ouvrirait, sur une note ou un compte mail, un
        // onglet que le serveur refuse, un onglet qui ne mène nulle part,
        // exactement ce que cette coquille refuse.
        //
        // Permissions : à l'échelle d'un **élément** seulement, ce que chaque
        // rôle voit de cette ligne-là. À l'échelle de la fonctionnalité, la
        // question n'existe pas ici : « qui a accès à Uptime » se règle sur le
        // rôle, dans Gérer l'espace. Un panneau qui la reposerait par
        // fonctionnalité a été essayé puis retiré, deux endroits pour un même
        // droit finissent toujours par se contredire.
        //
        // Derrière `workspace.roles` : restreindre un élément, c'est régler ce
        // qu'un rôle peut voir. Un espace personnel n'a pas de rôles, donc rien
        // à montrer. Et le branchement comme pour le partage : une restriction
        // n'existe que là où les listages la font respecter ; ailleurs, le
        // serveur la refuse, donc l'onglet mentirait.
        //
        // Commun aux natives et aux modules : les deux échelles se règlent
        // pareil, seule la source du branchement diffère.
        const pushSharingSections = (into: SectionDef[]): void => {
            if (scope.kind !== 'item' || !isShareWired(scope.feature)) return;
            if (permissions.canFeature(scope.feature, 'write')) {
                into.push({ id: 'sharing', label: 'Partage', icon: 'users' });
            }
            if (canRestrict && isShared) {
                // `shield` et non `lock` : le cadenas est l'icône du
                // chiffrement, et deux entrées de nav au même glyphe se
                // confondent.
                into.push({ id: 'permissions', label: 'Permissions', icon: 'shield' });
            }
        };

        // Un module installé déclare ses onglets dans son manifest ; les
        // règles que la coquille ajoute d'elle-même sont celles des natives
        // aussi : Notifications suit `notifies`, Partage et Permissions
        // suivent le branchement au partage (plus bas, commun aux deux).
        const manifest = moduleManifest(scope.feature);
        if (manifest) {
            for (const tab of manifest.settings?.[scope.kind] ?? []) {
                if (tab === 'general') sections.push({ id: 'general', label: 'Général', icon: 'settings' });
                else if (tab === 'sources' && scope.kind === 'feature') {
                    sections.push({ id: 'sources', label: 'Sources', icon: 'key' });
                } else if (tab === 'encryption' && scope.kind === 'item') {
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

        // Général : les réglages de la fonctionnalité qui ne sont ni des
        // sources ni des notifications (l'affichage des messages de Mail, ses
        // images approuvées). En tête : c'est l'onglet le plus large.
        if (GENERAL_WIRED[scope.feature]?.[scope.kind]) {
            sections.push({ id: 'general', label: 'Général', icon: 'settings' });
        }

        // Sources : plus aucune native n'en déclare. Les cinq features à
        // sources (Météo, OSINT, Sauvegardes, Déploiement, Git) sont des
        // modules, et l'onglet vient de leur manifest (plus haut).

        // Notifications : réservé aux émetteurs, et à l'échelle d'un élément
        // seulement quand la fonctionnalité en a de réglables.
        if (descriptor.notifies && (scope.kind === 'feature' || descriptor.hasItems)) {
            sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
        }

        // Synchronisation : le rythme de relève d'un élément, et sa
        // maintenance. À l'échelle d'un élément seulement.
        if (scope.kind === 'item' && SYNC_WIRED[scope.feature]) {
            sections.push({ id: 'sync', label: 'Synchronisation', icon: 'refresh' });
        }

        // Chiffrement : sous quelle clé la donnée de l'élément vit, quand la
        // fonctionnalité laisse le choix. À l'échelle d'un élément seulement.
        if (scope.kind === 'item' && ENCRYPTION_WIRED[scope.feature]) {
            sections.push({ id: 'encryption', label: 'Chiffrement', icon: 'lock' });
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
    /**
     * La section à montrer à l'ouverture.
     *
     * C'est ce qui permet aux dialogues d'élément de **mener quelque part** :
     * le « + » d'un sélecteur de source ouvre ces réglages directement sur
     * l'onglet Sources, plutôt que de laisser chercher.
     */
    initialSection?: SettingsSectionId;
}

export function FeatureSettingsDialog({ open, onClose, scope, initialSection }: FeatureSettingsDialogProps) {
    const sections = useSettingsSections(scope);
    const [active, setActive] = useState<SettingsSectionId>(initialSection ?? 'notifications');
    /**
     * Depuis les réglages d'un élément, « Gérer les canaux » ouvre ceux de sa
     * fonctionnalité, par-dessus. La récursion s'arrête là : la coquille d'une
     * fonctionnalité ne propose pas ce saut.
     */
    const [manageChannels, setManageChannels] = useState(false);
    const current = sections.some((s) => s.id === active) ? active : (sections[0]?.id ?? 'notifications');

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
                        dialogues de réglages ont la même silhouette, et c'est
                        cette constance qui fait qu'on s'y retrouve — un panneau
                        qui apparaît et disparaît selon le nombre de sections
                        ferait chercher les réglages à deux endroits selon la
                        feature. */}
                    <SideNav
                        items={items}
                        active={current}
                        onSelect={setActive}
                        label={`Réglages · ${scopeTitle(scope)}`}
                    />
                    <div className={styles.panel}>
                        {/* Les trois sections génériques de la coquille, les
                            mêmes pour une native et pour un module : les
                            canaux, le partage, les restrictions. Le reste
                            vient de la feature : ses panneaux (`settingsPanels`)
                            pour un module, les dispatcheurs à table pour une
                            native. */}
                        {current === 'notifications' && (
                            <NotificationsSection
                                scope={scope}
                                onManageChannels={scope.kind === 'item' ? () => setManageChannels(true) : undefined}
                            />
                        )}
                        {current === 'permissions' && scope.kind === 'item' && <ItemPermissionsSection scope={scope} />}
                        {current === 'sharing' && <SharingSection scope={scope} />}
                        {!GENERIC_SECTIONS.has(current) &&
                            (moduleManifest(scope.feature) ? (
                                <ModulePanel scope={scope} section={current} />
                            ) : (
                                <>
                                    {current === 'general' && <GeneralSection scope={scope} />}
                                    {current === 'sync' && <SyncSection scope={scope} />}
                                    {current === 'encryption' && <EncryptionSection scope={scope} />}
                                </>
                            ))}
                    </div>
                </div>
            </Dialog>
            {/* Les réglages de la fonctionnalité, empilés par-dessus ceux de
                l'élément : le geste « je règle cette base » qui débouche sur
                « il me manque un canal » ne doit pas faire fermer, chercher,
                rouvrir. La pile de couches route Échap vers le plus haut. */}
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
    /**
     * La section ouverte par un clic manuel ; la première à défaut.
     *
     * C'est ce qui permet à un bouton posé dans une fiche de MENER quelque
     * part : le « + » d'un sélecteur ouvre les réglages sur l'onglet qui crée
     * ce qu'il sélectionne (Sources, Catégories), plutôt que de laisser chercher.
     */
    initialSection?: SettingsSectionId;
    /**
     * La coquille s'ouvre ou se ferme (le démontage vaut fermeture).
     *
     * Pour le composant qui DÉTIENT la présence (`useLiveSegment`) quand rien
     * d'autre n'annonce l'élément : une carte sans fiche, où la coquille est un
     * lieu au même titre que les autres dialogues de l'élément. La coquille ne
     * déclare jamais le niveau elle-même : le registre n'admet qu'un déclarant
     * par niveau, et elle effacerait ce qu'une fiche déjà ouverte a posé.
     */
    onOpenChange?: (open: boolean) => void;
}

/**
 * Le bouton qui ouvre les réglages — **ou rien du tout**.
 *
 * Une ligne par point d'appel, et la règle « pas de section, pas de bouton »
 * tenue en un seul endroit.
 */
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
     * L'intention « ouvrir les réglages de cet élément » posée avant une
     * bascule d'espace (« Régler dans <espace> » d'un élément projeté). La
     * consommer ICI, dans le bouton commun, est ce qui rend le saut gratuit
     * pour toutes les features : monter le bouton suffit, aucune n'a de code à
     * écrire. L'intention périmée ou visant un autre élément rend `null`.
     */
    const itemId = scope.kind === 'item' ? scope.itemId : null;
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
                    // Une ouverture manuelle repart de la section demandée par
                    // le bouton, ou de la première : l'onglet d'une intention
                    // passée n'a plus rien de demandé.
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
 * Le panneau d'un module pour la section courante : fourni par son entrée
 * client (`settingsPanels`), qui reçoit la portée réduite du SDK et le droit
 * d'écriture. Rien à rendre si le module n'a pas fourni ce panneau : la
 * section ne devrait alors pas être proposée, mais un manifest et une entrée
 * client peuvent brièvement diverger pendant un développement.
 */
function ModulePanel({ scope, section }: { scope: SettingsScope; section: SettingsSectionId }) {
    const permissions = useWorkspacePermissions();
    const client = moduleClient(scope.feature);
    const Panel = client?.settingsPanels?.[section];
    if (!Panel) return null;
    // La phrase de tête des Sources vient du registre (`sources.hint`), comme
    // du temps des natives : elle dit à quoi servent ces réglages d'espace
    // avant que le panneau du module ne les liste. Les cinq features à
    // sources sont des modules depuis le rapatriement de Git ; c'est donc ici
    // qu'elle s'affiche, et nulle part ailleurs.
    const hint = section === 'sources' ? featureDescriptor(scope.feature).sources?.hint : undefined;
    return (
        <>
            {hint && <p className={styles.sectionHint}>{hint}</p>}
            <Panel
                scope={
                    scope.kind === 'feature'
                        ? { kind: 'feature' }
                        : { kind: 'item', itemId: scope.itemId, itemLabel: scope.itemLabel }
                }
                canWrite={permissions.canFeature(scope.feature, 'write')}
            />
        </>
    );
}
