<?php

    // Table: Users

    class User
    {
        /** @var int $ID */
        public $ID;

        /** @var string $Email */
        public $Email;

        /** @var string $Username */
        public $Username;

        /** @var string $Password */
        public $Password;

        /** @var string $Avatar */
        public $Avatar;

        /** @var array $Settings */
        public $Settings;

        /** @var int $Security */
        public $Security;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $user Contains all user information
         * @throws Exception If the user contains incorrect data
         */
        public function __construct($user) {
            if ($user === null || !$this->isValid($user)) {
                throw(new Exception('Invalid user'));
            }
            $this->ID = intval($user['ID']);
            $this->Email = $user['Email'];
            $this->Username = $user['Username'];
            $this->Password = $user['Password'];
            $this->Avatar = $user['Avatar'];
            $this->Settings = json_decode($user['Settings'], true);
            $this->Security = intval($user['Security']);
            $this->Created = strtotime($user['Created']);
        }

        /**
         * @param array $user Contains all user information
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function Load($user) {
            try { return new User($user); }
            catch (Exception $e) { return null; }
        }

        /**
         * Get user from the database using the username and password
         * Check if the user exists and if the password is correct
         * @param DataBase $db The database connection
         * @param string $username The user's username
         * @param string $password The user's password
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function LoadFromDB($db, $username, $password) {
            // Get the user
            $result = $db->QueryPrepare('Users', 'SELECT * FROM TABLE WHERE `Username` = ?', 's', [ $username ]);
            if ($result === false || count($result) === 0) {
                return null;
            }

            $rawUser = $result[0];
            $user = User::Load($rawUser);

            // Check if the user exists and loaded correctly
            if ($user === null) {
                return null;
            }

            // Check if the password is correct
            if (!password_verify($password, $user->Password)) {
                return null;
            }

            // Set the encryption keys
            if ($user->Security === 1) {
                $db->encryption->DefineSecondKey($password);
            }

            return $user;
        }

        /**
         * @param array $arr Contains all user information
         * @return bool True if the user contains correct data, false otherwise
         */
        private function isValid($arr) {
            if (!$arr) return false;
            $vars = array_keys(get_object_vars($this));
            foreach ($vars as $var) {
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }
    }

?>