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
    const token = localStorage.getItem('cc_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (res.status === 401) {
        localStorage.removeItem('cc_token');
        localStorage.removeItem('cc_user');
        return null;
    }
    return res.json();
}

const PLAN_MAX = { free: 50, pro: 500, enterprise: Infinity };

function updateCredits() {
    const plan = user?.plan || 'free';
    const max = PLAN_MAX[plan] || 50;
    const fill = document.getElementById('creditsFill');
    const text = document.getElementById('creditsText');
    const side = document.getElementById('sideCredits');
    
    if (!user) {
        const guestCredits = parseInt(localStorage.getItem('cc_guest_credits') || '10');
        const pct = Math.max(0, Math.min(100, (guestCredits / 10) * 100));
        if (fill) {
            fill.style.width = pct + '%';
            fill.style.background = pct < 20 ? 'linear-gradient(90deg,#ef4444,#f97316)' : 'linear-gradient(90deg,#7c3aed,#a78bfa)';
        }
        if (text) text.textContent = `Convidado (${guestCredits}/10 cr)`;
        if (side) side.textContent = `${guestCredits} crédito(s) restante(s)`;
        return;
    }

    const pct = plan === 'enterprise' ? 100 : Math.max(0, Math.min(100, (credits / max) * 100));
    const label = plan === 'enterprise' ? '∞ créditos' : `${credits}/${max}`;
    if (fill) {
        fill.style.width = pct + '%';
        fill.style.background = pct < 15 ? 'linear-gradient(90deg,#ef4444,#f97316)' : 'linear-gradient(90deg,#7c3aed,#a78bfa)';
    }
    if (text) text.textContent = label;
    if (side) side.textContent = plan === 'enterprise' ? 'Créditos ilimitados' : `${credits} crédito${credits !== 1 ? 's' : ''} restante${credits !== 1 ? 's' : ''}`;
}

function updateUserDropdown() {
    const pill = document.getElementById('creditsPill');
    const avBtn = document.getElementById('avatarBtn');
    const dd = document.getElementById('userDropdown');
    if (!pill || !avBtn || !dd) return;

    pill.style.display = 'flex';
    avBtn.style.display = 'flex';

    if (user) {
        const av = document.getElementById('userInitial');
        if (av) av.textContent = user.name?.charAt(0)?.toUpperCase() || 'U';
        dd.innerHTML = `
            <div class="dropdown-header">
                <div class="dropdown-name">${user.name || 'Usuário'}</div>
                <div class="dropdown-email">${user.email || ''}</div>
            </div>
            <div class="dropdown-divider"></div>
            <a href="pages/settings.html" class="dropdown-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                Configurações
            </a>
            <a href="pages/billing.html" class="dropdown-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                Planos
            </a>
            <button class="dropdown-item" onclick="exportChatAsTxt()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Exportar Conversa
            </button>
            <a href="admin/" class="dropdown-item" target="_blank">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Painel Admin
            </a>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" onclick="logout()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Sair
            </button>
        `;
    } else {
        const av = document.getElementById('userInitial');
        if (av) av.textContent = 'C';
        dd.innerHTML = `
            <div class="dropdown-header">
                <div class="dropdown-name">Convidado</div>
                <div class="dropdown-email">Faça login para salvar projetos</div>
            </div>
            <div class="dropdown-divider"></div>
            <a href="pages/login.html" class="dropdown-item" style="color:var(--accent);font-weight:600">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                Entrar / Login
            </a>
            <a href="pages/register.html" class="dropdown-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                Criar Conta
            </a>
            <a href="pages/billing.html" class="dropdown-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                Planos & Preços
            </a>
        `;
    }
}

function showCreditCost(cost) {
    if (!cost || cost <= 0) return;
    const pill = document.getElementById('creditsPill');
    if (!pill) return;
    const badge = document.createElement('span');
    badge.textContent = `−${cost}`;
    badge.style.cssText = 'position:absolute;top:-8px;right:-8px;background:rgba(167,139,250,0.9);color:#fff;font-size:0.68rem;font-weight:700;padding:2px 7px;border-radius:10px;animation:creditPop 2s forwards;pointer-events:none;z-index:999';
    if (!document.getElementById('creditPopStyle')) {
        const s = document.createElement('style');
        s.id = 'creditPopStyle';
        s.textContent = '@keyframes creditPop{0%{opacity:0;transform:translateY(4px)}15%{opacity:1;transform:translateY(-4px)}80%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}';
        document.head.appendChild(s);
    }
    pill.style.position = 'relative';
    pill.appendChild(badge);
    setTimeout(() => badge.remove(), 2100);
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
    document.getElementById('navActions').style.display = 'flex';
    const exportBtn = document.querySelector('.nav-action-btn.export');
    if (exportBtn) exportBtn.style.display = 'none';
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
            code: m.code, type: m.type, source: m.source,
            time: m.created_at ? new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : formatTime(new Date())
        }));
        
        // Verifica se há arquivos modificados no localStorage deste chat
        const localWorkspaceRaw = localStorage.getItem('cc_workspace');
        let loadedLocal = false;
        if (localWorkspaceRaw) {
            try {
                const localWorkspace = JSON.parse(localWorkspaceRaw);
                if (localWorkspace.chatId === id && localWorkspace.files) {
                    currentFiles = localWorkspace.files;
                    loadedLocal = true;
                }
            } catch (e) { console.error(e); }
        }

        if (!loadedLocal) {
            currentFiles = mergeFiles({}, data.files || {});
        }

        codeVersions = Object.keys(currentFiles).length ? [JSON.parse(JSON.stringify(currentFiles))] : [];
        currentVersionIndex = codeVersions.length - 1;
        renderMessages();
        renderChatList();
        toggleSidebar();
        
        // Se carregou o local modificado, sincroniza com o banco de dados do servidor
        if (loadedLocal) {
            saveChat();
        }
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
        const isAi = !isUser;
        const div = document.createElement('div');
        div.className = `message ${isUser ? 'user-msg' : ''}`;
        div.setAttribute('data-msg', m.id || '');
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
            <div class="msg-avatar ${isUser ? 'user' : 'ai'}">${isUser ? user?.name?.charAt(0)?.toUpperCase() || 'U' : '<img src="logo.jpg" alt="AI">'}</div>
            <div class="msg-body">
                <div class="msg-name">
                    <span>${isUser ? 'Você' : 'Corvo Coder'}</span>
                    <span class="msg-time">${m.time || formatTime(new Date())}</span>
                </div>
                <div class="msg-text">${formatMsg(m.content)}</div>
                ${m.model ? `<div class="model-used-badge" title="${m.modelInfo?.desc || ''}">${getModelShortName(m.model, m.modelInfo)}</div>` : ''}${m.guest ? `<a href="pages/login.html" class="guest-badge" title="Faça login para salvar conversas e ter mais créditos">👤 Convidado</a>` : ''}
                ${isAi && !m.id.startsWith('e-') ? `
                    <div class="msg-actions">
                        <button class="speaker-btn" data-msg="${m.id || ''}" onclick="toggleSpeech('${m.id || ''}', '${escapeHtml(m.content).replace(/'/g, '&apos;')}')" title="Ouvir resposta">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                            Ouvir
                        </button>
                    </div>
                ` : ''}
                ${m.images && m.images.length > 0 ? m.images.map((img, imgIdx) => `
                    <div class="gen-image-wrap">
                        <img src="data:${img.mimeType || 'image/png'};base64,${img.imageData}" class="gen-image" alt="${img.prompt || 'Imagem gerada'}" loading="lazy" onclick="openLightbox(this)" data-mime="${img.mimeType || 'image/png'}" data-prompt="${escapeHtml(img.prompt || '').replace(/'/g, '&apos;')}" title="Clique para ampliar">
                        <div class="gen-image-actions">
                            ${img.prompt ? '<span class="gen-image-caption">🎨 ' + escapeHtml(img.prompt) + '</span>' : ''}
                            <button class="gen-image-dl" onclick="dlImage('${img.imageData}', '${img.mimeType || 'image/png'}')" title="Baixar imagem">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                Baixar
                            </button>
                            <button class="gen-image-cp" onclick="cpImage('${img.imageData}', '${img.mimeType || 'image/png'}')" title="Copiar imagem">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                Copiar
                            </button>
                        </div>
                    </div>
                `).join('') : ''}
                ${imagesHtml}
                ${audioHtml}
            </div>`;
        msgs.appendChild(div);
    });
    document.getElementById('navActions').style.display = 'flex';
    const exportBtn = document.querySelector('.nav-action-btn.export');
    if (exportBtn) exportBtn.style.display = chatHistory.length > 0 ? 'flex' : 'none';
    msgs.scrollTop = msgs.scrollHeight;
}

// === PROJECT TEMPLATES ===

const PROJECT_TEMPLATES = [
    { icon: '🌐', title: 'Landing Page', desc: 'Site institucional moderno', prompt: 'Crie uma landing page moderna e responsiva para uma startup de tecnologia. Inclua: hero section com call-to-action, seção de features com grid de 3 colunas, depoimentos de clientes com avatar, footer com links e redes sociais. Use design limpo com gradientes e animações suaves. Cores principais: roxo (#7c5cfc) e rosa (#f472b6).' },
    { icon: '📊', title: 'Dashboard', desc: 'Painel administrativo', prompt: 'Crie um dashboard administrativo completo com: sidebar de navegação com ícones, cards de métricas com KPIs animados, gráfico de vendas estilo barras usando CSS puro, tabela de dados com busca e paginação, menu de usuário com dropdown. Design dark mode com destaque em roxo.' },
    { icon: '👤', title: 'Portfólio', desc: 'Site pessoal criativo', prompt: 'Crie um site de portfólio pessoal moderno com: header fixo com navegação suave, seção hero com foto e frase de efeito, grid de projetos com hover effects 3D, seção de habilidades com progress bars animadas, formulário de contato funcional. Design responsivo e clean.' },
    { icon: '🛒', title: 'E-commerce', desc: 'Loja virtual simples', prompt: 'Crie uma página de e-commerce com: header com logo e carrinho com contador, grid de produtos com imagens, preços e botão comprar, filtros por categoria, modal de detalhes do produto, carrinho lateral com total e remover. Design moderno e responsivo.' },
    { icon: '📝', title: 'Blog', desc: 'Plataforma de conteúdo', prompt: 'Crie um blog moderno com: header com navegação e barra de busca, grid de cards de posts com imagens e categorias, página de post individual com barra lateral de tags, seção de comentários, footer com links. Design clean com tipografia elegante e muito espaçamento.' },
    { icon: '⚡', title: 'SaaS App', desc: 'Aplicativo web completo', prompt: 'Crie uma página de aplicativo SaaS completa com: landing hero com demonstração do produto, pricing table com 3 planos e destaque no recomendado, FAQ accordion interativo, preview do dashboard, formulário de signup multi-step. Design premium com animações suaves. Tema escuro com gradientes.' },
    { icon: '📱', title: 'App Mobile', desc: 'Interface de app nativo', prompt: 'Crie uma interface de aplicativo mobile-first com: tela de login com background gradient e logo, feed de cards estilo social media com like/compartilhar, tela de perfil com foto e estatísticas, bottom navigation com 4 abas e transições. Design moderno com cantos arredondados e sombras.' },
    { icon: '🎨', title: 'Galeria de Arte', desc: 'Portfolio visual imersivo', prompt: 'Crie uma galeria de arte interativa com: header minimalista, grid masonry de imagens com lazy loading, lightbox modal com navegação por setas, filtro por categoria/tags, transições suaves entre obras, footer com newsletter. Design elegante e minimalista com foco no conteúdo visual.' }
];

function renderTemplates() {
    const grid = document.getElementById('templateGrid');
    if (!grid) return;
    grid.innerHTML = PROJECT_TEMPLATES.map((t, i) => `
        <div class="template-card" data-index="${i}" title="${escapeHtml(t.desc)}">
            <div class="template-icon">${t.icon}</div>
            <div class="template-info">
                <div class="template-title">${escapeHtml(t.title)}</div>
                <div class="template-desc">${escapeHtml(t.desc)}</div>
            </div>
        </div>
    `).join('');
    grid.onclick = (e) => {
        const card = e.target.closest('.template-card');
        if (card) {
            const idx = parseInt(card.dataset.index);
            if (!isNaN(idx) && PROJECT_TEMPLATES[idx]) {
                applyTemplate(PROJECT_TEMPLATES[idx].prompt);
            }
        }
    };
}

function applyTemplate(prompt) {
    document.getElementById('chatInput').value = prompt;
    send();
}

// === EXPORT CHAT ===

function exportChatAsTxt() {
    if (!chatHistory.length) {
        showToast('Nenhuma conversa para exportar', 'error');
        return;
    }

    let text = '═══════════════════════════════════════════\n';
    text += '        CORVO CODER — CONVERSA EXPORTADA\n';
    text += '═══════════════════════════════════════════\n';
    text += `Data: ${new Date().toLocaleString('pt-BR')}\n`;
    text += `Mensagens: ${chatHistory.length}\n`;
    text += '───────────────────────────────────────────\n\n';

    chatHistory.forEach((m, i) => {
        const name = m.role === 'user' ? '👤 VOCÊ' : '🤖 CORVO CODER';
        text += `[${name}]\n`;
        text += `${m.content}\n`;
        if (m.images?.length) text += `\n📷 ${m.images.length} imagem(ns) anexada(s)\n`;
        if (m.hasAudio) text += `\n🎤 Áudio anexado\n`;
        text += '\n─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─\n\n';
    });

    text += '═══════════════════════════════════════════\n';
    text += `Fim da conversa — ${chatHistory.length} mensagens\n`;
    text += `Exportado em: ${new Date().toLocaleString('pt-BR')}\n`;
    text += '═══════════════════════════════════════════\n';

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `corvo-conversa-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✅ Conversa exportada como .txt');
}

function useSuggestion(text) {
    document.getElementById('chatInput').value = text;
    send();
}

// === KEYBOARD SHORTCUTS ===

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) return;

        switch (e.key.toLowerCase()) {
            case 'k':
                e.preventDefault();
                newChat();
                showToast('✨ Nova conversa iniciada');
                break;
            case 'e':
                e.preventDefault();
                exportChatAsTxt();
                break;
        }
    });
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function formatTime(d) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Download generated image
function dlImage(base64, mimeType) {
    const a = document.createElement('a');
    a.href = `data:${mimeType};base64,${base64}`;
    a.download = `corvo-imagem-${Date.now()}.${mimeType.split('/')[1] || 'png'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('✅ Imagem baixada');
}

// Copy generated image to clipboard
async function cpImage(base64, mimeType) {
    try {
        // Direct base64 → blob conversion (more reliable than fetch dataURL)
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        await navigator.clipboard.write([
            new ClipboardItem({ [mimeType]: blob })
        ]);
        showToast('📋 Imagem copiada!');
    } catch (err) {
        showToast('Erro ao copiar: ' + err.message);
    }
}

// === TEXT-TO-SPEECH ===
let _speakingId = null;
const _SPEAKER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const _STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

function setSpeakerBtn(msgId, icon, label) {
    const btn = document.querySelector(`.speaker-btn[data-msg="${msgId}"]`);
    if (btn) {
        btn.innerHTML = icon + ' ' + label;
        btn.title = label === 'Parar' ? 'Parar reprodução' : 'Ouvir resposta';
    }
}

function toggleSpeech(msgId, text) {
    // If this message is already speaking, stop it
    if (_speakingId === msgId) {
        stopSpeaking();
        return;
    }

    // Cancel any previous speech
    if (_speakingId) {
        const prevEl = document.querySelector(`.message[data-msg="${_speakingId}"]`);
        if (prevEl) prevEl.classList.remove('speaking');
        setSpeakerBtn(_speakingId, _SPEAKER_ICON, 'Ouvir');
    }
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }

    // Strip markdown/code markers for cleaner speech
    const cleanText = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/[#*_~\[\]()>|]/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim();

    if (!cleanText) {
        showToast('Nada para falar', 'error');
        return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'pt-BR';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Try to find a Brazilian Portuguese voice
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(v => v.lang.startsWith('pt'));
    if (ptVoice) utterance.voice = ptVoice;

    _speakingId = msgId;

    // Add speaking class to this message, update its button
    const msgEl = document.querySelector(`.message[data-msg="${msgId}"]`);
    if (msgEl) msgEl.classList.add('speaking');
    setSpeakerBtn(msgId, _STOP_ICON, 'Parar');

    utterance.onend = () => {
        const el = document.querySelector(`.message[data-msg="${_speakingId}"]`);
        if (el) el.classList.remove('speaking');
        setSpeakerBtn(_speakingId, _SPEAKER_ICON, 'Ouvir');
        _speakingId = null;
    };

    utterance.onerror = () => {
        const el = document.querySelector(`.message[data-msg="${_speakingId}"]`);
        if (el) el.classList.remove('speaking');
        setSpeakerBtn(_speakingId, _SPEAKER_ICON, 'Ouvir');
        _speakingId = null;
        showToast('Erro ao reproduzir áudio', 'error');
    };

    window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    if (_speakingId) {
        const el = document.querySelector(`.message[data-msg="${_speakingId}"]`);
        if (el) el.classList.remove('speaking');
        setSpeakerBtn(_speakingId, _SPEAKER_ICON, 'Ouvir');
        _speakingId = null;
    }
}

// Pre-load voices (they load asynchronously)
if (window.speechSynthesis) {
    window.speechSynthesis.getVoices(); // Trigger async load
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}

// Lightbox modal for generated images
let _lbKeyHandler = null;

function openLightbox(imgEl) {
    // Clean up any previous listener to prevent leaks
    if (_lbKeyHandler) {
        document.removeEventListener('keydown', _lbKeyHandler);
        _lbKeyHandler = null;
    }

    // Extract data from the clicked img element via dataset (avoids quote-escaping issues)
    const src = imgEl.src;
    const mimeType = imgEl.dataset.mime || 'image/png';
    const prompt = imgEl.dataset.prompt || '';

    const existing = document.getElementById('lightbox-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'lightbox-overlay';
    overlay.className = 'lightbox-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) closeLightbox(); };

    overlay.innerHTML = `
        <button class="lightbox-close" onclick="closeLightbox()" title="Fechar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="lightbox-content" onclick="event.stopPropagation()">
            <img src="${src}" class="lightbox-image" alt="${prompt || 'Imagem'}">
            ${prompt ? '<div class="lightbox-caption">🎨 ' + prompt + '</div>' : ''}
            <div class="lightbox-actions">
                <button class="lightbox-btn" onclick="event.stopPropagation(); dlImage('${src.split(',').pop()}', '${mimeType}')" title="Baixar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Baixar
                </button>
                <button class="lightbox-btn" onclick="event.stopPropagation(); cpImage('${src.split(',').pop()}', '${mimeType}')" title="Copiar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copiar
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    // Keyboard: Escape to close (stored in global ref for cleanup)
    _lbKeyHandler = (e) => {
        if (e.key === 'Escape') {
            closeLightbox();
        }
    };
    document.addEventListener('keydown', _lbKeyHandler);
}

function closeLightbox() {
    const overlay = document.getElementById('lightbox-overlay');
    if (overlay) {
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 250);
    }
    // Always clean up keyboard listener
    if (_lbKeyHandler) {
        document.removeEventListener('keydown', _lbKeyHandler);
        _lbKeyHandler = null;
    }
}

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
        chatId: currentChatId,
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

    if (!user) {
        const guestCredits = parseInt(localStorage.getItem('cc_guest_credits') || '10');
        if (guestCredits < 1) {
            showToast('⚡ Créditos de convidado esgotados! Crie uma conta para ganhar 50 créditos.', 'error');
            chatHistory.push({ id: 'e-' + Date.now(), role: 'assistant', content: '⚡ Seus créditos de convidado acabaram. Faça login ou crie uma conta gratuita para ganhar **50 créditos**!' });
            renderMessages();
            return;
        }
    }

    if (!text && !hasImages && !hasAudio) return;



    // Build user content for display
    let displayContent = text || '';
    if (hasImages) displayContent += (displayContent ? '\n' : '') + `[${pendingImages.length} imagem(ns) anexada(s)]`;
    if (hasAudio) displayContent += (displayContent ? '\n' : '') + '[Áudio anexado]';

    // If AI is processing, queue the message and append to pending response
    if (isProcessing) {
        if (!pendingQueue) pendingQueue = [];
        pendingQueue.push({ text, displayContent, images: pendingImages.map(i => ({ preview: i.preview, name: i.name })), apiImages: pendingImages.map(i => ({ data: i.data, mimeType: i.mimeType })), audio: pendingAudio ? { data: pendingAudio.data, mimeType: pendingAudio.mimeType } : null });
        chatHistory.push({ id: 'u-' + Date.now(), role: 'user', content: displayContent, time: formatTime(new Date()) });
        renderMessages();
        pendingImages = [];
        pendingAudio = null;
        renderImagePreview();
        input.value = '';
        input.style.height = 'auto';
        showToast('Mensagem na fila — será processada quando a anterior terminar');
        return;
    }

    isProcessing = true;    chatHistory.push({
        id: 'u-' + Date.now(), role: 'user', content: displayContent,
        images: hasImages ? pendingImages.map(i => ({ preview: i.preview, name: i.name })) : undefined,
        hasAudio: hasAudio,
        time: formatTime(new Date())
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
            return;
        }

        const data = await res.json();

        if (res.status === 402) {
            const thinkEl = document.getElementById(thinkId);
            if (thinkEl) thinkEl.remove();
            chatHistory.push({ id: 'e-' + Date.now(), role: 'assistant', content: '⚡ Seus créditos acabaram. Faça upgrade do seu plano para continuar.' });
            renderMessages();
            return;
        }

        const reply = data.reply || 'Desculpe, erro ao processar.';

        // Atualiza créditos em tempo real sem nova requisição ao servidor
        if (user && typeof data.creditsLeft === 'number') {
            credits = data.creditsLeft;
            updateCredits();
        } else if (!user) {
            // Dedução local de créditos para convidados
            let cost = 1;
            const files = data.files || null;
            if (files && Object.keys(files).length > 0) cost = 3;
            let guestCredits = parseInt(localStorage.getItem('cc_guest_credits') || '10');
            guestCredits = Math.max(0, guestCredits - cost);
            localStorage.setItem('cc_guest_credits', guestCredits.toString());
            updateCredits();
            showCreditCost(cost);
        }
        if (data.creditsUsed > 0 && user) {
            showCreditCost(data.creditsUsed);
        }

        let files = data.files || null;
        const hasFiles = files && Object.keys(files).length > 0;

        if (!hasFiles && data.code) {
            files = { 'index.html': { content: data.code, size: data.code.length } };
        }

        const aiMsg = {
            id: 'a-' + Date.now(), role: 'assistant', content: reply,
            files, code: hasFiles ? (files['index.html']?.content || '') : (data.code || null),
            type: data.type || 'web', source: data.source,
            images: data.images || undefined,
            model: data.selectedModel || null,
            modelInfo: data.selectedModelInfo || null,
            guest: data.guest || false,
            time: formatTime(new Date())
        };
        chatHistory.push(aiMsg);

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
        // Auto-play: speak the AI response
        if (reply && !reply.startsWith('Desculpe, erro')) {
            toggleSpeech(aiMsg.id, reply);
        }
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

function showToast(msg, type) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'success');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// === INIT ===

async function init() {
    // Try to load user if token exists
    if (token) {
        try {
            const data = await apiFetch('/api/auth/me');
            if (data && data.user) {
                user = data.user;
                credits = user.credits;
            } else {
                token = null;
                localStorage.removeItem('cc_token');
                localStorage.removeItem('cc_user');
            }
        } catch {
            // Server not available — anonymous mode
        }
    }

    if (!user) {
        if (!localStorage.getItem('cc_guest_credits')) {
            localStorage.setItem('cc_guest_credits', '10');
        }
    }

    updateUserDropdown();
    document.getElementById('navActions').style.display = 'flex';
    const exportBtn = document.querySelector('.nav-action-btn.export');
    if (exportBtn) exportBtn.style.display = 'none';
    updateCredits();
    if (token) {
        await loadChats();
        
        // Retorna automaticamente para a conversa ativa que estava aberta no VS Code
        const workspaceRaw = localStorage.getItem('cc_workspace');
        if (workspaceRaw) {
            try {
                const workspace = JSON.parse(workspaceRaw);
                if (workspace.chatId) {
                    await selectChat(workspace.chatId);
                }
            } catch (e) { console.error('Erro ao retomar chat ativo:', e); }
        }
    }
    renderMessages();
    renderTemplates();
    setupDragDrop();
    setupKeyboardShortcuts();
    loadUserModel();
}

async function loadUserModel() {
    try {
        const data = await apiFetch('/api/user/model');
        if (data && data.model) {
            const badge = document.getElementById('modelBadgeName');
            if (badge) {
                const shortName = data.modelInfo?.name || data.model.split('/').pop() || data.model;
                badge.textContent = shortName;
            }
        }
    } catch {}
}

async function logout() {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('cc_token');
    localStorage.removeItem('cc_user');
    localStorage.removeItem('cc_credits');
    window.location.href = 'pages/login.html';
}

init();
