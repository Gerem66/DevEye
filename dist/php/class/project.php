<?php

    class Project {
        /** @var int $ID */
        public $ID;

        /** @var int $UserID */
        public $UserID;

        /** @var int $InstanceID */
        public $InstanceID;

        /** @var string $Name */
        public $Name;

        /** @var string $Description */
        public $Description;

        /** @var object $Links */
        public $Links;

        /** @var string $Type */
        public $Type;

        /** @var string $Status */
        public $Status;

        /** @var int $Progress */
        public $Progress;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $project Contains all project information
         * @throws Exception If the project contains incorrect data
         */
        public function __construct($project) {
            if ($project === null || !$this->isValid($project)) {
                throw(new Exception('Invalid project'));
            }
            $this->ID = intval($project['ID']);
            $this->UserID = intval($project['UserID']);
            $this->InstanceID = intval($project['InstanceID']);
            $this->Name = $project['Name'];
            $this->Description = $project['Description'];
            $this->Links = json_decode($project['Links'], true);
            $this->Type = $project['Type'];
            $this->Status = $project['Status'];
            $this->Progress = intval($project['Progress']);
            $this->Created = strtotime($project['Created']);
        }

        /**
         * @param array $project Contains all project information
         * @return Project|null Returns the project if it contains correct data, null otherwise
         */
        public static function Load($project) {
            try {
                $project = new Project($project);
                return $project;
            } catch (Exception $e) {
                return null;
            }
        }

        /**
         * @param array $arr Contains all project information
         * @return bool True if the project contains correct data, false otherwise
         */
        private function isValid($arr) {
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