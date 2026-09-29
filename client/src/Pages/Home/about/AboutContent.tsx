import { useState } from 'react';

import Tabs, { type TabDef } from '@/Features/Workspace/Tabs';
import ChangelogTab from './ChangelogTab';
import CreditsTab from './CreditsTab';
import FeaturesTab from './FeaturesTab';
import OverviewTab from './OverviewTab';
import ServicesTab from './ServicesTab';

export type AboutTab = 'overview' | 'changelog' | 'features' | 'services' | 'credits';

const TABS: TabDef<AboutTab>[] = [
    { id: 'overview', label: 'Aperçu', icon: 'info' },
    { id: 'changelog', label: 'Nouveautés', icon: 'star' },
    { id: 'features', label: 'Fonctionnalités', icon: 'list' },
    { id: 'services', label: 'Services', icon: 'globe' },
    { id: 'credits', label: 'Crédits', icon: 'file' }
];

/** Body of the "About" info dialog, opened from the navbar's version pill. */
export default function AboutContent() {
    const [tab, setTab] = useState<AboutTab>('overview');

    return (
        <>
            <Tabs tabs={TABS} active={tab} onSelect={setTab} />
            {tab === 'overview' && <OverviewTab onOpen={setTab} />}
            {tab === 'changelog' && <ChangelogTab />}
            {tab === 'features' && <FeaturesTab />}
            {tab === 'services' && <ServicesTab />}
            {tab === 'credits' && <CreditsTab />}
        </>
    );
}
