import React from 'react';

import { Sleep } from '../../utils';

import './style.css';
import './input.css'

function LoginPage() {
    const onLoginClick = (e) => {
        const div_login = document.getElementById('login');
        const card_login = document.getElementById('login-card');
        const input_username = /** @type {HTMLInputElement} */ (document.getElementById('tb-username'));
        const input_password = /** @type {HTMLInputElement} */ (document.getElementById('tb-password'));

        const username = input_username.value
        const password = input_password.value;

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
            body: JSON.stringify({ username, password })
        };

        fetch(url, data)
        .then(response => response.json())
        .then(async (data) => {
            // Await for progress bar to finish
            const end = Date.now();
            const elapsed = end - start;
            if (elapsed < 2000) {
                await Sleep(2000 - elapsed);
            }

            // Check response
            if (data['status'] !== 'success') {
                //console.error(data['message']);
                card_login.classList.remove('card-to-progressbar');
                return;
            }

            div_login.style.opacity = '0';
        })
        .catch(error => {
            //console.error(error);
            card_login.classList.remove('card-to-progressbar');
        });
    };

    return (
        <div id='login' className='login'>
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