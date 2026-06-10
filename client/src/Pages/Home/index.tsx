import { JSX, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { Navbar } from '@/Components';
import { FEATURE_BY_ID, FEATURES } from '@/Features/Features';
import AddWorkspacePopup from './popup-add-workspace';
import PopupUnlock from './popup-unlock';
import './style.css';

import type { FeatureType } from '@/Features/types';
import type { Workspace } from 'deveye-types';

function HomePage(): JSX.Element | null {
    const { user, workspaces } = useAuth();
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [feature, setFeature] = useState<FeatureType | null>(null);

    const workspacesById = useMemo(() => {
        const m = new Map<number, Workspace>();
        for (const w of workspaces) m.set(w.id, w);
        return m;
    }, [workspaces]);

    /** Initial selection from user defaults; revalidated on workspace/user changes. */
    useEffect(() => {
        if (!user) {
            setWorkspace(null);
            setFeature(null);
            return;
        }
        if (workspace && workspacesById.has(workspace.id)) return;

        const preferred = workspacesById.get(user.defaultWorkspace);
        const next = preferred ?? workspacesById.get(0) ?? workspaces[0] ?? null;
        setWorkspace(next ?? null);
    }, [user, workspaces, workspace, workspacesById]);

    /** Keep `feature` consistent with the currently selected workspace. */
    useEffect(() => {
        if (!workspace) {
            setFeature(null);
            return;
        }

        const stillAvailable = feature && workspace.features.includes(feature.id);
        if (stillAvailable) return;

        const defaultId = user?.defaultFeature;
        if (defaultId && workspace.features.includes(defaultId) && FEATURE_BY_ID[defaultId]) {
            setFeature(FEATURE_BY_ID[defaultId]);
            return;
        }

        const firstId = workspace.features[0];
        const fallback = (firstId && FEATURE_BY_ID[firstId]) || FEATURES.find((f) => f.id === 'profile') || null;
        setFeature(fallback);
    }, [workspace, user, feature]);

    if (!user) return null;

    return (
        <div id='home' className='home'>
            <div className='home-left'>
                <Navbar workspace={workspace} feature={feature} setWorkspace={setWorkspace} setFeature={setFeature} />
            </div>

            <div className='home-right'>
                {workspace !== null && feature !== null && (
                    <feature.component
                        key={`${feature.id} ${workspace.id}`}
                        user={user}
                        workspace={workspace}
                        feature={feature}
                        setWorkspace={setWorkspace}
                        setFeature={setFeature}
                    />
                )}

                <AddWorkspacePopup onCreated={setWorkspace} />
                <PopupUnlock workspace={workspace} />
            </div>
        </div>
    );
}

export default HomePage;
