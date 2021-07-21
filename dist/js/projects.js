// Edit page
function SubmitProject(event) {
    let pid = document.getElementById('projectID').value;
    let name = document.getElementById('projectName').value;
    let date = document.getElementById('inputDate').value;
    let type = document.getElementById('inputType').value;
    let prog = document.getElementById('inputProgress').value;
    let inst = document.getElementById('inputInstance').checked ? '1' : '0';
    let stat = document.getElementById('inputStatus').value;
    let color = document.getElementById('inputColorStatus').value;
    let description = document.getElementById('inputDescription').value;

    event.preventDefault();
    //return false; // ?

    let data = {
        'save': 1,
        'PID': pid,
        'Name': name,
        'Date': date,
        'Type': type,
        'Progress': prog,
        'InstanceMode': inst,
        'Status': stat,
        'Color': color,
        'Description': description
    };
    LoadPage('projects-kanban', data);
}

// Kanban
function ProjectSquareClick(element, pid) {
    let id = element.id;
    element.disabled = true;

    let fd = new FormData();
    fd.append('square_toggle', id);
    fd.append('PID', pid);
    params = { method: 'POST', body: fd };

    fetch('./projects-kanban', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            if (content != 'OK') {
                SwitchSquare();
            }
        })
        .catch(function(err) {
            console.error(err);
            SwitchSquare();
        })
        .finally(function() {
            element.disabled = false;
        });
}