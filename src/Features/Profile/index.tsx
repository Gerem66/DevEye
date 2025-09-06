import styles from './style.module.css';

import { Header, Row, Card, Popup, Button } from '../../Components';
import { ChangeImage, EditPassword } from './actions';

import type { FeatureProps } from 'deveye-types';

function FeatureProfile({ user, setUser, workspace, feature }: FeatureProps) {
    const convertDate = (time: number): string =>
        new Date(time * 1000)
            .toLocaleDateString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            })
            .split(' ')
            .map((word) => (word.length <= 1 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
            .join(' ');

    const dateCreated = convertDate(user.Created);
    const dateLastLogin = user.LastLogin ? convertDate(user.LastLogin) : 'Première connexion';

    return (
        <div className='profile'>
            <Header user={user} setUser={setUser} workspace={workspace} feature={feature} />

            <Row center>
                <Card.Element width={450} color='bg-blue-dark'>
                    <div className={styles['profile-header']}>
                        <div className={styles['profile-avatar']} onClick={ChangeImage}>
                            <img
                                className={styles['profile-avatar-logo']}
                                src={'./images/' + workspace.logo}
                                alt={workspace.name}
                            />
                        </div>
                        <h2 className={`${styles.title} ${styles['profile-avatar-name']}`}>{workspace.name}</h2>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Adresse e-mail</h3>
                        <p className={styles['profile-info-text']}>{user.Email}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>{"Nombre d'entreprises"}</h3>
                        <p className={styles['profile-info-text']}>{user.Workspaces.length - 1}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Double authentification</h3>
                        <div className={styles['profile-info-content']}>
                            <p className={styles['profile-info-text']}>[Désactivée]</p>
                            <i className={styles['icon-error']} />
                            {/*<i className={styles['icon-success']} />*/}
                        </div>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Chiffrage par mot de passe</h3>
                        <div className={styles['profile-info-content']}>
                            <p className={styles['profile-info-text']}>[Désactivée]</p>
                            <i className={styles['icon-error']} />
                            {/*<i className={styles['icon-success']} />*/}
                        </div>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Mot de passe</h3>
                        <div className={styles['profile-info-content']}>
                            <Button className={styles['btn-edit']} onClick={EditPassword}>
                                Modifier le mot de passe
                            </Button>
                        </div>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Dernière connexion</h3>
                        <p className={styles['profile-info-text']}>{dateLastLogin}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Créé le</h3>
                        <p className={styles['profile-info-text']}>{dateCreated}</p>
                    </div>

                    <div className={styles.separator} />
                    <Button className={styles['btn-disconnect']} onClick={() => setUser(null)} color='#aa3333'>
                        Se déconnecter
                    </Button>
                </Card.Element>
            </Row>

            <Popup id='in-dev' title='En développement'>
                <p>
                    Cette fonctionnalité est en cours de développement.
                    <br />
                    Elle sera bientôt disponible.
                </p>
            </Popup>
        </div>
    );
}

export default FeatureProfile;
