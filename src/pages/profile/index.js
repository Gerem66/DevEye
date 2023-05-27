import React from 'react';

import './style.css';
import auth from '../../class/auth';

import Header from '../../components/header';

/**
 * @typedef {import('../../class/feature').Context} Context
 * @typedef {import('../../class/feature').FeatureType} FeatureType
 */

/**
 * @param {Context} context
 * @param {FeatureType} feature
 * @returns {JSX.Element}
 */
function FeatureProfile(context, feature) {
    return (
        <div>
            <Header
                title={context.name}
                context_name={context.name}
                feature_name={feature.id}
            />

            <button
                onClick={auth.Logout}
            >
                Disconnect
            </button>
        </div>
    );
}

export default FeatureProfile;