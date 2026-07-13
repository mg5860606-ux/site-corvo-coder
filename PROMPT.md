# Corvo Coder — Prompt Completo de Arquitetura

## 🐦 O QUE É O CORVO CODER

O Corvo Coder é uma plataforma de desenvolvimento assistido por IA, similar ao Emergent. O usuário descreve o que quer construir e um agente AI autônomo gera o código completo, com a possibilidade de visualizar, editar e fazer deploy diretamente na plataforma.

---

## 🏗️ ARQUITETURA DO SISTEMA

### Stack Principal
- **Backend:** Node.js + Express (porta 3000)
- **Frontend:** HTML/CSS/JS puro (SPA)
- **Banco de dados:** SQLite (via better-sqlite3)
- **AI:** Google Gemini 2.5 Flash API
- **Temas:** Dark mode profissional (VS Code style)

### Componentes
1. **Chat Interface** — `/index.html` — Interface principal de conversa com a IA
2. **VS Code View** — `/pages/vscode.html` — Editor de código completo estilo VS Code
3. **Admin Panel** — `/admin/` — Painel de administração com agente autônomo
4. **Server** — `/server.js` — Backend com API Gemini + mocks + agent API

---

## 📁 ESTRUTURA DE ARQUIVOS

```
corvo-coder/
├── index.html              # Interface principal (chat)
├── server.js               # Backend Express + Gemini + Agent
├── .env                    # Variáveis de ambiente (GEMINI_API_KEY)
├── css/
│   ├── style.css           # Estilos do chat principal
│   ├── vscode.css          # Estilos do VS Code View
│   └── workspace.css       # Estilos legados
├── js/
│   ├── app.js              # Lógica do chat (enviar, receber, salvar)
│   ├── vscode.js           # Lógica do VS Code View (editor, file tree, search)
│   └── workspace.js        # Lógica legada
├── pages/
│   ├── vscode.html         # VS Code View (editor completo)
│   ├── workspace.html      # Workspace legado
│   ├── login.html          # Login
│   ├── signup.html         # Cadastro
│   ├── settings.html       # Configurações
│   └── billing.html        # Planos
├── admin/
│   └── index.html          # Painel Admin com agente autônomo
├── agent/
│   └── agent.js            # Agente autônomo (monitoramento, decisões, ações)
├── logo.jpg                # Logo da marca
├── fundo.jpg               # Imagem de fundo
└── backups/                # Backups do sistema
```

---

## 🤖 AGENTE AI (GEMINI)

### System Prompt
```
Você é o Corvo Coder, um agente de desenvolvimento autônomo e profissional.

IDENTIDADE:
- Nome: Corvo Coder
- É um engenheiro de software sênior que constrói aplicações reais
- Fala naturalmente, como um dev experiente
- Usa linguagem casual brasileira
- NUNCA diga "Sou uma IA"

FLUXO DE TRABALHO:
1. BOAS-VINDAS — Acknowledge + 2-3 perguntas-chave
2. PLAYBOOK — Apresenta arquitetura antes de gerar
3. GERAÇÃO — Código completo em ```html ... ```
4. ITERAÇÃO — Correções e adições (TODO o código novamente)

REGRAS:
- Gere CÓDIGO COMPLETO dentro de ```html ... ```
- Design profissional: dark mode, animações, responsivo
- Máximo 3-4 frases antes do código
- Quando for pergunta/conversa, responda SEM gerar código
```

### Design Guidelines
```css
/* Backgrounds */
--bg: #0a0a12;       /* Principal */
--bg2: #12121f;      /* Cards */
--bg3: #1a1a2e;      /* Elevated */

/* Borders */
--border: #1e1e35;   /* Sutil */
--border-light: #2a2a45; /* Hover */

/* Texto */
--text: #e8e8f0;     /* Principal */
--muted: #6b7280;    /* Secundário */

/* Accent */
--accent: #7c5cfc;   /* Roxo */
--green: #22c55e;    /* Sucesso */
--red: #ef4444;      /* Erro */

/* Fontes */
font-family: 'Inter', system-ui, sans-serif;
font-family: 'JetBrains Mono', monospace; /* Código */

/* Bordas e Sombras */
border-radius: 8px;  /* Cards */
border-radius: 12px; /* Modais */
box-shadow: 0 4px 20px rgba(0,0,0,0.3);
```

---

## 💬 INTERFACE DO CHAT

### Funcionalidades
- Tela de boas-vindas com logo + sugestões
- Mensagens alinhadas: usuário à direita, AI à esquerda
- Botões "VS Code View" e "Deploy" após geração de código
- Sidebar com histórico de conversas
- Barra de créditos
- Menu do usuário (configurações, planos, sair)

### API Backend
```
POST /api/chat
Body: { message: string, history: Array<{role, content}> }
Response: { reply: string, code?: string, type?: "web"|"code", source: string }

GET /api/health
Response: { status: "ok", ai: boolean, agent: string }
```

### Fluxo do Chat
1. Usuário digita mensagem
2. Frontend envia para POST /api/chat
3. Backend tenta Gemini API → se falhar, usa mock
4. Resposta: texto + código (se houver)
5. Código extraído de ```html ... ```
6. Botões "VS Code View" e "Deploy" aparecem na mensagem
7. Código salvo em versões (versionamento)

---

## ⬡ VS CODE VIEW

### Funcionalidades Completas
- **Activity Bar:** Explorer, Search, Git, Extensões
- **File Tree:** Pastas expansíveis com ícones por tipo
- **Editor:** Syntax highlighting, numeração de linhas, edição real
- **Tabs:** Múltiplos arquivos abertos simultaneamente
- **Search:** Busca em todos os arquivos (com regex)
- **Terminal:** Integrado (Ctrl+`)
- **Preview:** Painel de preview ao lado
- **Breadcrumb:** Navegação de caminho
- **Status Bar:** Branch, cursor, encoding, linguagem
- **Atalhos:** Ctrl+F (buscar), Ctrl+` (terminal), Ctrl+S (salvar)

### Syntax Highlighting Suportado
- HTML/HTM — Tags, atributos, valores, comentários
- CSS — Seletores, propriedades, valores, comentários
- JS — Keywords, funções, strings, números, comentários
- JSON — Chaves, valores, strings
- Python — Keywords, funções, strings, comentários

### Dados (localStorage)
```json
{
  "project": "Nome do Projeto",
  "files": {
    "index.html": { "content": "<!DOCTYPE html>...", "size": 1234 },
    "css": { "type": "folder", "children": {
      "style.css": { "content": "...", "size": 567 }
    }},
    "js": { "type": "folder", "children": {
      "app.js": { "content": "...", "size": 890 }
    }}
  },
  "preview": "<!DOCTYPE html>..."
}
```

---

## 🛠️ AGENTE AUTÔNOMO (ADMIN)

### Capacidades
- **Monitoramento:** Métricas a cada 30s (memória, CPU, uptime)
- **Auto-otimização:** Garbage collection automático
- **Alertas:** Detecção de problemas (memória alta, erros)
- **Decisões:** Analisa contexto e toma decisões sozinhas
- **Deploy:** Deploy do projeto com um clique
- **Backup:** Cria backups do sistema
- **Diagnósticos:** Verifica saúde de todos os componentes
- **Gerenciamento:** Usuários, créditos, configurações

### API Endpoints
```
GET  /api/agent/status        → Status do agente
GET  /api/agent/metrics       → Métricas (memória, CPU, uptime)
GET  /api/agent/logs          → Logs do sistema
GET  /api/agent/alerts        → Alertas ativos
GET  /api/agent/users         → Lista de usuários
GET  /api/agent/actions       → Últimas ações executadas
GET  /api/agent/decisions     → Decisões do agente
POST /api/agent/command       → Executar comando de texto
PUT  /api/agent/config        → Atualizar configurações
GET  /api/agent/action/:action → Executar ação específica
```

### Ações Disponíveis
- `get_status` — Status completo
- `get_metrics` — Métricas do sistema
- `get_logs` — Logs detalhados
- `run_diagnostics` — Diagnóstico completo
- `deploy` — Deploy do projeto
- `backup` — Criar backup
- `optimize` — Otimizar memória
- `clear_cache` — Limpar cache
- `get_users` — Listar usuários
- `analyze_code` — Analisar código
- `generate_report` — Gerar relatório

### Painel Admin
- Dashboard com cards de métricas
- Terminal de comandos interativo
- Tabela de usuários
- Logs em tempo real
- Alertas com severidade
- Histórico de decisões
- Configurações (auto-optimize, auto-fix)
- Deploy e backup

---

## 🔄 VERSIONAMENTO

### Como funciona
1. Cada geração de código salva uma versão
2. Versões salvas em array `codeVersions[]`
3. Pode restaurar qualquer versão anterior
4. Histórico mantido por conversa
5. Salvo em localStorage

---

## 🚀 DEPLOY

### Status atual
- Deploy simulado (alert)
- Botão presente no chat e no VS Code View
- Futuro: deploy real para Vercel/Netlify

---

## 📊 DADOS DO USUÁRIO

### localStorage
```json
{
  "cc_user": { "name": "Dev", "email": "dev@test.com" },
  "cc_credits": "10",
  "cc_chats": [{ "id": 1, "title": "...", "messages": [...], "versions": [...] }],
  "cc_chatId": "1",
  "cc_workspace": { "project": "...", "files": {...}, "preview": "..." }
}
```

---

## 🎨 DESIGN SYSTEM

### Paleta de Cores
| Cor | Hex | Uso |
|-----|-----|-----|
| Background | #0a0a12 | Fundo principal |
| Card | #12121f | Cards e painéis |
| Elevated | #1a1a2e | Elementos elevados |
| Border | #1e1e35 | Bordas sutis |
| Text | #e8e8f0 | Texto principal |
| Muted | #6b7280 | Texto secundário |
| Accent | #7c5cfc | Botões e links |
| Green | #22c55e | Sucesso |
| Red | #ef4444 | Erro |
| Yellow | #eab308 | Aviso |
| Blue | #3b82f6 | Info |
| Pink | #f472b6 | Destaque |

### Tipografia
- **Inter** — UI, textos, botões
- **JetBrains Mono** — Código, terminais

### Componentes
- **Cards:** bg2, border sutil, hover com glow
- **Botões:** accent, hover com shadow
- **Inputs:** bg3, border, focus com glow
- **Tabs:** underline accent
- **Dropdowns:** bg2, shadow, border

---

## 🔧 COMO RODAR

```bash
# Instalar dependências
npm install

# Configurar .env
echo "GEMINI_API_KEY=sua_chave" > .env
echo "PORT=3000" >> .env

# Rodar
npm start

# Acessar
# Chat:     http://localhost:3000
# VS Code:  http://localhost:3000/pages/vscode.html
# Admin:    http://localhost:3000/admin/
```

---

## 📋 PRÓXIMOS PASSOS

1. **Deploy real** — Integrar Vercel/Netlify
2. **Auth completa** — Login/signup funcional com JWT
3. **Banco de dados** — Migrar de SQLite para PostgreSQL
4. **WebSocket** — Atualizações em tempo real
5. **Multi-modelo** — Suporte GPT-4o, Claude, etc.
6. **Templates** — Playbooks de projetos prontos
7. **Collaboração** — Múltiplos usuários editando
8. **Versionamento Git** — Integração completa com Git
