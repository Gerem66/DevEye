import { useState, type ReactNode } from 'react';

import { Dialog } from '@/Components/Dialog';
import SideNav, { type SideNavItem } from '@/Components/FeatureSettings/SideNav';
import SegmentedControl from '@/Components/SegmentedControl';
import Switch from '@/Components/Switch';
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
import styles from './Gallery.module.css';

type SectionId = 'tokens' | 'icons' | 'buttons' | 'inputs' | 'feedback' | 'overlays' | 'layout' | 'identity';

const SECTIONS: SideNavItem<SectionId>[] = [
    { id: 'tokens', label: 'Jetons du thème', icon: 'appearance' },
    { id: 'icons', label: 'Icônes', icon: 'star' },
    { id: 'buttons', label: 'Boutons', icon: 'square-check' },
    { id: 'inputs', label: 'Saisie', icon: 'edit' },
    { id: 'feedback', label: 'Retours', icon: 'info' },
    { id: 'overlays', label: 'Fenêtres', icon: 'expand' },
    { id: 'layout', label: 'Mise en page', icon: 'list' },
    { id: 'identity', label: 'Identité', icon: 'user' }
];

const CONTENT: Record<SectionId, () => ReactNode> = {
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
export default function GalleryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [section, setSection] = useState<SectionId>('buttons');
    const [disabled, setDisabled] = useState(false);
    const [opaque, setOpaque] = useState(false);
    const render = useRenderState();

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Composants de l’interface'
            width={1200}
            fill
            headerAction={
                <div className={styles.toolbar}>
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
                    <Switch checked={disabled} onChange={setDisabled} label='Tout désactiver' />
                    <Switch checked={opaque} onChange={setOpaque} label='Fond opaque' />
                </div>
            }
        >
            <GalleryDisabled.Provider value={disabled}>
                <div className={`${styles.layout} ${opaque ? styles.opaque : ''}`}>
                    <SideNav items={SECTIONS} active={section} onSelect={setSection} label='Familles de composants' />
                    <div className={styles.panel}>{CONTENT[section]()}</div>
                </div>
            </GalleryDisabled.Provider>
        </Dialog>
    );
}
