import './style.css';
import './button.css';
import NavbarBack from './back';

import NavFeatures from './content/navFeatures';
import NavContexts from './content/navContexts';

// @ts-ignore
import packageJson from '../../../package.json';
const version = packageJson.version + (process.env.NODE_ENV === 'development' && '-dev' || '');

class Navbar extends NavbarBack {
    render() {
        const { user, context } = this.props;
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
                            user={user}
                            onContextClick={this.onContextClick}
                        />
                    </div>
                </div>
            </nav>
        );
    }
}

export default Navbar;
