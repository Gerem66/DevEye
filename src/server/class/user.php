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

        /**
         * Variable used to store the user's salt.
         * This is'nt stored in the database. (define in the constructor)
         * @var string $hashedPassword
         */
        public $hashedPassword;

        /**
         * Variable used to store the user's IP (only for session).
         * This is'nt stored in the database. (define in the constructor)
         * @var string $IP
         */
        public $IP;

        /** @var string $Avatar */
        public $Avatar;

        /** @var array $Settings */
        public $Settings;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $user Contains all user information
         * @param string $hashedPassword The user's hashed password
         * @throws Exception If the user contains incorrect data
         */
        public function __construct($user, $hashedPassword, $IP) {
            if ($user === null || !$this->isValid($user)) {
                throw(new Exception('Invalid user'));
            }
            $this->ID = intval($user['ID']);
            $this->Email = $user['Email'];
            $this->Username = $user['Username'];
            $this->Password = $user['Password'];
            $this->hashedPassword = $hashedPassword;
            $this->IP = $IP;
            $this->Avatar = $user['Avatar'];
            $this->Settings = json_decode($user['Settings'], true);
            $this->Created = strtotime($user['Created']);
        }

        /**
         * @param array $user Contains all user information
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function Load($user, $hashedPassword, $IP) {
            try { return new User($user, $hashedPassword, $IP); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param DataBase $db The database connection
         * @param string $username The user's username
         * @param string $password The user's password
         * @param string $IP The user's IP
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function LoadFromDB($db, $username, $password) {
            $IP = $db->GetClientIP();
            $hashedPassword = $db->encryption->HashPassword($password);

            // Get the user
            $result = $db->QueryPrepare('Users', 'SELECT * FROM TABLE WHERE `Username` = ?', 's', [ $username ]);
            if ($result === false || count($result) === 0) {
                return null;
            }

            $rawUser = $result[0];
            $user = User::Load($rawUser, $hashedPassword, $IP);
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
                // Exception for the hashedPassword variable
                if ($var === 'hashedPassword' || $var === 'IP') continue;
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }
    }

?>