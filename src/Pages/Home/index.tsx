import { JSX, useEffect, useState } from 'react';

import './style.css';
import { Navbar } from '@/Components';
import { FEATURES } from '@/Features/Features';
import AddWorkspacePopup from './popup-add-workspace';
import PopupUnlock from './popup-unlock';

import type { DBType_User, DBType_Workspace, FeatureType } from 'deveye-types';

let firstLoad = false;

interface HomePageProps {
    user: DBType_User | null;
    setUser: React.Dispatch<React.SetStateAction<DBType_User | null>>;
}

function HomePage({ user, setUser }: HomePageProps): JSX.Element | null {
    const [workspace, setWorkspace] = useState<DBType_Workspace | null>(null);
    const [feature, setFeature] = useState<FeatureType | null>(null);

    useEffect(() => {
        if (user === null) {
            setWorkspace(null);
            setFeature(null);
            firstLoad = false;
            return;
        }

        if (workspace === null) {
            const workspace = user.Workspaces.find((c) => c.id === user.DefaultWorkspace) || null;
            if (workspace === null || !workspace.features.includes(user.DefaultFeature)) {
                const selfWorkspace = user.Workspaces.find((f) => f.id === 0) || null;
                const firstFeature = FEATURES.find((f) => f.id === selfWorkspace?.features[0]) || null;
                setWorkspace(selfWorkspace);
                setFeature(firstFeature);
                console.error('Workspace or feature not found');
                return;
            }

            const feature = FEATURES.find((f) => f.id === user.DefaultFeature) || null;
            if (feature === null) {
                const firstFeature = FEATURES.find(() => workspace.features[0]) || null;
                setWorkspace(workspace);
                setFeature(firstFeature);
                console.error('Feature not found');
                return;
            }

            setWorkspace(workspace);
            setFeature(feature);
        }
    }, [user]);

    useEffect(() => {
        if (workspace === null) {
            return;
        }

        // Disable auto-load feature on first render
        if (!firstLoad) {
            firstLoad = true;
            return;
        }

        if (workspace.features.length <= 0) {
            setFeature(null);
            return;
        }

        const newFeature = FEATURES.find((f) => f.id === workspace.features[0]) || null;
        setFeature(newFeature);
    }, [workspace]);

    if (user === null) {
        return null;
    }

    const AddWorkspace = (workspace: DBType_Workspace) => {
        setUser({
            ...user,
            Workspaces: [...user.Workspaces, workspace]
        });
        setWorkspace(workspace);
    };

    return (
        <div id='home' className='home'>
            <div className='home-left'>
                <Navbar
                    user={user}
                    workspace={workspace}
                    feature={feature}
                    setWorkspace={setWorkspace}
                    setFeature={setFeature}
                />
            </div>

            <div className='home-right'>
                {workspace !== null && feature !== null && (
                    <feature.component
                        key={`${feature.id} ${workspace.id}`}
                        user={user}
                        setUser={setUser}
                        workspace={workspace}
                        feature={feature}
                        setWorkspace={setWorkspace}
                        setFeature={setFeature}
                    />
                )}

                <AddWorkspacePopup AddWorkspace={AddWorkspace} />
                <PopupUnlock workspace={workspace} />
            </div>
        </div>
    );
}

export default HomePage;
