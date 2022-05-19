<?php

    require_once(__DIR__.'/config.php');

    class DataBase {
        /**
         * @var mysqli $conn
         */
        private $conn;
        private $key;
        private $db_hostname;
        private $db_name;
        private $db_username;
        private $db_password;

        public function __construct($openConnection = true, $credentials = null) {
            $this->conn = null;
            if ($openConnection) {
                $this->OpenConnection($credentials);
            }
        }

        public function __destruct() {
            if ($this->conn != null) {
                $this->conn->close();
            }
        }

        /**
         * @param array|null $credentials Array containing the following keys:\
         * hostname, name, username, password\
         * or null to use the default credentials.
         * @return void
         * @throws Exception if the credentials are invalid.
         * @throws Exception if the connection fails.
         */
        public function OpenConnection($credentials = null) {
            if ($credentials !== null && count($credentials) !== 4) {
                throw(new Exception('Wrong database credentials'));
            }

            if ($credentials == null) {
                list(
                    $this->key,
                    $this->db_hostname,
                    $this->db_name,
                    $this->db_username,
                    $this->db_password
                ) = GetCredentials();
            } else {
                $this->db_hostname = $credentials[0];
                $this->db_name = $credentials[1];
                $this->db_username = $credentials[2];
                $this->db_password = $credentials[3];
            }

            $this->conn = new mysqli($this->db_hostname, $this->db_username, $this->db_password, $this->db_name);
            if ($this->conn->connect_error) {
                throw(new Exception('Connection failed: ' . $this->conn->connect_error));
            }
        }

        /**
         * @param string $command The query command to execute.
         * @throws Exception if the connection is not open.
         */
        public function Query($command) {
            if ($this->conn == null) {
                throw(new Exception('Connection not opened'));
            }
            return $this->conn->query($command);
        }

        /** Return last sql error */
        public function GetLastError() {
            return $this->conn->error;
        }

        /**
         * @param string $query The query to execute.
         * @return array|null Returns the result of the query, or null if the query failed.
         */
        public function QueryArray($command) {
            $output = null;
            $query = $this->Query($command);
            if ($query !== false) {
                $output = array();
                while ($row = $query->fetch_assoc()) {
                    array_push($output, $row);
                }
            }
            return $output;
        }

        public function GetTables() {
            $tables = $this->QueryArray("SHOW TABLES");
            if ($tables === null) return null;
            $tableMap = fn($table) => $table["Tables_in_{$this->db_name}"];
            return array_map($tableMap, $tables);
        }

        /**
         * @param string $str
         * @return string Encrypted string with sql key.
         */
        public function Encrypt($str) {
            $output = "";
            if ($str) {
                $output = openssl_encrypt($str, 'AES-128-ECB', $this->key);
            }
            return $output;
        }

        /**
         * @param string $str
         * @return string Decrypted string with sql key.
         */
        public function Decrypt($str) {
            $output = "";
            if ($str) {
                $output = openssl_decrypt($str, 'AES-128-ECB', $this->key);
            }
            return $output;
        }

        /**
         * @param string $table
         * @param string $cellSearch
         * @param string $cellValue
         * @return array
         */
        public function GetRowContent($table, $cellSearch, $cellValue) {
            $result = $this->Query("SELECT * FROM `{$this->db_name}`.`$table` WHERE `$cellSearch` = '$cellValue'")->fetch_assoc();
            if ($result === false) {
                return null;
            }
            return $result;
        }

        /**
         * @param string $table
         * @param string $cellSearch
         * @param string $cellValue
         * @return array Array of rows
         */
        public function GetRowsContent($table, $cellSearch, $cellValue) {
            $rows = array();
            $result = $this->Query("SELECT * FROM `{$this->db_name}`.`$table` WHERE `$cellSearch` = '$cellValue'");
            if ($result === false) {
                return null;
            }
            while ($row = $result->fetch_row()) {
                array_push($rows, $row);
            }
            return $rows;
        }

        /**
         * @param string $table
         * @param string $cell
         * @param string $id
         * @param bool $decrpyt
         * @return array Array of rows
         * @throws Exception If the query fails
         * @throws Exception If the cell is not found
         */
        public function GetCellContent($table, $cell, $id, $decrpyt = true) {
            $content = '';
            $result = $this->Query("SELECT `$cell` FROM `{$this->db_name}`.`$table` WHERE ID = '$id'")->fetch_assoc();
            if ($result === false) {
                throw(new Exception('No row found'));
            }
            if (!array_key_exists($cell, $result)) {
                throw(new Exception("Cell \"$cell\" found"));
            }
            $content = $result[$cell];
            if ($decrpyt) {
                $content = $this->Decrypt($content);
            }
            return $content;
        }

        /**
         * @param string $table
         * @param string $cell
         * @param string $id
         * @param string $content
         * @param bool $encrpyt
         * @return void Array of rows
         * @throws Exception If the query fails
         */
        public function SetCellContent($table, $cell, $id, $content, $encrpyt = true) {
            $command = '';
            if ($encrpyt) {
                $encryptedContent = $this->Encrypt($content);
                $command = "UPDATE `$table` SET `$cell` = '$encryptedContent' WHERE ID = '$id'";
            } else {
                $command = "UPDATE `$table` SET `$cell` = '$content' WHERE ID = '$id'";
            }

            $result = $this->Query($command);
            if ($result === false) {
                throw(new Exception('Query failed'));
            }
        }

        /**
         * @param string $table
         * @param int $cellID
         * @param int $id
         */
        public function RemoveRow($table, $cellID, $id) {
            return $this->Query("DELETE FROM `$table` WHERE `$cellID` = '$id'");
        }

        /**
         * @param int $UID
         * @param string $type
         * @param string $description
         * @return bool True if the query was successful
         */
        public function AddLog($UID, $type, $description) {
            $IP = GetIP();
            $result = $this->Query("INSERT INTO `Logs` (`UID`, `IP`, `Type`, `Description`) VALUES ('$UID', '$IP', '$type', '$description')");
            return $result !== false;
        }
    }

?>