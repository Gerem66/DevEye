import styles from './style.module.css';

import { Header, Row, Card, Popup, Button } from '../../Components';
import { OpenPopup, ClosePopup } from '../../Components/Popup';
import { tcp } from '../../Utils/TCP';

import type { FeatureProps } from 'deveye-types/Feature';

function FeatureDashboard({ user, setUser, workspace, feature, setWorkspace }: FeatureProps) {
    const OpenDeleteWorkspacePopup = () => {
        OpenPopup('popup-delete-workspace');
    };
    const CloseDeleteWorkspacePopup = () => {
        ClosePopup('popup-delete-workspace');
    };

    const DeleteWorkspace = () => {
        tcp.SendAndWait('delete-workspace', { workspaceID: workspace.id }).then((result) => {
            if (result === 'timeout' || result === 'not-sended' || result.status !== 'success') {
                return;
            }

            setUser({
                ...user,
                Workspaces: user.Workspaces.filter((c) => c.id !== workspace.id)
            });
            setWorkspace(user.Workspaces[0]);
            CloseDeleteWorkspacePopup();
        });
    };

    return (
        <div className='profile'>
            <Header user={user} setUser={setUser} workspace={workspace} feature={feature} />

            <Row>
                <Card.Value title='Nombre total de projets' value='0' color='bg-blue' icon='details' />

                <Card.Value title='Tâches en cours' value='0' color='bg-green' icon='sandbox' />

                <Card.Value title='Mails non lus' value='0' color='bg-yellow' icon='mail' />
            </Row>

            <Row style={{ justifyContent: 'space-evenly' }}>
                <Card.Element color='bg-blue-dark' width={600} title='Workspace'>
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Nom du workspace</h3>
                        <p className={styles['profile-info-text']}>{workspace.name}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>{"Nombre d'utilisateurs"}</h3>
                        <p className={styles['profile-info-text']}>{workspace.users.length}</p>
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
                            {new Date(workspace.created * 1000).toLocaleDateString()}
                        </p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['workspace-buttons']}>
                        <Button onClick={OpenDeleteWorkspacePopup} color='#aa3333'>
                            Supprimer le workspace
                        </Button>
                    </div>
                </Card.Element>
            </Row>

            <Popup id='popup-delete-workspace' title='Supprimer le workspace'>
                <p>
                    Êtes-vous sûr de vouloir supprimer le workspace ? Cette action est irréversible et supprimera
                    définitivement tous les projets, tâches, mots de passes... associés.
                </p>

                <div className={`form-group ${styles['popup-delete-workspace-buttons']}`}>
                    <Button onClick={CloseDeleteWorkspacePopup} color='#576d8c'>
                        Fermer
                    </Button>
                    <Button onClick={DeleteWorkspace} color='#aa3333'>
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
