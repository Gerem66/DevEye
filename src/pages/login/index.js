import React from 'react';

import './style.css';
import './input.css'

function LoginPage() {
    return (
        <div id="login-content" className="login">
            <div id="login-form" className="form">
                <span id="title" className="title">
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div className="login-card">
                    <div className="input-group">
                        <input
                            id="tb-username"
                            className="form-input"
                            type="text"
                            placeholder="Nom d'utilisateur"
                            autoFocus
                        />
                        <span className="icon icon-user"></span>
                    </div>

                    <div className="input-group">
                        <input
                            id="tb-password"
                            className="form-input"
                            type="password"
                            placeholder="Mot de passe"
                        />
                        <span className="icon icon-lock" />
                    </div>
                    <button id="bt-connect" className="submit">Se connecter</button>
                </div>
            </div>

            {/*
            <div id="loading" className="loading form-hide">
                <div className="loading-text">
                    <p id="loading-text"></p>
                    <p id="loading-value"></p>
                </div>
                <div className="loading-bar">
                    <div id="loading-bar" className="loading-bar-fill"></div>
                </div>
            </div>
            */}

        </div>
    );
}

export default LoginPage;