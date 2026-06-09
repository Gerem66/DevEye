import styles from './style.module.css';

import { Button, Card, Header, Popup, Row } from '@/Components';
import { OpenPopup } from '@/Components/Popup';

import type { FeatureProps } from '@/Features/types';

function FeatureGameLife({ user, workspace, feature }: FeatureProps) {
    const userTotalCount = 0;

    return (
        <div className='profile'>
            <Header user={user} workspace={workspace} feature={feature} />

            <Row>
                <Card.Value
                    title='Nombre total de joueurs'
                    value={userTotalCount.toString()}
                    color='bg-blue'
                    icon='details'
                />

                <Card.Value title='Moulaga mensuelle' value='—' color='bg-green' icon='mail' />

                <Card.Value title='Taille de la bdd' value='—' color='bg-yellow' icon='sandbox' />
            </Row>

            <Row style={{ justifyContent: 'space-evenly' }}>
                <Card.Element title={`Prod - ${workspace.name}`} color='bg-blue-dark' width={600}>
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>{"Nombre d'utilisateurs (live)"}</h3>
                        <p className={styles['profile-info-text']}>{userTotalCount}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Depuis le</h3>
                        <p className={styles['profile-info-text']}>
                            {new Date(workspace.created * 1000).toLocaleDateString()}
                        </p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Actualiser</h3>
                        <div className={styles['profile-info-content']}>
                            <Button className={styles['profile-info-button']} onClick={() => OpenPopup('in-dev')}>
                                Refresh
                            </Button>
                        </div>
                    </div>
                </Card.Element>

                <Card.Element title='Graphiques' color='bg-blue-dark' width={600}>
                    <div className={styles.separator} />
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

export default FeatureGameLife;
