import styles from './style.module.css';

import { ws, WsError } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { FEATURE_BY_ID, FEATURES } from '@/Features/Features';
import { Button, Card, Header, Popup, Row } from '../../Components';
import { ClosePopup, OpenPopup } from '../../Components/Popup';

import type { FeatureProps } from '@/Features/types';

function FeatureDashboard({ user, workspace, feature, setWorkspace, setFeature }: FeatureProps) {
    const { workspaces, setWorkspaces } = useAuth();

    const OpenDeleteWorkspacePopup = () => OpenPopup('popup-delete-workspace');
    const CloseDeleteWorkspacePopup = () => ClosePopup('popup-delete-workspace');

    const DeleteWorkspace = async () => {
        try {
            await ws.send('workspace.delete', { workspaceId: workspace.id });
        } catch (e) {
            if (!(e instanceof WsError)) throw e;
            return;
        }
        const remaining = workspaces.filter((w) => w.id !== workspace.id);
        setWorkspaces(() => remaining);

        const next = remaining.find((w) => w.id === 0) ?? remaining[0];
        if (next) {
            setWorkspace(next);
            const nextFeatureId = next.features[0];
            const nextFeature = (nextFeatureId && FEATURE_BY_ID[nextFeatureId]) || FEATURES[0];
            if (nextFeature) setFeature(nextFeature);
        }
        CloseDeleteWorkspacePopup();
    };

    return (
        <div className='profile'>
            <Header user={user} workspace={workspace} feature={feature} />

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
                            <Button className={styles['profile-info-button']} onClick={() => OpenPopup('in-dev')}>
                                Activer
                            </Button>
                            <i className={styles['icon-error']} />
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
