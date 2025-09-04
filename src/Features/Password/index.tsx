import styles from './style.module.css';

import FeaturePasswordBack from './back';
import PasswordRow from './passwordRow';
import LoadingTable from './loadingTable';
import { PasswordPopupAdd } from './popups-add-password';

import { Header, Row, Card, TextInput } from '../../Components';

class FeaturePassword extends FeaturePasswordBack {
    render() {
        const { user, setUser, context, feature } = this.props;
        const { loaded, search, categories } = this.state;

        return (
            <div className={styles.profile}>
                <Header user={user} setUser={setUser} context={context} feature={feature} />

                <Row center>
                    <Card.Element
                        title={`Rechercher (${this.allPasswords.length})`}
                        style={styles['search-container']}
                        color='bg-blue-dark'
                        width={500}
                    >
                        <a className={`link ${styles['add-password']}`} onClick={() => this.OpenEditPassword(null)}>
                            Ajouter un mot de passe
                        </a>
                        <TextInput placeholder="Nom d'un service" value={search} onChange={this.onSearchChange} />
                    </Card.Element>
                </Row>

                {!loaded && (
                    <>
                        <LoadingTable key={'loading-table-password-1'} />
                        <LoadingTable key={'loading-table-password-2'} />
                    </>
                )}

                {loaded &&
                    Object.keys(categories).map((category) => {
                        const passwords = categories[category];
                        if (passwords.length === 0) {
                            return null;
                        }

                        return (
                            <Row key={category} center>
                                <Card.Element
                                    title={`${category} (${passwords.length})`}
                                    width={1000}
                                    color='bg-blue-dark'
                                    style={styles['password-container']}
                                >
                                    <div className={styles['scroll-mode']}>
                                        <table className={`show-lines ${styles['scroll-mode']}`}>
                                            <thead>
                                                <tr>
                                                    <th style={{ width: '20%' }}>Service</th>
                                                    <th>{"Nom d'utilisateur / Email"}</th>
                                                    <th style={{ width: '20%' }}>Mot de passe</th>
                                                    <th style={{ width: '10%' }}>Status</th>
                                                    <th style={{ width: '5%' }}></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {passwords.map((password) => (
                                                    <PasswordRow
                                                        key={password.ID}
                                                        password={password}
                                                        onEdit={this.OpenEditPassword}
                                                        callback={this.GetPassword}
                                                    />
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </Card.Element>
                            </Row>
                        );
                    })}

                <PasswordPopupAdd passwordCategories={Object.keys(categories)} />
            </div>
        );
    }
}

export default FeaturePassword;
