import React from 'react';

import './style.css';

/**
 * @typedef {import('../../class/feature').Context} Context
 * @typedef {import('../../class/feature').FeatureType} FeatureType
 */

/**
 * @param {{ context: Context, feature: FeatureType }} props
 * @returns {JSX.Element}
 */
function Header(props) {
    const { context, feature } = props;

    return (
        <header>
            <h1>{context.name}</h1>
            <p>{`${context.name} / ${feature.id}`}</p>
        </header>
    );
}

export default Header;