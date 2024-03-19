import './style.css';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 */

/**
 * @param {Object} props
 * @param {ContextType} props.context
 * @param {FeatureType} props.feature
 * @returns {JSX.Element}
 */
function Header({ context, feature }) {
    return (
        <header>
            <h1>{context?.name}</h1>
            <p>{`${context?.name} / ${feature.id}`}</p>
        </header>
    );
}

export default Header;