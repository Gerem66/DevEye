import { useEffect, useState } from 'react';
import { itemNounForms, type NotificationFeature } from '@deveye/types';

import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';

import { FeatureSettingsButton, useSettingsSections } from './index';
import { routeItemId, targetInfo, type SettingsScope } from './scope';
import styles from './NotificationsNotice.module.css';

type NoticeScope = Exclude<SettingsScope, { kind: 'record' }>;

/**
 * Le bandeau d'une fonctionnalité qui n'a déclaré aucun canal, ou d'un élément
 * qui n'en coche aucun : rien ne partira, et son bouton ouvre l'onglet
 * Notifications à la bonne échelle. Muet pour qui ne pourrait rien y changer,
 * et tant que la réponse n'est pas là : un bandeau qui clignote au chargement
 * dirait faux une fois sur deux.
 */
export default function NotificationsNotice({ scope }: { scope: NoticeScope }) {
    const feature = scope.feature as NotificationFeature;
    const info = targetInfo(scope.feature);
    const permissions = useWorkspacePermissions();
    const hasTab = useSettingsSections(scope).some((s) => s.id === 'notifications');
    const channelsVersion = useResourceVersion('notify.channelList');
    const routeVersion = useResourceVersion('notify.routeGet');
    const itemId = routeItemId(scope);
    /** Ce qui se règle à cette échelle : cocher (élément, fonctionnalité qui prévient en son nom) ou déclarer. */
    const routes = scope.kind === 'item' || info.featureRoute;
    const canFix = routes
        ? permissions.canFeature(scope.feature, 'write', scope.kind === 'item' ? scope.itemId : undefined)
        : permissions.canChannels(scope.feature);
    const applies = hasTab && canFix && (scope.kind === 'feature' || itemId !== null);
    const [silent, setSilent] = useState(false);
    /** Son bouton tient le dialogue : le bandeau ne s'efface qu'une fois celui-ci refermé. */
    const [dialogOpen, setDialogOpen] = useState(false);

    useEffect(() => {
        if (!applies) {
            setSilent(false);
            return;
        }
        let live = true;
        const load = routes
            ? ws
                  .send('notify.routeGet', { feature, itemId: itemId ?? undefined })
                  .then((r) => r.managedHere && r.route.channelIds.length === 0 && r.foreign.length === 0)
            : ws.send('notify.channelList', { feature }).then((r) => r.channels.length === 0);
        void load.then(
            (none) => live && setSilent(none),
            () => live && setSilent(false)
        );
        return () => {
            live = false;
        };
    }, [applies, routes, feature, itemId, channelsVersion, routeVersion]);

    if (!applies || (!silent && !dialogOpen)) return null;
    const noun = itemNounForms(scope.feature);
    return (
        <div className={styles.notice} role='status'>
            <div>
                <p className={styles.title}>Aucune notification configurée</p>
                <p>
                    {scope.kind === 'item'
                        ? `${noun.Dem} ne prévient personne : aucun canal n’est coché dans ses réglages.`
                        : routes
                          ? `Aucun avis ne partira : aucun canal n’est coché pour ${info.label}.`
                          : `Aucun avis ne peut partir : aucun canal (e-mail, webhook ou Discord) n’est déclaré pour ${info.label}. Déclarez-en un, puis cochez-le dans les réglages de chaque ${noun.noun}.`}
                </p>
            </div>
            <FeatureSettingsButton
                scope={scope}
                variant='primary'
                initialSection='notifications'
                label={scope.kind === 'item' ? 'Choisir les canaux' : 'Configurer les notifications'}
                onOpenChange={setDialogOpen}
            />
        </div>
    );
}
