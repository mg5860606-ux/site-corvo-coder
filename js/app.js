const API = window.location.origin;

let user = null;
let token = localStorage.getItem('cc_token');
let credits = 100;
let chatHistory = [];
let savedChats = [];
let currentChatId = null;
let currentFiles = {};
let codeVersions = [];
let currentVersionIndex = -1;

// Image/audio state
let pendingImages = [];
let pendingAudio = null;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recognition = null;

function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

async function apiFetch(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
    if (res.status === 401) {
        localStorage.removeItem('cc_token');
        localStorage.removeItem('cc_user');
        window.location.href = 'pages/login.html';
        return null;
    }
    return res.json();
}

function updateCredits() {
    const fill = document.getElementById('creditsFill');
    const text = document.getElementById('creditsText');
    const side = document.getElementById('sideCredits');
    if (fill) fill.style.width = `${(credits / 100) * 100}%`;
    if (text) text.textContent = `${credits} crédito${credits !== 1 ? 's' : ''}`;
    if (side) side.textContent = `${credits} crédito${credits !== 1 ? 's' : ''} restante${credits !== 1 ? 's' : ''}`;
}

async function syncCredits() {
    try {
        const data = await apiFetch('/api/credits');
        if (data) { credits = data.credits; updateCredits(); }
    } catch {}
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('collapsed');
    if (overlay) overlay.classList.toggle('active', !sidebar.classList.contains('collapsed'));
}

function toggleUserMenu() {
    document.getElementById('userDropdown').classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const dd = document.getElementById('userDropdown');
    const btn = document.querySelector('.avatar-btn');
    if (dd && !dd.contains(e.target) && !btn?.contains(e.target)) {
        dd.classList.remove('open');
    }
});

// === CHAT MANAGEMENT ===

async function loadChats() {
    try {
        const data = await apiFetch('/api/chats');
        if (data) { savedChats = data.chats || []; renderChatList(); }
    } catch { savedChats = []; }
}

async function newChat() {
    chatHistory = [];
    currentChatId = null;
    codeVersions = [];
    currentVersionIndex = -1;
    currentFiles = {};
    document.getElementById('messages').innerHTML = '';
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('navActions').style.display = 'none';
    toggleSidebar();
}

async function selectChat(id) {
    try {
        const data = await apiFetch(`/api/chats/${id}`);
        if (!data) return;
        currentChatId = id;
        chatHistory = (data.messages || []).map(m => ({
            id: 'msg-' + m.id, role: m.role, content: m.content,
            files: m.files_json ? JSON.parse(m.files_json) : undefined,
            code: m.code, type: m.type, source: m.source
        }));
        currentFiles = data.files || {};
        codeVersions = Object.keys(currentFiles).length ? [JSON.parse(JSON.stringify(currentFiles))] : [];
        currentVersionIndex = codeVersions.length - 1;
        renderMessages();
        renderChatList();
        toggleSidebar();
    } catch (e) { console.error('Erro ao carregar chat:', e); }
}

async function saveChat(title) {
    try {
        if (!currentChatId) {
            const data = await apiFetch('/api/chats', {
                method: 'POST', body: JSON.stringify({ title: title || 'Nova Conversa' })
            });
            if (data) currentChatId = data.id;
        } else if (title) {
            await apiFetch(`/api/chats/${currentChatId}`, {
                method: 'PUT', body: JSON.stringify({ title })
            });
        }
        if (Object.keys(currentFiles).length > 0 && currentChatId) {
            await apiFetch(`/api/chats/${currentChatId}/files`, {
                method: 'POST', body: JSON.stringify({ files: currentFiles })
            });
        }
        await loadChats();
    } catch {}
}

async function deleteChat(id) {
    try {
        await apiFetch(`/api/chats/${id}`, { method: 'DELETE' });
        if (currentChatId === id) await newChat();
        await loadChats();
    } catch {}
}

function renderChatList() {
    const list = document.getElementById('chatList');
    if (!list) return;
    list.innerHTML = savedChats.slice(0, 10).map(c => `
        <div class="chat-item ${c.id === currentChatId ? 'active' : ''}" onclick="selectChat(${c.id})">
            <span class="chat-item-icon">💬</span>
            <span class="chat-item-title">${escapeHtml(c.title)}</span>
        </div>
    `).join('');
}

// === MESSAGE RENDERING ===

function renderMessages() {
    const msgs = document.getElementById('messages');
    msgs.innerHTML = '';
    document.getElementById('welcomeScreen').style.display = chatHistory.length ? 'none' : 'flex';
    let hasCode = false;
    chatHistory.forEach(m => {
        const isUser = m.role === 'user';
        const div = document.createElement('div');
        div.className = `message ${isUser ? 'user-msg' : ''}`;
        if (!isUser && (m.files || m.code)) hasCode = true;

        let imagesHtml = '';
        if (m.images?.length) {
            imagesHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
                m.images.map(img => `<img src="${img.preview}" class="msg-image" alt="${img.name}">`).join('') + '</div>';
        }

        let audioHtml = '';
        if (m.hasAudio) {
            audioHtml = '<div style="margin-top:8px;padding:6px 12px;background:rgba(124,92,252,0.1);border-radius:8px;font-size:0.75rem;color:var(--muted)">🎤 Áudio enviado</div>';
        }

        div.innerHTML = `
            <div class="msg-avatar ${isUser ? 'user' : 'ai'}">${isUser ? user.name?.charAt(0)?.toUpperCase() || 'U' : '<img src="logo.jpg" alt="AI">'}</div>
            <div class="msg-body">
                <div class="msg-name">${isUser ? 'Você' : 'Corvo Coder'}</div>
                <div class="msg-text">${formatMsg(m.content)}</div>
                ${imagesHtml}
                ${audioHtml}
            </div>`;
        msgs.appendChild(div);
    });
    document.getElementById('navActions').style.display = hasCode ? 'flex' : 'none';
    msgs.scrollTop = msgs.scrollHeight;
}

function useSuggestion(text) {
    document.getElementById('chatInput').value = text;
    send();
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function formatMsg(text) {
    let s = escapeHtml(text);
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, '');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\n/g, '<br>');
    s = s.replace(/<br>\s*<br>/g, '<br>');
    s = s.trim();
    if (!s) return '<span style="color:#6b7280">Projeto criado com sucesso ✓</span>';
    return s;
}

// === FILE MANAGEMENT ===

function buildFileTree(files) {
    const tree = {};
    for (const [path, file] of Object.entries(files)) {
        const parts = path.split('/');
        if (parts.length === 1) {
            tree[path] = file.type === 'folder' ? file : { content: file.content, size: file.size || file.content?.length || 0 };
        } else {
            let current = tree;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]]) current[parts[i]] = { type: 'folder', children: {} };
                current = current[parts[i]].children;
            }
            current[parts[parts.length - 1]] = { content: file.content, size: file.size || file.content?.length || 0 };
        }
    }
    return tree;
}

function getPreviewHTML() {
    if (currentFiles['index.html']?.content) return currentFiles['index.html'].content;
    return null;
}

// === WORKSPACE ===

function openWorkspace() {
    localStorage.setItem('cc_workspace', JSON.stringify({
        project: document.getElementById('projectName')?.textContent || 'Projeto',
        files: currentFiles,
        preview: getPreviewHTML()
    }));
    window.location.href = 'pages/vscode.html';
}

function deployProject() {
    const indexHTML = currentFiles['index.html']?.content;
    if (!indexHTML) {
        alert('Nenhum projeto para deploy. Gere código primeiro.');
        return;
    }
    // Simulated deploy — open preview in new tab
    const win = window.open('', '_blank');
    if (win) {
        win.document.write(indexHTML);
        win.document.close();
    }
    showToast('Projeto aberto em nova aba (preview do deploy)');
}

// === VERSION HISTORY ===

function saveVersion(files) {
    codeVersions.push(JSON.parse(JSON.stringify(files)));
    currentVersionIndex = codeVersions.length - 1;
}

// === SEND MESSAGE ===

let isProcessing = false;
let pendingQueue = null;

async function send() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    const hasImages = pendingImages.length > 0;
    const hasAudio = !!pendingAudio;

    if (!text && !hasImages && !hasAudio) return;

    // Require login to send messages
    if (!token || !user) {
        window.location.href = 'pages/login.html';
        return;
    }

    // Build user content for display
    let displayContent = text || '';
    if (hasImages) displayContent += (displayContent ? '\n' : '') + `[${pendingImages.length} imagem(ns) anexada(s)]`;
    if (hasAudio) displayContent += (displayContent ? '\n' : '') + '[Áudio anexado]';

    // If AI is processing, queue the message and append to pending response
    if (isProcessing) {
        if (!pendingQueue) pendingQueue = [];
        pendingQueue.push({ text, displayContent, images: pendingImages.map(i => ({ preview: i.preview, name: i.name })), apiImages: pendingImages.map(i => ({ data: i.data, mimeType: i.mimeType })), audio: pendingAudio ? { data: pendingAudio.data, mimeType: pendingAudio.mimeType } : null });
        chatHistory.push({ id: 'u-' + Date.now(), role: 'user', content: displayContent });
        renderMessages();
        pendingImages = [];
        pendingAudio = null;
        renderImagePreview();
        input.value = '';
        input.style.height = 'auto';
        showToast('Mensagem na fila — será processada quando a anterior terminar');
        return;
    }

    isProcessing = true;

    chatHistory.push({
        id: 'u-' + Date.now(), role: 'user', content: displayContent,
        images: hasImages ? pendingImages.map(i => ({ preview: i.preview, name: i.name })) : undefined,
        hasAudio: hasAudio
    });
    renderMessages();

    // Build API payload
    const apiImages = pendingImages.map(i => ({ data: i.data, mimeType: i.mimeType }));
    const apiAudio = pendingAudio ? { data: pendingAudio.data, mimeType: pendingAudio.mimeType } : null;

    // Clear inputs
    pendingImages = [];
    pendingAudio = null;
    renderImagePreview();
    input.value = '';
    input.style.height = 'auto';

    await doSend(text, apiImages, apiAudio);

    // Process queued messages
    let allQueuedTexts = [];
    while (pendingQueue && pendingQueue.length > 0) {
        const queued = pendingQueue.shift();
        allQueuedTexts.push(queued.text);
        showToast(`Processando fila... (${pendingQueue.length} restante${pendingQueue.length > 1 ? 's' : ''})`);
    }
    if (allQueuedTexts.length > 0) {
        await doSend(null, [], null, allQueuedTexts);
    }

    isProcessing = false;
    pendingQueue = null;
}

async function doSend(text, apiImages, apiAudio, queuedTexts) {
    const thinkId = 'think-' + Date.now();
    const msgs = document.getElementById('messages');
    msgs.innerHTML += `
        <div class="message" id="${thinkId}">
            <div class="msg-avatar ai"><img src="logo.jpg" alt="AI"></div>
            <div class="msg-body">
                <div class="msg-name">Corvo Coder</div>
                <div class="thinking">
                    <div class="thinking-dot"></div>
                    <div class="thinking-dot"></div>
                    <div class="thinking-dot"></div>
                </div>
            </div>
        </div>`;
    msgs.scrollTop = msgs.scrollHeight;

    // Ensure we have a chat in the DB
    if (!currentChatId && text) {
        const title = (text || 'Imagem/Áudio').substring(0, 40);
        const chatData = await apiFetch('/api/chats', { method: 'POST', body: JSON.stringify({ title }) });
        if (chatData) currentChatId = chatData.id;
    }

    try {
        const res = await fetch(`${API}/api/chat`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                message: text,
                history: chatHistory.map(m => ({ role: m.role, content: m.content })),
                images: apiImages.length ? apiImages : undefined,
                audio: apiAudio || undefined,
                chatId: currentChatId || undefined,
                queuedMessages: queuedTexts && queuedTexts.length > 0 ? queuedTexts : undefined
            })
        });

        if (res.status === 401) {
            localStorage.removeItem('cc_token');
            window.location.href = 'pages/login.html';
            return;
        }

        const data = await res.json();
        const reply = data.reply || 'Desculpe, erro ao processar.';

        let files = data.files || null;
        const hasFiles = files && Object.keys(files).length > 0;

        if (!hasFiles && data.code) {
            files = { 'index.html': { content: data.code, size: data.code.length } };
        }

        const aiMsg = {
            id: 'a-' + Date.now(), role: 'assistant', content: reply,
            files, code: hasFiles ? (files['index.html']?.content || '') : (data.code || null),
            type: data.type || 'web', source: data.source
        };
        chatHistory.push(aiMsg);

        if (hasFiles) {
            syncCredits();
        }

        const thinkEl = document.getElementById(thinkId);
        if (thinkEl) {
            thinkEl.querySelector('.thinking').outerHTML = `<div class="msg-text">${formatMsg(reply)}</div>`;
        }

        if (hasFiles) {
            currentFiles = mergeFiles(currentFiles, files);
            saveVersion(currentFiles);
        }

        await loadChats();
        renderMessages();
    } catch (err) {
        const thinkEl = document.getElementById(thinkId);
        if (thinkEl) thinkEl.remove();
        chatHistory.push({ id: 'e-' + Date.now(), role: 'assistant', content: 'Erro de conexão. Verifique se o servidor está rodando.' });
        renderMessages();
    }
}

// Merge files: existing files are edited, new ones are added
function mergeFiles(existing, newFiles) {
    const merged = JSON.parse(JSON.stringify(existing));
    for (const [path, file] of Object.entries(newFiles)) {
        const parts = path.split('/');
        if (parts.length === 1) {
            // Root file — overwrite or create
            merged[path] = file;
        } else if (parts.length === 2 && parts[0] === 'css') {
            // CSS file
            if (!merged['css'] || merged['css'].type !== 'folder') {
                merged['css'] = { type: 'folder', children: {} };
            }
            merged['css'].children[parts[1]] = file;
        } else if (parts.length === 2 && parts[0] === 'js') {
            // JS file
            if (!merged['js'] || merged['js'].type !== 'folder') {
                merged['js'] = { type: 'folder', children: {} };
            }
            merged['js'].children[parts[1]] = file;
        } else {
            // Deep path
            let current = merged;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]] || current[parts[i]].type !== 'folder') {
                    current[parts[i]] = { type: 'folder', children: {} };
                }
                current = current[parts[i]].children;
            }
            current[parts[parts.length - 1]] = file;
        }
    }
    return merged;
}

// === TOAST ===
// === FILE UPLOAD ===

function handleFiles(files) {
    if (!files || !files.length) return;
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result.split(',')[1];
                pendingImages.push({ data: base64, mimeType: file.type, name: file.name, preview: e.target.result });
                renderImagePreview();
                showToast(`Imagem "${file.name}" anexada`);
            };
            reader.readAsDataURL(file);
        } else if (file.type.startsWith('audio/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result.split(',')[1];
                pendingAudio = { data: base64, mimeType: file.type, name: file.name };
                showToast(`Áudio "${file.name}" anexado`);
            };
            reader.readAsDataURL(file);
        } else {
            const reader = new FileReader();
            reader.onload = (e) => {
                const content = e.target.result;
                const name = file.name;
                const ext = name.split('.').pop().toLowerCase();
                const input = document.getElementById('chatInput');
                const current = input.value.trim();
                const attachment = `[Arquivo anexado: ${name}]\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
                input.value = current + '\n' + attachment;
                autoResize(input);
                showToast(`Arquivo "${name}" anexado`);
            };
            reader.readAsText(file);
        }
    }
}

function renderImagePreview() {
    const bar = document.getElementById('imagePreviewBar');
    if (!bar) return;
    if (!pendingImages.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML = pendingImages.map((img, i) => `
        <div class="image-preview-item">
            <img src="${img.preview}" alt="${img.name}">
            <button class="remove-img" onclick="removePendingImage(${i})">×</button>
        </div>
    `).join('');
}

function removePendingImage(idx) {
    pendingImages.splice(idx, 1);
    renderImagePreview();
}

// Paste image from clipboard
document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) handleFiles([file]);
        }
    }
});

// Drag and drop
function setupDragDrop() {
    const area = document.getElementById('inputArea');
    if (!area) return;
    ['dragenter', 'dragover'].forEach(ev => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('dragover'); }));
    area.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files?.length) handleFiles(files);
    });
}

// === MICROPHONE / SPEECH RECOGNITION ===
function toggleMic() {
    if (isRecording) {
        if (recognition) { stopMic(); }
        else { stopAudioRecord(); }
    } else {
        startMic();
    }
}

function startMic() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        // Use Web Speech API (real-time transcription)
        recognition = new SpeechRecognition();
        recognition.lang = 'pt-BR';
        recognition.interimResults = true;
        recognition.continuous = true;
        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            const input = document.getElementById('chatInput');
            if (input) { input.value = transcript; autoResize(input); }
        };
        recognition.onerror = (event) => {
            if (event.error === 'not-allowed') showToast('Permissão de microfone negada');
            stopMic();
        };
        recognition.onend = () => { if (isRecording) stopMic(); };
        try {
            recognition.start();
            isRecording = true;
            document.getElementById('micBtn')?.classList.add('recording');
            showToast('Fale agora... (transcrição em tempo real)');
        } catch { startAudioRecord(); }
    } else {
        // Fallback: MediaRecorder (gravar áudio)
        startAudioRecord();
    }
}

function stopMic() {
    isRecording = false;
    document.getElementById('micBtn')?.classList.remove('recording');
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    showToast('Gravação finalizada');
}

// === AUDIO RECORDING (MediaRecorder) ===
async function startAudioRecord() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result.split(',')[1];
                pendingAudio = { data: base64, mimeType: 'audio/webm', name: 'audio.webm' };
                showToast('Áudio gravado e anexado');
            };
            reader.readAsDataURL(blob);
            stream.getTracks().forEach(t => t.stop());
        };
        mediaRecorder.start();
        isRecording = true;
        document.getElementById('micBtn')?.classList.add('recording');
    } catch (err) {
        showToast('Erro ao acessar microfone: ' + err.message);
    }
}

function stopAudioRecord() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); }
    isRecording = false;
    document.getElementById('micBtn')?.classList.remove('recording');
}

function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast success';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// === INIT ===

async function init() {
    // Try to load user if token exists, but don't block
    if (token) {
        try {
            const data = await apiFetch('/api/auth/me');
            if (data && data.user) {
                user = data.user;
                credits = user.credits;
            }
        } catch {}
    }

    if (user) {
        const av = document.getElementById('userInitial');
        if (av) av.textContent = user.name?.charAt(0)?.toUpperCase() || 'U';
        const dd = document.getElementById('dropdownName');
        if (dd) dd.textContent = user.name || 'Usuário';
        const de = document.getElementById('dropdownEmail');
        if (de) de.textContent = user.email || '';
    }
    updateCredits();
    if (token) await loadChats();
    renderMessages();
    setupDragDrop();
}

async function logout() {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('cc_token');
    localStorage.removeItem('cc_user');
    localStorage.removeItem('cc_credits');
    window.location.href = 'pages/login.html';
}

init();
