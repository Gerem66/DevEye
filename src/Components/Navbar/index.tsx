import styles from './style.module.css';

import NavbarBack from './back';
import NavFeatures from './sections/navFeatures';
import NavContexts from './sections/navContexts';

import packageJson from '../../../package.json';
const version = packageJson.version + ((process.env.NODE_ENV === 'development' && '-dev') || '');

class Navbar extends NavbarBack {
    render() {
        const { user, context } = this.props;
        const { active, is_navpanel_switch } = this.state;

        return (
            <nav id='navbar' className={`${styles.navbar} ${user === null ? '' : styles.open}`}>
                {/* Header - Logo & text */}
                <div className={styles['navbar-header']}>
                    <a href='/' className={styles['navbar-brand']}>
                        <img className={styles['navbar-brand-img']} src='./logo_deveye.png' alt='Logo' />
                        <span>DevEye</span>
                    </a>
                    <div className={styles.version}>
                        <span>{version}</span>
                    </div>
                </div>

                {/* Navpanel */}
                <div className={`${styles.navpanel} ${is_navpanel_switch ? styles.switch : ''}`}>
                    <div className={styles['navpanel-content']}>
                        <NavFeatures
                            context={context}
                            active={active}
                            onFeatureClick={this.onFeatureClick}
                            onProfileClick={this.onProfileClick}
                        />
                    </div>
                    <div className={styles['navpanel-content']}>
                        <NavContexts user={user} onContextClick={this.onContextClick} />
                    </div>
                </div>
            </nav>
        );
    }
}

export default Navbar;
