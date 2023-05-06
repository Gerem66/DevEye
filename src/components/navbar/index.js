import React from 'react';

import NavFeatures from './content/navFeatures';
import NavProjects from './content/navProjects';

import './style.css';

/**
 * @typedef {import('../../class/project').Feature} Feature
 */

class Navbar extends React.Component {
    state = {
        /** @type {string|null} */
        active_feature_id: null,

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    onProfileClick = () => {
        console.log('Profile clicked');
        this.setState({ is_navpanel_switch: true });
    }

    /** @param {Feature} feature */
    onFeatureClick = (feature) => {
        if (feature.id === this.state.active_feature_id) {
            return;
        }

        this.setState({ active_feature_id: feature.id });
    }

    onProjectClick = () => {
        // TODO
        this.setState({ is_navpanel_switch: false });
    }

    render() {
        const { active_feature_id, is_navpanel_switch } = this.state;
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

                <div className={'navpanel' + styleSwitch}>
                    <div className='navpanel-content'>
                        <NavFeatures
                            active_feature_id={active_feature_id}
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

export default Navbar;