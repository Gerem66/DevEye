import React from 'react';

/**
 * @typedef {import('../../class/feature').ProjectType} ProjectType
 */

/**
 * @param {ProjectType} context
 * @returns {JSX.Element}
 */
function FeatureProfile(context) {
    return (
        <div>
            <h1>{`Profile (${context.name})`}</h1>
        </div>
    );
}

export default FeatureProfile;