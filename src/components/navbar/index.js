import React from 'react';

import './style.css';
import './button.css';
import { AllFeatures } from '../../Types/Feature';
import { GlobalContext } from '../../context';

import NavFeatures from './content/navFeatures';
import NavContexts from './content/navContexts';

// @ts-ignore
import packageJson from '../../../package.json';
const version = packageJson.version + (process.env.NODE_ENV === 'development' && '-dev' || '');

/**
 * @typedef {import('Types/Feature').FeaturesID} FeaturesID
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('../../context').ReactContextType} ReactContextType
 */

const NavbarProps = {
    /** @type {ContextType} */
    context: null,

    /** @type {(context: ContextType) => void} */
    setContext: (context) => {},

    /** @type {(content: JSX.Element|null) => void} */
    setContent: (content) => {}
};

class Navbar extends React.Component {
    static contextType = GlobalContext;

    state = {
        active: {
            /** @type {string|null} */
            feature_id: null,

            /** @type {string|null} */
            context_id: null
        },

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    componentDidMount() {
        this.__selectDefaultFeature();
    }

    componentDidUpdate(prevProps) {
        if (prevProps.context !== this.props.context) {
            this.__selectDefaultFeature();
        }
    }

    __selectDefaultFeature = () => {
        const { context } = this.props;
        if (context === null || context.features.length === 0) return;

        this.onFeatureClick(context.id, context.features[0]);
    }

    onProfileClick = () => {
        this.setState({ is_navpanel_switch: true });
    }

    /** @param {ContextType|null} context */
    onContextClick = (context = null) => {
        this.setState({ is_navpanel_switch: false });

        if (context !== null) {
            this.props.setContext(context);
        }
    }

    /**
     * @param {string} context_id
     * @param {FeaturesID} feature_id
     */
    onFeatureClick = (context_id, feature_id) => {
        const { user } = /** @type {ReactContextType} */ (this.context);

        // Check if feature is already active
        if (feature_id === this.state.active.feature_id &&
            context_id === this.state.active.context_id) {
            return;
        }

        const context = user.Contexts.find(f => f.id === context_id);

        // Check if context & feature exists in this context
        if (!context)
            throw new Error('Context not found');
        if (!context.features.includes(feature_id))
            throw new Error('Feature not found');

        // Check if feature exists
        const feature = AllFeatures.find(f => f.id === feature_id);
        if (!feature)
            throw new Error('Feature not found');

        // Set active feature
        this.setState({
            active: {
                feature_id: feature.id,
                context_id: context.id
            }
        });

        // Set content
        this.props.setContent(feature.component(context, feature));
    }

    render() {
        const { context } = this.props;
        const { active, is_navpanel_switch } = this.state;
        const styleSwitch = is_navpanel_switch ? ' switch' : '';

        return (
            <nav id='navbar' className='navbar'>
                {/* Header - Logo & text */}
                <div className='navbar-header'>
                    <a href='/' className='navbar-brand'>
                        <img src='./logo_deveye.png' alt='Logo' />
                        <span>DevEye</span>
                    </a>
                    <div className='version'>
                        <span>{version}</span>
                    </div>
                </div>

                {/* Navpanel */}
                <div className={'navpanel' + styleSwitch}>
                    <div className='navpanel-content'>
                        <NavFeatures
                            context={context}
                            active={active}
                            onFeatureClick={this.onFeatureClick}
                            onProfileClick={this.onProfileClick}
                        />
                    </div>
                    <div className='navpanel-content'>
                        <NavContexts
                            onContextClick={this.onContextClick}
                        />
                    </div>
                </div>
            </nav>
        );
    }
}

Navbar.defaultProps = NavbarProps;
Navbar.prototype.props = NavbarProps;

export default Navbar;