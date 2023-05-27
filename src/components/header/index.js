import React from 'react';

import './style.css';

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.context_name
 * @param {string} props.feature_name
 * @returns {JSX.Element}
 */
function Header(props) {
    const { title, context_name, feature_name } = props;

    return (
        <header>
            <h1>{title}</h1>
            <p>{`${context_name} / ${feature_name}`}</p>
        </header>
    );
}

export default Header;