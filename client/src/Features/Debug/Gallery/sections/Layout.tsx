import { useState } from 'react';

import { CountWidget } from '@/Components/CountWidget';
import SideNav from '@/Components/FeatureSettings/SideNav';
import settingsStyles from '@/Components/FeatureSettings/FeatureSettings.module.css';
import Widget from '@/Components/Widget/Widget';
import Tabs from '@/Features/Workspace/Tabs';
import { Specimen, Variant } from '../Specimen';
import styles from '../Gallery.module.css';

export default function Layout() {
    const [nav, setNav] = useState<'general' | 'sources' | 'alerts'>('general');
    const [tab, setTab] = useState<'members' | 'roles'>('members');
    return (
        <>
            <Specimen title='SideNav' note='La colonne de la coquille de réglages.'>
                <Variant label='trois sections'>
                    <SideNav
                        items={[
                            { id: 'general', label: 'Général', icon: 'settings' },
                            { id: 'sources', label: 'Sources', icon: 'database', badge: 2 },
                            { id: 'alerts', label: 'Notifications', icon: 'mail' }
                        ]}
                        active={nav}
                        onSelect={setNav}
                        label='Démonstration'
                    />
                </Variant>
            </Specimen>
            <Specimen title='Tabs' note='Les onglets soulignés d’une fiche.'>
                <Variant label='deux onglets' wide>
                    <Tabs
                        tabs={[
                            { id: 'members', label: 'Membres', icon: 'users', badge: 3 },
                            { id: 'roles', label: 'Rôles', icon: 'shield' }
                        ]}
                        active={tab}
                        onSelect={setTab}
                    />
                </Variant>
            </Specimen>
            <Specimen title='Rangées de réglages' note='Les classes communes (settingsStyles).'>
                <Variant label='field' wide>
                    <div className={settingsStyles.field}>
                        <span className={settingsStyles.fieldLabel}>Intitulé d’un champ</span>
                        <span className={settingsStyles.sectionHint}>La phrase d’aide sous un bloc de réglages.</span>
                    </div>
                </Variant>
            </Specimen>
            <Specimen
                title='Widget et CountWidget'
                note='La tuile de l’accueil, et le compte qu’elle affiche le plus souvent.'
            >
                <Variant label='tuile'>
                    <div className={styles.widgetFrame}>
                        <Widget widgetId='debug-gallery' title='Uptime' icon='uptime' interactive={false}>
                            <CountWidget
                                state={{ kind: 'ready', count: 12 }}
                                noun='service'
                                hint='Tous répondent'
                                empty='Aucun service'
                            />
                        </Widget>
                    </div>
                </Variant>
                <Variant label='chargement et alerte'>
                    <div className={styles.widgetFrame}>
                        <Widget widgetId='debug-gallery-2' title='Sentinelle' icon='shield' interactive={false}>
                            <CountWidget
                                state={{ kind: 'ready', count: 2 }}
                                noun='alerte'
                                hint='À examiner'
                                empty='Rien à signaler'
                                tone='danger'
                            />
                        </Widget>
                    </div>
                    <div className={styles.widgetFrame}>
                        <Widget widgetId='debug-gallery-3' title='Notes' icon='notes' interactive={false}>
                            <CountWidget state={{ kind: 'loading' }} noun='note' hint='' empty='' />
                        </Widget>
                    </div>
                </Variant>
            </Specimen>
        </>
    );
}
