import { useState, type ReactNode } from 'react';

import SegmentedControl from '@/Components/SegmentedControl';
import Switch from '@/Components/Switch';
import Tabs, { type TabDef } from '@/Features/Workspace/Tabs';
import { setRenderMode, useRenderState, type RenderMode } from '@/stores/render';
import Buttons from './sections/Buttons';
import Feedback from './sections/Feedback';
import Icons from './sections/Icons';
import Identity from './sections/Identity';
import Inputs from './sections/Inputs';
import Layout from './sections/Layout';
import Overlays from './sections/Overlays';
import Tokens from './sections/Tokens';
import { GalleryDisabled } from './Specimen';
import debugStyles from '../Debug.module.css';
import styles from './Gallery.module.css';

type FamilyId = 'tokens' | 'icons' | 'buttons' | 'inputs' | 'feedback' | 'overlays' | 'layout' | 'identity';

const FAMILIES: TabDef<FamilyId>[] = [
    { id: 'buttons', label: 'Boutons', icon: 'square-check' },
    { id: 'inputs', label: 'Saisie', icon: 'edit' },
    { id: 'feedback', label: 'Retours', icon: 'info' },
    { id: 'overlays', label: 'Fenêtres', icon: 'expand' },
    { id: 'layout', label: 'Mise en page', icon: 'list' },
    { id: 'identity', label: 'Identité', icon: 'user' },
    { id: 'tokens', label: 'Jetons du thème', icon: 'appearance' },
    { id: 'icons', label: 'Icônes', icon: 'star' }
];

const CONTENT: Record<FamilyId, () => ReactNode> = {
    tokens: () => <Tokens />,
    icons: () => <Icons />,
    buttons: () => <Buttons />,
    inputs: () => <Inputs />,
    feedback: () => <Feedback />,
    overlays: () => <Overlays />,
    layout: () => <Layout />,
    identity: () => <Identity />
};

/**
 * Tous les composants de l'interface, en vrai et manipulables : pour juger
 * de leur cohérence d'un coup d'œil, dans chaque mode de rendu.
 */
export default function Gallery() {
    const [family, setFamily] = useState<FamilyId>('buttons');
    const [disabled, setDisabled] = useState(false);
    const [opaque, setOpaque] = useState(false);
    const render = useRenderState();

    return (
        <section className={debugStyles.section}>
            <div className={debugStyles.sectionHead}>
                <span className={debugStyles.sectionLabel}>Composants de l’interface</span>
                <div className={debugStyles.actions}>
                    <SegmentedControl
                        value={render.mode}
                        onChange={(mode: RenderMode) => setRenderMode(mode)}
                        aria-label='Mode de rendu'
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'full', label: 'Complet' },
                            { value: 'lite', label: 'Léger' }
                        ]}
                    />
                    <Switch
                        checked={disabled}
                        onChange={setDisabled}
                        label='Tout désactiver'
                        className={styles.toolSwitch}
                    />
                    <Switch checked={opaque} onChange={setOpaque} label='Fond opaque' className={styles.toolSwitch} />
                </div>
            </div>
            <Tabs tabs={FAMILIES} active={family} onSelect={setFamily} />
            <GalleryDisabled.Provider value={disabled}>
                <div className={`${styles.content} ${opaque ? styles.opaque : ''}`}>{CONTENT[family]()}</div>
            </GalleryDisabled.Provider>
        </section>
    );
}
