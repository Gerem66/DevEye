<?php

    class Project {
        function __construct($db, $row) {
            $this->ExtractDataFromDbRow($db, $row);
        }

        function ExtractDataFromDbRow($db, $row) {
            $r = array_values($row);
            $this->id = $r[0];
            $this->uid = $r[1];
            $this->iid = $r[2];
            $this->instanceMode = $r[3];
            $this->name = $r[4];
            $this->description = $r[5];
            $this->type = $r[6];
            $this->status = $r[7];
            $this->content = $db->Decrypt($r[8]);
            $this->changelog = $r[9];
            $this->progress = $r[10];
            $this->color = $r[11];
            $this->date = $r[12];

            //$this->avatar = $avatar;
            //$this->avatarName = $avatarName;
        }

        function Update($database = null) {
            $db = $database !== null ? $database : new DataBase;
            $row = $db->GetRowContent('Projects', 'ID', $this->id);
            if (isset($row)) {
                ExtractDataFromDbRow($db, $row);
            }
        }

        function SaveContent($db, $newContent) {
            $this->content = $newContent;
            $db->SaveCellContent('Projects', 'Content', $this->id, $this->content);
        }

        function Save($database = null) {
            $db = $database !== null ? $database : new DataBase;

            $encrypt_content = $db->Encrypt($this->content);
            $q = "UPDATE `u444572210_oxy`.`Projects` SET
                `InstanceMode`='$this->instanceMode',
                `Name`='$this->name',
                `Description`='$this->description',
                `Type`='$this->type',
                `Status`='$this->status',
                `Content`='$this->encrypt_content',
                `Changelog`='$this->changelog',
                `Progress`='$this->progress',
                `Color`='$this->color',
                `Date`='$this->date' WHERE `ID` = '$this->id'";

            return $db->query($q);
        }

        function toHTML() {
            $collab_icon = $this->instanceMode ? "<i class='fas fa-users'></i>" : "";
            return "<tr>
                        <td>$collab_icon</td>
                        <td>
                            <a>$this->name</a><br>
                            <small>Commencé le $this->date</small>
                        </td>
                        <td>
                            <ul class='list-inline'>
                                <li class='list-inline-item'>
                                    <img class='table-avatar' src='dist/img/$this->avatar' title='$this->avatarName' alt='$this->avatarName'>
                                </li>
                            </ul>
                        </td>
                        <td class='project_progress'>
                            <div class='progress progress-sm'>
                                <div class='bg-$this->color' style='width: $this->progress%'></div>
                            </div>
                            <small>Terminé à $this->progress%</small>
                        </td>
                        <td class='project-state'>
                            <span class='badge bg-$this->color'>$this->status</span>
                        </td>
                        <!--td class='project-actions text-right'>
                            <button type='button' class='btn btn-block bg-$this->color btn-sm' onclick=\"LoadPage('projects-edit', {'PID': '$this->id'})\"><i class='fas fa-edit' style='margin-right: .5rem;'></i>Éditer</button>
                        </td-->
                        <td class='project-actions text-right'>
                            <button type='button' class='btn btn-block btn-primary btn-sm' onclick=\"LoadPage('projects-kanban', {'PID': '$this->id'})\"><i class='fas fa-table' style='margin-right: .5rem;'></i>Afficher</button>
                        </td>
                    </tr>";
        }
    }

    class Projects {
        function __construct() {
            $this->projects = [];
            $this->avatars = [];
        }

        function AddProjectsFromDB($projects) {
            if (isset($projects)) {
                for ($i = 0; $i < count($projects); $i++) {
                    $this->AddProjectFromDB($projects[$i]);
                }
            }
        }

        function AddProjectFromDB($db_row, $database = null) {
            $db = $database !== null ? $database : new DataBase;
            $newProject = new Project($db, $db_row);

            if (!isset($this->avatars[$newProject->uid])) {
                $user = $db->GetRowContent('Users', 'ID', $newProject->uid);
                $user_name = $user['Username'];
                $user_avatar = $user['Avatar'];
                $this->avatars[$newProject->uid] = [ $user_name, $user_avatar ];
            }

            $avatar = $this->avatars[$newProject->uid];
            $newProject->avatarName = $avatar[0];
            $newProject->avatar = $avatar[1];

            $this->projects[] = $newProject;
        }

        function CreateNewProject($db, $UID, $IID, $Name, $Date, $Type, $Progress, $InstanceMode, $Status, $Color, $Description) {
            $content = $db->Encrypt(str_repeat('---', 3));
            $q = "INSERT INTO `u444572210_oxy`.`Projects`
                    (`UserID`, `InstanceID`, `Name`,  `Date`,  `Type`,  `Progress`,  `InstanceMode`,  `Status`, `Content`,   `Color`,  `Description`) VALUES
                    ('$UID',   '$IID',       '$Name', '$Date', '$Type', '$Progress', '$InstanceMode', '$Status', '$content', '$Color', '$Description')";

            $PID = -1;
            if ($db->query($q) === TRUE) {
                $PID = $db->conn->insert_id;
                $row = $db->GetRowContent('Projects', 'ID', $PID);
                $this->AddProjectFromDB($row, $db);
            }

            return $this->GetProjectFromID($PID);
        }

        function GetProjectFromID($id) {
            $project = null;
            if ($id > 0) {
                for ($i = 0; $i < count($this->projects); $i++) {
                    if ($this->projects[$i]->id == $id) {
                        $project = $this->projects[$i];
                        break;
                    }
                }
            }
            return $project;
        }

        function SortByDate() {
            $sortedProjects = [];
            for ($p = 0; $p < count($this->projects); $p++) {
                $p_date = $this->projects[$p]->date;
                $added = false;
                for ($s = 0; $s < count($sortedProjects); $s++) {
                    $s_date = $sortedProjects[$s]->date;
                    if (strcmp($p_date, $s_date) > 0) {
                        $added = true;
                        for ($d = count($sortedProjects) - 1; $d >= $s; $d--) {
                            $sortedProjects[$d+1] = $sortedProjects[$d];
                        }
                        $sortedProjects[$s] = $this->projects[$p];
                        break;
                    }
                }
                if (!$added) {
                    array_push($sortedProjects, $this->projects[$p]);
                }
            }
            $this->projects = $sortedProjects;
        }

        function AllProjectsToTable($UID) {
            $output = "";
            for ($i = 0; $i < count($this->projects); $i++) {
                $project = $this->projects[$i];
                if ($project->uid == $UID || $project->instanceMode) {
                    $output .= $project->toHTML();
                }
            }
            return $output;
        }
    }

    class KanBan {
        function __construct($pid, $content_text) {
            $this->pid = $pid;
            $this->raw_content = $content_text;
            $this->columns = array(
                'BACKLOG' => '',
                'TODO' => '',
                'INPROGRESS' => '',
                'FINISHED' => ''
            );
            $this->__CalculateContents();
        }

        function __CalculateContents() {
            $indexes = [ 'BACKLOG', 'TODO', 'INPROGRESS', 'FINISHED' ];
            $split_content = explode("---", $this->raw_content);
            if (count($split_content) != count($indexes)) {
                return;
            }
            // Each column
            $checkbox_id = 0;
            for ($i = 0; $i < count($indexes); $i++) {
                $index = $indexes[$i];
                if ($split_content[$i] != "") {
                    // Each block
                    $block = explode("#", $split_content[$i]);
                    for ($b = 0; $b < count($block); $b++) {
                        $lines = explode("\n", $block[$b]);
                        // Header
                        $header = $lines[0];
                        list($h_id, $h_title, $h_color) = explode("\t", $header);
                        // Each line
                        $content = "";
                        for ($l = 1; $l < count($lines); $l++) { // Line 0 is header
                            $line = $lines[$l];
                            $pre = explode(' ', $line)[0];
                            $rest = substr($line, strlen($pre) + 1);
                            if ($pre[0] == '[') $content .= $this->__AddCheckbox($checkbox_id++, $rest, strlen($pre) != 2);
                            else $content .= $this->__AddText($line);
                        }
                        $this->columns[$index] .= $this->__AddBox($h_id, $h_title, $h_color, $content);
                    }
                }
            }
        }

        function __AddBox($id, $title, $color, $content) {
            return "<div class='card card-$color card-outline box'>
                        <div class='card-header'>
                            <div class='grab hitbox' onmousedown='Grab(this.parentNode.parentNode, event)'></div>
                            <h5 class='card-title'>$title</h5>
                            <div class='card-tools'>
                                #$id
                                <a class='btn btn-tool a' onclick='OpenCreatePopup(this.parentNode.parentNode.parentNode)'>
                                    <i class='fas fa-pen'></i>
                                </a>
                            </div>
                        </div>
                        <div class='card-body'>
                            $content
                        </div>
                    </div>";
        }

        function __AddText($text) {
            return "<p>$text</p>";
        }

        function __AddCheckbox($id, $title, $checked = false) {
            $c = $checked ? "checked" : "";
            $e = "onclick=\"ProjectSquareClick(this, '$this->pid');\"";
            return "<div class='custom-control custom-checkbox'>
                        <input id='$id' type='checkbox' class='custom-control-input' $e $c>
                        <label for='$id' class='custom-control-label form-check-label'>$title</label>
                    </div>";
        }
    }

?>