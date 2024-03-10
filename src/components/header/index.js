import React from 'react';

import './style.css';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 */

/**
 * @param {{ context: ContextType, feature: FeatureType }} props
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