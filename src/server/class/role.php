<?php

    // Table: RolesDef

    class RoleDef {
        /** @var int $ID */
        public $ID;

        /** @var int $ContextID */
        public $ContextID;

        /** @var string $Name */
        public $Name;

        /** @var int $Created */
        public $Created;

        /**
         * Object with keys as feature IDs and values as permissions ('none'|'read'|'read-write')
         * @var array $Permissions
         */
        private $Permissions = array();

        /**
         * @param array $rowRole Contains all context information
         * @throws Exception If the context contains incorrect data
         */
        public function __construct($rowRole) {
            if ($rowRole === null || !$this->isValid($rowRole)) {
                throw(new Exception('Invalid context'));
            }
            $this->ID = intval($rowRole['ID']);
            $this->ContextID = intval($rowRole['ContextID']);
            $this->Name = $rowRole['Name'];
            $this->Created = strtotime($rowRole['Created']);

            foreach ($rowRole as $key => $value) {
                if (str_starts_with($key, 'Feature_')) {
                    $featureID = intval(substr($key, 8));
                    $this->Permissions[$featureID] = $value;
                }
            }
        }

        /**
         * @param int $featureID The feature's ID
         * @return 'none'|'read'|'read-write' Returns the permission if the role has it
         */
        public function GetPermission($featureID) {
            if (array_key_exists($featureID, $this->Permissions)) {
                return $this->Permissions[$featureID];
            }
            return 'none';
        }

        /**
         * @param array $rowRole Contains all context information
         * @return RoleDef|null Returns the context if it contains correct data, null otherwise
         */
        public static function Load($rowRole) {
            try { return new RoleDef($rowRole); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param array $arr Contains all context information
         * @return bool True if the context contains correct data, false otherwise
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