import React from 'react';

import NavFeatures from './content/navFeatures';
import NavProjects from './content/navProjects';

import './style.css';

/**
 * @typedef {import('../../class/feature').FeatureType} FeatureType
 * @typedef {import('../../class/feature').ProjectType} ProjectType
 */

const NavbarProps = {
    /** @type {ProjectType} */
    context: null,

    /** @type {(project: ProjectType) => void} */
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
        console.log('Profile clicked');
        this.setState({ is_navpanel_switch: true });
    }

    /**
     * @param {ProjectType} context
     * @param {FeatureType} feature
     */
    onFeatureClick = (context, feature) => {
        if (feature.id === this.state.active.feature_id &&
            context.id === this.state.active.context_id) {
            return;
        }

        this.setState({ active: { feature_id: feature.id, context_id: context.id } });
        this.props.setContent(feature.component(context));
    }

    /** @param {ProjectType} project */
    onProjectClick = (project) => {
        this.setState({ is_navpanel_switch: false });
        this.props.onProjectClick(project);
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