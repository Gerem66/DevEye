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
         * Unsafe method to execute a query when parameters are not checked.
         * @param string $command The query command to execute.
         * @throws Exception if the connection is not open.
         */
        public function Query($command) {
            if ($this->conn == null) {
                throw(new Exception('Connection not opened'));
            }
            return $this->conn->query($command);
        }

        /**
         * Used to select, insert, update or delete data.
         * @param string $table The table to replace in query.
         * @param string $command The query command to execute.
         * @param string $types The types of the parameters. ('i'(nteger), 'd'(ouble), 's'(tring), 'b'(lob))
         * @param array $variables The variables to bind to the query.
         * @return array|int|false Array if query type is select, otherwise the number of affected rows or false if the query failed.
         * @throws Exception if the connection is not open.
         */
        public function QueryPrepare($table, $command, $types = '', $variables = array()) {
            if ($this->conn === null) {
                throw(new Exception('Connection not opened'));
            }
            if (!$this->IsSafe($table)) {
                throw(new Exception('Invalid table name'));
            }

            $replace = 0;
            $command = str_replace('`TABLE`', "`$table`", $command, $replace);
            if ($replace === 0) {
                $command = str_replace('TABLE', "`$table`", $command, $replace);
            }

            $query = $this->conn->prepare($command);
            if ($query === false) return false;


            $bind = $query->bind_param($types, ...$variables);
            if ($bind === false) return false;

            $result = $query->execute();
            if ($result === false) return false;

            $output = $query->affected_rows;
            if (StartsWith($command, 'SELECT')) {
                $output = $query->get_result()->fetch_all(MYSQLI_ASSOC);
            }

            $query->close();
            return $output;
        }

        public function GetLastInsertedID() {
            return $this->conn->insert_id;
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

        public function GetColumns($table) {
            if (!$this->IsSafe($table)) {
                throw(new Exception('Invalid table name'));
            }
            $rawHeaders = $this->QueryArray("SHOW COLUMNS FROM `$table`");
            return array_map(fn($header) => $header['Field'], $rawHeaders);
        }

        /**
         * @param string $table
         * @return int|false The number of rows in the table, or false if an error occurred.
         */
        function GetTableLength($table) {
            $command = "SELECT COUNT(*) FROM TABLE";
            $result = $this->QueryPrepare($table, $command);
            return $result !== false ? $result[0]['COUNT(*)'] : false;
        }

        function IsSafe($string) {
            return !preg_match('/[^a-zA-Z0-9_]/', $string);
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
         * @return array|false
         */
        public function GetRowContent($table, $cellSearch, $cellValue) {
            if (!$this->IsSafe($cellSearch)) {
                throw(new Exception('Invalid cell search'));
            }
            $result = $this->QueryPrepare($table, "SELECT * FROM TABLE WHERE `$cellSearch` = ?", 's', array($cellValue));
            if ($result !== false && count($result) > 0) {
                return $result[0];
            }
            return false;
        }

        /**
         * Get cell content by ID.
         * @param string $table
         * @param string $cell
         * @param string $id
         * @param bool $decrpyt
         * @return array Array of rows
         * @throws Exception If the query fails
         * @throws Exception If the cell is not found
         */
        public function GetCellContent($table, $cell, $id, $decrpyt = false) {
            if (!$this->IsSafe($cell)) {
                throw(new Exception('Invalid cell name'));
            }

            $content = '';
            $result = $this->QueryPrepare($table, "SELECT `$cell` FROM TABLE WHERE `ID` = ?", 'i', array($id));

            if ($result === false || count($result) === 0) {
                throw(new Exception('No row found'));
            }

            $row = $result[0];
            if (!array_key_exists($cell, $row)) {
                throw(new Exception("Cell '$cell' not found"));
            }

            $content = $row[$cell];
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
        public function SetCellContent($table, $cell, $id, $content, $encrpyt = false) {
            if (!$this->IsSafe($cell)) {
                throw(new Exception('Invalid cell name'));
            }

            $command = '';
            if ($encrpyt) {
                $content = $this->Encrypt($content);
            }

            $command = "UPDATE TABLE SET `$cell` = ? WHERE ID = ?";
            $result = $this->QueryPrepare($table, $command, 'si', array($content, $id));
            return $result !== false;
        }

        /**
         * @param string $table
         * @param int $cellID
         * @param int $id
         */
        public function RemoveRow($table, $cellID, $id) {
            if (!$this->IsSafe($cellID)) {
                throw(new Exception('Invalid cell name'));
            }
            return $this->QueryPrepare($table, "DELETE FROM TABLE WHERE `$cellID` = ?", 'i', array($id));
        }

        /**
         * @param int $UID
         * @param string $type
         * @param string $description
         * @return bool True if the query was successful
         */
        public function AddLog($UID, $type, $description) {
            $IP = GetIP();
            $args = array($UID, $IP, $type, $description);
            $result = $this->QueryPrepare('Logs', "INSERT INTO TABLE (`UID`, `IP`, `Type`, `Description`) VALUES (?, ?, ?, ?)", 'isss', $args);
            return $result !== false;
        }
    }

?>