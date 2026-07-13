// === STATE ===
let files = {};
let openTabs = [];
let activeTab = null;
let modifiedFiles = {};
let searchTimeout = null;
let contextTarget = null;
let sidebarVisible = false;

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    renderFileTree();
    setupResize();
    setupKeyboard();
    setupContextMenu();
    termLog('ok', '$ Corvo Coder — VS Code View');
    termLog('info', '  Projeto carregado com sucesso');
});

function loadData() {
    const raw = localStorage.getItem('cc_workspace');
    if (!raw) return;
    try {
        const data = JSON.parse(raw);
        files = data.files || {};
        if (data.preview) {
            document.getElementById('previewFrame').srcdoc = data.preview;
        }
    } catch {}
}

// === FILE TREE ===
function renderFileTree() {
    const tree = document.getElementById('fileTree');
    if (!Object.keys(files).length) {
        tree.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:0.8rem">Nenhum arquivo<br><small>Gere código no chat para ver aqui</small></div>';
        return;
    }
    tree.innerHTML = buildTreeHTML(files, 0, '');
}

function buildTreeHTML(obj, depth, parentPath) {
    let html = '';
    const sorted = Object.entries(obj).sort(([, a], [, b]) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return 0;
    });
    for (const [name, file] of sorted) {
        const path = parentPath ? parentPath + '/' + name : name;
        if (file.type === 'folder') {
            const id = 'folder-' + path.replace(/[^a-z0-9]/gi, '-');
            const children = buildTreeHTML(file.children || {}, depth + 1, path);
            html += `
                <div class="tree-item" style="--depth:${depth}" onclick="toggleFolder('${id}', this)" oncontextmenu="showContext(event, '${path}', 'folder')">
                    <span class="tree-arrow" id="arrow-${id}">▶</span>
                    <span class="tree-icon folder-icon" id="icon-${id}">📁</span>
                    <span class="tree-name">${name}</span>
                </div>
                <div class="tree-children" id="${id}">${children}</div>`;
        } else {
            const icon = getFileIcon(name);
            const cls = getFileIconClass(name);
            html += `
                <div class="tree-item" style="--depth:${depth}" onclick="openFile('${path}')" data-path="${path}" oncontextmenu="showContext(event, '${path}', 'file')">
                    <span class="file-icon ${cls}">${icon}</span>
                    <span class="tree-name">${name}</span>
                </div>`;
        }
    }
    return html;
}

function getFileIcon(name) {
    if (name.endsWith('.html') || name.endsWith('.htm')) return 'H';
    if (name.endsWith('.css')) return 'C';
    if (name.endsWith('.js')) return 'JS';
    if (name.endsWith('.json')) return '{}';
    if (name.endsWith('.py')) return 'Py';
    if (name.endsWith('.md')) return 'M';
    if (name.endsWith('.env')) return '*';
    if (name.endsWith('.txt')) return 'T';
    if (name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.svg') || name.endsWith('.gif')) return 'IMG';
    return 'F';
}

function getFileIconClass(name) {
    if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
    if (name.endsWith('.css')) return 'css';
    if (name.endsWith('.js')) return 'js';
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.py')) return 'py';
    if (name.endsWith('.md')) return 'md';
    if (name.endsWith('.txt')) return 'txt';
    if (name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.svg')) return 'img';
    return 'txt';
}

function toggleFolder(id, el) {
    const folder = document.getElementById(id);
    const arrow = document.getElementById('arrow-' + id);
    const icon = document.getElementById('icon-' + id);
    if (!folder) return;
    const isOpen = folder.classList.toggle('open');
    arrow?.classList.toggle('open');
    if (icon) icon.textContent = isOpen ? '📂' : '📁';
    if (icon) icon.classList.toggle('open', isOpen);
}

function collapseAll() {
    document.querySelectorAll('.tree-children').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.tree-arrow').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.folder-icon').forEach(el => { el.textContent = '📁'; el.classList.remove('open'); });
}

function refreshTree() { renderFileTree(); }

// === FILE OPERATIONS ===
function getFileByPath(path) {
    const parts = path.split('/');
    if (parts.length === 1) return files[parts[0]];
    if (parts.length === 2) return files[parts[0]]?.children?.[parts[1]];
    if (parts.length === 3) return files[parts[0]]?.children?.[parts[1]]?.children?.[parts[2]];
    if (parts.length === 4) return files[parts[0]]?.children?.[parts[1]]?.children?.[parts[2]]?.children?.[parts[3]];
    return null;
}

function setFileContent(path, content) {
    const parts = path.split('/');
    if (parts.length === 1 && files[parts[0]]) files[parts[0]].content = content;
    else if (parts.length === 2 && files[parts[0]]?.children?.[parts[1]]) files[parts[0]].children[parts[1]].content = content;
    else if (parts.length === 3 && files[parts[0]]?.children?.[parts[1]]?.children?.[parts[2]]) files[parts[0]].children[parts[1]].children[parts[2]].content = content;
    else if (parts.length === 4 && files[parts[0]]?.children?.[parts[1]]?.children?.[parts[2]]?.children?.[parts[3]]) files[parts[0]].children[parts[1]].children[parts[2]].children[parts[3]].content = content;
}

function deleteFileByPath(path) {
    const parts = path.split('/');
    if (parts.length === 1) delete files[parts[0]];
    else if (parts.length === 2 && files[parts[0]]?.children) delete files[parts[0]].children[parts[1]];
    else if (parts.length === 3 && files[parts[0]]?.children?.[parts[1]]?.children) delete files[parts[0]].children[parts[1]].children[parts[2]];
}

function saveWorkspace() {
    try {
        const preview = document.getElementById('previewFrame')?.srcdoc || '';
        localStorage.setItem('cc_workspace', JSON.stringify({ files, preview }));
    } catch {}
}

function openFile(path) {
    const file = getFileByPath(path);
    if (!file || !file.content) return;

    if (!openTabs.includes(path)) openTabs.push(path);
    activeTab = path;

    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('codeEditor').style.display = 'flex';

    const textarea = document.getElementById('codeTextarea');
    textarea.value = file.content;
    textarea.focus();

    updateHighlight(file.content);
    updateLineNumbers(file.content);
    renderTabs();
    updateBreadcrumb(path);
    updateStatusBar(path, file.content);
    selectTreeItem(path);
}

function selectTreeItem(path) {
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`.tree-item[data-path="${path}"]`);
    if (el) el.classList.add('active');
}

function closeTab(path, e) {
    if (e) e.stopPropagation();
    openTabs = openTabs.filter(t => t !== path);
    delete modifiedFiles[path];
    if (activeTab === path) {
        activeTab = openTabs[openTabs.length - 1] || null;
        if (activeTab) openFile(activeTab);
        else {
            document.getElementById('welcomeScreen').style.display = 'flex';
            document.getElementById('codeEditor').style.display = 'none';
            document.getElementById('breadcrumb').innerHTML = '<span style="color:var(--muted)">Selecione um arquivo</span>';
        }
    }
    renderTabs();
}

function renderTabs() {
    const tabs = document.getElementById('editorTabs');
    tabs.innerHTML = openTabs.map(path => {
        const name = path.split('/').pop();
        const icon = getFileIcon(name);
        const cls = getFileIconClass(name);
        const isActive = path === activeTab;
        const mod = modifiedFiles[path] ? 'show' : '';
        return `<div class="etab ${isActive ? 'active' : ''}" onclick="openFile('${path}')">
            <span class="file-icon ${cls}" style="width:14px;height:14px;font-size:0.5rem">${icon}</span>
            <span>${name}</span>
            <span class="modified ${mod}"></span>
            <span class="close" onclick="closeTab('${path}', event)">×</span>
        </div>`;
    }).join('');

    const tbTabs = document.getElementById('tbTabs');
    tbTabs.innerHTML = openTabs.map(path => {
        const name = path.split('/').pop();
        return `<div class="tb-tab ${path === activeTab ? 'active' : ''}" onclick="openFile('${path}')">${name}</div>`;
    }).join('');

    document.getElementById('sbSync').textContent = `↻ ${Object.keys(modifiedFiles).length}  0`;
}

// === CODE EDITOR ===
function onCodeChange() {
    const textarea = document.getElementById('codeTextarea');
    const content = textarea.value;
    if (activeTab) {
        setFileContent(activeTab, content);
        modifiedFiles[activeTab] = true;
        updateHighlight(content);
        updateLineNumbers(content);
        renderTabs();
        updateStatusBar(activeTab, content);
        saveWorkspace();
    }
}

function updateLineNumbers(content) {
    const lines = content.split('\n').length;
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    document.getElementById('lineNumbers').textContent = nums.join('\n');
}

function updateHighlight(content) {
    const ext = activeTab?.split('.').pop() || '';
    document.getElementById('codeHighlightContent').innerHTML = highlightCode(content, ext);
}

function highlightCode(code, ext) {
    let escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (ext === 'html' || ext === 'htm') {
        escaped = escaped.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="cm">$1</span>');
        escaped = escaped.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tag">$2</span>');
        escaped = escaped.replace(/(\/&gt;)/g, '<span class="punct">$1</span>');
        escaped = escaped.replace(/([\w-]+)(=)/g, '<span class="attr">$1</span>$2');
        escaped = escaped.replace(/(=)(&quot;[^&]*&quot;|&#39;[^&]*&#39;|"[^"]*"|'[^']*')/g, '$1<span class="val">$2</span>');
    } else if (ext === 'css') {
        escaped = escaped.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="cm">$1</span>');
        escaped = escaped.replace(/([\.\#][\w-]+)/g, '<span class="css-sel">$1</span>');
        escaped = escaped.replace(/([\w-]+)(\s*:)/g, '<span class="css-prop">$1</span>$2');
        escaped = escaped.replace(/:\s*([^;{}]+)/g, ': <span class="css-val">$1</span>');
    } else if (ext === 'js') {
        escaped = escaped.replace(/(\/\/.*$)/gm, '<span class="cm">$1</span>');
        escaped = escaped.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="cm">$1</span>');
        const kws = ['const','let','var','function','return','if','else','for','while','do','class','extends','import','export','default','from','new','this','super','async','await','try','catch','finally','throw','switch','case','break','continue','typeof','instanceof','in','of','null','undefined','true','false','void','delete','yield','static','get','set'];
        kws.forEach(kw => {
            escaped = escaped.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span class="kw">$1</span>');
        });
        escaped = escaped.replace(/(\d+\.?\d*)/g, '<span class="num">$1</span>');
        escaped = escaped.replace(/(&#39;[^&#]*&#39;|&quot;[^&]*&quot;|'[^']*'|"[^"]*")/g, '<span class="str">$1</span>');
        escaped = escaped.replace(/\b([\w]+)\s*\(/g, '<span class="fn">$1</span>(');
    } else if (ext === 'json') {
        escaped = escaped.replace(/(&quot;[^&]*&quot;)(\s*:)/g, '<span class="attr">$1</span>$2');
        escaped = escaped.replace(/:\s*(&quot;[^&]*&quot;|&#39;[^&#]*&#39;|"[^"]*"|'[^']*')/g, ': <span class="str">$1</span>');
        escaped = escaped.replace(/:\s*(\d+\.?\d*)/g, ': <span class="num">$1</span>');
        escaped = escaped.replace(/:\s*(true|false|null)/g, ': <span class="kw">$1</span>');
    } else if (ext === 'py') {
        escaped = escaped.replace(/(#.*$)/gm, '<span class="cm">$1</span>');
        escaped = escaped.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, '<span class="cm">$1</span>');
        const pyKws = ['def','class','import','from','return','if','elif','else','for','while','try','except','finally','with','as','yield','lambda','pass','break','continue','True','False','None','self','print','raise','in','not','and','or','is','del','global','nonlocal','assert','async','await'];
        pyKws.forEach(kw => {
            escaped = escaped.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span class="kw">$1</span>');
        });
        escaped = escaped.replace(/(\d+\.?\d*)/g, '<span class="num">$1</span>');
        escaped = escaped.replace(/(&#39;[^&#]*&#39;|&quot;[^&]*&quot;|'[^']*'|"[^"]*")/g, '<span class="str">$1</span>');
    } else if (ext === 'md') {
        escaped = escaped.replace(/^(#{1,6}\s.+)$/gm, '<span class="kw">$1</span>');
        escaped = escaped.replace(/(\*\*[^*]+\*\*)/g, '<span class="fn">$1</span>');
        escaped = escaped.replace(/(`[^`]+`)/g, '<span class="str">$1</span>');
    }

    return escaped;
}

function syncScroll() {
    const textarea = document.getElementById('codeTextarea');
    const highlight = document.getElementById('codeHighlight');
    const lineNumbers = document.getElementById('lineNumbers');
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    lineNumbers.scrollTop = textarea.scrollTop;
}

function onEditorKeydown(e) {
    const textarea = e.target;
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        if (e.shiftKey) {
            // Dedent: remove leading spaces from selected lines
            const before = textarea.value.substring(0, start);
            const selected = textarea.value.substring(start, end);
            const lineStart = before.lastIndexOf('\n') + 1;
            const fullSelection = textarea.value.substring(lineStart, end);
            const dedented = fullSelection.replace(/^  /gm, '');
            const removed = fullSelection.length - dedented.length;
            textarea.value = textarea.value.substring(0, lineStart) + dedented + textarea.value.substring(end);
            textarea.selectionStart = Math.max(lineStart, start - 2);
            textarea.selectionEnd = end - removed;
        } else {
            const spaces = '  ';
            textarea.value = textarea.value.substring(0, start) + spaces + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + spaces.length;
        }
        onCodeChange();
    }
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }
    if (e.key === 'Enter') {
        const start = textarea.selectionStart;
        const before = textarea.value.substring(0, start);
        const currentLine = before.split('\n').pop();
        const indent = currentLine.match(/^(\s*)/)[1];
        const lastChar = before.trim().slice(-1);
        let extra = '';
        if (lastChar === '{' || lastChar === '(' || lastChar === '[' || lastChar === '>' || lastChar === ':') {
            extra = '  ';
        }
        if (lastChar === '{' && textarea.value[textarea.selectionStart] === '}') {
            e.preventDefault();
            const insert = '\n' + indent + extra + '\n' + indent;
            textarea.value = textarea.value.substring(0, start) + insert + textarea.value.substring(textarea.selectionEnd);
            textarea.selectionStart = textarea.selectionEnd = start + indent.length + extra.length + 1;
            onCodeChange();
            return;
        }
        if (extra) {
            e.preventDefault();
            const insert = '\n' + indent + extra;
            textarea.value = textarea.value.substring(0, start) + insert + textarea.value.substring(textarea.selectionEnd);
            textarea.selectionStart = textarea.selectionEnd = start + insert.length;
            onCodeChange();
        }
    }
}

function updateCursorPos() {
    const textarea = document.getElementById('codeTextarea');
    const content = textarea.value;
    const pos = textarea.selectionStart;
    const lines = content.substring(0, pos).split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    document.getElementById('sbCursor').textContent = `Ln ${line}, Col ${col}`;
}

function saveCurrentFile() {
    if (!activeTab) return;
    if (modifiedFiles[activeTab]) {
        delete modifiedFiles[activeTab];
        renderTabs();
        saveWorkspace();
        showToast('success', `${activeTab.split('/').pop()} salvo`);
        termLog('ok', `✓ ${activeTab.split('/').pop()} salvo`);
    }
}

// === BREADCRUMB ===
function updateBreadcrumb(path) {
    const parts = path.split('/');
    document.getElementById('breadcrumb').innerHTML = parts.map((p, i) => {
        const isLast = i === parts.length - 1;
        return `<span>${p}</span>${isLast ? '' : '<span class="sep">›</span>'}`;
    }).join('');
}

// === STATUS BAR ===
function updateStatusBar(path, content) {
    updateCursorPos();
    const ext = path.split('.').pop();
    const langMap = { html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JavaScript', json: 'JSON', py: 'Python', md: 'Markdown', txt: 'Text' };
    document.getElementById('sbLanguage').textContent = langMap[ext] || ext.toUpperCase();
}

// === SEARCH ===
function toggleSearch() {
    switchActivity('search');
    setTimeout(() => document.getElementById('searchInput')?.focus(), 100);
}

function searchFiles(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        const results = document.getElementById('searchResults');
        if (!query || query.length < 2) { results.innerHTML = ''; return; }
        const found = [];
        const q = document.getElementById('searchCase').checked ? query : query.toLowerCase();
        const isRegex = document.getElementById('searchRegex').checked;

        searchInObj(files, q, isRegex, found, '');

        results.innerHTML = found.length ? found.slice(0, 50).map(r => `
            <div class="search-result" onclick="openFile('${r.path}')">
                <div class="file">${r.path} <span class="line">Ln ${r.line}</span></div>
                <div>${r.context}</div>
            </div>`).join('') : '<div style="padding:12px;color:var(--muted);font-size:0.75rem">Nenhum resultado</div>';
    }, 200);
}

function searchInObj(obj, query, isRegex, found, parentPath) {
    const sorted = Object.entries(obj).sort(([, a], [, b]) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return 0;
    });
    for (const [name, file] of sorted) {
        const path = parentPath ? parentPath + '/' + name : name;
        if (file.type === 'folder') {
            searchInObj(file.children || {}, query, isRegex, found, path);
        } else if (file.content) {
            const lines = file.content.split('\n');
            lines.forEach((line, i) => {
                let match = false;
                if (isRegex) {
                    try { match = new RegExp(query, 'i').test(line); } catch {}
                } else {
                    match = line.toLowerCase().includes(query);
                }
                if (match) {
                    const escaped = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    found.push({ path, line: i + 1, context: escaped.substring(0, 120) });
                }
            });
        }
    }
}

// === ACTIVITY BAR ===
function switchActivity(name) {
    const map = { explorer: 'Explorer', search: 'Search', git: 'Git', run: 'Run', extensions: 'Extensions' };
    document.querySelectorAll('.activity-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    const actId = 'act' + name.charAt(0).toUpperCase() + name.slice(1);
    const panelId = 'panel' + (map[name] || name);
    document.getElementById(actId)?.classList.add('active');
    document.getElementById(panelId)?.classList.add('active');
    document.getElementById('sidebar').classList.remove('hidden');
    sidebarVisible = true;
}

// === BOTTOM PANELS ===
function toggleTerminal() {
    const panels = document.getElementById('bottomPanels');
    const btn = document.getElementById('btnTerminal');
    const isVisible = panels.style.display !== 'none';
    panels.style.display = isVisible ? 'none' : 'flex';
    btn.style.background = isVisible ? '' : 'rgba(255,255,255,0.1)';
    if (!isVisible) switchBottomPanel('terminal');
}

function switchBottomPanel(name) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
    const tab = document.getElementById('p' + name);
    const panel = document.getElementById(name + 'Panel');
    if (tab) tab.classList.add('active');
    if (panel) panel.classList.add('active');
}

function termLog(type, msg) {
    const el = document.getElementById('terminal');
    if (!el) return;
    const time = new Date().toLocaleTimeString('pt-BR');
    el.innerHTML += `<div class="term-line ${type}"><span style="color:#555">[${time}]</span> ${msg}</div>`;
    el.scrollTop = el.scrollHeight;
}

function runTerminalCmd() {
    const input = document.getElementById('termInput');
    const cmd = input.value.trim();
    if (!cmd) return;
    termLog('muted', `$ ${cmd}`);
    input.value = '';

    if (cmd === 'help') {
        termLog('info', 'Comandos disponíveis: help, ls, cat <arquivo>, clear, echo <texto>, pwd');
    } else if (cmd === 'ls') {
        const names = Object.keys(files);
        termLog('ok', names.join('  '));
    } else if (cmd.startsWith('cat ')) {
        const path = cmd.slice(4).trim();
        const file = getFileByPath(path);
        if (file?.content) termLog('info', file.content.substring(0, 2000));
        else termLog('error', `Arquivo não encontrado: ${path}`);
    } else if (cmd === 'clear') {
        document.getElementById('terminal').innerHTML = '';
    } else if (cmd.startsWith('echo ')) {
        termLog('ok', cmd.slice(5));
    } else if (cmd === 'pwd') {
        termLog('info', '/workspace');
    } else {
        termLog('error', `Comando não encontrado: ${cmd}. Digite "help" para ver comandos.`);
    }
}

// === PREVIEW ===
function togglePreview() {
    const panel = document.getElementById('previewPanel');
    const btn = document.getElementById('btnPreview');
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'flex' : 'none';
    panel.classList.toggle('hidden', !isHidden);
    btn.style.background = isHidden ? 'rgba(255,255,255,0.1)' : '';
}

function refreshPreview() {
    const frame = document.getElementById('previewFrame');
    if (frame) frame.srcdoc = frame.srcdoc;
}

function openPreviewInNewTab() {
    const frame = document.getElementById('previewFrame');
    if (frame?.srcdoc) {
        const w = window.open('', '_blank');
        w.document.write(frame.srcdoc);
        w.document.close();
    }
}

// === DOWNLOADS ===
function downloadCurrentFile() {
    if (!activeTab) {
        showToast('info', 'Abra um arquivo primeiro');
        return;
    }
    const file = getFileByPath(activeTab);
    if (!file?.content) return;
    downloadBlob(file.content, activeTab.split('/').pop());
    showToast('success', `Baixando ${activeTab.split('/').pop()}`);
}

function downloadAllFiles() {
    if (!Object.keys(files).length) {
        showToast('info', 'Nenhum arquivo para baixar');
        return;
    }
    const zip = new JSZip();
    addFilesToZip(zip, files, '');
    zip.generateAsync({ type: 'blob' }).then(blob => {
        downloadBlob(blob, 'corvo-project.zip');
        showToast('success', 'Projeto baixado como ZIP');
        termLog('ok', '✓ Projeto baixado como ZIP');
    });
}

function addFilesToZip(zip, obj, parentPath) {
    for (const [name, file] of Object.entries(obj)) {
        const path = parentPath ? parentPath + '/' + name : name;
        if (file.type === 'folder') {
            addFilesToZip(zip, file.children || {}, path);
        } else if (file.content) {
            zip.file(path, file.content);
        }
    }
}

function downloadBlob(content, filename) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 150);
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        setTimeout(() => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const w = window.open('about:blank');
                if (w) {
                    w.document.write('<html><head><title>' + filename + '</title><style>body{background:#1a1a2e;color:#e0e0e0;font-family:monospace;padding:16px;white-space:pre-wrap;word-wrap:break-word;}</style></head><body><pre>' + escapeHtml(e.target.result) + '</pre></body></html>');
                    w.document.close();
                }
            };
            reader.readAsText(blob);
        }, 500);
    }
}

// === CONTEXT MENU ===
function setupContextMenu() {
    document.addEventListener('click', () => hideContext());
    document.addEventListener('contextmenu', (e) => {
        if (!e.target.closest('.tree-item')) hideContext();
    });
}

function showContext(e, path, type) {
    e.preventDefault();
    e.stopPropagation();
    contextTarget = { path, type };
    const menu = document.getElementById('contextMenu');
    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (e.clientX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (e.clientY - rect.height) + 'px';
}

function hideContext() {
    document.getElementById('contextMenu').style.display = 'none';
}

function ctxNewFile() {
    hideContext();
    const name = prompt('Nome do arquivo (ex: index.html):');
    if (!name) return;
    if (contextTarget?.type === 'folder' && contextTarget.path) {
        const folder = getFileByPath(contextTarget.path);
        if (folder?.children) {
            folder.children[name] = { type: 'file', content: '' };
        }
    } else {
        files[name] = { type: 'file', content: '' };
    }
    saveWorkspace();
    renderFileTree();
    openFile(contextTarget?.type === 'folder' ? contextTarget.path + '/' + name : name);
}

function ctxNewFolder() {
    hideContext();
    const name = prompt('Nome da pasta:');
    if (!name) return;
    if (contextTarget?.path) {
        const parent = getFileByPath(contextTarget.path);
        if (parent?.children) {
            parent.children[name] = { type: 'folder', children: {} };
        }
    } else {
        files[name] = { type: 'folder', children: {} };
    }
    saveWorkspace();
    renderFileTree();
}

function ctxDownloadFile() {
    hideContext();
    if (!contextTarget?.path) return;
    const file = getFileByPath(contextTarget.path);
    if (!file?.content) return;
    downloadBlob(file.content, contextTarget.path.split('/').pop());
    showToast('success', `Baixando ${contextTarget.path.split('/').pop()}`);
}

function ctxDownloadAll() {
    hideContext();
    downloadAllFiles();
}

function ctxCopyPath() {
    hideContext();
    if (!contextTarget?.path) return;
    navigator.clipboard?.writeText(contextTarget.path);
    showToast('info', 'Caminho copiado');
}

function ctxCopyContent() {
    hideContext();
    if (!contextTarget?.path) return;
    const file = getFileByPath(contextTarget.path);
    if (!file?.content) return;
    navigator.clipboard?.writeText(file.content);
    showToast('info', 'Conteúdo copiado');
}

function ctxDeleteFile() {
    hideContext();
    if (!contextTarget?.path) return;
    if (!confirm(`Excluir "${contextTarget.path}"?`)) return;
    deleteFileByPath(contextTarget.path);
    openTabs = openTabs.filter(t => t !== contextTarget.path);
    delete modifiedFiles[contextTarget.path];
    if (activeTab === contextTarget.path) {
        activeTab = openTabs[openTabs.length - 1] || null;
        if (activeTab) openFile(activeTab);
        else {
            document.getElementById('welcomeScreen').style.display = 'flex';
            document.getElementById('codeEditor').style.display = 'none';
        }
    }
    saveWorkspace();
    renderFileTree();
    renderTabs();
    showToast('info', 'Arquivo excluído');
}

// === NEW FILE/FOLDER (toolbar) ===
function newFile() {
    const name = prompt('Nome do arquivo (ex: index.html):');
    if (!name) return;
    files[name] = { type: 'file', content: `<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  \n</body>\n</html>` };
    saveWorkspace();
    renderFileTree();
    openFile(name);
}

function newFolder() {
    const name = prompt('Nome da pasta:');
    if (!name) return;
    files[name] = { type: 'folder', children: {} };
    saveWorkspace();
    renderFileTree();
}

// === RUN ===
function runProject() {
    const indexFile = files['index.html'] || files['app']?.children?.['index.html'];
    if (indexFile?.content) {
        togglePreview();
        document.getElementById('previewFrame').srcdoc = indexFile.content;
        termLog('ok', '✓ Preview atualizado');
    } else {
        termLog('warn', 'Nenhum index.html encontrado');
    }
}

// === RESIZE ===
function setupResize() {
    const handle = document.getElementById('resizeHandle');
    const sidebar = document.getElementById('sidebar');
    let startX, startWidth;
    handle.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        handle.classList.add('dragging');
        const onMove = (e) => {
            const newWidth = Math.max(160, Math.min(500, startWidth + e.clientX - startX));
            sidebar.style.width = newWidth + 'px';
        };
        const onUp = () => {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// === KEYBOARD SHORTCUTS ===
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'f') { e.preventDefault(); toggleSearch(); }
        if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); }
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
        if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); }
        if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
        if (e.key === 'F12') { e.preventDefault(); }
    });
}

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    sidebarVisible = !sidebarVisible;
    sb.classList.toggle('hidden', !sidebarVisible);
}

// === TOAST ===
function showToast(type, msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const icons = { success: '✓', error: '✗', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${msg}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
