import { RequestCommands } from 'deveye-types';
import { IFeature } from '@/Interfaces/IFeature';

// Authentification
import { Login } from '@/Features/Auth/login';

// Workspaces
import { AddWorkspace } from '@/Features/Workspaces/add-workspace';
import { DeleteWorkspace } from '@/Features/Workspaces/delete-workspace';
import { SetFavoriteWorkspace } from '@/Features/Workspaces/set-favorite-workspace';

// Passwords
import { AddPassword } from '@/Features/PasswordManager/add-password';
import { EditPassword } from '@/Features/PasswordManager/edit-password';
import { DeletePassword } from '@/Features/PasswordManager/delete-password';
import { GetPassword } from '@/Features/PasswordManager/get-password';
import { GetPasswords } from '@/Features/PasswordManager/get-passwords';
import { CheckPassword } from '@/Features/PasswordManager/check-password';

// GameLife
import { GetGameLifeData } from '@/Features/GameLife/gamelife-set-loop';

type FeaturesType = {
    [K in keyof RequestCommands]: IFeature<K>;
};

export const FeatureRegistry: FeaturesType = {
    // Authentification
    login: Login,

    // Workspaces
    'add-workspace': AddWorkspace,
    'delete-workspace': DeleteWorkspace,
    'set-favorite-workspace': SetFavoriteWorkspace,

    // Passwords
    'add-password': AddPassword,
    'edit-password': EditPassword,
    'delete-password': DeletePassword,
    'get-password': GetPassword,
    'get-passwords': GetPasswords,
    'check-password': CheckPassword,

    // GameLife
    'gamelife-set-loop': GetGameLifeData
};
