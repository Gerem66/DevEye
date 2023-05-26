import React from 'react';

import auth from '../../class/auth';

/**
 * @typedef {import('../../class/feature').Context} Context
 */

/**
 * @param {Context} context
 * @returns {JSX.Element}
 */
function FeatureProfile(context) {
    return (
        <div>
            <h1>{`Profile (${context.name})`}</h1>

            <button
                onClick={auth.Logout}
            >
                Disconnect
            </button>
        </div>
    );
}

export default FeatureProfile;