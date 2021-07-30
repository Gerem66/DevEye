// Edit
function Init_Projects_Edit() {
    let form = document.getElementsByTagName('form')[0];
    let bt_rem = document.getElementById('bt-rem-project');
    let bt_back = document.getElementById('bt-back');
    
    let pid = document.getElementById('PID').value;

    if (pid === 'NEW') {
        bt_back.onclick = () => LoadPage('projects');
        bt_rem.remove();
    } else {
        bt_back.onclick = () => LoadPage('projects-kanban', { 'PID': pid });
        bt_rem.onclick = () => RemoveProject(bt_rem, pid);
    }
    form.onsubmit = (event) => SubmitProject(event);
}

function SubmitProject(event) {
    event.preventDefault();
    //return false; // ?

    let pid   = document.getElementById('projectID').value;
    let name  = document.getElementById('projectName').value;
    let date  = document.getElementById('inputDate').value;
    let type  = document.getElementById('inputType').value;
    let prog  = document.getElementById('inputProgress').value;
    let inst  = document.getElementById('inputInstance').checked ? '1' : '0';
    let stat  = document.getElementById('inputStatus').value;
    let color = document.getElementById('inputColorStatus').value;
    let link  = document.getElementById('inputLink').value;
    let description = document.getElementById('inputDescription').value;

    let data = { 'save': 1, 'PID': pid,
        'Name': name, 'Date': date,
        'Type': type, 'Progress': prog,
        'InstanceMode': inst, 'Status': stat,
        'Color': color, 'Link': link, 'Description': description
    };
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

// Kanban
let PID = -1;

function Init_Projects_Kanban() {
    // Load PID
    PID = document.getElementById('PID').value;

    // Drag & drop + open edit
    let boxes = document.getElementsByName('box');
    for (let i = 0; i < boxes.length; i++) {
        let grab = boxes[i].getElementsByClassName('grab')[0];
        let edit = boxes[i].getElementsByClassName('a')[0];
        grab.onmousedown = (event) => Grab(boxes[i], event);
        edit.onclick = () => OpenEditBoxPopup(boxes[i]);
    }

    // Columns events : Add / Archive / Scrollbars
    let columns = document.getElementsByName('column');
    for (let i = 0; i < 3; i++) {
        let plus = columns[i].getElementsByClassName('a')[0];
        plus.onclick = () => AddBox(i);
    }

    let button = columns[3].getElementsByTagName('button')[0];
    button.onclick = () => ArchiveBox(button);

    // Squares checkable
    let squares = document.getElementsByName('checkable');
    for (let i = 0; i < squares.length; i++) {
        squares[i].onclick = () => ProjectSquareClick(squares[i]);
    }
}

function SaveScrollbars() {
    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        let scrollPos = columns[i].getElementsByClassName('card-body')[0].scrollTop;
        sessionStorage.setItem('scrollpos' + i, scrollPos);
    }
}

function LoadScrollbars() {
    let columns = document.getElementsByName('column');
    for (let i = 0; i < 4; i++) {
        let scrollPos = sessionStorage.getItem('scrollpos' + i);
        if (typeof(scrollPos) !== 'undefined') {
            columns[i].getElementsByClassName('card-body')[0].scrollTo(0, scrollPos);
            sessionStorage.removeItem('scrollpos');
        }
    }
}

function ProjectSquareClick(element) {
    let id = element.id;
    element.disabled = true;

    let fd = new FormData();
    fd.append('square_toggle', id);
    fd.append('PID', PID);
    params = { method: 'POST', body: fd };

    fetch('./projects-kanban', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            if (content != 'OK') {
                element.checked = !element.checked;
            }
        })
        .catch(function(err) {
            console.error(err);
            element.checked = !element.checked;
        })
        .finally(function() {
            element.disabled = false;
        });
}

function OpenEditBoxPopup(element) {
    let popup = document.getElementById('popup-edit-box');
    popup.classList.add('active');

    let btn_del = document.getElementsByName('del')[0];
    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];

    let id;
    let bid = GetBID(element);

    let fd = new FormData();
    fd.append('PID', PID);
    fd.append('get_box', bid);
    params = { method: 'POST', body: fd };
    fetch('./projects-kanban', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            let parts = content.split("\t");
            id = parts[0];
            let name = parts[1];
            let color = parts[2];
            let body = parts[3];

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
        let data = { 'PID': PID, 'rem_box': bid };
        SaveScrollbars();
        LoadPage('projects-kanban', data, false, false, LoadScrollbars);
    }
    btn_save.onclick = () => {
        let content_name = document.getElementById('box-name').value.replace("\t", "");
        let content_color = document.getElementById('box-color').value;
        let content_body = document.getElementById('box-body').value.replace("\t", "");
        let content = [ id, content_name, content_color, content_body ].join("\t");
        let data = { 'PID': PID, 'set_box': bid, 'content': content };
        SaveScrollbars();
        LoadPage('projects-kanban', data, false, false, LoadScrollbars);
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

    //console.log([PID, bid, lastColumnIndex, lastRowIndex]);
    let data = { 'PID': PID, 'BID': bid, 'column': lastColumnIndex, 'row': lastRowIndex};
    SaveScrollbars();
    LoadPage('projects-kanban', data, false, false, LoadScrollbars);
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
    let data = { 'PID': PID, 'add_box': index };
    SaveScrollbars();
    LoadPage('projects-kanban', data, false, false, LoadScrollbars);
}

function ArchiveBox(button) {
    if (typeof(button.sure) === 'undefined') {
        button.sure = 1;
        button.textContent = "Confirmer ?";
        setTimeout(() => {
            if (typeof(button) !== 'undefined') {
                button.sure = undefined;
                button.textContent = "Archiver";
            }
        }, 10*1000);
    } else {
        let data = { 'PID': PID, 'archive': '1' };
        SaveScrollbars();
        LoadPage('projects-kanban', data, false, false, LoadScrollbars);
    }
}

function Init_Projects_Changelog() {
    PID = document.getElementById('PID').value;

    let blocks = document.getElementsByName('changelog-block');
    for (let i = 0; i < blocks.length; i++) {
        let bt_restore = blocks[i].getElementsByTagName('button')[0];
        bt_restore.onclick = () => {
            let data = { 'PID': PID, 'restore': i };
            LoadPage('projects-changelog', data, false, false);
        }
    }
}