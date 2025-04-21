import styles from './style.module.css';

import { Header, Row, Card, Popup, Button } from '../../Components';
import { OpenPopup, ClosePopup } from '../../Components/Popup';
import { tcp } from '../../Utils/TCP';

type FeatureProps = import('Types/Feature').FeatureProps;

function FeatureDashboard({ user, setUser, context, feature, setContext }: FeatureProps) {
    const OpenDeleteContextPopup = () => {
        OpenPopup('popup-delete-context');
    };
    const CloseDeleteContextPopup = () => {
        ClosePopup('popup-delete-context');
    };

    const DeleteContext = () => {
        tcp.SendAsync('delete-context', { contextID: context.id }).then((result) => {
            if (result === 'timeout' || result === 'not-sended' || result.status !== 0) {
                return;
            }

            setUser({
                ...user,
                Contexts: user.Contexts.filter((c) => c.id !== context.id)
            });
            setContext(user.Contexts[0]);
            CloseDeleteContextPopup();
        });
    };

    return (
        <div className='profile'>
            <Header user={user} setUser={setUser} context={context} feature={feature} />

            <Row>
                <Card.Value title='Nombre total de projets' value='0' color='bg-blue' icon='details' />

                <Card.Value title='Tâches en cours' value='0' color='bg-green' icon='sandbox' />

                <Card.Value title='Mails non lus' value='0' color='bg-yellow' icon='mail' />
            </Row>

            <Row style={{ justifyContent: 'space-evenly' }}>
                <Card.Element color='bg-blue-dark' width={600} title='Contexte'>
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Nom du contexte</h3>
                        <p className={styles['profile-info-text']}>{context.name}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Nombre d'utilisateurs</h3>
                        <p className={styles['profile-info-text']}>{context.users.length}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Chiffrage par mot de passe</h3>
                        <div className={styles['profile-info-content']}>
                            {
                                // TODO: Finish
                                // eslint-disable-next-line no-constant-condition
                                true ? (
                                    <>
                                        <Button
                                            className={styles['profile-info-button']}
                                            onClick={() => OpenPopup('in-dev')}
                                        >
                                            Activer
                                        </Button>
                                        <i className={styles['icon-error']} />
                                    </>
                                ) : (
                                    <>
                                        <Button
                                            className={styles['profile-info-button']}
                                            onClick={() => OpenPopup('in-dev')}
                                        >
                                            Modifier
                                        </Button>
                                        <i className={styles['icon-success']} />
                                    </>
                                )
                            }
                        </div>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Créé le</h3>
                        <p className={styles['profile-info-text']}>
                            {new Date(context.created * 1000).toLocaleDateString()}
                        </p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['context-buttons']}>
                        <Button onClick={OpenDeleteContextPopup} color='#aa3333'>
                            Supprimer le contexte
                        </Button>
                    </div>
                </Card.Element>
            </Row>

            <Popup id='popup-delete-context' title='Supprimer le contexte'>
                <p>
                    Êtes-vous sûr de vouloir supprimer le contexte ? Cette action est irréversible et supprimera
                    définitivement tous les projets, tâches, mots de passes... associés.
                </p>

                <div className={`form-group ${styles['popup-delete-contexte-buttons']}`}>
                    <Button onClick={CloseDeleteContextPopup} color='#576d8c'>
                        Fermer
                    </Button>
                    <Button onClick={DeleteContext} color='#aa3333'>
                        Supprimer
                    </Button>
                </div>
            </Popup>

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

export default FeatureDashboard;
