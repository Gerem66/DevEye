import styles from './style.module.css';

import FeaturePasswordBack from './back';
import PasswordRow from './passwordRow';
import LoadingTable from './loadingTable';
import { PasswordPopupAdd } from './popups';

import { OpenPopup } from '../../Components/Popup';
import { Header, Row, Card, Popup, Button, TextInput } from '../../Components';

class FeaturePassword extends FeaturePasswordBack {
    render() {
        const { context, feature } = this.props;
        const { search, categories } = this.state;

        return (
            <div className={styles.profile}>
                <Header
                    context={context}
                    feature={feature}
                />

                <Row style='center'>
                    <Card.Element title={`Rechercher (${this.allPasswords.length})`} style={styles['search-container']} color='blue-dark' size='1/3'>
                        <a className={`link ${styles['add-password']}`} onClick={() => OpenPopup('popup-add-password')}>
                            Ajouter un mot de passe
                        </a>
                        <TextInput
                            placeholder="Nom d'un service"
                            value={search}
                            onChange={this.onSearchChange}
                        />
                    </Card.Element>
                </Row>

                {Object.keys(categories).length === 0 && (
                    <>
                        <LoadingTable key={'loading-table-password-1'} />
                        <LoadingTable key={'loading-table-password-2'} />
                    </>
                )}

                {Object.keys(categories).map((category) => {
                    const passwords = categories[category];
                    if (passwords.length === 0) {
                        return null;
                    }

                    return (
                        <Row key={category} style='center'>
                            <Card.Element
                                title={`${category} (${passwords.length})`}
                                size='2/3'
                                color='blue-dark'
                                style={styles['password-container']}
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

                <Popup id='popup-unlock' title='Déverrouiller' onClosePopup={this.CloseUnlockPopup}>
                    <p>
                        Pour accéder à vos mots de passe, veuillez entrer votre mot de passe principal.
                    </p>
    
                    <div className="form-group">
                        <TextInput
                            ref={this.refInputUnlock}
                            type="password"
                            placeholder="Mot de passe principal"
                            value={this.state.inputPassword}
                            error={this.state.errorPassword}
                            onChange={this.onInputPasswordChange}
                            onKeyDown={this.onInputPasswordKeyDown}
                            enableShowHideButton
                        />
                    </div>

                    <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                        <Button onClick={this.CloseUnlockPopup} color='#576d8c'>Fermer</Button>
                        <Button onClick={this.UnlockPassword}>Déverrouiller</Button>
                    </div>
                </Popup>

                <PasswordPopupAdd passwordCategories={Object.keys(categories)} />
            </div>
        );
    }
}

export default FeaturePassword;
