import React, { useEffect } from 'react';

import { Sleep } from '../../utils';

import './style.css';
import './input.css'

function LoginPage({ show, setShowLogin, setLogged }) {
    useEffect(() => {
        // Login on press enter
        const onKeyPress = (e) => {
            e.key === 'Enter' && onLoginClick(e);
        };
        document.addEventListener('keypress', onKeyPress);
        return () => {
            document.removeEventListener('keypress', onKeyPress);
        };
    });

    const onLoginClick = (e) => {
        const card_login = document.getElementById('login-card');
        const input_username = /** @type {HTMLInputElement} */ (document.getElementById('tb-username'));
        const input_password = /** @type {HTMLInputElement} */ (document.getElementById('tb-password'));

        const username = input_username.value;
        const password = input_password.value;

        // Check inputs
        if (username === '') {
            input_username.focus();
            return;
        }
        else if (password === '') {
            input_password.focus();
            return;
        }

        // Get start time & start progress bar
        const start = Date.now();
        card_login.classList.add('card-to-progressbar');

        // Login request
        const url = 'https://wyrmo.com/DevEyeReact/auth.php';
        const data = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password
            })
        };

        fetch(url, data)
        .then(response => response.json())
        .then(async (data) => {
            // Load home page without pause
            if (data['status'] === 'success') {
                setLogged(true);
            }

            // Await for progress bar to finish
            const end = Date.now();
            const elapsed = end - start;
            if (elapsed < 2000) {
                await Sleep(2000 - elapsed);
            }

            if (data['status'] === 'success') {
                input_username.value = '';
                setShowLogin(false);
                await Sleep(500);
            }

            // Reset login card
            input_password.value = '';
            input_password.focus();
            card_login.classList.remove('card-to-progressbar');

            // Error message ?
            //if (data['status'] !== 'success') {
            //    //console.error(data['message']);
            //    return;
            //}
        })
        .catch(error => {
            //console.error(error);
            card_login.classList.remove('card-to-progressbar');
        });
    };

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
                        onClick={onLoginClick}
                    >
                        Se connecter
                    </button>
                </div>
            </div>

        </div>
    );
}

export default LoginPage;