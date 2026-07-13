<div align="center">

# 🐦‍⬛ Corvo Coder

**Plataforma de desenvolvimento full-stack assistido por inteligência artificial.**  
Descreva o que quer construir — o Corvo Coder gera o código completo para você.

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-2.5%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![License](https://img.shields.io/badge/license-MIT-7c5cfc)](LICENSE)

</div>

---

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Funcionalidades](#-funcionalidades)
- [Arquitetura](#️-arquitetura)
- [Estrutura de Arquivos](#-estrutura-de-arquivos)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação e Configuração](#-instalação-e-configuração)
- [Variáveis de Ambiente](#-variáveis-de-ambiente)
- [Uso](#-uso)
- [API Reference](#-api-reference)
- [Design System](#-design-system)
- [Próximos Passos](#-próximos-passos)
- [Contribuindo](#-contribuindo)

---

## 🌟 Visão Geral

O **Corvo Coder** é uma plataforma de desenvolvimento assistido por IA, inspirada no Emergent. O usuário descreve o que quer construir em linguagem natural e um agente AI autônomo — alimentado pelo **Google Gemini 2.5 Flash** — gera o código completo da aplicação, com a possibilidade de visualizar, editar e fazer deploy diretamente na plataforma.

> **"Você fala, o Corvo Coder constrói."**

---

## ✨ Funcionalidades

### 💬 Chat com IA
- Interface de conversa fluida com o agente Corvo Coder
- Geração de código completo (HTML/CSS/JS) com um único prompt
- Histórico de conversas com versionamento de código
- Sistema de créditos por usuário
- Sugestões de projetos na tela de boas-vindas

### ⬡ VS Code View (Editor Integrado)
- Editor de código estilo VS Code completo no browser
- **Activity Bar** com Explorer, Search, Git e Extensões
- **File Tree** com pastas expansíveis e ícones por tipo de arquivo
- **Syntax Highlighting** para HTML, CSS, JS, JSON e Python
- **Múltiplas abas** abertas simultaneamente
- **Busca global** com suporte a regex
- **Terminal integrado** (Ctrl + `)
- **Preview** ao vivo do projeto gerado
- **Status Bar** com branch, cursor, encoding e linguagem

### 🛠️ Admin Panel com Agente Autônomo
- Dashboard com métricas em tempo real (memória, CPU, uptime)
- Terminal de comandos interativo em linguagem natural
- Monitoramento automático a cada 30 segundos
- Auto-otimização com garbage collection
- Sistema de alertas com severidade
- Histórico de decisões do agente
- Gerenciamento de usuários e créditos
- Deploy e backup com um clique

### 🔑 Rotação de API Keys
- Suporte a até **30 chaves Gemini** simultâneas (`GEMINI_KEY_1` … `GEMINI_KEY_30`)
- Rotação automática em caso de falha ou rate limit
- Cooldown de 5 minutos por chave com erro
- Estado persistido em `keys.json`
- Fallback automático para respostas mock em caso de indisponibilidade total

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────┐
│                      Browser                        │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐ │
│  │  Chat (SPA)  │  │  VS Code   │  │ Admin Panel │ │
│  │  index.html  │  │ vscode.html│  │   admin/    │ │
│  └──────┬───────┘  └─────┬──────┘  └──────┬──────┘ │
└─────────┼────────────────┼────────────────┼─────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────┐
│              Express Server (Node.js)               │
│                    server.js                        │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Chat API  │  │  Agent API   │  │  Admin API  │ │
│  │ /api/chat  │  │ /api/agent/* │  │  /api/keys  │ │
│  └─────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│        │                │                 │         │
│  ┌─────▼────────────────▼─────┐  ┌────────▼──────┐ │
│  │     Google Gemini API      │  │   SQLite DB   │ │
│  │   (com rotação de chaves)  │  │   corvo.db    │ │
│  └────────────────────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Stack Principal:**

| Camada         | Tecnologia                        |
|----------------|-----------------------------------|
| Runtime        | Node.js 18+                       |
| Framework      | Express 4.x                       |
| Banco de Dados | SQLite (better-sqlite3)           |
| IA             | Google Gemini 2.5 Flash           |
| Frontend       | HTML / CSS / JavaScript (SPA)     |
| Estilo         | Dark Mode profissional (VS Code)  |

---

## 📁 Estrutura de Arquivos

```
corvo-coder/
├── 📄 index.html              # Interface principal (chat)
├── 📄 server.js               # Backend Express + Gemini + Agent
├── 📄 database.js             # Configuração e helpers do SQLite
├── 📄 .env                    # Variáveis de ambiente (não commitar!)
├── 📄 keys.json               # Estado das API keys (auto-gerado)
│
├── 📁 css/
│   ├── style.css              # Estilos do chat principal
│   ├── vscode.css             # Estilos do VS Code View
│   └── workspace.css          # Estilos legados
│
├── 📁 js/
│   ├── app.js                 # Lógica do chat (enviar, receber, salvar)
│   ├── vscode.js              # Lógica do VS Code View (editor, file tree)
│   └── workspace.js           # Lógica legada
│
├── 📁 pages/
│   ├── vscode.html            # VS Code View (editor completo)
│   ├── login.html             # Login
│   ├── signup.html            # Cadastro
│   ├── settings.html          # Configurações do usuário
│   └── billing.html           # Planos e créditos
│
├── 📁 admin/
│   └── index.html             # Painel Admin com agente autônomo
│
├── 📁 agent/
│   └── agent.js               # Agente autônomo (monitoramento, decisões)
│
├── 🖼️  logo.jpg               # Logo da marca
├── 🖼️  fundo.jpg              # Imagem de fundo
└── 🗃️  corvo.db               # Banco de dados SQLite (auto-gerado)
```

---

## 📦 Pré-requisitos

- **Node.js** `>= 18.x`
- **npm** `>= 9.x`
- Conta no [Google AI Studio](https://aistudio.google.com) com pelo menos uma **API Key do Gemini**

---

## 🚀 Instalação e Configuração

### 1. Clone o repositório

```bash
git clone https://github.com/seu-usuario/corvo-coder.git
cd corvo-coder
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure o arquivo `.env`

Crie um arquivo `.env` na raiz do projeto:

```env
# Servidor
PORT=3000
ADMIN_PASS=sua_senha_admin_aqui

# Google Gemini API Keys (até 30 chaves com rotação automática)
GEMINI_KEY_1=AIza...
GEMINI_KEY_2=AIza...
```

### 4. Inicie o servidor

```bash
# Produção
npm start

# Desenvolvimento
npm run dev
```

### 5. Acesse a aplicação

| Módulo        | URL                                                              |
|---------------|------------------------------------------------------------------|
| Chat Principal | http://localhost:3000                                           |
| VS Code View  | http://localhost:3000/pages/vscode.html                         |
| Admin Panel   | http://localhost:3000/admin/                                    |

---

## 🔐 Variáveis de Ambiente

| Variável          | Obrigatório | Padrão       | Descrição                              |
|-------------------|-------------|--------------|----------------------------------------|
| `PORT`            | Não         | `3000`       | Porta do servidor Express              |
| `ADMIN_PASS`      | Sim         | `corvo2026`  | Senha de acesso ao Admin Panel         |
| `GEMINI_KEY_1`    | Sim         | —            | Primeira chave da API Gemini           |
| `GEMINI_KEY_2..30`| Não         | —            | Chaves adicionais para rotação         |

> ⚠️ **Nunca commite o arquivo `.env`** com suas chaves de API. Ele deve estar no `.gitignore`.

---

## 💡 Uso

### Chat com o Agente

1. Acesse [http://localhost:3000](http://localhost:3000)
2. Descreva o que deseja construir no campo de mensagem
3. O agente irá:
   - Fazer perguntas para entender melhor o projeto
   - Apresentar a arquitetura planejada
   - Gerar o código completo em `HTML/CSS/JS`
4. Clique em **"VS Code View"** para abrir o editor completo
5. Clique em **"Deploy"** para fazer o deploy do projeto

### Admin Panel

1. Acesse [http://localhost:3000/admin/](http://localhost:3000/admin/)
2. Insira a senha definida em `ADMIN_PASS`
3. Use o terminal interativo para enviar comandos ao agente:

```
> run diagnostics
> show users
> create backup
> optimize memory
> generate report
```

---

## 📡 API Reference

### Chat

```http
POST /api/chat
Content-Type: application/json
```

**Body:**
```json
{
  "message": "Crie um dashboard de vendas",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Resposta:**
```json
{
  "reply": "Aqui está seu dashboard...",
  "code": "<!DOCTYPE html>...",
  "type": "web",
  "source": "gemini"
}
```

### Health Check

```http
GET /api/health
```

```json
{ "status": "ok", "ai": true, "agent": "active" }
```

### Agent API

| Método | Endpoint                       | Descrição                            |
|--------|--------------------------------|--------------------------------------|
| `GET`  | `/api/agent/status`            | Status completo do agente            |
| `GET`  | `/api/agent/metrics`           | Métricas (memória, CPU, uptime)      |
| `GET`  | `/api/agent/logs`              | Logs do sistema                      |
| `GET`  | `/api/agent/alerts`            | Alertas ativos                       |
| `GET`  | `/api/agent/users`             | Lista de usuários                    |
| `GET`  | `/api/agent/actions`           | Últimas ações executadas             |
| `GET`  | `/api/agent/decisions`         | Decisões do agente                   |
| `POST` | `/api/agent/command`           | Executar comando em linguagem natural |
| `PUT`  | `/api/agent/config`            | Atualizar configurações              |
| `GET`  | `/api/agent/action/:action`    | Executar ação específica             |

**Ações disponíveis** via `/api/agent/action/:action`:

| Ação              | Descrição                            |
|-------------------|--------------------------------------|
| `get_status`      | Status completo do sistema           |
| `get_metrics`     | Métricas de performance              |
| `get_logs`        | Logs detalhados                      |
| `run_diagnostics` | Diagnóstico completo                 |
| `deploy`          | Deploy do projeto                    |
| `backup`          | Criar backup do sistema              |
| `optimize`        | Otimizar uso de memória              |
| `clear_cache`     | Limpar cache da aplicação            |
| `get_users`       | Listar todos os usuários             |
| `analyze_code`    | Analisar qualidade do código         |
| `generate_report` | Gerar relatório completo             |

---

## 🎨 Design System

### Paleta de Cores

| Token           | Hex         | Uso                    |
|-----------------|-------------|------------------------|
| `--bg`          | `#0a0a12`   | Fundo principal        |
| `--bg2`         | `#12121f`   | Cards e painéis        |
| `--bg3`         | `#1a1a2e`   | Elementos elevados     |
| `--border`      | `#1e1e35`   | Bordas sutis           |
| `--text`        | `#e8e8f0`   | Texto principal        |
| `--muted`       | `#6b7280`   | Texto secundário       |
| `--accent`      | `#7c5cfc`   | Botões e destaques     |
| `--green`       | `#22c55e`   | Sucesso                |
| `--red`         | `#ef4444`   | Erro                   |
| `--yellow`      | `#eab308`   | Aviso                  |
| `--blue`        | `#3b82f6`   | Info                   |
| `--pink`        | `#f472b6`   | Destaque especial      |

### Tipografia

| Família           | Uso                      |
|-------------------|--------------------------|
| **Inter**         | UI, textos, botões       |
| **JetBrains Mono**| Código, terminais        |

---

## 🔭 Próximos Passos

- [ ] **Deploy real** — Integração com Vercel e Netlify
- [ ] **Auth completa** — Login/signup funcional com JWT
- [ ] **Banco de dados escalável** — Migração de SQLite para PostgreSQL
- [ ] **WebSocket** — Streaming de respostas da IA em tempo real
- [ ] **Multi-modelo** — Suporte a GPT-4o, Claude Sonnet, etc.
- [ ] **Templates** — Playbooks de projetos prontos para usar
- [ ] **Colaboração** — Múltiplos usuários editando em tempo real
- [ ] **Versionamento Git** — Integração completa com repositórios Git

---

## 🤝 Contribuindo

Contribuições são bem-vindas! Para contribuir:

1. Faça um **fork** do repositório
2. Crie uma branch para sua feature:
   ```bash
   git checkout -b feature/minha-feature
   ```
3. Faça commit das suas alterações:
   ```bash
   git commit -m "feat: adiciona minha feature"
   ```
4. Faça push para a branch:
   ```bash
   git push origin feature/minha-feature
   ```
5. Abra um **Pull Request**

---

## 📄 Licença

Este projeto está licenciado sob a licença **MIT**. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

---

<div align="center">

Feito com ❤️ e ☕ pelo time **Corvo Coder**

</div>
#   s i t e - c o r v o - c o d e r  
 