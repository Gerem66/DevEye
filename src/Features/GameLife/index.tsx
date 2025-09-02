import { useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import { Header, Row, Card, Popup, Button } from '@/Components';
import { OpenPopup } from '@/Components/Popup';
import { tcp } from '@/Utils/TCP';

import type { FeatureProps, TCPRequestReceiveHeader } from 'deveye-types';

function FeatureGameLife({ user, setUser, context, feature }: FeatureProps) {
    const [intervalID, setIntervalID] = useState('');
    const intervalRef = useRef(intervalID);

    // Main variable
    const [userTotalCount, setUserTotalCount] = useState(0);

    useEffect(() => {
        // Send the request to start the loop
        tcp.SendAndWait('gamelife-set-loop', { contextID: context.id, type: 'open' }).then((data) => {
            console.log(data);

            // Check if the request was sent correctly
            if (data === 'timeout' || data === 'not-sended' || data.status !== 0) {
                console.error('Error when sending the request');
                return;
            }

            // Loop accepted by the server, save the intervalID for callback
            const intervalID = data.intervalID;
            setIntervalID(intervalID);
            intervalRef.current = intervalID;

            // Manually define the callback for this intervalID to update the userTotalCount
            tcp.callbacks[intervalID] = (data: TCPRequestReceiveHeader<'gamelife-data'>) => {
                setUserTotalCount(data.content.totalUserCount);
                return false;
            };
        });

        // Clear the interval when the component is unmounted
        return () => {
            const id = intervalRef.current;
            console.log('End interval', id);
            tcp.Send('gamelife-set-loop', { contextID: context.id, type: 'close', intervalID: id });
            delete tcp.callbacks[id];
        };
    }, [context.id]);

    return (
        <div className='profile'>
            <Header user={user} setUser={setUser} context={context} feature={feature} />

            <Row>
                <Card.Value
                    title='Nombre total de joueurs'
                    value={userTotalCount.toString()}
                    color='bg-blue'
                    icon='details'
                />

                <Card.Value title='Moulaga mensuelle' value='9999999 €' color='bg-green' icon='mail' />

                <Card.Value title='Taille de la bdd' value='10 Mo' color='bg-yellow' icon='sandbox' />
            </Row>

            <Row style={{ justifyContent: 'space-evenly' }}>
                <Card.Element title={`Prod - ${context.name}`} color='bg-blue-dark' width={600}>
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>
                            {"Nombre d'utilisateurs [Live] (vraie valeur (normalement))"}
                        </h3>
                        <p className={styles['profile-info-text']}>{userTotalCount}</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Nombre de nouveaux utilisateurs</h3>
                        <p className={styles['profile-info-text']}>-256</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Nombre random</h3>
                        <p className={styles['profile-info-text']}>123456</p>
                    </div>

                    <div className={styles.separator} />
                    <div className={styles['profile-info']}>
                        <h3 className={styles['profile-info-title']}>Depuis le</h3>
                        <p className={styles['profile-info-text']}>
                            {new Date(context.created * 1000).toLocaleDateString()}
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
