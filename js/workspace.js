let wsFiles = {};
let wsCurrentFile = null;
let wsAllFiles = [];

function getWsData() {
    const raw = localStorage.getItem('cc_workspace');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function initWorkspace() {
    const data = getWsData();
    if (!data) {
        document.getElementById('wsEditorEmpty').style.display = 'flex';
        document.getElementById('wsCodeArea').style.display = 'none';
        document.getElementById('wsProject').textContent = 'Sem projeto';
        return;
    }

    document.getElementById('wsProject').textContent = data.project || 'Projeto';
    wsFiles = data.files || {};

    wsAllFiles = [];
    for (const [name, file] of Object.entries(wsFiles)) {
        if (file.type === 'folder') {
            for (const [fname, fobj] of Object.entries(file.children || {})) {
                wsAllFiles.push({ path: `${name}/${fname}`, ...fobj });
            }
        } else {
            wsAllFiles.push({ path: name, ...file });
        }
    }

    renderWsFileTree();
    renderWsTabs();

    if (wsAllFiles.length > 0) {
        openWsFile(wsAllFiles[0].path);
    }

    if (data.preview) {
        document.getElementById('wsPreviewFrame').srcdoc = data.preview;
    }

    addWsTerminal('ok', '$ Projeto carregado no workspace');
    addWsTerminal('info', `${wsAllFiles.length} arquivo(s) encontrado(s)`);
}

function renderWsFileTree() {
    const tree = document.getElementById('wsFileTree');
    if (wsAllFiles.length === 0) {
        tree.innerHTML = '<div class="ws-file-empty">Nenhum arquivo</div>';
        return;
    }

    let html = '';
    for (const [name, file] of Object.entries(wsFiles)) {
        if (file.type === 'folder') {
            html += `<div class="ws-folder">📁 ${name}</div><div class="ws-folder-children">`;
            for (const [fname, fobj] of Object.entries(file.children || {})) {
                const icon = getFileIcon(fname);
                html += `<div class="ws-file" data-path="${name}/${fname}" onclick="openWsFile('${name}/${fname}')">
                    <span class="ws-file-icon">${icon}</span>
                    <span class="ws-file-name">${fname}</span>
                </div>`;
            }
            html += '</div>';
        } else {
            const icon = getFileIcon(name);
            html += `<div class="ws-file" data-path="${name}" onclick="openWsFile('${name}')">
                <span class="ws-file-icon">${icon}</span>
                <span class="ws-file-name">${name}</span>
            </div>`;
        }
    }
    tree.innerHTML = html;
}

function getFileIcon(name) {
    if (name.endsWith('.html')) return '🌐';
    if (name.endsWith('.css')) return '🎨';
    if (name.endsWith('.js')) return '⚡';
    if (name.endsWith('.json')) return '📦';
    if (name.endsWith('.py')) return '🐍';
    if (name.endsWith('.md')) return '📝';
    return '📄';
}

function openWsFile(path) {
    let file = null;
    const parts = path.split('/');
    if (parts.length === 1) {
        file = wsFiles[parts[0]];
    } else {
        file = wsFiles[parts[0]]?.children?.[parts[1]];
    }
    if (!file || !file.content) return;

    wsCurrentFile = path;

    document.querySelectorAll('.ws-file').forEach(f => f.classList.remove('active'));
    const el = document.querySelector(`.ws-file[data-path="${path}"]`);
    if (el) el.classList.add('active');

    document.getElementById('wsEditorEmpty').style.display = 'none';
    document.getElementById('wsCodeArea').style.display = 'flex';

    const code = file.content;
    document.getElementById('wsCodeContent').textContent = code;

    const lines = code.split('\n').length;
    const nums = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    document.getElementById('wsLineNumbers').textContent = nums;

    renderWsTabs();
}

function renderWsTabs() {
    const tabs = document.getElementById('wsTabs');
    if (!wsCurrentFile) { tabs.innerHTML = ''; return; }

    const name = wsCurrentFile.split('/').pop();
    const icon = getFileIcon(name);
    tabs.innerHTML = `
        <div class="ws-tab active">
            <span>${icon}</span>
            <span>${name}</span>
        </div>`;
}

function toggleTerminal() {
    const el = document.getElementById('wsTerminalArea');
    const btn = document.getElementById('toggleTerminalBtn');
    if (el.style.display === 'none') {
        el.style.display = 'flex';
        btn.classList.add('active');
    } else {
        el.style.display = 'none';
        btn.classList.remove('active');
    }
}

function togglePreviewPanel() {
    const el = document.getElementById('wsPreviewArea');
    const btn = document.getElementById('togglePreviewBtn');
    if (el.classList.contains('hidden')) {
        el.classList.remove('hidden');
        btn.classList.add('active');
    } else {
        el.classList.add('hidden');
        btn.classList.remove('active');
    }
}

function toggleFileSidebar() {
    document.getElementById('wsSidebar').classList.toggle('hidden');
}

function refreshWsPreview() {
    const frame = document.getElementById('wsPreviewFrame');
    if (frame && frame.srcdoc) {
        frame.srcdoc = frame.srcdoc;
        addWsTerminal('info', '🔄 Preview atualizado');
    }
}

function clearWsTerminal() {
    document.getElementById('wsTerminal').innerHTML = '';
}

function addWsTerminal(type, msg) {
    const el = document.getElementById('wsTerminal');
    const time = new Date().toLocaleTimeString('pt-BR');
    const div = document.createElement('div');
    div.className = `ws-term-line ${type}`;
    div.textContent = `[${time}] ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

function deployProject() {
    addWsTerminal('warn', '⚠ Deploy ainda não implementado');
    alert('Deploy será implementado em breve!');
}

document.addEventListener('DOMContentLoaded', initWorkspace);
