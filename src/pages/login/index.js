import React, { useEffect } from 'react';

import auth from '../../class/auth';

import './style.css';
import './input.css'

function LoginPage({ show }) {
    useEffect(() => {
        auth.onMount();
        return auth.onUnmount;
    });

    return (
        <div className={'login' + (show ? '' : ' login-to-home')}>
            <div className='form'>

                {/* Title */}
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div id='login-card' className='login-card'>
                    {/* Progress bar */}
                    <div className='progress-bar' />

                    {/* Username input */}
                    <div className='input-group'>
                        <input
                            id='tb-username'
                            className='form-input'
                            type='text'
                            placeholder="Nom d'utilisateur"
                            autoFocus
                        />
                        <span className='icon icon-user'></span>
                    </div>

                    {/* Password input */}
                    <div className='input-group'>
                        <input
                            id='tb-password'
                            className='form-input'
                            type='password'
                            placeholder='Mot de passe'
                        />
                        <span className='icon icon-lock' />
                    </div>

                    {/* Submit button */}
                    <button
                        className='submit'
                        onClick={auth.Login}
                    >
                        Se connecter
                    </button>
                </div>
            </div>

        </div>
    );
}

export default LoginPage;