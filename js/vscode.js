// === STATE ===
let files = {};
let previousFiles = null;
let chatId = null;
let openTabs = [];
let activeTab = null;
let modifiedFiles = {};
let searchTimeout = null;
let contextTarget = null;
let sidebarVisible = false;
let monacoEditor = null;
let monacoDiffEditor = null;
let diffViewActive = false;
let diffOriginalModel = null;
let diffModifiedModel = null;
let xterm = null;
let termSocket = null;
let termFit = null;

// Zoom state
let editorFontSize = 12;

// Save indicator
let saveStatus = '';
let saveStatusTimeout = null;

// Selected files for batch download
let selectedFilesSet = new Set();

// Version history for undo
let versionHistory = [];
let versionIndex = -1;

// Split editor
let splitEditorActive = false;
let monacoEditor2 = null;


// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    renderFileTree();
    setupResize();
    setupKeyboard();
    setupContextMenu();
    initMonaco();
    // Deploy check
    checkDeployStatus();
    // Render git changes with diff
    setTimeout(renderGitChanges, 300);
    
    // Load version history
    loadVersionHistory();
    
    // Update zoom status
    updateZoomStatus();
    
    // Initialize problems/lint listener
    setTimeout(() => {
        if (monaco.editor && monaco.editor.onDidChangeMarkers) {
            monaco.editor.onDidChangeMarkers(() => updateProblemsPanel());
            updateProblemsPanel();
        }
    }, 2000);
});

function checkDeployStatus() {
    fetch('/api/deploy/check').then(r=>r.json()).then(d=>{
        const btn = document.getElementById('btnDeploy');
        if (btn) {
            const platforms = [];
            if (d.netlify) platforms.push('Netlify');
            if (d.vercel) platforms.push('Vercel');
            if (d.railway) platforms.push('Railway');
            btn.title = platforms.length ? 'Deploy (' + platforms.join('/') + ')' : 'Nenhum deploy configurado';
        }
    }).catch(()=>{});
}

function loadData() {
    const raw = localStorage.getItem('cc_workspace');
    if (!raw) return;
    try {
        const data = JSON.parse(raw);
        files = data.files || {};
        chatId = data.chatId || null;

        // Update project name in titlebar
        if (data.project) {
            const label = document.getElementById('projectNameLabel');
            if (label) label.textContent = data.project;
            document.title = data.project + ' — VS Code';
        }

        if (data.preview) {
            document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(data.preview);
        }
        // Load snapshot for diff
        const snapRaw = localStorage.getItem('cc_workspace_snapshot');
        if (snapRaw) {
            try { previousFiles = JSON.parse(snapRaw); } catch { previousFiles = null; }
        }
        // If no snapshot exists, create one from current files
        if (!previousFiles && Object.keys(files).length) {
            previousFiles = JSON.parse(JSON.stringify(files));
            localStorage.setItem('cc_workspace_snapshot', JSON.stringify(previousFiles));
        }
        
        // Auto-open preview if we have an index.html
        autoOpenPreview();
        // Save version for undo
        saveVersion(files);
        // Load other projects in sidebar
        loadProjectsTree();
    } catch {}
}

// === COLLAPSABLE SIDEBAR SECTIONS ===
function toggleSection(section) {
    const isFiles = section === 'Files';
    const content = document.getElementById(isFiles ? 'fileTree' : 'projectsTree');
    const arrow = document.getElementById(isFiles ? 'arrowSectionFiles' : 'arrowSectionProjects');
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        arrow.classList.remove('collapsed');
        arrow.textContent = '▼';
    } else {
        content.style.display = 'none';
        arrow.classList.add('collapsed');
        arrow.textContent = '▶';
    }
}

async function loadProjectsTree() {
    const token = localStorage.getItem('cc_token');
    const tree = document.getElementById('projectsTree');
    const header = document.getElementById('projectsSectionHeader');
    if (!tree) return;

    if (!token) {
        if (header) header.style.display = 'none';
        tree.style.display = 'none';
        return;
    }

    try {
        const res = await fetch('/api/chats', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        const chats = data.chats || [];

        if (chats.length === 0) {
            tree.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.7rem">Nenhum outro projeto</div>';
            return;
        }

        tree.innerHTML = chats.map(c => {
            const isActive = c.id === chatId;
            return `
                <div class="projects-tree-item ${isActive ? 'active' : ''}" onclick="switchWorkspaceChat(${c.id})">
                    <span class="project-icon">💬</span>
                    <span class="project-name" title="${c.title}">${c.title}</span>
                    <span class="project-badge">Chat</span>
                </div>
            `;
        }).join('');
    } catch (e) {
        tree.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.7rem">Erro ao carregar projetos</div>';
    }
}

async function switchWorkspaceChat(newChatId) {
    if (newChatId === chatId) return;
    const token = localStorage.getItem('cc_token');
    if (!token) return;

    try {
        // Load files from server for chosen chat
        const res = await fetch(`/api/chats/${newChatId}/files`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();

        // Get chat title
        const chatRes = await fetch(`/api/chats/${newChatId}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const chatData = await chatRes.json();
        const chatTitle = chatData.chat?.title || 'meu-projeto';

        // Clean project name format
        const cleanName = chatTitle
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .substring(0, 30) || 'meu-projeto';

        // Update local variables
        chatId = newChatId;
        files = data.files || {};
        previousFiles = JSON.parse(JSON.stringify(files));

        // Save to localStorage workspace state
        localStorage.setItem('cc_workspace', JSON.stringify({
            chatId,
            project: cleanName,
            files,
            preview: files['index.html']?.content || ''
        }));
        localStorage.setItem('cc_workspace_snapshot', JSON.stringify(previousFiles));

        // Clear active editor and open tabs
        openFiles = [];
        activeFile = null;
        const tabsContainer = document.getElementById('tbTabs');
        if (tabsContainer) tabsContainer.innerHTML = '';
        if (editor) editor.setValue('');

        // Update labels
        const nameLabel = document.getElementById('projectNameLabel');
        if (nameLabel) nameLabel.textContent = cleanName.toUpperCase();
        document.title = cleanName + ' — VS Code';

        // Re-render and refresh
        renderFileTree();
        loadProjectsTree();

        // Open preview if index.html exists
        if (files['index.html']) {
            document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(files['index.html'].content);
            openFile('index.html');
        } else {
            document.getElementById('previewFrame').srcdoc = '';
        }
    } catch (e) {
        alert('Erro ao alternar de projeto: ' + e.message);
    }
}

window.toggleSection = toggleSection;
window.switchWorkspaceChat = switchWorkspaceChat;

// Build a self-contained srcdoc by inlining all referenced CSS and JS files
function buildPreviewSrcdoc(htmlContent) {
    if (!htmlContent) return '';
    let result = htmlContent;

    // Inline <link rel="stylesheet" href="..."> 
    result = result.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*\/?>/gi, (match, href) => {
        // Remove leading ./ or /
        const normalized = href.replace(/^\.?\//, '');
        const cssFile = getFileByPath(normalized);
        if (cssFile?.content) {
            return `<style>/* inlined: ${normalized} */\n${cssFile.content}\n</style>`;
        }
        return match; // keep original if not found
    });

    // Also catch <link href="..." rel="stylesheet">
    result = result.replace(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["'][^>]*\/?>/gi, (match, href) => {
        const normalized = href.replace(/^\.?\//, '');
        const cssFile = getFileByPath(normalized);
        if (cssFile?.content) {
            return `<style>/* inlined: ${normalized} */\n${cssFile.content}\n</style>`;
        }
        return match;
    });

    // Inline <script src="...">
    result = result.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
        const normalized = src.replace(/^\.?\//, '');
        // Skip external CDN scripts
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
            return match;
        }
        const jsFile = getFileByPath(normalized);
        if (jsFile?.content) {
            return `<script${pre}${post}>/* inlined: ${normalized} */\n${jsFile.content}\n</script>`;
        }
        return match;
    });

    return result;
}

function autoOpenPreview() {
    const panel = document.getElementById('previewPanel');
    const btn = document.getElementById('btnPreview');
    const frame = document.getElementById('previewFrame');
    if (!panel || !frame) return;
    
    // Already open? Skip.
    if (panel.style.display !== 'none') return;
    
    // Find index.html in root, app folder, or any HTML file
    let previewContent = null;
    
    const indexFile = files['index.html'];
    if (indexFile?.content) {
        previewContent = indexFile.content;
    } else {
        const appIndex = files['app']?.children?.['index.html'];
        if (appIndex?.content) {
            previewContent = appIndex.content;
        } else {
            const publicIndex = files['public']?.children?.['index.html'];
            if (publicIndex?.content) {
                previewContent = publicIndex.content;
            } else {
                const htmlFile = Object.entries(files).find(([name, f]) => 
                    (name.endsWith('.html') || name.endsWith('.htm')) && f?.content
                );
                if (htmlFile) previewContent = htmlFile[1].content;
            }
        }
    }
    
    if (!previewContent) return;
    
    frame.srcdoc = buildPreviewSrcdoc(previewContent);
    panel.style.display = 'flex';
    panel.classList.remove('hidden');
    if (btn) btn.style.background = 'rgba(255,255,255,0.1)';
    
    if (!window._previewAutoOpened) {
        window._previewAutoOpened = true;
        setTimeout(() => showToast('success', '👁️ Preview aberto automaticamente'), 500);
    }
}

// === MONACO EDITOR ===
let monacoReady = false;

function initMonaco() {
    if (typeof require === 'undefined') {
        // Monaco not loaded yet, retry
        setTimeout(initMonaco, 500);
        return;
    }
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    window.MonacoEnvironment = {
        getWorkerUrl: function(moduleId, label) {
            return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
                self.MonacoEnvironment = { baseUrl: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/' };
                importScripts('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/base/worker/workerMain.js');
            `)}`;
        }
    };
    require(['vs/editor/editor.main'], function() {
        monacoReady = true;
        if (activeTab) openFile(activeTab);
    });
}

function createMonacoEditor(content, language) {
    if (!monacoReady || !document.getElementById('monacoContainer')) return;

    if (monacoEditor) {
        monacoEditor.dispose();
        monacoEditor = null;
        document.getElementById('monacoContainer').innerHTML = '';
    }

    const container = document.getElementById('monacoContainer');
    monacoEditor = monaco.editor.create(container, {
        value: content || '',
        language: language || 'html',
        theme: 'vs-dark',
        minimap: { 
            enabled: true,
            showSlider: 'mouseover',
            renderCharacters: true,
            maxColumn: 120
        },
        fontSize: editorFontSize,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        lineNumbers: 'on',
        tabSize: 2,
        insertSpaces: true,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        renderWhitespace: 'selection',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true },
        autoIndent: 'full',
        formatOnPaste: true,
        padding: { top: 8, bottom: 8 },
        suggest: { showWords: true },
        quickSuggestions: true
    });

    monacoEditor.onDidChangeModelContent(() => {
        if (activeTab) {
            const val = monacoEditor.getValue();
            setFileContent(activeTab, val);
            modifiedFiles[activeTab] = true;
            renderTabs();
            updateStatusBar(activeTab, val);
            saveWorkspace();
            // Auto-save indicator
            const saveEl = document.getElementById('sbAutoSave');
            if (saveEl) {
                saveEl.textContent = '⟳ Salvando...';
                saveEl.style.color = '#dcdcaa';
                clearTimeout(saveStatusTimeout);
                saveStatusTimeout = setTimeout(() => {
                    saveEl.textContent = '✓ Salvo';
                    saveEl.style.color = '#4ec9b0';
                    setTimeout(() => { saveEl.textContent = ''; saveEl.style.color = ''; }, 2000);
                }, 400);
            }
            // Live preview: update when editing HTML/CSS/JS
            const panel = document.getElementById('previewPanel');
            if (panel && panel.style.display !== 'none') {
                const indexContent = files['index.html']?.content;
                if (indexContent) {
                    clearTimeout(window._previewDebounce);
                    window._previewDebounce = setTimeout(() => {
                        const frame = document.getElementById('previewFrame');
                        if (frame) frame.srcdoc = buildPreviewSrcdoc(indexContent);
                    }, 600);
                }
            }
            // Broadcast change to collaboration room
            sendCollabFileChange(activeTab, val);
        }
    });

    monacoEditor.onDidChangeCursorPosition((e) => {
        document.getElementById('sbCursor').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        // Broadcast cursor position to collaboration room
        sendCollabCursorUpdate(e.position.lineNumber, e.position.column, activeTab);
    });

    // Ctrl+S to save
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveCurrentFile();
    });

    // Fix: prevent default browser save dialog
    monacoEditor.onKeyDown((e) => {
        if (e.ctrlKey && e.keyCode === monaco.KeyCode.KeyS) {
            e.preventDefault();
        }
    });

    // Ctrl+Scroll to zoom
    monacoEditor.onKeyDown((e) => {
        if (e.ctrlKey && e.keyCode === monaco.KeyCode.Equal) {
            e.preventDefault();
            adjustFontSize(1);
        }
        if (e.ctrlKey && e.keyCode === monaco.KeyCode.Minus) {
            e.preventDefault();
            adjustFontSize(-1);
        }
        if (e.ctrlKey && e.keyCode === monaco.KeyCode.Digit0) {
            e.preventDefault();
            editorFontSize = 12;
            monacoEditor?.updateOptions({ fontSize: editorFontSize });
            updateZoomStatus();
        }
    });
    
    // Ctrl+Wheel zoom on container
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            adjustFontSize(e.deltaY > 0 ? -1 : 1);
        }
    }, { passive: false });

    // Trigger initial layout
    setTimeout(() => monacoEditor?.layout(), 100);
}

function getMonacoLanguage(ext) {
    const map = {
        html: 'html', htm: 'html', css: 'css', js: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', md: 'markdown',
        xml: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell',
        sql: 'sql', go: 'go', rs: 'rust', rust: 'rust', java: 'java',
        cpp: 'cpp', c: 'c', cs: 'csharp', php: 'php', rb: 'ruby',
        swift: 'swift', kt: 'kotlin', dart: 'dart', dockerfile: 'dockerfile',
        txt: 'plaintext', env: 'plaintext', gitignore: 'plaintext'
    };
    return map[ext] || 'plaintext';
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
            const checked = selectedFilesSet.has(path) ? 'checked' : '';
            html += `
                <div class="tree-item" style="--depth:${depth}" onclick="openFile('${path}')" data-path="${path}" oncontextmenu="showContext(event, '${path}', 'file')">
                    <input type="checkbox" class="tree-checkbox" ${checked} onclick="event.stopPropagation();toggleFileSelection('${path}')">
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

function flattenForSave(obj, prefix = '') {
    const result = {};
    for (const [name, file] of Object.entries(obj)) {
        const path = prefix ? prefix + '/' + name : name;
        if (file.type === 'folder') {
            Object.assign(result, flattenForSave(file.children || {}, path));
        } else if (file.content !== undefined) {
            result[path] = { content: file.content, size: file.content.length };
        }
    }
    return result;
}

function saveWorkspace() {
    try {
        const preview = document.getElementById('previewFrame')?.srcdoc || '';
        localStorage.setItem('cc_workspace', JSON.stringify({ chatId, files, preview }));
        saveVersion(files);
        
        // Sincroniza com o banco de dados do servidor
        if (chatId) {
            const token = localStorage.getItem('cc_token');
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            
            const flatFiles = flattenForSave(files);
            fetch('/api/chats/' + chatId + '/files', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ files: flatFiles })
            }).catch(e => console.error('Erro ao sincronizar arquivos com o banco:', e));
        }
    } catch {}
}

function isFileSelected(path) {
    return selectedFilesSet.has(path);
}

// === DIFF / CHANGES SYSTEM ===
// Compares current files vs snapshot (previousFiles)
function computeChanges() {
    const changes = { added: [], modified: [], deleted: [], total: 0 };
    if (!previousFiles) return changes;
    
    // Flatten function to get {path: content} map
    function flatten(obj, prefix) {
        const result = {};
        for (const [name, file] of Object.entries(obj)) {
            const path = prefix ? prefix + '/' + name : name;
            if (file.type === 'folder') {
                Object.assign(result, flatten(file.children || {}, path));
            } else if (file.content !== undefined) {
                result[path] = file.content;
            }
        }
        return result;
    }
    
    const currFlat = flatten(files, '');
    const prevFlat = flatten(previousFiles, '');
    const allPaths = new Set([...Object.keys(currFlat), ...Object.keys(prevFlat)]);
    
    for (const path of allPaths) {
        const currContent = currFlat[path];
        const prevContent = prevFlat[path];
        
        if (currContent !== undefined && prevContent === undefined) {
            // New file
            const lines = currContent.split('\n').length;
            changes.added.push({ path, linesAdded: lines });
            changes.total += lines;
        } else if (currContent === undefined && prevContent !== undefined) {
            // Deleted file
            const lines = prevContent.split('\n').length;
            changes.deleted.push({ path, linesRemoved: lines });
            changes.total += lines;
        } else if (currContent !== prevContent) {
            // Modified file - compute line-level diff
            const oldLines = prevContent.split('\n');
            const newLines = currContent.split('\n');
            let added = 0, removed = 0;
            
            // Simple LCS-based diff
            const maxLen = Math.max(oldLines.length, newLines.length);
            const minLen = Math.min(oldLines.length, newLines.length);
            
            // Count added/removed lines
            const oldSet = new Set(oldLines);
            const newSet = new Set(newLines);
            for (const line of newLines) { if (!oldSet.has(line)) added++; }
            for (const line of oldLines) { if (!newSet.has(line)) removed++; }
            
            changes.modified.push({ path, linesAdded: added, linesRemoved: removed });
            changes.total += added + removed;
        }
    }
    
    return changes;
}

function renderGitChanges() {
    const container = document.getElementById('gitChanges');
    if (!container) return;
    
    // Clean container
    container.innerHTML = '';
    
    const changes = computeChanges();
    const hasChanges = changes.added.length || changes.modified.length || changes.deleted.length;
    
    if (!hasChanges) {
        container.innerHTML = `
            <div class="git-section-title">Alterações</div>
            <div style="color:var(--muted);font-size:0.75rem;padding:8px">Nenhuma alteração</div>
            <div style="color:var(--muted);font-size:0.65rem;padding:4px 8px">
                ${previousFiles ? '✓ Snapshot atual' : 'ℹ Faça alterações no chat para ver o diff'}
            </div>`;
        return;
    }
    
    let html = `<div class="git-section-title">Alterações (${changes.added.length + changes.modified.length + changes.deleted.length} arquivos)</div>`;
    
    // New files (green)
    for (const f of changes.added) {
        const encodedPath = encodeURIComponent(f.path);
        html += `
            <div class="git-change-item added" onclick="openDiffView(decodeURIComponent('${encodedPath}'))" title="Ver diff">
                <span class="git-change-badge added">A</span>
                <span class="git-change-path">${escapeHtml(f.path)}</span>
                <span class="git-change-count added">+${f.linesAdded}</span>
            </div>`;
    }
    
    // Modified files (yellow)
    for (const f of changes.modified) {
        const encodedPath = encodeURIComponent(f.path);
        html += `
            <div class="git-change-item modified" onclick="openDiffView(decodeURIComponent('${encodedPath}'))" title="Ver diff">
                <span class="git-change-badge modified">M</span>
                <span class="git-change-path">${escapeHtml(f.path)}</span>
                <span class="git-change-count">
                    <span class="added">+${f.linesAdded}</span>
                    <span class="removed">-${f.linesRemoved}</span>
                </span>
            </div>`;
    }
    
    // Deleted files (red)
    for (const f of changes.deleted) {
        const encodedPath = encodeURIComponent(f.path);
        html += `
            <div class="git-change-item deleted" onclick="openDiffView(decodeURIComponent('${encodedPath}'))" title="Arquivo removido">
                <span class="git-change-badge deleted">D</span>
                <span class="git-change-path deleted">${escapeHtml(f.path)}</span>
                <span class="git-change-count removed">-${f.linesRemoved}</span>
            </div>`;
    }
    
    // Accept changes button
    html += `
        <div class="git-accept-bar">
            <button class="git-accept-btn" onclick="acceptChanges()">✓ Aceitar Alterações</button>
        </div>`;
    
    container.innerHTML = html;
}

function acceptChanges() {
    if (!Object.keys(files).length) return;
    previousFiles = JSON.parse(JSON.stringify(files));
    localStorage.setItem('cc_workspace_snapshot', JSON.stringify(previousFiles));
    renderGitChanges();
    showToast('success', '✓ Alterações aceitas. Novo snapshot salvo!');
    xtermWrite('✓ Snapshot atualizado - alterações aceitas\n', 'green');
}

// === MONACO DIFF EDITOR ===
function openDiffView(path) {
    const file = getFileByPath(path);
    const ext = path.split('.').pop().toLowerCase();
    const lang = getMonacoLanguage(ext);
    
    // Get old content from snapshot
    function findSnapshotContent(obj, path) {
        const parts = path.split('/');
        let current = obj;
        for (let i = 0; i < parts.length; i++) {
            if (!current || typeof current !== 'object') return null;
            if (current[parts[i]]) {
                if (i === parts.length - 1) return current[parts[i]]?.content;
                current = current[parts[i]]?.children || current[parts[i]];
            } else return null;
        }
        return null;
    }
    
    const oldContent = previousFiles ? (findSnapshotContent(previousFiles, path) || '') : '';
    const newContent = file?.content || '';
    
    if (!monacoReady) {
        showToast('info', 'Aguardando Monaco carregar...');
        return;
    }
    
    // Switch to diff mode
    const container = document.getElementById('monacoContainer');
    
    // Dispose existing editors and models
    if (diffOriginalModel) { diffOriginalModel.dispose(); diffOriginalModel = null; }
    if (diffModifiedModel) { diffModifiedModel.dispose(); diffModifiedModel = null; }
    if (monacoDiffEditor) {
        monacoDiffEditor.dispose();
        monacoDiffEditor = null;
    }
    if (monacoEditor) {
        monacoEditor.dispose();
        monacoEditor = null;
    }
    container.innerHTML = '';
    
    diffViewActive = true;
    
    // Create diff editor
    monacoDiffEditor = monaco.editor.createDiffEditor(container, {
        theme: 'vs-dark',
        fontSize: 12,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        enableSplitViewResizing: true,
        renderSideBySide: true,
        originalEditable: false,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'off'
    });
    
    diffOriginalModel = monaco.editor.createModel(oldContent, lang);
    diffModifiedModel = monaco.editor.createModel(newContent, lang);
    
    monacoDiffEditor.setModel({
        original: diffOriginalModel,
        modified: diffModifiedModel
    });
    
    // Update UI to show diff mode
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('codeEditor').style.display = 'flex';
    
    // Add a diff badge to breadcrumb
    document.getElementById('breadcrumb').innerHTML = `
        <span style="color:var(--muted)">📊 Diff:</span>
        <span style="color:var(--green)">${path}</span>
        <span style="color:var(--muted);font-size:0.6rem;margin-left:8px;background:#2d2d2d;padding:1px 6px;border-radius:3px">side-by-side</span>
        <button onclick="closeDiffView()" style="margin-left:8px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.65rem;text-decoration:underline">Fechar diff</button>
    `;
    
    if (!openTabs.includes(path)) openTabs.push(path);
    activeTab = path;
    renderTabs();
    selectTreeItem(path);
    
    setTimeout(() => monacoDiffEditor?.layout(), 100);
}

function closeDiffView() {
    if (diffOriginalModel) { diffOriginalModel.dispose(); diffOriginalModel = null; }
    if (diffModifiedModel) { diffModifiedModel.dispose(); diffModifiedModel = null; }
    if (monacoDiffEditor) {
        monacoDiffEditor.dispose();
        monacoDiffEditor = null;
    }
    diffViewActive = false;
    if (activeTab) {
        openFile(activeTab);
    } else {
        document.getElementById('welcomeScreen').style.display = 'flex';
        document.getElementById('codeEditor').style.display = 'none';
        document.getElementById('breadcrumb').innerHTML = '<span style="color:var(--muted)">Selecione um arquivo</span>';
    }
}

function openFile(path) {
    const file = getFileByPath(path);
    if (!file || !file.content) return;

    if (!openTabs.includes(path)) openTabs.push(path);
    activeTab = path;

    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('codeEditor').style.display = 'flex';

    const ext = path.split('.').pop().toLowerCase();
    const lang = getMonacoLanguage(ext);

    if (monacoReady) {
        createMonacoEditor(file.content, lang);
    } else {
        // Fallback: show content in a simple div
        document.getElementById('monacoContainer').innerHTML = `<pre style="padding:16px;color:var(--text);font-family:monospace;font-size:12px;overflow:auto;height:100%;white-space:pre">${escapeHtml(file.content)}</pre>`;
    }

    renderTabs();
    updateBreadcrumb(path);
    updateStatusBar(path, file.content);
    selectTreeItem(path);
    
    // Clean up remote cursors from other files
    removeAllRemoteCursors();
}

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
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
            if (monacoEditor) { monacoEditor.dispose(); monacoEditor = null; document.getElementById('monacoContainer').innerHTML = ''; }
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
    const ext = path.split('.').pop();
    const langMap = { html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', json: 'JSON', py: 'Python', md: 'Markdown', txt: 'Text', yaml: 'YAML', yml: 'YAML', sql: 'SQL', go: 'Go', rs: 'Rust', java: 'Java', php: 'PHP', rb: 'Ruby', sh: 'Shell', bash: 'Shell', dockerfile: 'Dockerfile' };
    document.getElementById('sbLanguage').textContent = langMap[ext] || ext.toUpperCase();
}

function saveCurrentFile() {
    if (!activeTab) return;
    if (modifiedFiles[activeTab]) {
        delete modifiedFiles[activeTab];
        renderTabs();
        saveWorkspace();
        showToast('success', `${activeTab.split('/').pop()} salvo`);
        xtermWrite(`✓ ${activeTab.split('/').pop()} salvo\n`, 'green');
    }
}

// === ZOOM ===
function adjustFontSize(delta) {
    editorFontSize = Math.max(8, Math.min(40, editorFontSize + delta));
    if (monacoEditor) monacoEditor.updateOptions({ fontSize: editorFontSize });
    if (monacoEditor2) monacoEditor2.updateOptions({ fontSize: editorFontSize });
    updateZoomStatus();
}

function updateZoomStatus() {
    const el = document.getElementById('sbZoom');
    if (el) el.textContent = `${editorFontSize}px`;
}

// === DOWNLOAD SELECTED FILES ===
function toggleFileSelection(path) {
    if (selectedFilesSet.has(path)) {
        selectedFilesSet.delete(path);
    } else {
        selectedFilesSet.add(path);
    }
    renderFileTree();
}

function downloadSelectedFiles() {
    if (!selectedFilesSet.size) {
        showToast('info', 'Selecione arquivos clicando nos checkboxes');
        return;
    }
    const zip = new JSZip();
    for (const path of selectedFilesSet) {
        const file = getFileByPath(path);
        if (file?.content) zip.file(path, file.content);
    }
    zip.generateAsync({ type: 'blob' }).then(blob => {
        downloadBlob(blob, 'selected-files.zip');
        showToast('success', `${selectedFilesSet.size} arquivo(s) baixados 📦`);
        selectedFilesSet.clear();
        renderFileTree();
    });
}

// === SNIPPETS / TEMPLATES ===
const FILE_TEMPLATES = {
    'HTML Básico': {
        files: { 
            'index.html': { content: '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Meu Projeto</title>\n  <link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n  <h1>Olá, Mundo!</h1>\n  <script src="js/app.js"></script>\n</body>\n</html>' },
            'css/style.css': { content: '*{margin:0;padding:0;box-sizing:border-box}\nbody{font-family:sans-serif;background:#0a0a12;color:#e8e8f0}' },
            'js/app.js': { content: 'console.log(\'App iniciado\');\n' } }
    },
    'React + Vite': {
        files: {
            'index.html': { content: '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>React App</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>' },
            'package.json': { content: '{\n  "name": "react-app",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "react": "^18.3.1",\n    "react-dom": "^18.3.1"\n  },\n  "devDependencies": {\n    "@vitejs/plugin-react": "^4.3.0",\n    "vite": "^5.4.0"\n  }\n}' },
            'vite.config.js': { content: 'import { defineConfig } from \'vite\';\nimport react from \'@vitejs/plugin-react\';\nexport default defineConfig({ plugins: [react()] });\n' },
            'src/main.jsx': { content: 'import React from \'react\';\nimport ReactDOM from \'react-dom/client\';\nimport App from \'./App\';\nimport \'./App.css\';\nReactDOM.createRoot(document.getElementById(\'root\')).render(<React.StrictMode><App /></React.StrictMode>);\n' },
            'src/App.jsx': { content: 'import React from \'react\';\nexport default function App() {\n  return <div className="app"><h1>React App</h1></div>;\n}' },
            'src/App.css': { content: '.app { font-family: sans-serif; text-align: center; padding: 40px; color: #e8e8f0; background: #0a0a12; min-height: 100vh; }\n' }
        }
    },
    'Dashboard': {
        files: {
            'index.html': { content: '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Dashboard</title>\n  <link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n  <aside class="sidebar">...</aside>\n  <main>\n    <div class="header"><h1>Dashboard</h1></div>\n    <div class="cards">...</div>\n    <div class="chart">...</div>\n  </main>\n  <script src="js/app.js"></script>\n</body>\n</html>' },
            'css/style.css': { content: '/* Dashboard styles */' },
            'js/app.js': { content: '// Dashboard script' }
        }
    },
    'Node.js API': {
        files: {
            'package.json': { content: '{\n  "name": "api-server",\n  "version": "1.0.0",\n  "main": "server.js",\n  "scripts": {\n    "start": "node server.js"\n  },\n  "dependencies": {\n    "express": "^4.21.0"\n  }\n}' },
            'server.js': { content: 'const express = require(\'express\');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(express.json());\n\napp.get(\'/api/health\', (req, res) => {\n  res.json({ status: \'ok\' });\n});\n\napp.listen(PORT, () => {\n  console.log(`Server running on port ${PORT}`);\n});\n' },
            '.env.example': { content: 'PORT=3000\n' }
        }
    }
};

function newFromTemplate() {
    const names = Object.keys(FILE_TEMPLATES);
    let msg = 'Escolha um template:\n\n';
    names.forEach((n, i) => { msg += `${i + 1}. ${n}\n`; });
    msg += '\nDigite o número:';
    const choice = prompt(msg);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (isNaN(idx) || !FILE_TEMPLATES[names[idx]]) {
        showToast('error', 'Opção inválida');
        return;
    }
    const template = FILE_TEMPLATES[names[idx]];
    // Merge template files into project
    function mergeTemplate(target, source) {
        for (const [path, file] of Object.entries(source)) {
            const parts = path.split('/');
            if (parts.length === 1) {
                target[path] = file.type === 'folder' ? file : { type: 'file', content: file.content, size: file.content?.length };
            } else {
                let current = target;
                for (let i = 0; i < parts.length - 1; i++) {
                    const dir = parts[i];
                    if (!current[dir] || current[dir].type !== 'folder') {
                        current[dir] = { type: 'folder', children: {} };
                    }
                    current = current[dir].children;
                }
                current[parts[parts.length - 1]] = { type: 'file', content: file.content, size: file.content?.length };
            }
        }
    }
    mergeTemplate(files, template.files);
    saveWorkspace();
    renderFileTree();
    // Open first file
    const firstFile = Object.keys(template.files)[0];
    if (firstFile) openFile(firstFile);
    showToast('success', `Template "${names[idx]}" criado! 🎉`);
    xtermWrite(`✓ Template "${names[idx]}" adicionado ao projeto\n`, 'green');
}

// === PROBLEMAS / LINT ===
function updateProblemsPanel() {
    const panel = document.getElementById('problemsPanel');
    const tab = document.getElementById('pproblems');
    if (!panel) return;
    
    if (!monaco.editor || !monaco.editor.getModelMarkers) {
        panel.innerHTML = '<div class="terminal"><div class="term-line ok">✓ Nenhum problema encontrado</div></div>';
        return;
    }
    
    const markers = monaco.editor.getModelMarkers({});
    const errors = markers.filter(m => m.severity === 8);
    const warnings = markers.filter(m => m.severity === 4);
    const infos = markers.filter(m => m.severity === 2 || m.severity === 1);
    
    const total = markers.length;
    if (tab) {
        tab.textContent = total ? `PROBLEMAS (${total})` : 'PROBLEMAS';
        tab.style.color = errors.length ? '#f44747' : warnings.length ? '#dcdcaa' : '';
    }
    
    if (!total) {
        panel.innerHTML = '<div class="terminal"><div class="term-line ok">✓ Nenhum problema encontrado</div></div>';
        return;
    }
    
    let html = '<div class="terminal">';
    for (const m of markers) {
        const sev = m.severity === 8 ? 'error' : m.severity === 4 ? 'warn' : 'info';
        html += `<div class="term-line ${sev}">[${sev.toUpperCase()}] ${escapeHtml(m.message)} <span style="color:var(--muted);font-size:0.65rem">(${m.startLineNumber}:${m.startColumn})</span></div>`;
    }
    html += '</div>';
    panel.innerHTML = html;
}

// === SPLIT EDITOR ===
function toggleSplitEditor() {
    if (!monacoReady || !monacoEditor) {
        showToast('info', 'Abra um arquivo primeiro');
        return;
    }
    
    if (splitEditorActive) {
        closeSplitEditor();
        return;
    }
    
    const container = document.getElementById('monacoContainer');
    container.classList.add('split');
    
    // Create second editor
    const splitDiv = document.createElement('div');
    splitDiv.className = 'split-editor-right';
    splitDiv.id = 'splitEditorRight';
    container.appendChild(splitDiv);
    
    // Get the content from the current editor
    const currentContent = monacoEditor.getValue();
    const currentLang = getMonacoLanguage(activeTab?.split('.').pop() || '');
    
    // Create second editor
    monacoEditor2 = monaco.editor.create(splitDiv, {
        value: currentContent,
        language: currentLang,
        theme: 'vs-dark',
        fontSize: editorFontSize,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        lineNumbers: 'on',
        tabSize: 2,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off'
    });
    
    splitEditorActive = true;
    showToast('success', '📐 Editor dividido. Abra outro arquivo na direita.');
}

function closeSplitEditor() {
    if (monacoEditor2) {
        monacoEditor2.dispose();
        monacoEditor2 = null;
    }
    const rightEl = document.getElementById('splitEditorRight');
    if (rightEl) rightEl.remove();
    const container = document.getElementById('monacoContainer');
    if (container) container.classList.remove('split');
    splitEditorActive = false;
}

// === VERSION HISTORY (Undo do Chat) ===
function saveVersion(filesSnapshot) {
    if (!filesSnapshot || !Object.keys(filesSnapshot).length) return;
    // Check if different from latest
    if (versionHistory.length > 0) {
        const last = versionHistory[versionHistory.length - 1];
        if (JSON.stringify(last.files) === JSON.stringify(filesSnapshot)) return;
    }
    versionHistory.push({
        timestamp: new Date().toISOString(),
        files: JSON.parse(JSON.stringify(filesSnapshot))
    });
    versionIndex = versionHistory.length - 1;
    // Keep max 20 versions
    if (versionHistory.length > 20) {
        versionHistory.shift();
    }
    localStorage.setItem('cc_version_history', JSON.stringify(versionHistory));
}

function loadVersionHistory() {
    try {
        const raw = localStorage.getItem('cc_version_history');
        if (raw) {
            versionHistory = JSON.parse(raw);
            versionIndex = versionHistory.length - 1;
        }
    } catch {}
}

function undoToPreviousVersion() {
    if (versionHistory.length < 2) {
        showToast('info', 'Apenas uma versão disponível');
        return;
    }
    // Go back one version
    const targetIdx = Math.max(0, versionIndex - 1);
    const target = versionHistory[targetIdx];
    if (!target) return;
    
    files = JSON.parse(JSON.stringify(target.files));
    versionIndex = targetIdx;
    saveWorkspace();
    renderFileTree();
    renderGitChanges();
    if (activeTab) openFile(activeTab);
    showToast('success', `⏪ Versão restaurada: ${new Date(target.timestamp).toLocaleString('pt-BR')}`);
}

function showVersionSlider() {
    if (!versionHistory.length) {
        showToast('info', 'Nenhum histórico de versões');
        return;
    }
    // Simple approach: show a list in the terminal
    xtermWrite('\r\n\x1b[33m=== Histórico de Versões ===\x1b[0m\r\n');
    versionHistory.forEach((v, i) => {
        const count = Object.keys(v.files).length;
        const time = new Date(v.timestamp).toLocaleString('pt-BR');
        const arrow = i === versionIndex ? ' ← atual' : '';
        xtermWrite(`  [${i + 1}] ${time} (${count} arquivos)${arrow}\r\n`);
    });
    xtermWrite('\x1b[90mDigite: restore <n> para restaurar\x1b[0m\r\n');
}

// === DESIGN MODE VISUAL ===
let designModeActive = false;
let designSelectedComponent = null;
let designCanvasElement = null;

const DESIGN_COMPONENTS = {
    'Layout': [
        { name: 'Container', icon: '📦', html: '<div class="container">\n    <!-- conteúdo -->\n</div>' },
        { name: 'Section', icon: '📐', html: '<section class="section">\n    <div class="container">\n        \n    </div>\n</section>' },
        { name: 'Grid 2 Colunas', icon: '🔲', html: '<div class="grid grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">\n    <div class="card"></div>\n    <div class="card"></div>\n</div>' },
        { name: 'Grid 3 Colunas', icon: '🔳', html: '<div class="grid grid-3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">\n    <div class="card"></div>\n    <div class="card"></div>\n    <div class="card"></div>\n</div>' },
        { name: 'Flex Row', icon: '➡️', html: '<div class="flex-row" style="display:flex;gap:12px;flex-wrap:wrap">\n    <div style="flex:1;min-width:200px"></div>\n    <div style="flex:1;min-width:200px"></div>\n</div>' },
        { name: 'Flex Center', icon: '🎯', html: '<div style="display:flex;align-items:center;justify-content:center;padding:20px">\n    \n</div>' },
    ],
    'Texto': [
        { name: 'Heading H1', icon: 'H1', html: '<h1>Título Principal</h1>' },
        { name: 'Heading H2', icon: 'H2', html: '<h2>Título da Seção</h2>' },
        { name: 'Heading H3', icon: 'H3', html: '<h3>Subtítulo</h3>' },
        { name: 'Parágrafo', icon: '¶', html: '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>' },
        { name: 'Texto Pequeno', icon: '•', html: '<small style="color:var(--muted)">Texto auxiliar ou legenda</small>' },
        { name: 'Lista', icon: '📋', html: '<ul>\n    <li>Item 1</li>\n    <li>Item 2</li>\n    <li>Item 3</li>\n</ul>' },
    ],
    'Botões': [
        { name: 'Botão Primário', icon: '🔵', html: '<button class="btn btn-primary" style="padding:10px 24px;background:#7c5cfc;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600">Clique Aqui</button>' },
        { name: 'Botão Secundário', icon: '⚪', html: '<button class="btn btn-secondary" style="padding:10px 24px;background:transparent;color:#333;border:2px solid #7c5cfc;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600">Saiba Mais</button>' },
        { name: 'Botão Ghost', icon: '👻', html: '<button class="btn btn-ghost" style="padding:8px 20px;background:none;border:none;color:#7c5cfc;cursor:pointer;font-size:0.85rem">Link →</button>' },
        { name: 'Grupo Botões', icon: '🔗', html: '<div style="display:flex;gap:8px;flex-wrap:wrap">\n    <button class="btn-primary" style="padding:10px 24px;background:#7c5cfc;color:#fff;border:none;border-radius:8px;cursor:pointer">Começar</button>\n    <button class="btn-secondary" style="padding:10px 24px;background:transparent;border:2px solid #7c5cfc;border-radius:8px;cursor:pointer">Ver Mais</button>\n</div>' },
    ],
    'Cards': [
        { name: 'Card Simples', icon: '🃏', html: '<div class="card" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">\n    <h3>Título do Card</h3>\n    <p style="color:#6b7280;font-size:0.85rem;margin-top:8px">Descrição do card com informações relevantes.</p>\n</div>' },
        { name: 'Card com Imagem', icon: '🖼️', html: '<div class="card" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">\n    <div style="height:140px;background:linear-gradient(135deg,#7c5cfc,#f472b6)"></div>\n    <div style="padding:16px">\n        <h3>Título</h3>\n        <p style="color:#6b7280;font-size:0.8rem">Descrição</p>\n    </div>\n</div>' },
        { name: 'Card de Preço', icon: '💎', html: '<div class="pricing-card" style="background:#fff;border:2px solid #7c5cfc;border-radius:12px;padding:24px;text-align:center;box-shadow:0 4px 20px rgba(124,92,252,0.1)">\n    <h3 style="color:#6b7280;font-size:0.85rem;text-transform:uppercase">Pro</h3>\n    <div style="font-size:2rem;font-weight:800;margin:12px 0">R$49<span style="font-size:0.8rem;font-weight:400;color:#6b7280">/mês</span></div>\n    <button style="padding:10px 24px;background:#7c5cfc;color:#fff;border:none;border-radius:8px;cursor:pointer;width:100%;font-weight:600">Assinar</button>\n</div>' },
    ],
    'Formulário': [
        { name: 'Input Texto', icon: '✏️', html: '<div class="form-group" style="margin-bottom:12px">\n    <label style="display:block;font-size:0.8rem;margin-bottom:4px;color:#374151">Nome</label>\n    <input type="text" placeholder="Seu nome" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.85rem">\n</div>' },
        { name: 'Textarea', icon: '📄', html: '<div class="form-group" style="margin-bottom:12px">\n    <label style="display:block;font-size:0.8rem;margin-bottom:4px;color:#374151">Mensagem</label>\n    <textarea rows="4" placeholder="Digite sua mensagem..." style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.85rem;resize:vertical"></textarea>\n</div>' },
        { name: 'Select', icon: '▼', html: '<div class="form-group" style="margin-bottom:12px">\n    <label style="display:block;font-size:0.8rem;margin-bottom:4px;color:#374151">Opções</label>\n    <select style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.85rem;background:#fff">\n        <option>Opção 1</option>\n        <option>Opção 2</option>\n        <option>Opção 3</option>\n    </select>\n</div>' },
        { name: 'Formulário Completo', icon: '📝', html: '<form style="max-width:400px;margin:0 auto">\n    <div style="margin-bottom:12px">\n        <label style="display:block;font-size:0.8rem;margin-bottom:4px;color:#374151">Email</label>\n        <input type="email" placeholder="seu@email.com" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.85rem">\n    </div>\n    <div style="margin-bottom:16px">\n        <label style="display:block;font-size:0.8rem;margin-bottom:4px;color:#374151">Mensagem</label>\n        <textarea rows="3" placeholder="Digite sua mensagem..." style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.85rem"></textarea>\n    </div>\n    <button type="submit" style="width:100%;padding:12px;background:#7c5cfc;color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer">Enviar</button>\n</form>' },
    ],
    'Navegação': [
        { name: 'Navbar', icon: '🧭', html: '<nav style="display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:#fff;border-bottom:1px solid #e5e7eb">\n    <div style="font-weight:700;font-size:1.1rem">Logo</div>\n    <div style="display:flex;gap:16px">\n        <a href="#" style="color:#6b7280;text-decoration:none;font-size:0.85rem">Início</a>\n        <a href="#" style="color:#6b7280;text-decoration:none;font-size:0.85rem">Sobre</a>\n        <a href="#" style="color:#6b7280;text-decoration:none;font-size:0.85rem">Contato</a>\n    </div>\n</nav>' },
        { name: 'Footer', icon: '🦶', html: '<footer style="background:#1f2937;color:#fff;padding:40px 24px;text-align:center">\n    <div style="font-size:0.85rem;opacity:0.8">© 2026 Meu Site. Todos os direitos reservados.</div>\n    <div style="display:flex;justify-content:center;gap:16px;margin-top:12px">\n        <a href="#" style="color:#9ca3af;text-decoration:none;font-size:0.8rem">Privacidade</a>\n        <a href="#" style="color:#9ca3af;text-decoration:none;font-size:0.8rem">Termos</a>\n    </div>\n</footer>' },
    ],
    'Hero & Seções': [
        { name: 'Hero Simples', icon: '⭐', html: '<section style="text-align:center;padding:60px 24px;background:linear-gradient(135deg,#f0f0ff,#fff)">\n    <h1 style="font-size:2.5rem;font-weight:800;margin-bottom:12px">Título Principal</h1>\n    <p style="font-size:1.05rem;color:#6b7280;max-width:500px;margin:0 auto 24px">Descrição impactante do seu produto ou serviço.</p>\n    <button style="padding:12px 28px;background:#7c5cfc;color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer">Começar Agora →</button>\n</section>' },
        { name: 'Features 3 Col', icon: '✨', html: '<section style="padding:60px 24px">\n    <h2 style="text-align:center;font-size:1.8rem;font-weight:700;margin-bottom:32px">Nossos Recursos</h2>\n    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;max-width:900px;margin:0 auto">\n        <div style="text-align:center;padding:20px">\n            <div style="font-size:2rem;margin-bottom:8px">⚡</div>\n            <h3 style="font-size:1rem;margin-bottom:4px">Rápido</h3>\n            <p style="font-size:0.8rem;color:#6b7280">Performance excepcional</p>\n        </div>\n        <div style="text-align:center;padding:20px">\n            <div style="font-size:2rem;margin-bottom:8px">🔒</div>\n            <h3 style="font-size:1rem;margin-bottom:4px">Seguro</h3>\n            <p style="font-size:0.8rem;color:#6b7280">Proteção de dados</p>\n        </div>\n        <div style="text-align:center;padding:20px">\n            <div style="font-size:2rem;margin-bottom:8px">🚀</div>\n            <h3 style="font-size:1rem;margin-bottom:4px">Escalável</h3>\n            <p style="font-size:0.8rem;color:#6b7280">Cresça sem limites</p>\n        </div>\n    </div>\n</section>' },
        { name: 'Depoimentos', icon: '💬', html: '<section style="padding:60px 24px;background:#f9fafb">\n    <h2 style="text-align:center;font-size:1.8rem;font-weight:700;margin-bottom:32px">O que dizem</h2>\n    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;max-width:700px;margin:0 auto">\n        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px">\n            <p style="font-style:italic;font-size:0.85rem;color:#4b5563">"Produto incrível! Mudou minha vida."</p>\n            <div style="margin-top:10px;font-size:0.8rem;font-weight:600">— Cliente Feliz</div>\n        </div>\n        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px">\n            <p style="font-style:italic;font-size:0.85rem;color:#4b5563">"Simplesmente fantástico. Recomendo!"</p>\n            <div style="margin-top:10px;font-size:0.8rem;font-weight:600">— Usuário Satisfeito</div>\n        </div>\n    </div>\n</section>' },
        { name: 'CTA Section', icon: '🎯', html: '<section style="text-align:center;padding:60px 24px;background:linear-gradient(135deg,#7c5cfc,#f472b6);color:#fff">\n    <h2 style="font-size:2rem;font-weight:800;margin-bottom:8px">Pronto para começar?</h2>\n    <p style="opacity:0.9;margin-bottom:24px;font-size:1.05rem">Junte-se a milhares de usuários satisfeitos</p>\n    <button style="padding:14px 36px;background:#fff;color:#7c5cfc;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer">Começar Grátis →</button>\n</section>' },
    ],
    'Mídia': [
        { name: 'Imagem', icon: '🖼️', html: '<img src="https://via.placeholder.com/400x250" alt="Descrição" style="max-width:100%;border-radius:8px">' },
        { name: 'Vídeo Embed', icon: '▶️', html: '<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px">\n    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none" allowfullscreen></iframe>\n</div>' },
        { name: 'Ícone + Texto', icon: '🔤', html: '<div style="display:flex;align-items:center;gap:8px">\n    <span style="font-size:1.5rem">🚀</span>\n    <span style="font-size:0.9rem">Texto com ícone</span>\n</div>' },
    ]
};

function enterDesignMode() {
    designModeActive = true;
    renderDesignPalette('');
    renderDesignCanvas();
    document.getElementById('previewPanel').style.display = 'flex';
    document.getElementById('previewPanel').style.width = '50%';
    document.getElementById('btnPreview').style.background = 'rgba(255,255,255,0.1)';
}

function closeDesignMode() {
    designModeActive = false;
    designSelectedComponent = null;
    designCanvasElement = null;
    document.getElementById('designPalette').innerHTML = '';
    // Hide design canvas if exists
    const canvasWrap = document.getElementById('designCanvasWrap');
    if (canvasWrap) canvasWrap.remove();
    // Restore editor container visibility
    const editorContainer = document.querySelector('.editor-container');
    if (editorContainer) editorContainer.style.display = '';
    // Close properties panel
    const propsPanel = document.getElementById('designProps');
    if (propsPanel) propsPanel.remove();
    // Restore preview if it was auto-opened
    const previewPanel = document.getElementById('previewPanel');
    if (previewPanel) previewPanel.style.width = '40%';
    // Show welcome or current file
    if (activeTab) {
        document.getElementById('welcomeScreen').style.display = 'none';
        document.getElementById('codeEditor').style.display = 'flex';
    } else {
        document.getElementById('welcomeScreen').style.display = 'flex';
        document.getElementById('codeEditor').style.display = 'none';
    }
    switchActivity('explorer');
}

function renderDesignPalette(filter) {
    const container = document.getElementById('designPalette');
    if (!container) return;
    
    let html = '';
    const q = (filter || '').toLowerCase().trim();
    
    for (const [category, items] of Object.entries(DESIGN_COMPONENTS)) {
        const filtered = q ? items.filter(it => it.name.toLowerCase().includes(q)) : items;
        if (q && !filtered.length && !category.toLowerCase().includes(q)) continue;
        
        const showing = q ? filtered : items;
        const catId = 'dcat-' + category.replace(/[^a-z0-9]/gi, '-');
        
        html += `<div class="design-category">
            <div class="design-cat-title" onclick="toggleDesignCategory('${catId}')">
                <span class="design-cat-arrow open" id="darrow-${catId}">▶</span>
                ${category}
            </div>
            <div class="design-items open" id="${catId}">`;
        
        for (const comp of showing) {
            const selected = designSelectedComponent?.name === comp.name ? 'selected' : '';
            html += `<div class="design-item ${selected}" draggable="true" 
                onclick="selectDesignComponent('${escapeHtml(comp.name)}')" 
                ondblclick="insertDesignComponent()"
                ondragstart="handleDesignDragStart(event, '${escapeHtml(comp.name)}', '${escapeHtml(comp.icon)}')">
                <span class="design-item-icon">${comp.icon}</span>
                <span class="design-item-name">${comp.name}</span>
            </div>`;
        }
        
        html += '</div></div>';
    }
    
    container.innerHTML = html || '<div style="padding:20px;text-align:center;color:var(--muted);font-size:0.75rem">Nenhum componente encontrado</div>';
}

function toggleDesignCategory(id) {
    const el = document.getElementById(id);
    const arrow = document.getElementById('darrow-' + id);
    if (el) el.classList.toggle('open');
    if (arrow) arrow.classList.toggle('open');
}

function filterDesignComponents(query) {
    renderDesignPalette(query);
}

function selectDesignComponent(name) {
    // Find the component
    for (const items of Object.values(DESIGN_COMPONENTS)) {
        const found = items.find(c => c.name === name);
        if (found) {
            designSelectedComponent = found;
            break;
        }
    }
    renderDesignPalette(document.getElementById('designSearch')?.value || '');
}

function insertDesignComponent() {
    if (!designSelectedComponent) {
        showToast('info', 'Clique em um componente da lista para selecionar');
        return;
    }
    
    const comp = designSelectedComponent;
    
    // If files has index.html, append to it, otherwise create it
    const indexFile = files['index.html'];
    if (indexFile) {
        // Append component before closing body tag or at end
        let content = indexFile.content;
        if (content.includes('</body>')) {
            content = content.replace('</body>', '  ' + comp.html + '\n</body>');
        } else if (content.includes('</html>')) {
            content = content.replace('</html>', '  ' + comp.html + '\n</html>');
        } else {
            content += '\n' + comp.html;
        }
        indexFile.content = content;
    } else {
        // Create index.html with the component
        files['index.html'] = {
            type: 'file',
            content: `<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Meu Site</title>\n  <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;color:#1f2937;line-height:1.6}</style>\n</head>\n<body>\n  ${comp.html}\n</body>\n</html>`
        };
    }
    
    saveWorkspace();
    renderFileTree();
    if (activeTab === 'index.html' || !activeTab) {
        openFile('index.html');
    }
    renderDesignCanvas();
    // Update preview
    const indexContent = files['index.html']?.content;
    if (indexContent) {
        document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(indexContent);
    }
    showToast('success', `${comp.icon} ${comp.name} inserido!`);
    xtermWrite(`✓ Componente "${comp.name}" inserido no index.html\n`, 'green');
}

function renderDesignCanvas() {
    let canvasWrap = document.getElementById('designCanvasWrap');
    if (!canvasWrap) {
        canvasWrap = document.createElement('div');
        canvasWrap.id = 'designCanvasWrap';
        canvasWrap.className = 'design-canvas-wrap';
        
        // Insert after the editor container
        const editorContainer = document.querySelector('.editor-container');
        if (editorContainer) {
            editorContainer.parentNode.insertBefore(canvasWrap, editorContainer.nextSibling);
        }
    }
    
    canvasWrap.classList.add('active');
    document.querySelector('.editor-container').style.display = 'none';
    
    const indexFile = files['index.html'];
    let htmlContent = '';
    if (indexFile?.content) {
        // Extract body content for the canvas
        const bodyMatch = indexFile.content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        htmlContent = bodyMatch ? bodyMatch[1] : indexFile.content;
    }
    
    if (!htmlContent) {
        htmlContent = '<div style="text-align:center;padding:60px;color:#6b7280"><h2 style="font-size:1.2rem;margin-bottom:8px">🎨 Canvas Vazio</h2><p style="font-size:0.85rem">Selecione um componente na paleta e clique em "Inserir no Código"</p></div>';
    }
    
    canvasWrap.innerHTML = `
        <div class="design-canvas-header">
            <span>🎨 Canvas Visual</span>
            <span class="badge">Clique para selecionar • Duplo clique para editar</span>
            <div style="flex:1"></div>
            <button class="tb-btn" onclick="syncDesignToCode()" title="Sincronizar com código">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                Sincronizar
            </button>
            <button class="tb-btn" onclick="closeDesignMode()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Sair
            </button>
        </div>
        <div class="design-canvas" id="designCanvas">
            <div class="design-canvas-inner" id="designCanvasInner">
                ${htmlContent}
            </div>
        </div>
    `;
    
    // Add properties panel
    let propsPanel = document.getElementById('designProps');
    if (!propsPanel) {
        propsPanel = document.createElement('div');
        propsPanel.id = 'designProps';
        propsPanel.className = 'design-props';
        document.querySelector('.vscode-body')?.appendChild(propsPanel);
    }
    
    // Setup canvas interactions after render
    setTimeout(setupDesignCanvas, 100);
    updateDesignProperties(null);
}

function setupDesignCanvas() {
    const canvas = document.getElementById('designCanvasInner');
    if (!canvas) return;
    // Remove old toolbars
    document.querySelectorAll('.design-toolbar').forEach(t => t.remove());
    
    // Click handler for element selection
    canvas.addEventListener('click', (e) => {
        // Ignore clicks on the canvas itself
        if (e.target === canvas) {
            selectDesignElement(null);
            return;
        }
        // Find the clicked element (not text nodes)
        let target = e.target;
        while (target && target !== canvas) {
            if (target.nodeType === 1) { // Element node
                selectDesignElement(target);
                e.stopPropagation();
                return;
            }
            target = target.parentElement;
        }
        selectDesignElement(null);
    });
    
    // Double-click for inline editing
    canvas.addEventListener('dblclick', (e) => {
        let target = e.target;
        while (target && target !== canvas) {
            if (target.nodeType === 1) {
                editDesignElement(target);
                return;
            }
            target = target.parentElement;
        }
    });
    
    // Mouseover for hover effect
    let hoverTarget = null;
    canvas.addEventListener('mouseover', (e) => {
        if (hoverTarget) hoverTarget.classList.remove('ds-hover');
        let target = e.target;
        while (target && target !== canvas) {
            if (target.nodeType === 1 && target !== canvas) {
                target.classList.add('ds-hover');
                hoverTarget = target;
                return;
            }
            target = target.parentElement;
        }
    });
    
    // === DRAG & DROP: Canvas aceita drops da paleta ===
    canvas.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvas.classList.add('drag-over');
        
        // Show insertion indicator at mouse position
        showCanvasDropIndicator(canvas, e.clientX, e.clientY);
    });
    
    canvas.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvas.classList.add('drag-over');
    });
    
    canvas.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only remove if actually leaving the canvas
        if (!canvas.contains(e.relatedTarget)) {
            canvas.classList.remove('drag-over');
            removeCanvasDropIndicator();
        }
    });
    
    canvas.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvas.classList.remove('drag-over');
        removeCanvasDropIndicator();
        
        const compName = e.dataTransfer.getData('text/design-component');
        if (compName) {
            // Find component by name
            for (const items of Object.values(DESIGN_COMPONENTS)) {
                const found = items.find(c => c.name === compName);
                if (found) {
                    insertComponentAtPosition(canvas, found, e.clientX, e.clientY);
                    break;
                }
            }
        }
    });
    
    // === DRAG & DROP: Reordenação de elementos DENTRO do canvas ===
    // Make child elements draggable for reordering
    makeCanvasElementsDraggable(canvas);
}

// Make child elements inside canvas draggable for reordering
function makeCanvasElementsDraggable(canvas) {
    // Apply to all direct children and deeper elements
    const elements = canvas.querySelectorAll('*');
    for (const el of elements) {
        if (el === canvas || el.dataset.draggable) continue;
        // Only make elements draggable if they're not form elements
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') continue;
        
        el.dataset.draggable = '1';
        el.draggable = true;
        
        el.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/design-element', 'true');
            // Store reference to the dragged element
            e.dataTransfer.setData('text/design-element-id', el.dataset.designId || '');
            // Set a custom drag image
            const rect = el.getBoundingClientRect();
            const ghost = document.createElement('div');
            ghost.className = 'design-drag-ghost';
            ghost.textContent = '↕ ' + (el.textContent || el.tagName.toLowerCase()).substring(0, 30);
            ghost.style.position = 'fixed';
            ghost.style.top = '-1000px';
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
            setTimeout(() => ghost.remove(), 0);
            
            el.classList.add('ds-dragging');
        });
        
        el.addEventListener('dragend', (e) => {
            el.classList.remove('ds-dragging');
            canvas.querySelectorAll('.ds-drop-target').forEach(t => t.classList.remove('ds-drop-target'));
            removeCanvasDropIndicator();
            canvas.classList.remove('drag-over');
        });
        
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Only show drop target for reordering (when dragging an element, not a palette item)
            if (e.dataTransfer.types.includes('text/design-element')) {
                showCanvasDropIndicator(canvas, e.clientX, e.clientY);
            }
        });
        
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('ds-drop-target');
            canvas.classList.remove('drag-over');
            removeCanvasDropIndicator();
            
            const isElementDrag = e.dataTransfer.types.includes('text/design-element');
            const isPaletteDrag = e.dataTransfer.getData('text/design-component');
            
            if (isElementDrag) {
                // Reorder: find the dragged element and move it
                const draggedEl = canvas.querySelector('.ds-dragging');
                if (draggedEl && draggedEl !== el && canvas.contains(el)) {
                    // Determine if we should insert before or after based on mouse Y
                    const rect = el.getBoundingClientRect();
                    const mouseY = e.clientY;
                    const midY = rect.top + rect.height / 2;
                    
                    if (mouseY < midY) {
                        canvas.insertBefore(draggedEl, el);
                    } else {
                        if (el.nextSibling) {
                            canvas.insertBefore(draggedEl, el.nextSibling);
                        } else {
                            canvas.appendChild(draggedEl);
                        }
                    }
                    draggedEl.classList.remove('ds-dragging');
                    showToast('success', '↕ Elemento reposicionado!');
                }
            }
        });
    }
}

// Show drop indicator line at the mouse position within the canvas
function showCanvasDropIndicator(canvas, clientX, clientY) {
    removeCanvasDropIndicator();
    
    // Find which child element is closest to the mouse Y
    const children = Array.from(canvas.children);
    if (!children.length) {
        // Empty canvas, just show indicator at top
        const indicator = document.createElement('div');
        indicator.className = 'design-drop-indicator';
        indicator.id = 'designDropIndicator';
        canvas.insertBefore(indicator, canvas.firstChild);
        return;
    }
    
    let insertBefore = null;
    for (const child of children) {
        const rect = child.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (clientY < midY) {
            insertBefore = child;
            break;
        }
    }
    
    const indicator = document.createElement('div');
    indicator.className = 'design-drop-indicator';
    indicator.id = 'designDropIndicator';
    
    if (insertBefore) {
        canvas.insertBefore(indicator, insertBefore);
    } else {
        canvas.appendChild(indicator);
    }
}

function removeCanvasDropIndicator() {
    const existing = document.getElementById('designDropIndicator');
    if (existing) existing.remove();
}

// Insert a component at a specific position in the canvas
function insertComponentAtPosition(canvas, component, clientX, clientY) {
    // Parse the component HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = component.html.trim();
    const newNode = tempDiv.firstChild;
    if (!newNode) return;
    
    // Remove any drop indicators
    removeCanvasDropIndicator();
    
    // Find insertion point based on mouse position
    const children = Array.from(canvas.children);
    let insertBefore = null;
    
    for (const child of children) {
        const rect = child.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (clientY < midY) {
            insertBefore = child;
            break;
        }
    }
    
    if (insertBefore) {
        canvas.insertBefore(newNode, insertBefore);
    } else {
        canvas.appendChild(newNode);
    }
    
    // Also insert into actual index.html
    insertComponentToCode(component);
    
    // Make new elements draggable
    makeCanvasElementsDraggable(canvas);
    
    // Select the new element
    selectDesignElement(newNode);
    
    showToast('success', `${component.icon} ${component.name} inserido via drag & drop!`);
}

// Insert component to actual code (index.html)
function insertComponentToCode(comp) {
    const indexFile = files['index.html'];
    if (indexFile) {
        let content = indexFile.content;
        if (content.includes('</body>')) {
            content = content.replace('</body>', '  ' + comp.html + '\n</body>');
        } else if (content.includes('</html>')) {
            content = content.replace('</html>', '  ' + comp.html + '\n</html>');
        } else {
            content += '\n' + comp.html;
        }
        indexFile.content = content;
    } else {
        files['index.html'] = {
            type: 'file',
            content: `<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Meu Site</title>\n  <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;color:#1f2937;line-height:1.6}</style>\n</head>\n<body>\n  ${comp.html}\n</body>\n</html>`
        };
    }
    
    saveWorkspace();
    renderFileTree();
    if (activeTab === 'index.html' || !activeTab) {
        openFile('index.html');
    }
    
    // Update preview
    const indexContent = files['index.html']?.content;
    if (indexContent) {
        document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(indexContent);
    }
    xtermWrite(`✓ Componente "${comp.name}" inserido no index.html via drag & drop\n`, 'green');
}

function handleDesignDragStart(event, compName, compIcon) {
    event.dataTransfer.setData('text/design-component', compName);
    event.dataTransfer.effectAllowed = 'copy';
    
    // Create custom ghost for drag
    const ghost = document.createElement('div');
    ghost.className = 'design-drag-ghost';
    ghost.innerHTML = `<span class="icon">${compIcon}</span> ${compName}`;
    ghost.style.position = 'fixed';
    ghost.style.top = '-1000px';
    ghost.style.left = '-1000px';
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => ghost.remove(), 0);
    
    // Add dragging class to source
    setTimeout(() => {
        event.target.classList.add('dragging-source');
    }, 0);
    
    // Select the component in palette
    selectDesignComponent(compName);
}

function selectDesignElement(element) {
    // Clear previous selection
    document.querySelectorAll('.ds-selected').forEach(el => el.classList.remove('ds-selected'));
    document.querySelectorAll('.design-toolbar').forEach(t => t.remove());
    
    if (!element) {
        updateDesignProperties(null);
        return;
    }
    
    element.classList.add('ds-selected');
    designCanvasElement = element;
    
    // Show toolbar
    showDesignToolbar(element);
    
    // Update properties panel
    updateDesignProperties(element);
}

function showDesignToolbar(element) {
    const existing = document.querySelector('.design-toolbar');
    if (existing) existing.remove();
    
    const toolbar = document.createElement('div');
    toolbar.className = 'design-toolbar show';
    
    // Get element position
    const rect = element.getBoundingClientRect();
    const canvasRect = document.getElementById('designCanvas')?.getBoundingClientRect();
    
    toolbar.innerHTML = `
        <button class="design-tb-btn" onclick="editDesignElement(designCanvasElement)" title="Editar texto">✏️</button>
        <button class="design-tb-btn" onclick="duplicateDesignElement()" title="Duplicar">📋</button>
        <button class="design-tb-btn danger" onclick="deleteDesignElement()" title="Excluir">🗑️</button>
    `;
    
    toolbar.style.position = 'fixed';
    toolbar.style.top = (rect.top - 35) + 'px';
    toolbar.style.left = rect.left + 'px';
    
    document.body.appendChild(toolbar);
}

function editDesignElement(element) {
    if (!element) return;
    
    // Get current text content
    const currentText = element.textContent;
    const newText = prompt('Editar texto:', currentText);
    if (newText !== null && newText !== currentText) {
        element.textContent = newText;
        showDesignToolbar(element);
        updateDesignProperties(element);
    }
}

function duplicateDesignElement() {
    if (!designCanvasElement) return;
    const clone = designCanvasElement.cloneNode(true);
    clone.classList.remove('ds-selected', 'ds-hover');
    designCanvasElement.parentNode.insertBefore(clone, designCanvasElement.nextSibling);
    selectDesignElement(clone);
}

function deleteDesignElement() {
    if (!designCanvasElement) return;
    if (confirm(`Excluir este elemento?`)) {
        const el = designCanvasElement;
        selectDesignElement(null);
        el.remove();
    }
}

function updateDesignProperties(element) {
    const panel = document.getElementById('designProps');
    if (!panel) return;
    
    if (!element) {
        panel.innerHTML = `
            <div class="design-props-header">Propriedades</div>
            <div class="design-props-empty">Clique em um elemento no canvas para ver suas propriedades</div>
        `;
        return;
    }
    
    const tagName = element.tagName.toLowerCase();
    const className = element.className || '';
    const id = element.id || '';
    const text = element.textContent?.trim() || '';
    const style = element.getAttribute('style') || '';
    const href = element.getAttribute('href') || '';
    const src = element.getAttribute('src') || '';
    const alt = element.getAttribute('alt') || '';
    
    panel.innerHTML = `
        <div class="design-props-header">Propriedades: &lt;${tagName}&gt;</div>
        
        <div class="design-prop-group">
            <h4>Atributos</h4>
            <div class="design-prop-row">
                <label>Tag</label>
                <input value="${escapeHtml(tagName)}" onchange="updateDesignAttr('tag', this.value)">
            </div>
            <div class="design-prop-row">
                <label>ID</label>
                <input value="${escapeHtml(id)}" onchange="updateDesignAttr('id', this.value)">
            </div>
            <div class="design-prop-row">
                <label>Classe</label>
                <input value="${escapeHtml(className)}" onchange="updateDesignAttr('class', this.value)">
            </div>
        </div>
        
        <div class="design-prop-group">
            <h4>Conteúdo</h4>
            <div class="design-prop-row">
                <label>Texto</label>
                <textarea rows="2" onchange="updateDesignAttr('text', this.value)">${escapeHtml(text)}</textarea>
            </div>
        </div>
        
        ${href ? `<div class="design-prop-group">
            <h4>Link</h4>
            <div class="design-prop-row">
                <label>Href</label>
                <input value="${escapeHtml(href)}" onchange="updateDesignAttr('href', this.value)">
            </div>
        </div>` : ''}
        
        ${src ? `<div class="design-prop-group">
            <h4>Imagem</h4>
            <div class="design-prop-row">
                <label>Src</label>
                <input value="${escapeHtml(src)}" onchange="updateDesignAttr('src', this.value)">
            </div>
            <div class="design-prop-row">
                <label>Alt</label>
                <input value="${escapeHtml(alt)}" onchange="updateDesignAttr('alt', this.value)">
            </div>
        </div>` : ''}
        
        <div class="design-prop-group">
            <h4>Estilo</h4>
            <div class="design-prop-row">
                <label>Inline</label>
                <textarea rows="3" onchange="updateDesignAttr('style', this.value)">${escapeHtml(style)}</textarea>
            </div>
        </div>
        
        <div class="design-prop-group" style="padding:12px">
            <button class="tb-btn" onclick="syncDesignToCode()" style="width:100%;justify-content:center;background:var(--accent);color:#fff;padding:6px 12px">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                Sincronizar com Código
            </button>
        </div>
    `;
    
    panel.classList.add('active');
}

function updateDesignAttr(attr, value) {
    if (!designCanvasElement) return;
    
    switch (attr) {
        case 'tag':
            // Can't easily change tag in DOM, show info toast
            showToast('info', 'Altere a tag no código (Monaco)');
            break;
        case 'id':
            designCanvasElement.id = value;
            break;
        case 'class':
            designCanvasElement.className = value;
            break;
        case 'text':
            designCanvasElement.textContent = value;
            break;
        case 'href':
            designCanvasElement.setAttribute('href', value);
            break;
        case 'src':
            designCanvasElement.setAttribute('src', value);
            break;
        case 'alt':
            designCanvasElement.setAttribute('alt', value);
            break;
        case 'style':
            designCanvasElement.setAttribute('style', value);
            break;
    }
    
    // Update toolbar position
    showDesignToolbar(designCanvasElement);
}

function syncDesignToCode() {
    const canvasInner = document.getElementById('designCanvasInner');
    if (!canvasInner) return;
    
    const indexFile = files['index.html'];
    if (!indexFile) {
        showToast('info', 'Nenhum index.html para sincronizar');
        return;
    }
    
    // Get the HTML inside the canvas
    const newBodyContent = canvasInner.innerHTML;
    
    // Update index.html by replacing body content
    let content = indexFile.content;
    const bodyRegex = /(<body[^>]*>)[\s\S]*(<\/body>)/i;
    
    if (bodyRegex.test(content)) {
        content = content.replace(bodyRegex, (match, openTag, closeTag) => {
            return openTag + '\n  ' + newBodyContent + '\n' + closeTag;
        });
        indexFile.content = content;
        saveWorkspace();
        // Reload in Monaco if it's the active file
        if (activeTab === 'index.html' && monacoEditor) {
            monacoEditor.setValue(content);
        }
        document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(content);
        showToast('success', '✓ Código sincronizado com o design');
    } else {
        showToast('error', 'Não foi possível encontrar <body> no HTML');
    }
}

// === FORMAT CODE (Prettier) ===
async function formatCode() {
    if (!monacoEditor || !activeTab) {
        showToast('info', 'Abra um arquivo para formatar');
        return;
    }
    
    if (typeof prettier === 'undefined') {
        showToast('error', 'Prettier não carregou. Recarregue a página.');
        return;
    }
    
    const ext = activeTab.split('.').pop().toLowerCase();
    const content = monacoEditor.getValue();
    
    const config = getPrettierConfig(ext);
    if (!config) {
        showToast('info', `Formatação não disponível para .${ext}`);
        return;
    }
    
    showToast('info', '✎ Formatando código...');
    xtermWrite(`Formatando ${activeTab.split('/').pop()}... `, 'blue');
    
    try {
        const formatted = await prettier.format(content, {
            parser: config.parser,
            plugins: config.plugins,
            tabWidth: 2,
            useTabs: false,
            semi: true,
            singleQuote: false,
            printWidth: 100,
            trailingComma: 'all',
            bracketSpacing: true,
            arrowParens: 'always'
        });
        
        if (formatted !== content) {
            // Preserve undo history using pushEditOperations
            const model = monacoEditor.getModel();
            if (model) {
                const fullRange = model.getFullModelRange();
                model.pushEditOperations(
                    [],
                    [{ range: fullRange, text: formatted }],
                    () => []
                );
            }
            showToast('success', '✓ Código formatado com Prettier');
            xtermWrite('✓\n', 'green');
        } else {
            showToast('success', '✓ Código já está formatado');
            xtermWrite('já formatado\n', 'green');
        }
    } catch (err) {
        console.error('Prettier error:', err);
        showToast('error', 'Erro ao formatar: ' + err.message);
        xtermWrite(`✗ ${err.message}\n`, 'red');
    }
}

function getPrettierConfig(ext) {
    const map = {
        html: { parser: 'html', plugins: [prettierPlugins.html] },
        htm: { parser: 'html', plugins: [prettierPlugins.html] },
        css: { parser: 'css', plugins: [prettierPlugins.postcss] },
        scss: { parser: 'scss', plugins: [prettierPlugins.postcss] },
        less: { parser: 'less', plugins: [prettierPlugins.postcss] },
        js: { parser: 'babel', plugins: [prettierPlugins.babel] },
        mjs: { parser: 'babel', plugins: [prettierPlugins.babel] },
        cjs: { parser: 'babel', plugins: [prettierPlugins.babel] },
        jsx: { parser: 'babel', plugins: [prettierPlugins.babel] },
        ts: { parser: 'typescript', plugins: [prettierPlugins.typescript] },
        tsx: { parser: 'typescript', plugins: [prettierPlugins.typescript] },
        json: { parser: 'json', plugins: [prettierPlugins.estree] },
        md: { parser: 'markdown', plugins: [prettierPlugins.markdown] },
        markdown: { parser: 'markdown', plugins: [prettierPlugins.markdown] },
        yaml: { parser: 'yaml', plugins: [prettierPlugins.yaml] },
        yml: { parser: 'yaml', plugins: [prettierPlugins.yaml] },
        xml: { parser: 'html', plugins: [prettierPlugins.html] },
        svg: { parser: 'html', plugins: [prettierPlugins.html] }
    };
    return map[ext] || null;
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
                    match = line.toLowerCase().includes(q);
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
    const map = { explorer: 'Explorer', search: 'Search', git: 'Git', run: 'Run', extensions: 'Extensions', design: 'Design', collaboration: 'Collaboration' };
    document.querySelectorAll('.activity-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    const actId = 'act' + name.charAt(0).toUpperCase() + name.slice(1);
    const panelId = 'panel' + (map[name] || name);
    document.getElementById(actId)?.classList.add('active');
    document.getElementById(panelId)?.classList.add('active');
    document.getElementById('sidebar').classList.remove('hidden');
    sidebarVisible = true;
    
    // Render git changes when switching to Git panel
    if (name === 'git') {
        renderGitChanges();
    }
    
    // Enter design mode
    if (name === 'design') {
        enterDesignMode();
    }
    
    // Show name input prompt if entering collaboration
    if (name === 'collaboration') {
        // Pre-fill name from localStorage
        const savedName = localStorage.getItem('cc_collab_name');
        const nameInput = document.getElementById('collabUserName');
        if (nameInput && savedName) nameInput.value = savedName;
    }
}

// === COLLABORATION (Multiplayer) ===
let collabSocket = null;
let collabUserId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let collabRoomCode = null;
let collabUsers = new Map(); // userId -> { name, color }
let collabRemoteCursors = {}; // userId -> { line, col, filePath }

function connectCollab() {
    if (collabSocket && collabSocket.readyState === WebSocket.OPEN) return;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/collaboration`;
    
    try {
        collabSocket = new WebSocket(url);
        
        collabSocket.onopen = () => {
            updateCollabStatus('online', 'Conectado');
        };
        
        collabSocket.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                handleCollabMessage(msg);
            } catch {}
        };
        
        collabSocket.onclose = () => {
            collabSocket = null;
            if (collabRoomCode) {
                updateCollabStatus('offline', 'Desconectado');
                showToast('error', '👥 Conexão perdida com a sala');
            } else {
                updateCollabStatus('offline', 'Desconectado');
            }
            collabRoomCode = null;
            collabUsers.clear();
            renderCollabUsers();
            removeAllRemoteCursors();
        };
        
        collabSocket.onerror = () => {
            updateCollabStatus('offline', 'Servidor indisponível');
            showToast('error', '👥 Não foi possível conectar ao servidor de colaboração');
        };
    } catch {
        updateCollabStatus('offline', 'Erro de conexão');
    }
}

function handleCollabMessage(msg) {
    switch (msg.type) {
        case 'room_joined': {
            collabRoomCode = msg.data.roomCode;
            collabUserId = msg.data.userId;
            localStorage.setItem('cc_collab_user_id', collabUserId);
            
            // Show room UI
            document.getElementById('collabConnect').style.display = 'none';
            document.getElementById('collabRoom').style.display = 'block';
            document.getElementById('collabRoomCode').textContent = msg.data.roomCode;
            
            // Load existing files from room
            if (msg.data.files && Object.keys(msg.data.files).length) {
                files = JSON.parse(JSON.stringify(msg.data.files));
                saveWorkspace();
                renderFileTree();
                renderGitChanges();
                if (activeTab) openFile(activeTab);
            }
            
            // Set users
            collabUsers.clear();
            if (msg.data.users) {
                for (const u of msg.data.users) {
                    collabUsers.set(u.id, u);
                }
            }
            // Add self
            collabUsers.set(msg.data.userId, {
                id: msg.data.userId,
                name: msg.data.userName,
                color: msg.data.userColor
            });
            renderCollabUsers();
            
            showToast('success', `👥 Sala ${msg.data.roomCode} — ${collabUsers.size} membro(s)`);
            break;
        }
        
        case 'room_error': {
            showToast('error', '👥 ' + msg.data.message);
            break;
        }
        
        case 'user_joined': {
            collabUsers.set(msg.data.id, {
                id: msg.data.id,
                name: msg.data.name,
                color: msg.data.color
            });
            renderCollabUsers();
            showToast('success', `👤 ${msg.data.name} entrou na sala`);
            break;
        }
        
        case 'user_left': {
            collabUsers.delete(msg.data.id);
            removeRemoteCursor(msg.data.id);
            renderCollabUsers();
            showToast('info', `👤 ${msg.data.name} saiu da sala`);
            break;
        }
        
        case 'user_count': {
            document.getElementById('collabUserCount').textContent = msg.data.count || collabUsers.size;
            break;
        }
        
        case 'file_change': {
            const path = msg.data.path;
            const content = msg.data.content;
            if (path && content !== undefined) {
                // Update the file in memory
                const parts = path.split('/');
                if (parts.length === 1) {
                    if (files[parts[0]]) files[parts[0]].content = content;
                } else if (parts.length === 2 && files[parts[0]]?.children?.[parts[1]]) {
                    files[parts[0]].children[parts[1]].content = content;
                }
                
                // If this file is currently open, update the editor
                if (activeTab === path && monacoEditor && !monacoEditor.isDisposed()) {
                    const currentValue = monacoEditor.getValue();
                    if (currentValue !== content) {
                        monacoEditor.setValue(content);
                    }
                }
                
                // If preview is showing this file, update it
                if (path === 'index.html' || path.endsWith('/index.html')) {
                    const frame = document.getElementById('previewFrame');
                    if (frame && frame.srcdoc && frame.style.display !== 'none') {
                        frame.srcdoc = buildPreviewSrcdoc(content);
                    }
                }
                
                // Sync to localStorage
                saveWorkspace();
            }
            break;
        }
        
        case 'cursor_update': {
            const remote = msg.sender;
            if (!remote || remote.id === collabUserId) break;
            
            const cursor = msg.data;
            updateRemoteCursor(remote.id, remote.name, remote.color, cursor);
            break;
        }
        
        case 'file_sync': {
            if (msg.data.files && Object.keys(msg.data.files).length) {
                files = JSON.parse(JSON.stringify(msg.data.files));
                saveWorkspace();
                renderFileTree();
                renderGitChanges();
                if (activeTab) openFile(activeTab);
            }
            break;
        }
    }
}

function createCollabRoom() {
    const nameInput = document.getElementById('collabUserName');
    const userName = (nameInput?.value || '').trim() || 'Dev_' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('cc_collab_name', userName);
    
    connectCollab();
    if (!collabSocket || collabSocket.readyState !== WebSocket.OPEN) {
        // Wait for connection then create room
        setTimeout(() => createCollabRoom(), 500);
        return;
    }
    
    collabSocket.send(JSON.stringify({
        type: 'create_room',
        userId: collabUserId,
        userName: userName
    }));
}

function promptJoinRoom() {
    const nameInput = document.getElementById('collabUserName');
    const userName = (nameInput?.value || '').trim() || 'Dev_' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('cc_collab_name', userName);
    
    const code = prompt('Código da sala (6 caracteres):', '');
    if (!code || code.trim().length < 4) return;
    
    joinCollabRoom(code.trim().toUpperCase(), userName);
}

function joinCollabRoom(code, userName) {
    connectCollab();
    if (!collabSocket || collabSocket.readyState !== WebSocket.OPEN) {
        setTimeout(() => joinCollabRoom(code, userName), 500);
        return;
    }
    
    collabSocket.send(JSON.stringify({
        type: 'join_room',
        roomCode: code,
        userId: collabUserId,
        userName: userName
    }));
}

function leaveCollabRoom() {
    if (collabSocket) {
        collabSocket.close();
        collabSocket = null;
    }
    collabRoomCode = null;
    collabUsers.clear();
    removeAllRemoteCursors();
    
    document.getElementById('collabConnect').style.display = 'block';
    document.getElementById('collabRoom').style.display = 'none';
    updateCollabStatus('offline', 'Desconectado');
    
    showToast('info', '👥 Você saiu da sala');
}

function copyCollabRoomCode() {
    const code = collabRoomCode;
    if (!code) return;
    
    navigator.clipboard.writeText(code).then(() => {
        showToast('success', '📋 Código copiado: ' + code);
    }).catch(() => {
        // Fallback
        showToast('success', '📋 Código: ' + code);
    });
}

function sendCollabFileChange(path, content) {
    if (!collabSocket || collabSocket.readyState !== WebSocket.OPEN || !collabRoomCode) return;
    
    collabSocket.send(JSON.stringify({
        type: 'file_change',
        data: { path, content }
    }));
}

function sendCollabCursorUpdate(lineNumber, column, filePath) {
    if (!collabSocket || collabSocket.readyState !== WebSocket.OPEN || !collabRoomCode) return;
    
    collabSocket.send(JSON.stringify({
        type: 'cursor_update',
        data: {
            filePath: filePath || activeTab,
            lineNumber: lineNumber || 1,
            column: column || 1
        }
    }));
}

function updateCollabStatus(status, text) {
    const statusEl = document.getElementById('collabStatus');
    const dot = statusEl?.querySelector('.collab-dot');
    const textEl = statusEl?.querySelector('span:last-child');
    
    if (dot) {
        dot.className = 'collab-dot ' + status;
    }
    if (textEl) {
        textEl.textContent = text || (status === 'online' ? 'Conectado' : 'Desconectado');
    }
    
    // Also update room header
    const statusText = document.getElementById('collabStatusText');
    if (statusText) {
        statusText.textContent = text || (status === 'online' ? 'Conectado' : 'Desconectado');
    }
}

function renderCollabUsers() {
    const list = document.getElementById('collabUsersList');
    const count = document.getElementById('collabUserCount');
    if (!list) return;
    
    if (!collabUsers.size) {
        list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:0.75rem">Aguardando...</div>';
        return;
    }
    
    let html = '';
    for (const [id, user] of collabUsers) {
        const isSelf = id === collabUserId;
        const initial = (user.name || '?').charAt(0).toUpperCase();
        html += `
            <div class="collab-user-item">
                <div class="collab-user-avatar" style="background:${user.color || '#7c5cfc'}">${initial}</div>
                <div class="collab-user-name">${escapeHtml(user.name || 'Dev')}</div>
                <span style="font-size:0.55rem;color:var(--muted)">${isSelf ? '(você)' : ''}</span>
            </div>`;
    }
    
    list.innerHTML = html;
    if (count) count.textContent = collabUsers.size;
}

// Remote cursors
function updateRemoteCursor(userId, userName, userColor, cursor) {
    // Remove existing cursor for this user
    removeRemoteCursor(userId);
    
    // Only show cursors for the current file
    if (cursor.filePath !== activeTab) return;
    
    const container = document.querySelector('.monaco-editor .overflow-guard');
    if (!container) return;
    
    const lineHeight = 18; // Monaco default
    const charWidth = 8.5; // Approximate for JetBrains Mono at 12px
    
    const top = (cursor.lineNumber - 1) * lineHeight;
    const left = (cursor.column - 1) * charWidth;
    
    const cursorEl = document.createElement('div');
    cursorEl.className = 'remote-cursor';
    cursorEl.id = 'remote-cursor-' + userId;
    cursorEl.style.cssText = `top:${top}px;left:${left}px;height:${lineHeight}px;background:${userColor || '#7c5cfc'}`;
    cursorEl.setAttribute('data-name', userName || '?');
    
    container.appendChild(cursorEl);
}

function removeRemoteCursor(userId) {
    const el = document.getElementById('remote-cursor-' + userId);
    if (el) el.remove();
}

function removeAllRemoteCursors() {
    document.querySelectorAll('.remote-cursor').forEach(el => el.remove());
}

// === TERMINAL (xterm.js) ===
function toggleTerminal() {
    const panels = document.getElementById('bottomPanels');
    const btn = document.getElementById('btnTerminal');
    const isVisible = panels.style.display !== 'none';
    panels.style.display = isVisible ? 'none' : 'flex';
    btn.style.background = isVisible ? '' : 'rgba(255,255,255,0.1)';
    if (!isVisible) {
        switchBottomPanel('terminal');
        initXterm();
    }
}

let xtermInited = false;
let xtermOnDataDisposable = null;

function disposeXtermOnData() {
    if (xtermOnDataDisposable && typeof xtermOnDataDisposable.dispose === 'function') {
        xtermOnDataDisposable.dispose();
        xtermOnDataDisposable = null;
    }
}

function initXterm() {
    if (xtermInited) return;
    const termEl = document.getElementById('terminal');
    if (!termEl || termEl._xterm_initialized) return;
    
    xterm = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
        theme: {
            background: '#1e1e1e',
            foreground: '#cccccc',
            cursor: '#cccccc',
            selectionBackground: '#264f78',
            black: '#000000',
            red: '#f44747',
            green: '#4ec9b0',
            yellow: '#dcdcaa',
            blue: '#569cd6',
            magenta: '#c586c0',
            cyan: '#4fc1ff',
            white: '#d4d4d4',
            brightBlack: '#808080',
            brightRed: '#f44747',
            brightGreen: '#4ec9b0',
            brightYellow: '#dcdcaa',
            brightBlue: '#569cd6',
            brightMagenta: '#c586c0',
            brightCyan: '#4fc1ff',
            brightWhite: '#ffffff'
        },
        allowProposedApi: true,
        cols: 80,
        rows: 12
    });

    termEl._xterm_initialized = true;
    xterm.open(termEl);
    termFit = new FitAddon.FitAddon();
    xterm.loadAddon(termFit);
    termFit.fit();
    
    // Try to connect WebSocket
    tryConnectTerminal();
    
    // Write welcome message
    xterm.write('\x1b[32mCorvo Coder Terminal\x1b[0m\r\n');
    xterm.write('\x1b[90mConectando ao servidor...\x1b[0m\r\n');
    
    xtermInited = true;
    setTimeout(() => termFit?.fit(), 200);
}

function tryConnectTerminal() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/terminal`;
    
    try {
        termSocket = new WebSocket(wsUrl);
        termSocket.onopen = () => {
            xtermWrite('\x1b[32mConectado!\x1b[0m\r\n', 'green');
            xterm.focus();
        };
        termSocket.onmessage = (e) => {
            xterm.write(e.data);
        };
        termSocket.onclose = () => {
            xtermWrite('\x1b[31mConexão perdida. Use comandos locais.\x1b[0m\r\n', 'red');
            xtermInited = false;
            // Fallback: use local terminal mode
            setupLocalTerminal();
        };
        termSocket.onerror = () => {
            // No WebSocket server, use local terminal
            xtermInited = false;
            setupLocalTerminal();
        };
        
        // Forward user input to WebSocket
        disposeXtermOnData();
        xtermOnDataDisposable = xterm.onData((data) => {
            if (termSocket && termSocket.readyState === WebSocket.OPEN) {
                termSocket.send(data);
            }
        });
    } catch {
        xtermInited = false;
        setupLocalTerminal();
    }
}

function setupLocalTerminal() {
    if (!xterm) return;
    xterm.clear();
    xterm.write('\x1b[32mCorvo Coder Terminal\x1b[0m (local)\r\n');
    xterm.write('\x1b[90mDigite help para comandos disponíveis\x1b[0m\r\n');
    xterm.write('\r\n');
    
    let inputBuffer = '';
    let commandHistory = [];
    let historyIndex = -1;
    
    const writePrompt = () => {
        xterm.write('\r\n\x1b[32m$\x1b[0m ');
    };
    
    disposeXtermOnData();
    xtermOnDataDisposable = xterm.onData((data) => {
        if (data === '\r') { // Enter
            const cmd = inputBuffer.trim();
            inputBuffer = '';
            if (cmd) {
                commandHistory.push(cmd);
                historyIndex = -1;
                executeLocalCommand(cmd);
            } else {
                writePrompt();
            }
        } else if (data === '\x7f') { // Backspace
            if (inputBuffer.length > 0) {
                inputBuffer = inputBuffer.slice(0, -1);
                xterm.write('\b \b');
            }
        } else if (data === '\x1b[A') { // Up arrow
            if (commandHistory.length > 0) {
                historyIndex = Math.max(0, historyIndex - 1);
                const cmd = commandHistory[historyIndex];
                // Clear current line
                xterm.write('\r\x1b[K\x1b[32m$\x1b[0m ' + cmd);
                inputBuffer = cmd;
            }
        } else if (data === '\x1b[B') { // Down arrow
            if (historyIndex < commandHistory.length - 1) {
                historyIndex++;
                const cmd = commandHistory[historyIndex];
                xterm.write('\r\x1b[K\x1b[32m$\x1b[0m ' + cmd);
                inputBuffer = cmd;
            } else {
                historyIndex = commandHistory.length;
                xterm.write('\r\x1b[K\x1b[32m$\x1b[0m ');
                inputBuffer = '';
            }
        } else if (data === '\t') { // Tab
            // Simple file name completion
            const names = Object.keys(files);
            const match = names.filter(n => n.startsWith(inputBuffer));
            if (match.length === 1) {
                inputBuffer = match[0];
                xterm.write('\r\x1b[K\x1b[32m$\x1b[0m ' + inputBuffer);
            }
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
            inputBuffer += data;
            xterm.write(data);
        }
    });
    
    writePrompt();
}

async function executeLocalCommand(cmd) {
    if (cmd === 'help') {
        xterm.write('\r\n\x1b[90mComandos disponíveis:\x1b[0m\r\n');
        xterm.write('  \x1b[33mhelp\x1b[0m       Mostra esta ajuda\r\n');
        xterm.write('  \x1b[33mls\x1b[0m         Lista arquivos\r\n');
        xterm.write('  \x1b[33mcat <file>\x1b[0m  Exibe conteúdo de um arquivo\r\n');
        xterm.write('  \x1b[33mclear\x1b[0m      Limpa o terminal\r\n');
        xterm.write('  \x1b[33mecho\x1b[0m       Ecoa texto\r\n');
        xterm.write('  \x1b[33mpwd\x1b[0m        Mostra diretório atual\r\n');
        xterm.write('  \x1b[33mdeploy\x1b[0m     Faz deploy do projeto\r\n');
        xterm.write('  \x1b[33mnpm install\x1b[0m  Instala dependencias do projeto\r\n');
        xterm.write('  \x1b[33mnode\x1b[0m        Executa Node.js\r\n');
        xterm.write('  \x1b[33mnpx\x1b[0m         Executa pacotes NPX\r\n');
        xterm.write('  \x1b[33mgit\x1b[0m         Comandos Git\r\n');
        const prompt = () => xterm.write('\r\n\x1b[32m$\x1b[0m ');
        prompt();
    } else if (cmd === 'ls') {
        const names = Object.keys(files);
        xterm.write('\r\n');
        names.forEach(n => {
            const file = files[n];
            if (file?.type === 'folder') {
                xterm.write(`\x1b[34m${n}/\x1b[0m  `);
            } else {
                xterm.write(`${n}  `);
            }
        });
        xterm.write('\r\n');
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd.startsWith('cat ')) {
        const path = cmd.slice(4).trim();
        const file = getFileByPath(path);
        if (file?.content) {
            xterm.write('\r\n' + file.content.substring(0, 2000) + '\r\n');
        } else {
            xterm.write(`\r\n\x1b[31mArquivo não encontrado: ${path}\x1b[0m\r\n`);
        }
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd === 'clear') {
        xterm.clear();
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd.startsWith('echo ')) {
        xterm.write('\r\n' + cmd.slice(5) + '\r\n');
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd === 'pwd') {
        xterm.write('\r\n\x1b[36m/workspace\x1b[0m\r\n');
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd === 'deploy') {
        deployProject();
    } else if (cmd === 'build' || cmd === 'run' || cmd === 'start') {
        // Run the project
        runProject();
    } else if (cmd.startsWith('npm') || cmd.startsWith('node ') || cmd.startsWith('npx ') || cmd.startsWith('git ') || cmd.startsWith('ls -') || cmd.startsWith('cat /') || cmd === 'ls' || cmd === 'pwd') {
        // Send real commands to backend
        xterm.write('\r\n\x1b[90mExecutando no servidor...\x1b[0m\r\n');
        const token = localStorage.getItem('cc_token') || '';
        try {
            const filesData = typeof files !== 'undefined' && files ? files : {};
            const res = await fetch('/api/terminal/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ command: cmd, files: filesData })
            });
            const data = await res.json();
            if (data.error) {
                xterm.write('\x1b[31m' + data.error + '\x1b[0m\r\n');
            } else {
                if (data.stdout) xterm.write('\r\n' + data.stdout.replace(/\n/g, '\r\n'));
                if (data.stderr) xterm.write('\r\n\x1b[33m' + data.stderr.replace(/\n/g, '\r\n') + '\x1b[0m');
                if (data.exitCode === 0) {
                    xterm.write('\r\n\x1b[32m✓ Comando concluído\x1b[0m\r\n');
                } else {
                    xterm.write('\r\n\x1b[31m✗ Código de saída: ' + data.exitCode + '\x1b[0m\r\n');
                }
            }
        } catch (err) {
            xterm.write('\r\n\x1b[31mErro de conexão: ' + err.message + '\x1b[0m\r\n');
        }
        xterm.write('\x1b[32m$\x1b[0m ');
    } else if (cmd) {
        xterm.write(`\r\n\x1b[31mComando não encontrado: ${cmd}\x1b[0m\r\n`);
        xterm.write('\x1b[32m$\x1b[0m ');
    } else {
        xterm.write('\x1b[32m$\x1b[0m ');
    }
}

function xtermWrite(msg, color) {
    if (!xterm) return;
    if (color === 'green') xterm.write('\x1b[32m' + msg + '\x1b[0m');
    else if (color === 'red') xterm.write('\x1b[31m' + msg + '\x1b[0m');
    else if (color === 'yellow') xterm.write('\x1b[33m' + msg + '\x1b[0m');
    else if (color === 'blue') xterm.write('\x1b[34m' + msg + '\x1b[0m');
    else xterm.write(msg);
}

function switchBottomPanel(name) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
    const tab = document.getElementById('p' + name);
    const panel = document.getElementById(name + 'Panel');
    if (tab) tab.classList.add('active');
    if (panel) panel.classList.add('active');
    if (name === 'terminal') setTimeout(() => termFit?.fit(), 100);
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
    const indexContent = files['index.html']?.content;
    if (frame && indexContent) frame.srcdoc = buildPreviewSrcdoc(indexContent);
}

function openPreviewInNewTab() {
    const frame = document.getElementById('previewFrame');
    if (frame?.srcdoc) {
        const w = window.open('', '_blank');
        w.document.write(frame.srcdoc);
        w.document.close();
    }
}

// === GITHUB (git push via terminal) ===
function pushToGitHub() {
    if (!Object.keys(files).length) {
        showToast('info', 'Nenhum arquivo para enviar');
        return;
    }
    
    const repoUrl = prompt('URL do repositório GitHub (ex: https://github.com/usuario/repo.git):', '');
    if (!repoUrl || !repoUrl.trim()) return;
    
    const commitMsg = prompt('Mensagem do commit:', 'first commit');
    if (!commitMsg) return;
    
    xtermWrite('\r\n\x1b[33m=== Git Push para GitHub ===\x1b[0m\r\n');
    xtermWrite(`\x1b[90mRepo: ${repoUrl}\x1b[0m\r\n`);
    
    // Show the commands that will run
    xtermWrite('\x1b[90m$ git init\x1b[0m\r\n');
    xtermWrite('\x1b[90m$ git add .\x1b[0m\r\n');
    xtermWrite(`\x1b[90m$ git commit -m "${commitMsg}"\x1b[0m\r\n`);
    xtermWrite('\x1b[90m$ git branch -M main\x1b[0m\r\n');
    xtermWrite(`\x1b[90m$ git remote add origin ${repoUrl}\x1b[0m\r\n`);
    xtermWrite('\x1b[90m$ git push -u origin main\x1b[0m\r\n\r\n');
    
    fetch('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, repoUrl, commitMessage: commitMsg })
    })
    .then(r => r.json())
    .then(d => {
        // Show command output in terminal
        if (d.output && d.output.length) {
            d.output.forEach(line => {
                if (line.toLowerCase().includes('error') || line.toLowerCase().includes('fatal')) {
                    xtermWrite(`\x1b[31m${line}\x1b[0m\r\n`);
                } else if (line.toLowerCase().includes('done') || line.toLowerCase().includes('created') || line.toLowerCase().includes('main -> main')) {
                    xtermWrite(`\x1b[32m${line}\x1b[0m\r\n`);
                } else {
                    xtermWrite(`${line}\r\n`);
                }
            });
        }
        
        if (d.success && d.url) {
            xtermWrite(`\r\n\x1b[32m✓ Push realizado com sucesso!\x1b[0m\r\n`, 'green');
            xtermWrite(`\x1b[36m${d.url}\x1b[0m\r\n`);
            showToast('success', 'GitHub: push realizado!');
            window.open(d.url, '_blank');
        } else if (d.error) {
            xtermWrite(`\r\n\x1b[31m✗ ${d.error}\x1b[0m\r\n`, 'red');
            showToast('error', d.error);
        }
    })
    .catch(err => {
        xtermWrite(`\r\n\x1b[31m✗ Erro: ${err.message}\x1b[0m\r\n`, 'red');
        showToast('error', 'Erro ao enviar para GitHub');
    });
}

// === DEPLOY ===
function deployProject(e) {
    if (e) e.stopPropagation();
    if (!Object.keys(files).length) {
        showToast('info', 'Nenhum arquivo para deploy');
        return;
    }
    
    // Ask which platform
    const choice = prompt('Escolha a plataforma:\n1 - Netlify\n2 - Vercel\n3 - Railway\n\n(Digite 1, 2 ou 3)', '1');
    const platform = choice === '2' ? 'vercel' : choice === '3' ? 'railway' : 'netlify';
    
    xtermWrite(`\r\n\x1b[33mDeploy para ${platform.toUpperCase()}...\x1b[0m\r\n`);
    
    const endpoint = platform === 'vercel' ? '/api/deploy/vercel' : 
                     platform === 'railway' ? '/api/deploy/railway' : '/api/deploy';
    
    const body = { files, chatId };
    if (platform === 'railway') {
        body.projectName = prompt('Nome do projeto Railway:', 'corvo-project-' + Date.now().toString(36));
        body.serviceName = prompt('Nome do serviço (opcional):', 'web');
        const envId = prompt('Environment ID (deixe vazio pra usar production):', '');
        if (envId) body.environmentId = envId;
    }
    
    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    .then(r => r.json())
    .then(d => {
        if (d.url) {
            xtermWrite(`\r\n\x1b[32m✓ Deploy realizado!\x1b[0m\r\n`, 'green');
            xtermWrite(`\x1b[36mURL: ${d.url}\x1b[0m\r\n`);
            const name = platform.charAt(0).toUpperCase() + platform.slice(1);
            showToast('success', `${name}: deploy realizado!`);
            window.open(d.url, '_blank');
        } else if (d.error) {
            xtermWrite(`\r\n\x1b[31m✗ ${d.error}\x1b[0m\r\n`, 'red');
            showToast('error', d.error);
        }
    })
    .catch(err => {
        xtermWrite(`\r\n\x1b[31m✗ Erro: ${err.message}\x1b[0m\r\n`, 'red');
        showToast('error', 'Erro ao fazer deploy');
    });
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
        xtermWrite('✓ Projeto baixado como ZIP\n', 'green');
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

function ctxRenameFile() {
    hideContext();
    if (!contextTarget?.path) return;
    const currentName = contextTarget.path.split('/').pop();
    const newName = prompt('Novo nome:', currentName);
    if (!newName || newName === currentName) return;
    
    const parts = contextTarget.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const file = getFileByPath(contextTarget.path);
    if (!file) return;
    
    deleteFileByPath(contextTarget.path);
    
    const newPath = parentPath ? parentPath + '/' + newName : newName;
    const newParts = newPath.split('/');
    if (newParts.length === 1) {
        files[newName] = file;
    } else if (newParts.length === 2) {
        if (!files[newParts[0]] || files[newParts[0]].type !== 'folder') {
            files[newParts[0]] = { type: 'folder', children: {} };
        }
        files[newParts[0]].children[newParts[1]] = file;
    }
    
    openTabs = openTabs.map(t => t === contextTarget.path ? newPath : t);
    if (activeTab === contextTarget.path) activeTab = newPath;
    if (modifiedFiles[contextTarget.path]) {
        modifiedFiles[newPath] = modifiedFiles[contextTarget.path];
        delete modifiedFiles[contextTarget.path];
    }
    
    saveWorkspace();
    renderFileTree();
    renderTabs();
    showToast('success', `✏️ Renomeado para "${newName}"`);
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
            if (monacoEditor) { monacoEditor.dispose(); monacoEditor = null; document.getElementById('monacoContainer').innerHTML = ''; }
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
        document.getElementById('previewFrame').srcdoc = buildPreviewSrcdoc(indexFile.content);
        xtermWrite('✓ Preview atualizado\n', 'green');
    } else {
        xtermWrite('Nenhum index.html encontrado\n', 'yellow');
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
        if (e.ctrlKey && e.key === 'p') { e.preventDefault(); openQuickOpen(); }
        if (e.ctrlKey && e.key === 'f') { e.preventDefault(); toggleSearch(); }
        if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); }
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
        if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); }
        if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
        if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); formatCode(); }
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

// === HANDLE WINDOW RESIZE FOR MONACO ===
window.addEventListener('resize', () => {
    if (monacoEditor) setTimeout(() => monacoEditor?.layout(), 50);
    if (termFit) setTimeout(() => termFit?.fit(), 100);
});

// === KEYBOARD SHORTCUTS FOR TERMINAL INSIDE PANEL ===
document.addEventListener('keydown', (e) => {
    // Only send Ctrl+C to terminal if terminal panel is visible AND xterm is focused
    if (e.ctrlKey && e.key === 'c' && xterm) {
        const panels = document.getElementById('bottomPanels');
        if (panels?.style.display !== 'none') {
            const termPanel = document.getElementById('terminalPanel');
            if (termPanel?.classList.contains('active')) {
                e.preventDefault();
                xterm.write('\x03');
            }
        }
    }
});

// === QUICK OPEN (Ctrl+P) ===
let quickOpenIndex = -1;

function openQuickOpen() {
    const overlay = document.getElementById('quickOpen');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const input = document.getElementById('quickOpenInput');
    input.value = '';
    input.focus();
    quickOpenIndex = -1;
    renderQuickOpenResults('');
}

function closeQuickOpen() {
    document.getElementById('quickOpen').style.display = 'none';
    quickOpenIndex = -1;
}

function renderQuickOpenResults(query) {
    const container = document.getElementById('quickOpenResults');
    if (!container) return;
    
    // Flatten all file paths
    const fileList = [];
    function flattenFiles(obj, prefix) {
        for (const [name, file] of Object.entries(obj)) {
            const path = prefix ? prefix + '/' + name : name;
            if (file.type === 'folder') {
                flattenFiles(file.children || {}, path);
            } else {
                fileList.push({ path, name });
            }
        }
    }
    flattenFiles(files, '');
    
    if (!fileList.length) {
        container.innerHTML = '<div class="quick-open-empty">Nenhum arquivo no projeto</div>';
        return;
    }
    
    const q = query.toLowerCase().trim();
    
    // Filter and score files
    let results = [];
    if (!q) {
        results = fileList.slice(0, 15);
    } else {
        const scored = fileList.map(f => {
            const nameLow = f.name.toLowerCase();
            const pathLow = f.path.toLowerCase();
            let score = 0;
            
            // Exact file name match (highest priority)
            if (nameLow === q) score = 1000;
            // Starts with query
            else if (nameLow.startsWith(q)) score = 800;
            // File name contains query
            else if (nameLow.includes(q)) score = 400;
            // Path contains query
            else if (pathLow.includes(q)) score = 100;
            // Fuzzy match: each char in order
            else {
                let ci = 0;
                for (const ch of q) {
                    const idx = nameLow.indexOf(ch, ci);
                    if (idx === -1) { score = -1; break; }
                    score += 10;
                    ci = idx + 1;
                }
                // If fuzzy matched, bonus for proximity
                if (score > 0 && ci <= nameLow.length) {
                    score += Math.max(0, 50 - (ci - q.length) * 5);
                }
            }
            return { ...f, score };
        }).filter(f => f.score > 0).sort((a, b) => b.score - a.score);
        results = scored.slice(0, 20);
    }
    
    if (!results.length) {
        container.innerHTML = `<div class="quick-open-empty">Nenhum resultado para "${escapeHtml(q)}"</div>`;
        return;
    }
    
    // Highlight matching chars in results
    function highlightName(name, query) {
        if (!query) return name;
        const lower = name.toLowerCase();
        const ql = query.toLowerCase();
        let result = '';
        let lastIdx = 0;
        for (let i = 0; i < ql.length; i++) {
            const idx = lower.indexOf(ql[i], lastIdx);
            if (idx === -1) break;
            if (idx > lastIdx) result += escapeHtml(name.substring(lastIdx, idx));
            result += '<span class="qo-highlight">' + escapeHtml(name[idx]) + '</span>';
            lastIdx = idx + 1;
        }
        if (lastIdx < name.length) result += escapeHtml(name.substring(lastIdx));
        return result;
    }
    
    container.innerHTML = results.map((f, i) => {
        const ext = f.name.split('.').pop().toLowerCase();
        const iconCls = getFileIconClass(f.name) || 'txt';
        const icon = getFileIcon(f.name) || 'F';
        const dir = f.path.substring(0, f.path.length - f.name.length - 1);
        const selected = i === quickOpenIndex ? 'selected' : '';
        return `<div class="quick-open-item ${selected}" onclick="openQuickOpenFile('${encodeURIComponent(f.path)}')" onmouseenter="quickOpenIndex=${i};renderQuickOpenResults(document.getElementById('quickOpenInput').value)">
            <span class="qo-icon ${iconCls}">${icon}</span>
            <span class="qo-name">${highlightName(f.name, q)}</span>
            <span class="qo-path">${dir || '.'}</span>
        </div>`;
    }).join('');
    
    // Reset selection if out of bounds
    if (quickOpenIndex >= results.length) quickOpenIndex = results.length - 1;
    if (quickOpenIndex < 0 && results.length > 0) quickOpenIndex = 0;
}

function openQuickOpenFile(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    closeQuickOpen();
    openFile(path);
}

// Quick Open keyboard navigation (attached to the quick open input)
document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('quickOpen');
    if (!overlay || overlay.style.display === 'none') return;
    
    const results = document.querySelectorAll('.quick-open-item');
    
    if (e.key === 'Escape') {
        e.preventDefault();
        closeQuickOpen();
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        quickOpenIndex = Math.min(quickOpenIndex + 1, results.length - 1);
        renderQuickOpenResults(document.getElementById('quickOpenInput').value);
        const selected = results[quickOpenIndex];
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        quickOpenIndex = Math.max(quickOpenIndex - 1, 0);
        renderQuickOpenResults(document.getElementById('quickOpenInput').value);
        const selected = results[quickOpenIndex];
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length > 0 && quickOpenIndex >= 0) {
            const item = results[quickOpenIndex];
            if (item) item.click();
        }
    }
});

// Quick Open input filtering with debounce
let quickOpenTimeout = null;
document.addEventListener('input', (e) => {
    if (e.target.id === 'quickOpenInput') {
        clearTimeout(quickOpenTimeout);
        quickOpenIndex = 0;
        quickOpenTimeout = setTimeout(() => {
            renderQuickOpenResults(e.target.value);
        }, 80);
    }
});
