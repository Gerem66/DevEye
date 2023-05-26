import React from 'react';

import './style.css';
import user from '../../class/user';
import Features from '../../class/feature';
import NavFeatures from './content/navFeatures';
import NavProjects from './content/navProjects';


/**
 * @typedef {import('../../class/feature').FeaturesID} FeaturesID
 * @typedef {import('../../class/feature').FeatureType} FeatureType
 * @typedef {import('../../class/feature').ProjectContext} ProjectContext
 */

const NavbarProps = {
    /** @type {ProjectContext} */
    context: null,

    /** @type {(project: ProjectContext) => void} */
    onProjectClick: (project) => {},

    /** @type {(content: JSX.Element|null) => void} */
    setContent: (content) => {}
};

class Navbar extends React.Component {
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

    onProfileClick = () => {
        this.setState({ is_navpanel_switch: true });
    }

    /**
     * @param {string} context_id
     * @param {FeaturesID} feature_id
     */
    onFeatureClick = (context_id, feature_id) => {
        // Check if feature is already active
        if (feature_id === this.state.active.feature_id &&
            context_id === this.state.active.context_id) {
            return;
        }

        const context = user.projects.find(f => f.id === context_id);

        // Check if context & feature exists in this context
        if (!context)
            throw new Error('Context not found');
        if (!context.features.includes(feature_id))
            throw new Error('Feature not found');

        // Check if feature exists
        const feature = Features.find(f => f.id === feature_id);
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
        this.props.setContent(feature.component(context));
    }

    /** @param {ProjectContext|null} project */
    onProjectClick = (project = null) => {
        this.setState({ is_navpanel_switch: false });

        if (project !== null) {
            this.props.onProjectClick(project);
        }
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
                    <span className='icon icon-menu-left' />
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
                        <NavProjects
                            onProjectClick={this.onProjectClick}
                        />
                    </div>
                </div>
            </nav>
        );
    }
}

Navbar.prototype.props = NavbarProps;
Navbar.defaultProps = NavbarProps;

export default Navbar;