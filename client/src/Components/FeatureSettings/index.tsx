import { useMemo, useState } from 'react';
import { SHARE_WIRED_FEATURES, featureDescriptor } from 'deveye-types';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';

import NotificationsSection from './sections/NotificationsSection';
import ItemPermissionsSection from './sections/ItemPermissionsSection';
import SharingSection from './sections/SharingSection';
import SideNav, { type SideNavItem } from './SideNav';
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

        // Notifications : réservé aux émetteurs, et à l'échelle d'un élément
        // seulement quand la fonctionnalité en a de réglables.
        if (descriptor.notifies && (scope.kind === 'feature' || descriptor.hasItems)) {
            sections.push({ id: 'notifications', label: 'Notifications', icon: 'mail' });
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
            sections.push({ id: 'permissions', label: 'Permissions', icon: 'lock' });
        }

        return sections;
    }, [scope.feature, scope.kind, canRead, canRestrict, isShared, permissions]);
}

export interface FeatureSettingsDialogProps {
    open: boolean;
    onClose: () => void;
    scope: SettingsScope;
}

export function FeatureSettingsDialog({ open, onClose, scope }: FeatureSettingsDialogProps) {
    const sections = useSettingsSections(scope);
    const [active, setActive] = useState<SettingsSectionId>('notifications');
    const current = sections.some((s) => s.id === active) ? active : (sections[0]?.id ?? 'notifications');

    const items: SideNavItem<SettingsSectionId>[] = sections.map((s) => ({
        id: s.id,
        label: s.label,
        icon: s.icon
    }));

    return (
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
                    dialogues de réglages ont la même silhouette, et c'est cette
                    constance qui fait qu'on s'y retrouve — un panneau qui
                    apparaît et disparaît selon le nombre de sections ferait
                    chercher les réglages à deux endroits selon la feature. */}
                <SideNav
                    items={items}
                    active={current}
                    onSelect={setActive}
                    label={`Réglages · ${scopeTitle(scope)}`}
                />
                <div className={styles.panel}>
                    {current === 'notifications' && <NotificationsSection scope={scope} />}
                    {current === 'permissions' && scope.kind === 'item' && <ItemPermissionsSection scope={scope} />}
                    {current === 'sharing' && <SharingSection scope={scope} />}
                </div>
            </div>
        </Dialog>
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

    if (sections.length === 0) return null;

    return (
        <>
            <Button variant={variant} icon='settings' onClick={() => setOpen(true)}>
                {label}
            </Button>
            <FeatureSettingsDialog open={open} onClose={() => setOpen(false)} scope={scope} />
        </>
    );
}

export type { SettingsScope, SettingsSectionId } from './scope';
