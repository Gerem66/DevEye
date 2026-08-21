import { useEffect, useMemo, useState } from 'react';
import { SHARE_WIRED_FEATURES, featureDescriptor } from 'deveye-types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { consumeItemSettings } from '@/stores/settingsRequest';
import { getActiveWorkspaceId, useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';

import EncryptionSection, { ENCRYPTION_WIRED } from './sections/EncryptionSection';
import GeneralSection, { GENERAL_WIRED } from './sections/GeneralSection';
import NotificationsSection from './sections/NotificationsSection';
import ItemPermissionsSection from './sections/ItemPermissionsSection';
import SharingSection from './sections/SharingSection';
import SourcesSection from './sections/SourcesSection';
import SyncSection, { SYNC_WIRED } from './sections/SyncSection';
import SideNav, { type SideNavItem } from './SideNav';
import { moduleClient, moduleManifest } from '@/sdk/modules';
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

        // Un module installé déclare ses onglets dans son manifest ; la seule
        // règle que la coquille ajoute d'elle-même est celle des émetteurs
        // (l'onglet Notifications suit `notifies`, comme pour les natives).
        const manifest = moduleManifest(scope.feature);
        if (manifest) {
            for (const tab of manifest.settings?.[scope.kind] ?? []) {
                if (tab === 'general') sections.push({ id: 'general', label: 'Général', icon: 'settings' });
                else if (tab === 'sources' && scope.kind === 'feature') {
                    sections.push({ id: 'sources', label: 'Sources', icon: 'key' });
                } else if (typeof tab === 'object') {
                    sections.push({ id: tab.id, label: tab.label, icon: tab.icon ?? 'settings' });
                }
            }
            if (descriptor.notifies && (scope.kind === 'feature' || descriptor.hasItems)) {
                sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
            }
            return sections;
        }

        // Général : les réglages de la fonctionnalité qui ne sont ni des
        // sources ni des notifications (l'affichage des messages de Mail, ses
        // images approuvées). En tête : c'est l'onglet le plus large.
        if (GENERAL_WIRED[scope.feature]?.[scope.kind]) {
            sections.push({ id: 'general', label: 'Général', icon: 'settings' });
        }

        // Sources : à l'échelle de la **fonctionnalité** seulement. C'est le
        // seul endroit où les réglages réutilisables (jetons, destinations) se
        // créent et se corrigent. Les dialogues d'élément ne font que choisir
        // dans la liste, avec un bouton qui mène ici. En tête : on déclare ses
        // sources avant de s'en servir.
        if (scope.kind === 'feature' && descriptor.sources) {
            sections.push({ id: 'sources', label: 'Sources', icon: 'key' });
        }

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

        // Partage : à l'échelle d'un **élément** seulement — on projette une
        // ligne, pas une fonctionnalité entière.
        //
        // `SHARE_WIRED_FEATURES` et non `shareTier` : le premier dit ce que le
        // code fait, le second ce que le chiffrement autoriserait. Se fier au
        // second ouvrirait, sur une note ou un compte mail, un onglet que le
        // serveur refuse — un onglet qui ne mène nulle part, exactement ce que
        // cette coquille refuse.
        if (
            scope.kind === 'item' &&
            SHARE_WIRED_FEATURES.includes(scope.feature) &&
            permissions.canFeature(scope.feature, 'write')
        ) {
            sections.push({ id: 'sharing', label: 'Partage', icon: 'users' });
        }

        // Permissions : à l'échelle d'un **élément** seulement — ce que chaque
        // rôle voit de cette ligne-là. À l'échelle de la fonctionnalité, la
        // question n'existe pas ici : « qui a accès à Uptime » se règle sur le
        // rôle, dans Gérer l'espace. Un panneau qui la reposerait par
        // fonctionnalité a été essayé puis retiré — deux endroits pour un même
        // droit finissent toujours par se contredire.
        //
        // Derrière `workspace.roles` : restreindre un élément, c'est régler ce
        // qu'un rôle peut voir. Un espace personnel n'a pas de rôles, donc rien
        // à montrer. Et `SHARE_WIRED_FEATURES` comme pour le partage : une
        // restriction n'existe que là où les listages la font respecter —
        // ailleurs, le serveur la refuse, donc l'onglet mentirait.
        if (scope.kind === 'item' && SHARE_WIRED_FEATURES.includes(scope.feature) && canRestrict && isShared) {
            // `shield` et non `lock` : le cadenas est l'icône du chiffrement,
            // et deux entrées de nav au même glyphe se confondent.
            sections.push({ id: 'permissions', label: 'Permissions', icon: 'shield' });
        }

        return sections;
    }, [scope.feature, scope.kind, canRead, canRestrict, isShared, permissions]);
}

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
                        {moduleManifest(scope.feature) ? (
                            /* Un module : ses panneaux viennent de son entrée
                               client ; seul Notifications reste le générique de
                               la coquille, comme chez les natives. */
                            <>
                                {current === 'notifications' ? (
                                    <NotificationsSection
                                        scope={scope}
                                        onManageChannels={
                                            scope.kind === 'item' ? () => setManageChannels(true) : undefined
                                        }
                                    />
                                ) : (
                                    <ModulePanel scope={scope} section={current} />
                                )}
                            </>
                        ) : (
                            <>
                                {current === 'general' && <GeneralSection scope={scope} />}
                                {current === 'sources' && scope.kind === 'feature' && <SourcesSection scope={scope} />}
                                {current === 'sync' && <SyncSection scope={scope} />}
                                {current === 'encryption' && <EncryptionSection scope={scope} />}
                                {current === 'notifications' && (
                                    <NotificationsSection
                                        scope={scope}
                                        onManageChannels={
                                            scope.kind === 'item' ? () => setManageChannels(true) : undefined
                                        }
                                    />
                                )}
                                {current === 'permissions' && scope.kind === 'item' && (
                                    <ItemPermissionsSection scope={scope} />
                                )}
                                {current === 'sharing' && <SharingSection scope={scope} />}
                            </>
                        )}
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
    label = 'Réglages'
}: FeatureSettingsButtonProps) {
    const sections = useSettingsSections(scope);
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState<SettingsSectionId | undefined>(undefined);

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
                    // Une ouverture manuelle repart de la première section :
                    // l'onglet d'une intention passée n'a plus rien de demandé.
                    setSection(undefined);
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
    return (
        <Panel
            scope={
                scope.kind === 'feature'
                    ? { kind: 'feature' }
                    : { kind: 'item', itemId: scope.itemId, itemLabel: scope.itemLabel }
            }
            canWrite={permissions.canFeature(scope.feature, 'write')}
        />
    );
}
