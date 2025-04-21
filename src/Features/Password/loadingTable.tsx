import styles from './style.module.css';
import PasswordRow from './passwordRow';

import { Card, Row } from '../../Components';

function LoadingTable() {
    return (
        <Row key={'category-empy'} center>
            <Card.Element
                title={`Chargement en cours`}
                width={1000}
                color='bg-blue-dark'
                style={styles['password-container-loading']}
            >
                <div className={styles['scroll-mode']}>
                    <table className={`show-lines ${styles['scroll-mode']}`}>
                        <thead>
                            <tr>
                                <th style={{ width: '20%' }}>Service</th>
                                <th>Nom d'utilisateur / Email</th>
                                <th style={{ width: '20%' }}>Mot de passe</th>
                                <th style={{ width: '10%' }}>Status</th>
                                <th style={{ width: '5%' }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            <PasswordRow password={null} />
                            <PasswordRow password={null} />
                            <PasswordRow password={null} />
                        </tbody>
                    </table>
                </div>
            </Card.Element>
        </Row>
    );
}

export default LoadingTable;
