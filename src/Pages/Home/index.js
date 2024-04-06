import { useEffect, useState } from 'react';

import './style.css';
import { Navbar } from '../../Components';
import { FEATURES } from '../../Features/Features';
import AddContextPopup from './addContext';
import PopupUnlock from './unlock';

/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 * @typedef {import('Utils/TCP').default} ClientTCP
 */

let firstLoad = false;

/**
 * @param {Object} props
 * @param {UserType | null} props.user
 * @param {(user: UserType | null) => void} props.setUser
 * @returns {JSX.Element | null}
 */
function HomePage({ user, setUser }) {
    const [ context, setContext ] = useState(/** @type {ContextType | null} */ (null));
    const [ feature, setFeature ] = useState(/** @type {FeatureType | null} */ (null));


    useEffect(() => {
        if (user === null) {
            setContext(null);
            setFeature(null);
            firstLoad = false;
            return;
        }

        if (context === null) {
            const context = user.Contexts.find(c => c.id === user.DefaultContext) || null;
            if (context === null || !context.features.includes(user.DefaultFeature)) {
                const selfContext = user.Contexts.find(f => f.id === 0) || null;
                const firstFeature = FEATURES.find(f => f.id === selfContext?.features[0]) || null;
                setContext(selfContext);
                setFeature(firstFeature)
                console.error('Context or feature not found');
                return;
            }

            const feature = FEATURES.find(f => f.id === user.DefaultFeature) || null;
            if (feature === null) {
                const firstFeature = FEATURES.find(f => context.features[0]) || null;
                setContext(context);
                setFeature(firstFeature)
                console.error('Feature not found');
                return;
            }

            setContext(context);
            setFeature(feature);
        }
    }, [ user ]);

    useEffect(() => {
        if (context === null) {
            return;
        }

        // Disable auto-load feature on first render
        if (!firstLoad) {
            firstLoad = true;
            return;
        }

        if (context.features.length <= 0) {
            setFeature(null);
            return;
        }

        const newFeature = FEATURES.find(f => f.id === context.features[0]) || null;
        setFeature(newFeature);
    }, [ context ]);

    if (user === null) {
        return null;
    }

    /** @param {ContextType} context */
    const AddContext = (context) => {
        setUser({
            ...user,
            Contexts: [
                ...user.Contexts,
                context
            ]
        });
        setContext(context);
    };

    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar
                    user={user}
                    context={context}
                    feature={feature}
                    setContext={setContext}
                    setFeature={setFeature}
                />
            </div>

            <div className="home-right">
                {context !== null && feature !== null && (
                    <feature.component
                        key={`${feature.id} ${context.id}`}
                        user={user}
                        setUser={setUser}
                        context={context}
                        feature={feature}
                        setContext={setContext}
                        setFeature={setFeature}
                    />
                )}

                <AddContextPopup AddContext={AddContext} />
                <PopupUnlock context={context} />
            </div>
        </div>
    );
}

export default HomePage;
