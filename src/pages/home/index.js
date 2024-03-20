import { useEffect, useState } from 'react';

import './style.css';
import { Navbar } from '../../components/components';
import { AllFeatures } from '../../Types/Feature';

/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 * @typedef {import('Utils/TCP').default} ClientTCP
 */

/**
 * @param {Object} props
 * @param {ClientTCP} props.tcp
 * @param {UserType | null} props.user
 * @param {(user: UserType | null) => void} props.setUser
 * @returns {JSX.Element | null}
 */
function HomePage({ user, setUser }) {
    const defaultFeature = AllFeatures.find(f => f.id === 'dashboard');
    if (defaultFeature === undefined) {
        return null;
    }

    const [ context, setContext ] = useState(/** @type {ContextType | null} */ (null));
    const [ feature, setFeature ] = useState(/** @type {FeatureType | null} */ (null));

    useEffect(() => {
        if (user !== null && user.Contexts.length > 0) {
            setContext(user.Contexts[0]);
            setFeature(defaultFeature);
        }
    }, [ user ]);

    if (user === null || context === null || feature === null) {
        return null;
    }

    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar
                    user={user}
                    context={context}
                    setContext={setContext}
                    setFeature={setFeature}
                />
            </div>

            <div className="home-right">
                {context !== null && feature !== null && (
                    <feature.component
                        user={user}
                        setUser={setUser}
                        context={context}
                        feature={feature}
                    />
                )}
            </div>
        </div>
    );
}

export default HomePage;
