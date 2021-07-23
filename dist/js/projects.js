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

function OpenCreatePopup(element) {
    let popup = document.getElementById('popup-edit-box');
    popup.classList.add('active');

    let btn_del = document.getElementsByName('del')[0];
    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];

    let bid = GetBID(element);
    let pid = document.getElementById('PID').value;

    let fd = new FormData();
    fd.append('PID', pid);
    fd.append('get_box', bid);
    params = { method: 'POST', body: fd };
    fetch('./projects-kanban', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            let lines = content.split("\n");
            let header = lines[0].split("\t");
            id =  header[0];
            let name =  header[1];
            let color = header[2];
            let body = lines.slice(1).join("\n");

            document.getElementById('box-title').textContent = "Box #" + id;
            document.getElementById('box-name').value = name;
            document.getElementById('box-body').textContent = body;

            let box_colors = document.getElementById('box-color')
            for (let i = 1; i < box_colors.children.length; i++) {
                box_colors.children[i].selected = color.startsWith(box_colors.children[i].value);
            }
        })
        .catch(function(err) {
            console.error(err);
        });

    btn_del.onclick = () => {
        let data = { 'PID': pid, 'rem_box': bid };
        LoadPage('projects-kanban', data);
    }
    btn_save.onclick = () => {
        let header = [ id, document.getElementById('box-name').value, document.getElementById('box-color').value ];
        let box_content = header.join("\t") + "\n" + document.getElementById('box-body').value;
        let data = { 'PID': pid, 'set_box': bid, 'content': box_content };
        LoadPage('projects-kanban', data);
    };
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}

function GetBID(element) {
    let output;
    let boxes = document.getElementsByClassName('box');
    for (let b = 0; b < boxes.length; b++) {
        if (boxes[b] == element) {
            output = b;
            break;
        }
    }
    return output;
}

let init_box;
let temp_box;
let ghost_box;
let bid = -1;
let lastColumnIndex = -1;
let lastRowIndex = -1;
function Grab(box, ev) {
    ev.preventDefault();

    if (typeof(temp_box) !== 'undefined') {
        return;
    }

    init_box = box;
    bid = GetBID(init_box);

    temp_box = init_box.cloneNode(true);
    temp_box.style.position = 'fixed';
    temp_box.style.top = (ev.clientY - 24) + 'px';
    temp_box.style.left = (ev.clientX - 146) + 'px';
    temp_box.style.width = init_box.clientWidth + 'px';
    temp_box.style.pointerEvents = 'none';
    document.body.classList.add('grabbing');

    let parent = box.parentNode.parentNode;
    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        if (columns[i] == parent) {
            lastColumnIndex = i;
            let col = parent.getElementsByClassName('card-body')[0];
            for (let r = 0; r < col.childElementCount; r++) {
                if (col.children[r] == init_box) {
                    lastRowIndex = r;
                    break;
                }
            }
            EstimateGhostBox();
            break;
        }
    }

    init_box.remove();
    document.getElementById('parent').appendChild(temp_box);

    AddHoverEvents();
}

function GrabMove(ev) {
    if (typeof(temp_box) === 'undefined') {
        return;
    }

    temp_box.style.top = (ev.clientY - 24) + 'px';
    temp_box.style.left = (ev.clientX - 146) + 'px';
}

function Ungrab() {
    if (typeof(temp_box) === 'undefined' || typeof(ghost_box) === 'undefined') {
        return;
    }
    
    let column = document.getElementsByName('column')[lastColumnIndex];
    let boxes = column.getElementsByClassName('card-body')[0];
    for (let i = 0; i < boxes.length; i++) {
        if (boxes[i] == ghost_box) {
            lastRowIndex = i;
        }
    }

    let new_box = init_box.cloneNode(true);
    new_box.style.position = 'initial';
    new_box.style.opacity = 1;
    boxes.replaceChild(new_box, ghost_box);

    temp_box.remove();
    temp_box = undefined;
    document.body.classList.remove('grabbing');

    RemoveHoverEvents();

    let pid = document.getElementById('PID').value;

    //console.log([pid, bid, lastColumnIndex, lastRowIndex]);
    let data = { 'PID': pid, 'BID': bid, 'column': lastColumnIndex, 'row': lastRowIndex};
    LoadPage('projects-kanban', data);
}

function EstimateGhostBox() {
    if (typeof(temp_box) === 'undefined') {
        return;
    }

    if (typeof(ghost_box) !== 'undefined') {
        ghost_box.remove();
        ghost_box = undefined;
    }

    ghost_box = temp_box.cloneNode(true);
    ghost_box.style.position = 'initial';
    ghost_box.style.opacity = .5;

    let column = document.getElementsByName('column')[lastColumnIndex];
    let cbody = column.getElementsByClassName('card-body')[0];
    if (lastRowIndex >= 0 && lastRowIndex < cbody.childElementCount) {
        cbody.children[lastRowIndex].insertAdjacentElement('beforebegin', ghost_box);
    } else {
        cbody.appendChild(ghost_box);
    }
}

function OnBoxHover(evt) {
    // Get parent box
    let parent = evt.currentTarget;
    while (!parent.classList.contains('box')) {
        parent = parent.parentNode;
    }

    // Get position
    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        let cards = columns[i].getElementsByClassName('card-body')[0];
        for (let e = 0; e < cards.childElementCount; e++) {
            let box = cards.children[e];
            if (box == parent) {
                if (lastRowIndex != e || lastColumnIndex != i) {
                    lastRowIndex = e;
                    lastColumnIndex = i;
                    EstimateGhostBox();
                }
                break;
            }
        }
    }
}

function OnColumnHover(evt) {
    let index = evt.currentTarget.index;
    if (index != lastColumnIndex) {
        lastColumnIndex = index;
        EstimateGhostBox();
    }
}

function AddHoverEvents() {
    document.addEventListener('mousemove', GrabMove);
    document.addEventListener('mouseup', Ungrab);

    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        columns[i].index = i;
        columns[i].addEventListener('mousemove', OnColumnHover);
        let cards = columns[i].getElementsByClassName('card-body')[0];
        for (let e = 0; e < cards.childElementCount; e++) {
            cards.children[e].addEventListener('mousemove', OnBoxHover);
        }
    }
}

function RemoveHoverEvents() {
    document.removeEventListener('mousemove', GrabMove);
    document.removeEventListener('mouseup', Ungrab);

    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        columns[i].removeEventListener('mousemove', OnColumnHover);
        let cards = columns[i].getElementsByClassName('card-body')[0];
        for (let e = 0; e < cards.childElementCount; e++) {
            cards.children[e].removeEventListener('mousemove', OnBoxHover);
        }
    }
}

function AddBox(index) {
    let pid = document.getElementById('PID').value;
    let data = { 'PID': pid, 'add_box': index };
    LoadPage('projects-kanban', data);
}

function RemoveProject(element, pid) {
    if (typeof(element.sure) === 'undefined') {
        element.sure = 1;
        element.textContent = "T'es sûr ?";
        return;
    } else if (element.sure == 1) {
        element.sure = 2;
        element.textContent = "Sûr sûr, hein ?";
        return;
    }
    let data = { 'RemoveProject': pid };
    LoadPage('projects', data);
}