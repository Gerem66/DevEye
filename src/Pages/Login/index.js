import './style.css';
import './input.css';
import LoginPageBack from './back';

class LoginPage extends LoginPageBack {
    render() {
        return (
            <div className={'login' + (this.state.show ? '' : ' hide')}>
                <div className='form'>

                    {/* Title */}
                    <span className='title'>
                        <b>Dev</b> <p>Eye</p>
                    </span>

                    <div
                        ref={this.cardLogin}
                        className='login-card'
                        onKeyDown={this.onKeyDown}
                    >
                        {/* Progress bar */}
                        <div className='progress-bar' />

                        {/* Username input */}
                        <div className='input-group'>
                            <input
                                ref={this.inputUsername}
                                className='form-input'
                                type='text'
                                placeholder="Nom d'utilisateur"
                                value={this.state.input.username}
                                onChange={this.onInputUsernameChange}
                                autoFocus
                            />
                            <span className='icon icon-user'></span>
                        </div>

                        {/* Password input */}
                        <div className='input-group'>
                            <input
                                ref={this.inputPassword}
                                className='form-input'
                                type='password'
                                placeholder='Mot de passe'
                                value={this.state.input.password}
                                onChange={this.onInputPasswordChange}
                            />
                            <span className='icon icon-lock' />
                        </div>

                        {/* Submit button */}
                        <button
                            className='submit'
                            onClick={this.onLogin}
                        >
                            Se connecter
                        </button>
                    </div>
                </div>

            </div>
        );
    }
}

export default LoginPage;
