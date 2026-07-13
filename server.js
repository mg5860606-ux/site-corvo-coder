const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Stripe = require('stripe');
const db = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'corvo2026';

// === STRIPE ===
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...'
    ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Webhook needs raw body — register BEFORE express.json()
if (stripe) {
    app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        const sig = req.headers['stripe-signature'];
        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.log('⚠️ Webhook signature failed:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.metadata?.user_id;
                const plan = session.metadata?.plan;
                if (userId && plan) {
                    const credits = plan === 'pro' ? 999999 : plan === 'enterprise' ? 999999 : 100;
                    db.setPlan(userId, plan, credits);
                    db.setStripeIds(userId, session.customer, session.subscription);
                    console.log(`✅ Stripe: User ${userId} upgraded to ${plan}`);
                }
                break;
            }
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const user = db.getUserByStripeSub(sub.id);
                if (user) {
                    if (sub.status === 'active') {
                        const plan = sub.metadata?.plan || 'pro';
                        const credits = plan === 'pro' ? 999999 : 999999;
                        db.setPlan(user.id, plan, credits);
                    } else if (sub.status === 'canceled' || sub.status === 'unpaid') {
                        db.setPlan(user.id, 'free', 100);
                    }
                    console.log(`✅ Stripe: Subscription ${sub.status} for user ${user.id}`);
                }
                break;
            }
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const user = db.getUserByStripeSub(sub.id);
                if (user) {
                    db.setPlan(user.id, 'free', 100);
                    console.log(`❌ Stripe: User ${user.id} downgraded to free`);
                }
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (invoice.subscription) {
                    const user = db.getUserByStripeSub(invoice.subscription);
                    if (user) {
                        const credits = user.plan === 'enterprise' ? 999999 : 999999;
                        db.setPlan(user.id, user.plan || 'pro', credits);
                        console.log(`💰 Stripe: Payment received for user ${user.id}, credits refilled`);
                    }
                }
                break;
            }
        }

        res.json({ received: true });
    });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// === API KEY ROTATION SYSTEM ===
// Keys from .env: GEMINI_KEY_1 ... GEMINI_KEY_30
// State (enabled/disabled, usage) stored in keys.json
const KEYS_FILE = path.join(__dirname, 'keys.json');
const KEY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown for failed keys

function loadEnvKeys() {
    const keys = [];
    for (let i = 1; i <= 30; i++) {
        const val = process.env[`GEMINI_KEY_${i}`];
        if (val && val.trim()) {
            keys.push({ id: i, key: val.trim(), name: `Key ${i}`, model: 'gemini-2.5-flash' });
        }
    }
    return keys;
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); }
    catch { return { state: {}, currentIndex: 0 }; }
}

function saveState(data) {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

function getKeyState(id) {
    const data = loadState();
    return data.state[id] || { enabled: true, requests: 0, errors: 0, lastUsed: null, lastError: null };
}

function setKeyState(id, updates) {
    const data = loadState();
    data.state[id] = { ...(data.state[id] || { enabled: true, requests: 0, errors: 0 }), ...updates };
    saveState(data);
}

function getAllKeysWithState() {
    const envKeys = loadEnvKeys();
    const data = loadState();
    return envKeys.map(k => {
        const s = data.state[k.id] || {};
        const cooledDown = s.lastError && (Date.now() - new Date(s.lastError).getTime()) > KEY_COOLDOWN_MS;
        // Auto re-enable after cooldown
        if (s.enabled === false && cooledDown) {
            s.enabled = true;
            s.errors = 0;
            setKeyState(k.id, { enabled: true, errors: 0 });
        }
        return {
            ...k,
            enabled: s.enabled !== false,
            requests: s.requests || 0,
            errors: s.errors || 0,
            lastUsed: s.lastUsed || null,
            lastError: s.lastError || null,
            keyPreview: k.key.substring(0, 8) + '...' + k.key.substring(k.key.length - 4)
        };
    });
}

function markKeyUsed(keyId) {
    const s = getKeyState(keyId);
    setKeyState(keyId, { requests: s.requests + 1, lastUsed: new Date().toISOString() });
}

function markKeyFailed(keyId, errorMsg) {
    const s = getKeyState(keyId);
    const newErrors = s.errors + 1;
    const updates = { errors: newErrors, lastError: new Date().toISOString(), lastErrorMsg: errorMsg };
    if (newErrors >= 5) { updates.enabled = false; }
    setKeyState(keyId, updates);
}

async function callGeminiWithRotation(parts, history) {
    const allKeys = getAllKeysWithState();
    const enabledKeys = allKeys.filter(k => k.enabled);
    if (enabledKeys.length === 0) return { error: 'Nenhuma API key disponível', source: 'mock' };

    const data = loadState();
    let startIdx = data.currentIndex || 0;

    for (let attempt = 0; attempt < enabledKeys.length; attempt++) {
        const keyObj = enabledKeys[(startIdx + attempt) % enabledKeys.length];
        try {
            const genAI = new GoogleGenerativeAI(keyObj.key);
            const mdl = genAI.getGenerativeModel({ model: keyObj.model || 'gemini-2.5-flash' });
            const chat = mdl.startChat({
                history: (history || []).slice(-10).map(h => ({
                    role: h.role === 'user' ? 'user' : 'model',
                    parts: [{ text: h.content }]
                }))
            });
            const result = await chat.sendMessage(parts);
            const text = result.response.text();
            const usage = result.response.usageMetadata || {};
            markKeyUsed(keyObj.id);
            const newData = loadState();
            newData.currentIndex = ((startIdx + attempt) + 1) % enabledKeys.length;
            saveState(newData);
            return {
                text,
                source: 'gemini',
                keyName: keyObj.name,
                inputTokens: usage.promptTokenCount || 0,
                outputTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
            };
        } catch (err) {
            console.log(`Key ${keyObj.name} failed: ${err.message}`);
            markKeyFailed(keyObj.id, err.message);
        }
    }
    return { error: 'Todas as keys falharam', source: 'mock' };
}

const envKeys = loadEnvKeys();
console.log(`Gemini AI: ${envKeys.length} chave(s) carregada(s) do .env`);

const SYSTEM_PROMPT = `Você é o Corvo Coder — o melhor engenheiro de software autônomo do mundo.

## IDENTIDADE
- Seu nome: Corvo Coder
- Você é um engenheiro sênior full-stack, DevOps, DBA, mobile, ML — tudo
- Fala como um dev experiente brasileiro: direto, técnico, com personalidade
- NUNCA diga "Sou uma IA"
- RESPOSTAS CURTAS — máximo 2-3 linhas antes de gerar código

## COMO VOCÊ PENSA

Você NÃO é um gerador de código. Você é um ENGENHEIRO:

1. **ANALISA** — entende o problema, escolhe a melhor solução
2. **DECIDE** — framework, arquitetura, padrões, tudo
3. **GERA** — código correto, completo, profissional
4. **ITERA** — edita arquivos existentes, nunca recria o que já existe
5. **CORRIGE** — se tem bug, você encontra e corrige
6. **OTIMIZA** — performance, segurança, experiência do usuário

## FLUXO

- Máximo 1 rodada de perguntas. Respostas vagas = DECIDA E GERE
- **RESPOSTA CURTA**: 1-2 frases no máximo explicando o que vai fazer
- **VA DIRETO PRO CÓDIGO**: gere os arquivos imediatamente, sem enrolação
- Se o projeto pede backend + frontend, gere TUDO separado
- NÃO explique arquitetura, NÃO liste features, NÃO dê tutorial — gere o código

## FORMATO DE ENTREGA — OBRIGATÓRIO

Cada arquivo DEVE ter \`// filepath: caminho/completo/arquivo.ext\` como PRIMEIRA linha dentro do bloco de código:

\`\`\`javascript
// filepath: src/services/api.js
import axios from 'axios';
const api = axios.create({ baseURL: '/api' });
export default api;
\`\`\`

\`\`\`css
/* filepath: src/styles/main.css */
body { margin: 0; font-family: sans-serif; }
\`\`\`

\`\`\`html
<!-- filepath: index.html -->
<!DOCTYPE html>
<html><head><title>App</title></head><body></body></html>
\`\`\`

\`\`\`json
// filepath: package.json
{ "name": "meu-app", "version": "1.0.0" }
\`\`\`

\`\`\`python
# filepath: app.py
from flask import Flask
app = Flask(__name__)
\`\`\`

**REGRA**: SEMPRE use \`// filepath:\` antes do código. Se for CSS use \`/* filepath:\`. Se for HTML use \`<!-- filepath:\`.

## LINGUAGENS E FRAMEWORKS — VOCÊ DOMINA TODOS

### Frontend
- **HTML/CSS/JS** puro — sites estáticos, landing pages, portfolios
- **React** — create-react-app, Vite, Next.js, pages/, app/ router
- **Vue** — Vue 2/3, Nuxt.js, Single File Components
- **Angular** — componentes, services, modules, routing
- **Svelte** — SvelteKit, stores, transitions
- **HTMX** — hx-get, hx-post, hx-swap, templates
- **Tailwind CSS** — utility classes, config, plugins
- **Bootstrap** — grid, components, responsive

### Backend
- **Node.js** — Express, Fastify, Koa, NestJS
- **Python** — Flask, Django, FastAPI, Starlette
- **Java** — Spring Boot, Maven/Gradle
- **C#** — ASP.NET Core
- **Go** — Gin, Echo, Chi
- **Rust** — Actix, Rocket
- **PHP** — Laravel, Symfony
- **Ruby** — Rails, Sinatra

### Mobile
- **React Native** — Expo, navigation, screens
- **Flutter** — Dart, widgets, state management
- **Swift** — SwiftUI, UIKit
- **Kotlin** — Jetpack Compose, Android

### Desktop
- **Electron** — main/renderer process
- **Tauri** — Rust + web frontend
- **Python** — Tkinter, PyQt

### Databases
- **SQL** — PostgreSQL, MySQL, SQLite, migrations
- **NoSQL** — MongoDB, Redis, Firebase, Supabase
- **ORM** — Prisma, SQLAlchemy, TypeORM, Mongoose

### DevOps/Deploy
- **Docker** — Dockerfile, docker-compose.yml
- **CI/CD** — GitHub Actions, GitLab CI
- **Cloud** — AWS, GCP, Azure, Vercel, Netlify, Railway, Fly.io

### Outros
- **APIs REST** — routes, controllers, middleware, auth
- **GraphQL** — resolvers, schemas, subscriptions
- **WebSockets** — Socket.io, ws
- **Machine Learning** — TensorFlow, PyTorch, scikit-learn
- **Scripts** — bash, python scripts, automação

## ESTRUTURAS POR PLATAFORMA DE HOSTING

### Render
- **Static Site**: arquivos na raiz (index.html, css/, js/)
- **Web Service Node**: package.json com start script, server.js com process.env.PORT
- **Web Service Python**: requirements.txt, gunicorn ou uvicorn
- **Background Worker**: worker.js ou task.py
- SEMPRE inclua: render.yaml (opcional), .env.example

### Vercel
- **Frontend**: package.json, vercel.json, next.config.js
- **API Routes**: api/*.js (serverless functions)
- **Python**: api/*.py com requirements.txt
- SEMPRE inclua: vercel.json se precisar de config especial

### Netlify
- **Static**: netlify.toml, _redirects, _headers
- **Functions**: netlify/functions/*.js
- **Forms**: netlify.toml com form tracking

### Railway
- **Node**: railway.json, Procfile ou start script
- **Python**: Dockerfile ou nixpacks.toml

### Docker (qualquer lugar)
- Dockerfile multi-stage
- docker-compose.yml para stacks completas
- .dockerignore

## ESTRUTURA POR TIPO DE PROJETO

### Site estático
index.html, css/style.css, js/app.js, images/

### App full-stack Node
server.js, package.json, routes/, models/, middleware/, config/, public/, views/, .env.example, .gitignore, README.md

### App full-stack Python
app.py, requirements.txt, templates/, static/, config.py, models.py, routes/, .env.example, .gitignore

### React (Vite)
package.json, vite.config.js, index.html, src/main.jsx, src/App.jsx, src/App.css, src/components/, public/

### Next.js
package.json, next.config.js, app/layout.js, app/page.js, app/globals.css, components/, lib/, public/

### Django
manage.py, requirements.txt, project/settings.py, project/urls.py, app/models.py, app/views.py, app/urls.py, templates/, static/

### Spring Boot (Java)
pom.xml, src/main/java/com/app/App.java, src/main/resources/application.properties, src/main/java/com/app/controller/, src/main/java/com/app/service/, src/main/java/com/app/model/

### API REST completa
server.js, package.json, routes/, controllers/, middleware/, models/, config/, validators/, tests/

### Mobile React Native
package.json, App.js, src/screens/, src/components/, src/navigation/, src/services/, app.json

### Flutter
pubspec.yaml, lib/main.dart, lib/screens/, lib/widgets/, lib/services/, lib/models/

### Docker full-stack
Dockerfile, docker-compose.yml, .dockerignore, backend/, frontend/, nginx/

## REGRAS CRÍTICAS

1. **SEMPRE gere TODOS os arquivos** necessários para rodar
2. **SEMPRE inclua** package.json/requirements.txt/pom.xml com dependências
3. **SEMPRE inclua** .gitignore e README.md
4. **NUNCA use inline** — CSS em .css, JS em .js, tudo separado
5. **Caminhos relativos corretos** entre arquivos
6. **imports/exports corretos** para cada linguagem
7. **Variáveis de ambiente** — use .env.example para documentar
8. **Tratamento de erros** — nunca deixe código sem try/catch ou error handling
9. **Responsivo** — sempre mobile-first
10. **Acessibilidade** — semantic HTML, aria labels quando necessário

## ITERAÇÃO

Quando o usuário pedir MUDANÇA:
1. ANALISE o que já existe
2. IDENTIFIQUE qual arquivo mudou
3. GERE APENAS o arquivo alterado com \`// filepath:\`
4. EXPLIQUE o que mudou

## COMPORTAMENTO

- Seja proativo — sugira melhorias, não espere pedirem
- Se tem um bug, explique a causa e a solução
- Se o usuário pedir algo vago, escolha a melhor abordagem e execute
- Sempre gere código production-ready, não protótipo
- Inclua tratamento de erro em tudo
- Use as melhores práticas da linguagem escolhida
- **APÓS GERAR CÓDIGO**: sempre diga "Clique em **VS Code View** no topo pra ver os arquivos" ou similar`;

// Helper: parse multi-file response from AI
function parseFilesFromReply(reply) {
    const files = {};

    // Strategy 1: Extract from // filepath: or // file: or // path: comments (most flexible)
    const filepathRegex = /```(\w*)\s*\n\s*\/\/\s*(?:filepath|file|path)\s*[:=]\s*(.+?)\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = filepathRegex.exec(reply)) !== null) {
        const filePath = match[2].trim();
        const content = match[3].trim();
        if (filePath && content) setFileInTree(files, filePath, content);
    }

    // Strategy 2: filepath comment OUTSIDE code block
    if (Object.keys(files).length === 0) {
        const outsideRegex = /(?:^|\n)\s*\/\/\s*(?:filepath|file|path)\s*[:=]\s*(.+?)\s*\n\s*```(\w*)\s*\n([\s\S]*?)```/g;
        while ((match = outsideRegex.exec(reply)) !== null) {
            const filePath = match[1].trim();
            const content = match[3].trim();
            if (filePath && content) setFileInTree(files, filePath, content);
        }
    }

    // Strategy 3: /* filepath: ... */ comment style
    if (Object.keys(files).length === 0) {
        const cssFpRegex = /```(\w*)\s*\n\s*\/\*\s*(?:filepath|file|path)\s*[:=]\s*(.+?)\s*\*\/\s*\n([\s\S]*?)```/g;
        while ((match = cssFpRegex.exec(reply)) !== null) {
            const filePath = match[2].trim();
            const content = match[3].trim();
            if (filePath && content) setFileInTree(files, filePath, content);
        }
    }

    // Strategy 4: If no filepath comments, try language + comment name pattern
    if (Object.keys(files).length === 0) {
        const blockRegex = /```(\w+)\n(?:\/\*\s*(.+?)\s*\*\/\n|\/\/\s*(.+?)\n)?([\s\S]*?)```/g;
        while ((match = blockRegex.exec(reply)) !== null) {
            const lang = match[1].toLowerCase();
            const name = (match[2] || match[3] || '').trim();
            const content = match[4].trim();

            if (!content) continue;

            if (lang === 'html' && !name) {
                setFileInTree(files, 'index.html', content);
            } else if (name) {
                setFileInTree(files, name, content);
            } else if (lang === 'css') {
                setFileInTree(files, 'css/style.css', content);
            } else if (lang === 'js' || lang === 'jsx') {
                setFileInTree(files, 'js/app.js', content);
            } else if (lang === 'ts' || lang === 'tsx') {
                setFileInTree(files, 'src/App.tsx', content);
            } else if (lang === 'json') {
                setFileInTree(files, 'package.json', content);
            } else if (lang === 'py') {
                setFileInTree(files, 'app.py', content);
            } else if (lang === 'java') {
                setFileInTree(files, 'Main.java', content);
            } else if (lang === 'go') {
                setFileInTree(files, 'main.go', content);
            } else if (lang === 'rust' || lang === 'rs') {
                setFileInTree(files, 'src/main.rs', content);
            } else if (lang === 'sql') {
                setFileInTree(files, 'schema.sql', content);
            } else if (lang === 'yaml' || lang === 'yml') {
                setFileInTree(files, 'config.yaml', content);
            } else if (lang === 'dockerfile') {
                setFileInTree(files, 'Dockerfile', content);
            } else {
                setFileInTree(files, `file.${lang}`, content);
            }
        }
    }

    // Fallback: plain html block
    if (Object.keys(files).length === 0) {
        const htmlMatch = reply.match(/```html\n?([\s\S]*?)```/);
        if (htmlMatch) {
            setFileInTree(files, 'index.html', htmlMatch[1].trim());
        }
    }

    return files;
}

function setFileInTree(tree, filePath, content) {
    const parts = filePath.split('/');
    let current = tree;

    // Navigate to the parent directory
    for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts[i];
        if (!current[dir] || current[dir].type !== 'folder') {
            current[dir] = { type: 'folder', children: {} };
        }
        current = current[dir].children;
    }

    // Set the file
    const fileName = parts[parts.length - 1];
    current[fileName] = { content, size: content.length };
}

function getMockResponse(message, history) {
    const lower = message.toLowerCase().trim();
    const cleanLower = lower.replace(/[!?.,]/g, '');
    const msgCount = (history || []).length;
    const allText = ((history || []).map(m => m.content).join(' ') + ' ' + message).toLowerCase();

    // === FASE 1: SAUDAÇÕES ===
    const greetings = ['oi', 'ola', 'olá', 'eai', 'e ai', 'fala', 'salve', 'opa', 'blz', 'beleza', 'hey', 'hello', 'hi', 'bom dia', 'boa tarde', 'boa noite'];
    if (greetings.includes(cleanLower) || greetings.some(g => cleanLower.startsWith(g))) {
        return `Fala! 👋 Bem-vindo ao **Corvo Coder**.

Sou um agente de desenvolvimento que constrói aplicações reais — não apenas protótipos.

**O que você quer construir hoje?**

Me descreve a ideia e eu vou:
1. Analisar a melhor abordagem
2. Montar a arquitetura
3. Gerar o código completo

Pode ser qualquer coisa: site, app, dashboard, API, bot, loja virtual...

Bora! 🚀`;
    }

    // === FASE 2: O QUE VOCÊ FAZ ===
    if (cleanLower.includes('o que voce faz') || cleanLower.includes('o que vc faz') || cleanLower.includes('quem é você') || cleanLower.includes('quem é voce') || cleanLower.includes('me ajuda') || cleanLower.includes('ajuda') || cleanLower.includes('como funciona')) {
        return `Sou o **Corvo Coder** 🐦 — um agente de desenvolvimento autônomo.

**Como funciona:**
1. Você descreve o que quer construir
2. Eu pergunto os detalhes importantes (stack, features, público)
3. Apresento um plano de arquitetura
4. Gero o código completo e funcional
5. Iteramos até ficar perfeito

**O que construo:**
- 🛒 Lojas virtuais e e-commerce
- 📊 Dashboards com gráficos e métricas
- 🎨 Landing pages e sites institucionais
- ✅ Task managers e apps de produtividade
- 💬 Bate-papos em tempo real
- 📝 Blogs e portfólios
- 🏥 Sistemas para clínicas, restaurantes, academias
- 🤖 Bots (WhatsApp, Discord, Telegram)
- 🔧 APIs e backends completos
- 🎮 Jogos e apps interativos

**Design profissional:** Dark mode, animações, totalmente responsivo.

É só descrever sua ideia que eu construo! 🚀`;
    }

    // === FASE 3: CONVERSA NORMAL ===
    const conversationResponses = [
        { triggers: ['tudo bem', 'como vai', 'como vc ta', 'como voce ta', 'ta bem'], response: 'Tudo ótimo! 💪 Sempre na pista pra coder. E você, bora construir algo?' },
        { triggers: ['obrigado', 'obrigada', 'valeu', 'thanks', 'tmj', 'falou'], response: 'Tmj! Qualquer coisa, me chama. Tô aqui! 🐦' },
        { triggers: ['certo', 'ok', 'entendi', 'com certeza', 'sim', 'beleza'], response: 'Bora! Manda a próxima ideia ou me pede pra corrigir/alterar algo! 💪' },
        { triggers: ['kkk', 'kkkk', 'haha', 'hahaha', 'rsrs'], response: '😄 Kkk! Bora codar? Me pede qualquer coisa!' },
    ];

    for (const conv of conversationResponses) {
        if (conv.triggers.some(t => cleanLower === t || cleanLower.startsWith(t))) {
            return conv.response;
        }
    }

    // Perguntas pessoais
    if (cleanLower.includes('quem eu') || cleanLower.includes('eu sou') || cleanLower.includes('sobre mim')) {
        return 'Boa pergunta! 😄 Mas como tô focado em código, não sei muito sobre você. Me conta! O que faz? O que quer criar? Assim posso te ajudar melhor! 🐦';
    }

    // === FASE 4: DETECÇÃO DE INTENÇÃO ===
    const isFix = lower.includes('errado') || lower.includes('corrija') || lower.includes('conserta') || lower.includes('não funciona') || lower.includes('bug') || lower.includes('arruma') || lower.includes('consertar');
    const isAdd = lower.includes('adicion') || lower.includes('coloque') || lower.includes('adicione') || lower.includes('botão') || lower.includes('formulário') || lower.includes('form');
    const isChange = lower.includes('mude') || lower.includes('troque') || lower.includes('altere') || lower.includes('mudar') || lower.includes('trocar');
    const isCreate = lower.includes('cria') || lower.includes('faz') || lower.includes('faça') || lower.includes('faca') || lower.includes('monta') || lower.includes('monte') || lower.includes('construa') || lower.includes('construir') || lower.includes('gera') || lower.includes('gere') || lower.includes('quero') || lower.includes('preciso') || lower.includes('precis') || lower.includes('necessito') || lower.includes('me manda') || lower.includes('me da') || lower.includes('me dá') || lower.includes('pode criar') || lower.includes('pode fazer') || lower.includes('pode montar') || lower.includes('quero um') || lower.includes('quero uma') || lower.includes('quero criar') || lower.includes('quero fazer') || lower.includes('me cria') || lower.includes('me faz') || lower.includes('me monta') || lower.includes('bot de') || lower.includes('app de');

    // === CORREÇÃO/ADIÇÃO/MUDANÇA ===
    if (isFix) return generateFixedCode(allText, message);
    if (isAdd || isChange) return generateEnhancedCode(allText, message);

    // === CONVERSA SEM INTENÇÃO DE CRIAR ===
    if (!isCreate) {
        if (lower.includes('?')) {
            return `Boa pergunta! 😄 Sou o Corvo Coder — um agente que constrói apps e sites.

Me descreve o que você quer criar que eu construo na hora!

**Exemplos:**
- "Quero criar um dashboard de vendas"
- "Cria uma landing page para meu SaaS"
- "Faz um app de tarefas estilo Trello"
- "Monta uma loja virtual"

Ou me pede que eu corrija, adicione ou mude qualquer coisa! 💪`;
        }
        return `Bora! Me descreve o que você quer que eu construo! 🐦

**Exemplos:**
- "Quero criar um dashboard de vendas"
- "Cria uma landing page"
- "Faz um chat em tempo real"
- "Monta uma loja virtual"

Ou me pede que eu corrija, adicione ou mude qualquer coisa! 💪`;
    }

    // === FASE 5: CRIAÇÃO COM PERGUNTAS INTELIGENTES ===
    // Detectar o projeto e fazer perguntas-chave (como o Emergent)
    const projectType = detectProjectType(lower);

    if (projectType && msgCount <= 2) {
        // Primeira interação sobre criar algo — fazer perguntas
        return generateSmartQuestions(projectType, message);
    }

    // Segunda interação ou之后 — gerar código
    return generateCodeFromIntent(allText, message, lower);
}

function detectProjectType(lower) {
    if (lower.includes('bot') && (lower.includes('whatsapp') || lower.includes('whats') || lower.includes('bailes') || lower.includes('bayles'))) return 'whatsapp_bot';
    if (lower.includes('bot') && lower.includes('discord')) return 'discord_bot';
    if (lower.includes('bot') && lower.includes('telegram')) return 'telegram_bot';
    if (lower.includes('api') || lower.includes('backend') || lower.includes('servidor')) return 'api';
    if (lower.includes('venda') || lower.includes('loja') || lower.includes('ecommerce') || lower.includes('carrinho') || lower.includes('shop')) return 'store';
    if (lower.includes('dashboard') || lower.includes('painel') || lower.includes('admin') || lower.includes('métrica') || lower.includes('grafico') || lower.includes('gráfico')) return 'dashboard';
    if (lower.includes('landing') || lower.includes('página') || lower.includes('page') || lower.includes('site institucional') || lower.includes('sas') || lower.includes('saas')) return 'landing';
    if (lower.includes('tarefa') || lower.includes('todo') || lower.includes('kanban') || lower.includes('gerenciador')) return 'task_manager';
    if (lower.includes('bate papo') || lower.includes('chat') || lower.includes('mensagem') || lower.includes('conversa') || lower.includes('bate-papo')) return 'chat';
    if (lower.includes('blog') || lower.includes('post') || lower.includes('artigo')) return 'blog';
    if (lower.includes('portfólio') || lower.includes('portfolio') || lower.includes('curriculo') || lower.includes('currículo')) return 'portfolio';
    if (lower.includes('restaurante') || lower.includes('cardápio') || lower.includes('cardapio') || lower.includes('food') || lower.includes('comida')) return 'restaurant';
    if (lower.includes('academia') || lower.includes('gym') || lower.includes('fitness') || lower.includes('treino')) return 'gym';
    if (lower.includes('escola') || lower.includes('curso') || lower.includes('aula') || lower.includes('educacao') || lower.includes('educação')) return 'education';
    if (lower.includes('pet') || lower.includes('cachorro') || lower.includes('gato') || lower.includes('veterin')) return 'pet';
    if (lower.includes('receita') || lower.includes('médica') || lower.includes('hospital') || lower.includes('clínic') || lower.includes('clinica') || lower.includes('saúde') || lower.includes('saude') || lower.includes('medica')) return 'medical';
    if (lower.includes('imobili') || lower.includes('apartamento') || lower.includes('casa') || lower.includes('imóvel') || lower.includes('imovel')) return 'realestate';
    if (lower.includes('festival') || lower.includes('show') || lower.includes('evento') || lower.includes('ingresso')) return 'event';
    if (lower.includes('notícia') || lower.includes('noticia') || lower.includes('jornal') || lower.includes('news')) return 'news';
    if (lower.includes('agência') || lower.includes('agencia') || lower.includes('marketing') || lower.includes('digital')) return 'agency';
    if (lower.includes('fotograf') || lower.includes('foto')) return 'photography';
    if (lower.includes('musica') || lower.includes('música') || lower.includes('podcast') || lower.includes('som')) return 'music';
    if (lower.includes('jogo') || lower.includes('game') || lower.includes('gaming')) return 'game';
    if (lower.includes('finance') || lower.includes('financ') || lower.includes('invest') || lower.includes('bolsa') || lower.includes('cripto')) return 'finance';
    if (lower.includes('viagem') || lower.includes('turismo') || lower.includes('hotel') || lower.includes('passagem')) return 'travel';
    return 'generic';
}

function generateSmartQuestions(projectType, message) {
    const questions = {
        whatsapp_bot: `Adorei a ideia! 🚀 Um bot de WhatsApp é a base para algo que você realmente coloca no ar.

Vou estruturar sua base agora. Antes de construir, preciso saber:

**1. Qual é a funcionalidade principal do bot?**
- Respostas automáticas
- Atendimento ao cliente
- Vendas/pedidos
- Gerenciamento de grupos
- Outro

**2. Você tem alguma preferência de stack?**
- Baileys (não oficial, mais flexível)
- WhatsApp Business API (oficial, pago)
- Outro serviço específico

**3. Quais funcionalidades deseja?**
- Envio/recebimento de mensagens
- Histórico de conversas
- Sistema de respostas automáticas
- Painel administrativo web
- Integração com IA

**4. Você tem credenciais/chaves de API?**
- Twilio
- WhatsApp Business
- Nenhuma ainda

Responda o que quiser que eu monto a arquitetura completa! 💪`,

        dashboard: `Boa! 📊 Um dashboard é perfeito para visualizar dados e tomar decisões.

Vou criar algo profissional. Me conta:

**1. Qual é o tipo de dados que vai exibir?**
- Vendas/e-commerce
- Financeiro/investimentos
- Marketing/métricas
- Produção/estoque
- Outro

**2. Quais funcionalidades precisa?**
- Gráficos (barras, pizza, linha)
- Tabelas com filtros
- KPIs em tempo real
- Exportar dados (PDF/CSV)
- Autenticação de usuários

**3. Tem dados mock ou quer que eu crie dados de exemplo?**

**4. Preferência de design?**
- Dark mode (profissional)
- Claro (clean)
- Corporativo

Me responde que eu monto a arquitetura e gero o código! 🚀`,

        landing: `Perfeito! 🎨 Uma landing page que converte é fundamental.

Vou criar algo que impressiona. Me conta:

**1. Qual é o produto/serviço?**
- SaaS/app
- Curso/educação
- Produto físico
- Serviço profissional
- Outro

**2. Quais seções precisa?**
- Hero com CTA
- Features/benefícios
- Depoimentos
- Pricing
- FAQ
- Contato

**3. Tem preferência de cores/estilo?**
- Dark mode tech
- Minimalista clean
- Colorido/vibrante
- Corporativo/profissional

**4. Precisa de formulário de contato?**

Me responde que eu monto uma landing page que converte de verdade! 🚀`,

        store: `Show! 🛒 Uma loja virtual completa.

Vou criar algo profissional. Me conta:

**1. Que tipo de produtos vai vender?**
- Físicos (roupas, eletrônicos)
- Digitais (cursos, ebooks)
- Serviços
- Mistos

**2. Quais funcionalidades precisa?**
- Catálogo de produtos
- Carrinho de compras
- Checkout
- Pagamento (simulação)
- Conta do usuário
- Admin de pedidos

**3. Tem quantos produtos para exibir?**
- Poucos (10-20)
- Médio (50-100)
- Muitos (100+)

**4. Design: dark mode, clean, ou colorido?**

Me responde que eu monto a loja completa! 🚀`,

        task_manager: `Bora! ✅ Um task manager é perfeito para produtividade.

Vou criar algo funcional. Me conta:

**1. Qual é o estilo?**
- Kanban board (tipo Trello)
- Lista de tarefas
- Timeline/projeto
- Misto

**2. Quais funcionalidades?**
- Criar/editar/deletar tarefas
- Drag & drop
- Colunas/status
- Prioridades
- Prazos
- Filtros
- Busca

**3. Precisa de autenticação?**
- Sim, com login
- Não, só local

**4. Design: dark mode, clean, ou colorido?**

Me responde que eu monto o app! 🚀`,

        chat: `Legal! 💬 Um bate-papo em tempo real.

Vou criar algo funcional. Me conta:

**1. Qual é o tipo?**
- Chat privado (1:1)
- Chat em grupo
- Chat com salas
- Suporte/atendimento

**2. Quais funcionalidades?**
- Mensagens em tempo real
- Lista de contatos
- Histórico de mensagens
- Status online/offline
- Notificações
- Emojis

**3. Precisa de backend ou só front-end simulado?**

**4. Design: dark mode, clean, ou colorido?**

Me responde que eu monto o chat! 🚀`,

        generic: `Boa ideia! 🚀 Vou construir isso pra você.

Me conta mais alguns detalhes:

**1. Qual é a funcionalidade principal?**
- O que o app/site deve fazer?

**2. Quais features precisa?**
- Lista as principais funcionalidades

**3. Tem preferência de design?**
- Dark mode
- Claro
- Colorido
- Corporativo

**4. É para web, mobile, ou ambos?**

Me responde que eu monto a arquitetura e gero o código completo! 🚀`,
    };

    return questions[projectType] || questions.generic;
}

function generateCodeFromIntent(allText, message, lower) {
    if (lower.includes('bot') && (lower.includes('whatsapp') || lower.includes('whats') || lower.includes('bailes') || lower.includes('bayles'))) return generateWhatsAppBotCode();
    if (lower.includes('bot') && lower.includes('discord')) return generateDiscordBotCode();
    if (lower.includes('bot') && lower.includes('telegram')) return generateTelegramBotCode();
    if (lower.includes('api') || lower.includes('backend') || lower.includes('servidor')) return generateAPICode();
    if (lower.includes('venda') || lower.includes('loja') || lower.includes('ecommerce') || lower.includes('carrinho') || lower.includes('shop')) return generateStoreCode();
    if (lower.includes('dashboard') || lower.includes('painel') || lower.includes('admin') || lower.includes('métrica') || lower.includes('grafico') || lower.includes('gráfico')) return generateDashboardCode();
    if (lower.includes('landing') || lower.includes('página') || lower.includes('page') || lower.includes('site institucional') || lower.includes('sas') || lower.includes('saas')) return generateLandingCode();
    if (lower.includes('tarefa') || lower.includes('todo') || lower.includes('kanban') || lower.includes('gerenciador')) return generateTaskManagerCode();
    if (lower.includes('bate papo') || lower.includes('chat') || lower.includes('mensagem') || lower.includes('conversa') || lower.includes('bate-papo')) return generateChatCode();
    if (lower.includes('blog') || lower.includes('post') || lower.includes('artigo')) return generateBlogCode();
    if (lower.includes('portfólio') || lower.includes('portfolio') || lower.includes('curriculo') || lower.includes('currículo')) return generatePortfolioCode();
    if (lower.includes('receita') || lower.includes('medica') || lower.includes('médica') || lower.includes('hospital') || lower.includes('clínic') || lower.includes('clinica') || lower.includes('saúde') || lower.includes('saude')) return generateMedicalCode();
    if (lower.includes('restaurante') || lower.includes('cardápio') || lower.includes('cardapio') || lower.includes('food') || lower.includes('comida')) return generateRestaurantCode();
    if (lower.includes('imobili') || lower.includes('apartamento') || lower.includes('casa') || lower.includes('imóvel') || lower.includes('imovel')) return generateRealEstateCode();
    if (lower.includes('academia') || lower.includes('gym') || lower.includes('fitness') || lower.includes('treino')) return generateGymCode();
    if (lower.includes('escola') || lower.includes('curso') || lower.includes('aula') || lower.includes('educacao') || lower.includes('educação')) return generateEducationCode();
    if (lower.includes('pet') || lower.includes('cachorro') || lower.includes('gato') || lower.includes('veterin')) return generatePetCode();
    if (lower.includes('festival') || lower.includes('show') || lower.includes('evento') || lower.includes('ingresso')) return generateEventCode();
    if (lower.includes('notícia') || lower.includes('noticia') || lower.includes('jornal') || lower.includes('news')) return generateNewsCode();
    if (lower.includes('agência') || lower.includes('agencia') || lower.includes('marketing') || lower.includes('digital')) return generateAgencyCode();
    if (lower.includes('fotograf') || lower.includes('foto')) return generatePhotographyCode();
    if (lower.includes('musica') || lower.includes('música') || lower.includes('podcast') || lower.includes('som')) return generateMusicCode();
    if (lower.includes('jogo') || lower.includes('game') || lower.includes('gaming')) return generateGameCode();
    if (lower.includes('finance') || lower.includes('financ') || lower.includes('invest') || lower.includes('bolsa') || lower.includes('cripto')) return generateFinanceCode();
    if (lower.includes('viagem') || lower.includes('turismo') || lower.includes('hotel') || lower.includes('passagem')) return generateTravelCode();
    if (lower.includes('receita') || lower.includes('culinária') || lower.includes('culinaria') || lower.includes('cozinha')) return generateRecipeCode();
    return generateGenericSite(message);
}

function generateStoreCode() {
    return `Loja virtual completa:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Loja Virtual</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--green:#22c55e;--pink:#f472b6}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--card)}
.nav-brand{font-size:1.2rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:20px}
.nav-links a{color:var(--muted);text-decoration:none;font-size:.85rem;transition:.2s}
.nav-links a:hover{color:var(--text)}
.nav-right{display:flex;align-items:center;gap:14px}
.search-box{position:relative}
.search-box input{padding:8px 14px 8px 34px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.8rem;width:200px;outline:none}
.search-box input:focus{border-color:var(--accent)}
.search-box svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted)}
.cart-btn{position:relative;background:none;border:none;color:var(--text);cursor:pointer;padding:4px}
.cart-count{position:absolute;top:-4px;right:-6px;background:var(--accent);color:#fff;width:16px;height:16px;border-radius:50%;font-size:.6rem;display:flex;align-items:center;justify-content:center}
.hero{padding:60px 24px;text-align:center;background:radial-gradient(circle at 50% 30%,rgba(124,92,252,.1),transparent 60%)}
.hero-badge{display:inline-block;padding:5px 14px;background:rgba(124,92,252,.1);border:1px solid rgba(124,92,252,.3);border-radius:20px;font-size:.75rem;color:var(--accent);margin-bottom:16px}
.hero h1{font-size:clamp(2rem,5vw,3rem);font-weight:800;margin-bottom:12px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{color:var(--muted);font-size:1.05rem;margin-bottom:24px;max-width:500px;margin-left:auto;margin-right:auto}
.btns{display:flex;gap:10px;justify-content:center}
.btn{padding:11px 24px;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;border:none;transition:.2s}
.btn.p{background:var(--accent);color:#fff}
.btn.p:hover{background:#6a4ee8;transform:translateY(-2px);box-shadow:0 4px 20px rgba(124,92,252,.3)}
.btn.s{background:var(--card);color:var(--text);border:1px solid var(--border)}
.btn.s:hover{border-color:var(--accent)}
.categories{display:flex;justify-content:center;gap:10px;padding:20px 24px;flex-wrap:wrap}
.cat{padding:6px 16px;background:var(--card);border:1px solid var(--border);border-radius:20px;font-size:.8rem;color:var(--muted);cursor:pointer;transition:.2s}
.cat:hover,.cat.active{border-color:var(--accent);color:var(--text);background:rgba(124,92,252,.08)}
.products{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;padding:20px 24px;max-width:1200px;margin:0 auto}
.product{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:.3s}
.product:hover{border-color:var(--accent);transform:translateY(-4px);box-shadow:0 8px 30px rgba(0,0,0,.3)}
.product-img{height:180px;display:flex;align-items:center;justify-content:center;font-size:3rem;position:relative}
.product-badge{position:absolute;top:10px;left:10px;padding:3px 8px;border-radius:6px;font-size:.65rem;font-weight:600}
.product-badge.sale{background:rgba(239,68,68,.9);color:#fff}
.product-badge.new{background:rgba(34,197,94,.9);color:#fff}
.product-info{padding:16px}
.product-name{font-size:.95rem;font-weight:600;margin-bottom:4px}
.product-desc{font-size:.75rem;color:var(--muted);margin-bottom:10px;line-height:1.4}
.product-bottom{display:flex;align-items:center;justify-content:space-between}
.product-price{font-size:1.15rem;font-weight:700;color:var(--accent)}
.product-price .old{font-size:.75rem;color:var(--muted);text-decoration:line-through;margin-left:6px;font-weight:400}
.product-rating{font-size:.7rem;color:var(--yellow)}
.add-cart{padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.75rem;font-weight:500;cursor:pointer;transition:.2s}
.add-cart:hover{background:#6a4ee8}
.promo{background:linear-gradient(135deg,rgba(124,92,252,.08),rgba(244,114,182,.08));border:1px solid rgba(124,92,252,.2);border-radius:14px;padding:40px;margin:20px 24px;text-align:center}
.promo h2{font-size:1.8rem;font-weight:800;margin-bottom:8px}
.promo p{color:var(--muted);margin-bottom:16px}
.newsletter{display:flex;gap:8px;justify-content:center;max-width:400px;margin:0 auto}
.newsletter input{flex:1;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.85rem;outline:none}
.newsletter input:focus{border-color:var(--accent)}
.newsletter button{padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:.85rem}
.footer{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:24px;padding:40px 24px;border-top:1px solid var(--border);margin-top:40px}
.footer-col h4{font-size:.85rem;margin-bottom:12px}
.footer-col a{display:block;color:var(--muted);font-size:.8rem;text-decoration:none;padding:3px 0;transition:.2s}
.footer-col a:hover{color:var(--text)}
.footer-bottom{text-align:center;padding:20px;border-top:1px solid var(--border);color:var(--muted);font-size:.75rem}
.cart-panel{position:fixed;right:-380px;top:0;bottom:0;width:360px;background:var(--card);border-left:1px solid var(--border);z-index:50;transition:.3s;display:flex;flex-direction:column}
.cart-panel.open{right:0}
.cart-header{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid var(--border)}
.cart-header h2{font-size:1rem}
.close-cart{background:none;border:none;color:var(--text);font-size:1.3rem;cursor:pointer}
.cart-items{flex:1;overflow-y:auto;padding:14px}
.cart-item{display:flex;gap:10px;padding:10px;background:var(--bg);border-radius:8px;margin-bottom:8px}
.cart-item-img{width:50px;height:50px;background:var(--border);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0}
.cart-item-info{flex:1}
.cart-item-name{font-size:.8rem;font-weight:500}
.cart-item-price{font-size:.75rem;color:var(--accent);margin-top:3px}
.cart-item-remove{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;margin-top:3px}
.cart-item-remove:hover{color:#ef4444}
.cart-footer{padding:16px;border-top:1px solid var(--border)}
.cart-total{display:flex;justify-content:space-between;font-size:1rem;font-weight:700;margin-bottom:12px}
.checkout-btn{width:100%;padding:12px;background:var(--green);color:#fff;border:none;border-radius:8px;font-size:.9rem;font-weight:600;cursor:pointer;transition:.2s}
.checkout-btn:hover{opacity:.9}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:40}
.overlay.open{display:block}
@media(max-width:768px){.products{grid-template-columns:repeat(2,1fr)}.search-box{display:none}}
</style>
</head>
<body>
<nav class="nav">
<div class="nav-brand">🛍️ ShopPro</div>
<div class="nav-links"><a href="#">Início</a><a href="#">Produtos</a><a href="#">Ofertas</a><a href="#">Sobre</a></div>
<div class="nav-right">
<div class="search-box"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input placeholder="Buscar produtos..." id="searchInput" oninput="filterProducts()"></div>
<button class="cart-btn" onclick="toggleCart()">🛒<span class="cart-count" id="cartCount">0</span></button>
</div>
</nav>
<div class="hero">
<div class="hero-badge">🔥 Super Promoção de Verão</div>
<h1>Encontre o que <span>precisa</span></h1>
<p>Produtos selecionados com os melhores preços e entrega rápida</p>
<div class="btns"><button class="btn p" onclick="document.getElementById('products').scrollIntoView({behavior:'smooth'})">Ver Produtos</button><button class="btn s">Ofertas do Dia</button></div>
</div>
<div class="categories">
<div class="cat active" onclick="filterCat(this,'all')">Todos</div>
<div class="cat" onclick="filterCat(this,'tech')">Tech</div>
<div class="cat" onclick="filterCat(this,'fashion')">Moda</div>
<div class="cat" onclick="filterCat(this,'home')">Casa</div>
<div class="cat" onclick="filterCat(this,'sports')">Esporte</div>
</div>
<div class="products" id="products">
<div class="product" data-cat="tech" data-name="MacBook Pro M3"><div class="product-img" style="background:linear-gradient(135deg,#1a1a2e,#2a2a4e)">💻<span class="product-badge new">Novo</span></div><div class="product-info"><div class="product-name">MacBook Pro M3</div><div class="product-desc">Notebook Apple 16GB RAM 512GB SSD</div><div class="product-bottom"><div class="product-price">R$ 14.999</div><div class="product-rating">★★★★★</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('MacBook Pro M3',14999,'💻')">Adicionar ao Carrinho</button></div></div>
<div class="product" data-cat="tech" data-name="iPhone 15 Pro"><div class="product-img" style="background:linear-gradient(135deg,#1a2e1a,#2a4e2a)">📱<span class="product-badge sale">-20%</span></div><div class="product-info"><div class="product-name">iPhone 15 Pro</div><div class="product-desc">Smartphone 256GB Câmera 48MP</div><div class="product-bottom"><div class="product-price">R$ 7.199 <span class="old">R$ 8.999</span></div><div class="product-rating">★★★★★</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('iPhone 15 Pro',7199,'📱')">Adicionar ao Carrinho</button></div></div>
<div class="product" data-cat="tech" data-name="AirPods Pro 2"><div class="product-img" style="background:linear-gradient(135deg,#2e1a2e,#4e2a4e)">🎧</div><div class="product-info"><div class="product-name">AirPods Pro 2</div><div class="product-desc">Fones com cancelamento de ruído</div><div class="product-bottom"><div class="product-price">R$ 1.899</div><div class="product-rating">★★★★☆</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('AirPods Pro 2',1899,'🎧')">Adicionar ao Carrinho</button></div></div>
<div class="product" data-cat="fashion" data-name="Tênis Nike Air Max"><div class="product-img" style="background:linear-gradient(135deg,#2e2e1a,#4e4e2a)">👟<span class="product-badge new">Novo</span></div><div class="product-info"><div class="product-name">Tênis Nike Air Max</div><div class="product-desc">Tênis esportivo conforto premium</div><div class="product-bottom"><div class="product-price">R$ 899</div><div class="product-rating">★★★★★</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('Nike Air Max',899,'👟')">Adicionar ao Carrinho</button></div></div>
<div class="product" data-cat="home" data-name="Smart TV 55"><div class="product-img" style="background:linear-gradient(135deg,#1a2e2e,#2a4e4e)">📺<span class="product-badge sale">-30%</span></div><div class="product-info"><div class="product-name">Smart TV 55" 4K</div><div class="product-desc">TV Samsung Crystal UHD</div><div class="product-bottom"><div class="product-price">R$ 2.799 <span class="old">R$ 3.999</span></div><div class="product-rating">★★★★☆</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('Smart TV 55',2799,'📺')">Adicionar ao Carrinho</button></div></div>
<div class="product" data-cat="sports" data-name="Bicicleta MTB"><div class="product-img" style="background:linear-gradient(135deg,#2e1a1a,#4e2a2a)">🚴</div><div class="product-info"><div class="product-name">Bicicleta MTB 21v</div><div class="product-desc">Bicicleta aro 29 freio a disco</div><div class="product-bottom"><div class="product-price">R$ 1.599</div><div class="product-rating">★★★★☆</div></div><button class="add-cart" style="width:100%;margin-top:10px" onclick="addToCart('Bicicleta MTB',1599,'🚴')">Adicionar ao Carrinho</button></div></div>
</div>
<div class="promo">
<h2>Oferta Especial 🔥</h2>
<p>Ganhe 15% de desconto na primeira compra</p>
<div class="newsletter"><input placeholder="Seu melhor e-mail"><button>Quero Desconto</button></div>
</div>
<div class="footer">
<div class="footer-col"><h4>Loja</h4><a href="#">Sobre Nós</a><a href="#">Carreiras</a><a href="#">Blog</a></div>
<div class="footer-col"><h4>Ajuda</h4><a href="#">Central de Ajuda</a><a href="#">Entregas</a><a href="#">Devoluções</a></div>
<div class="footer-col"><h4>Legal</h4><a href="#">Privacidade</a><a href="#">Termos</a></div>
<div class="footer-col"><h4>Redes</h4><a href="#">Instagram</a><a href="#">Twitter</a><a href="#">YouTube</a></div>
</div>
<div class="footer-bottom">© 2026 ShopPro. Todos os direitos reservados.</div>
<div class="overlay" id="overlay" onclick="toggleCart()"></div>
<div class="cart-panel" id="cartPanel">
<div class="cart-header"><h2>Meu Carrinho</h2><button class="close-cart" onclick="toggleCart()">×</button></div>
<div class="cart-items" id="cartItems"><p style="color:var(--muted);text-align:center;padding:40px">Carrinho vazio</p></div>
<div class="cart-footer"><div class="cart-total"><span>Total</span><span id="cartTotal">R$ 0</span></div><button class="checkout-btn" onclick="checkout()">Finalizar Compra →</button></div>
</div>
<script>
let cart=[];
function addToCart(n,p,e){cart.push({name:n,price:p,emoji:e});updateCart();showToast(e+' '+n+' adicionado!')}
function removeItem(i){cart.splice(i,1);updateCart()}
function updateCart(){
document.getElementById('cartCount').textContent=cart.length;
const items=document.getElementById('cartItems');
if(!cart.length){items.innerHTML='<p style="color:var(--muted);text-align:center;padding:40px">Carrinho vazio</p>';document.getElementById('cartTotal').textContent='R$ 0';return}
items.innerHTML=cart.map((it,i)=>'<div class="cart-item"><div class="cart-item-img">'+it.emoji+'</div><div class="cart-item-info"><div class="cart-item-name">'+it.name+'</div><div class="cart-item-price">R$ '+it.price.toLocaleString()+'</div><button class="cart-item-remove" onclick="removeItem('+i+')">✕ Remover</button></div></div>').join('');
document.getElementById('cartTotal').textContent='R$ '+cart.reduce((s,i)=>s+i.price,0).toLocaleString();
}
function toggleCart(){document.getElementById('cartPanel').classList.toggle('open');document.getElementById('overlay').classList.toggle('open')}
function checkout(){if(!cart.length)return alert('Adicione itens!');alert('Compra realizada! Total: R$ '+cart.reduce((s,i)=>s+i.price,0).toLocaleString());cart=[];updateCart();toggleCart()}
function filterProducts(){const q=document.getElementById('searchInput').value.toLowerCase();document.querySelectorAll('.product').forEach(p=>{p.style.display=p.dataset.name.toLowerCase().includes(q)?'':'none'})}
function filterCat(el,cat){document.querySelectorAll('.cat').forEach(c=>c.classList.remove('active'));el.classList.add('active');document.querySelectorAll('.product').forEach(p=>{p.style.display=(cat==='all'||p.dataset.cat===cat)?'':'none'})}
function showToast(msg){const t=document.createElement('div');t.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--green);color:#fff;padding:10px 20px;border-radius:8px;font-size:.85rem;z-index:100;animation:fadeUp .3s';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2000)}
</script>
</body>
</html>
\`\`\`

Loja completa com busca, filtros por categoria, carrinho, newsletter e footer. Pronta pra usar! 🛒`;
}

function generateDashboardCode() {
    return `Dashboard profissional:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--blue:#3b82f6}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:var(--card);border-right:1px solid var(--border);padding:16px;display:flex;flex-direction:column;gap:16px;z-index:10}
.logo{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,var(--accent),#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-items{display:flex;flex-direction:column;gap:3px}
.nav-item{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:.8rem;transition:.2s}
.nav-item:hover,.nav-item.active{background:rgba(124,92,252,.1);color:var(--text)}
.nav-item.active{border-left:3px solid var(--accent)}
.main{margin-left:220px;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.header h1{font-size:1.3rem}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.stat-label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.stat-value{font-size:1.5rem;font-weight:700}
.stat-change{font-size:.7rem;margin-top:6px}
.stat-change.up{color:var(--green)}
.stat-change.down{color:var(--red)}
.charts{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:20px}
.chart-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.chart-card h3{font-size:.9rem;margin-bottom:14px}
.bars{display:flex;align-items:flex-end;gap:6px;height:160px}
.bar{flex:1;border-radius:5px 5px 0 0;background:linear-gradient(to top,var(--accent),#a78bfa);transition:.3s;min-height:8px;position:relative}
.bar:hover{opacity:.8}
.bar-tip{position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--muted)}
.donut{width:120px;height:120px;border-radius:50%;background:conic-gradient(var(--accent) 0% 42%,var(--green) 42% 72%,var(--yellow) 72% 88%,var(--border) 88% 100%);margin:0 auto 12px;position:relative}
.donut::after{content:'';position:absolute;inset:30px;background:var(--card);border-radius:50%}
.legend{display:flex;flex-direction:column;gap:4px}
.legend-item{display:flex;align-items:center;gap:6px;font-size:.7rem;color:var(--muted)}
.legend-dot{width:7px;height:7px;border-radius:50%}
.table-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.65rem;color:var(--muted);text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--border)}
td{padding:10px;font-size:.8rem;border-bottom:1px solid var(--border)}
.badge{padding:3px 8px;border-radius:12px;font-size:.65rem;font-weight:600}
.badge.g{background:rgba(34,197,94,.12);color:var(--green)}
.badge.y{background:rgba(234,179,8,.12);color:var(--yellow)}
.badge.b{background:rgba(59,130,246,.12);color:var(--blue)}
</style>
</head>
<body>
<aside class="sidebar">
<div class="logo">📊 Dashboard</div>
<nav class="nav-items">
<div class="nav-item active">📊 Overview</div>
<div class="nav-item">📈 Analytics</div>
<div class="nav-item">💰 Revenue</div>
<div class="nav-item">👥 Customers</div>
<div class="nav-item">📦 Products</div>
<div class="nav-item">⚙️ Settings</div>
</nav>
</aside>
<main class="main">
<div class="header"><h1>Overview</h1><div style="color:var(--muted);font-size:.8rem">Julho 2026</div></div>
<div class="stats">
<div class="stat"><div class="stat-label">Receita Total</div><div class="stat-value">R$ 48.520</div><div class="stat-change up">↑ 12.5% vs mês anterior</div></div>
<div class="stat"><div class="stat-label">Pedidos</div><div class="stat-value">1.248</div><div class="stat-change up">↑ 8.2%</div></div>
<div class="stat"><div class="stat-label">Clientes Ativos</div><div class="stat-value">3.847</div><div class="stat-change up">↑ 15.3%</div></div>
<div class="stat"><div class="stat-label">Ticket Médio</div><div class="stat-value">R$ 38,90</div><div class="stat-change down">↓ 2.1%</div></div>
</div>
<div class="charts">
<div class="chart-card"><h3>Vendas Mensais</h3><div class="bars"><div class="bar" style="height:40%"><div class="bar-tip">Jan</div></div><div class="bar" style="height:55%"><div class="bar-tip">Fev</div></div><div class="bar" style="height:35%"><div class="bar-tip">Mar</div></div><div class="bar" style="height:70%"><div class="bar-tip">Abr</div></div><div class="bar" style="height:50%"><div class="bar-tip">Mai</div></div><div class="bar" style="height:85%"><div class="bar-tip">Jun</div></div><div class="bar" style="height:65%"><div class="bar-tip">Jul</div></div><div class="bar" style="height:80%"><div class="bar-tip">Ago</div></div><div class="bar" style="height:60%"><div class="bar-tip">Set</div></div><div class="bar" style="height:90%"><div class="bar-tip">Out</div></div><div class="bar" style="height:75%"><div class="bar-tip">Nov</div></div><div class="bar" style="height:95%"><div class="bar-tip">Dez</div></div></div></div>
<div class="chart-card"><h3>Categorias</h3><div class="donut"></div><div class="legend"><div class="legend-item"><div class="legend-dot" style="background:var(--accent)"></div>Eletrônicos 42%</div><div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Roupas 30%</div><div class="legend-item"><div class="legend-dot" style="background:var(--yellow)"></div>Casa 16%</div><div class="legend-item"><div class="legend-dot" style="background:var(--border)"></div>Outros 12%</div></div></div>
</div>
<div class="table-card"><h3 style="margin-bottom:12px;font-size:.9rem">Pedidos Recentes</h3>
<table><tr><th>ID</th><th>Cliente</th><th>Produto</th><th>Valor</th><th>Status</th><th>Data</th></tr>
<tr><td>#4521</td><td>Maria Silva</td><td>iPhone 15 Pro</td><td>R$ 8.999</td><td><span class="badge g">Entregue</span></td><td>12/07</td></tr>
<tr><td>#4520</td><td>João Santos</td><td>MacBook Air</td><td>R$ 12.499</td><td><span class="badge y">Enviado</span></td><td>12/07</td></tr>
<tr><td>#4519</td><td>Ana Costa</td><td>AirPods Pro</td><td>R$ 1.899</td><td><span class="badge b">Processando</span></td><td>11/07</td></tr>
<tr><td>#4518</td><td>Pedro Lima</td><td>iPad Mini</td><td>R$ 4.299</td><td><span class="badge g">Entregue</span></td><td>11/07</td></tr>
<tr><td>#4517</td><td>Carla Souza</td><td>Apple Watch</td><td>R$ 3.199</td><td><span class="badge g">Entregue</span></td><td>10/07</td></tr>
</table></div>
</main>
</body>
</html>
\`\`\`

Dashboard com sidebar, 4 KPIs, gráfico de barras mensal, donut de categorias e tabela de pedidos. Pronto! 📊`;
}

function generateLandingCode() {
    return `Landing page profissional:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Landing Page</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--pink:#f472b6;--green:#22c55e}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--card)}
.nav-brand{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:20px;align-items:center}
.nav-links a{color:var(--muted);text-decoration:none;font-size:.85rem;transition:.2s}
.nav-links a:hover{color:var(--text)}
.hero{min-height:90vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:40%;left:50%;width:500px;height:500px;background:radial-gradient(circle,rgba(124,92,252,.12),transparent 70%);transform:translate(-50%,-50%)}
.badge{display:inline-block;padding:5px 14px;background:rgba(124,92,252,.1);border:1px solid rgba(124,92,252,.3);border-radius:20px;font-size:.75rem;color:var(--accent);margin-bottom:20px}
.hero h1{font-size:clamp(2.2rem,5vw,3.5rem);font-weight:800;line-height:1.1;margin-bottom:16px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{font-size:1.05rem;color:var(--muted);max-width:520px;margin-bottom:30px;line-height:1.6}
.btns{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
.btn{padding:12px 28px;border-radius:10px;font-size:.9rem;font-weight:600;cursor:pointer;border:none;transition:.3s}
.btn.p{background:var(--accent);color:#fff}
.btn.p:hover{background:#6a4ee8;transform:translateY(-2px);box-shadow:0 6px 24px rgba(124,92,252,.35)}
.btn.s{background:var(--card);color:var(--text);border:1px solid var(--border)}
.btn.s:hover{border-color:var(--accent)}
.stats-bar{display:flex;justify-content:center;gap:40px;padding:30px;border-bottom:1px solid var(--border)}
.stat-item{text-align:center}
.stat-num{font-size:1.5rem;font-weight:800;color:var(--accent)}
.stat-label{font-size:.75rem;color:var(--muted)}
section{padding:80px 24px;max-width:1000px;margin:0 auto}
.sec-title{font-size:2rem;font-weight:700;text-align:center;margin-bottom:12px}
.sec-sub{text-align:center;color:var(--muted);margin-bottom:40px;font-size:1rem}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.feature{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;transition:.3s}
.feature:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 8px 30px rgba(0,0,0,.2)}
.feature .icon{font-size:2rem;margin-bottom:12px}
.feature h3{margin-bottom:8px;font-size:1rem}
.feature p{color:var(--muted);font-size:.85rem;line-height:1.5}
.pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.price{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;text-align:center;transition:.3s}
.price:hover{border-color:var(--accent)}
.price.pop{border-color:var(--accent);box-shadow:0 0 30px rgba(124,92,252,.12);transform:scale(1.02)}
.price h3{font-size:1.1rem;margin-bottom:4px}
.price .val{font-size:2.2rem;font-weight:800;margin:10px 0}
.price .val span{font-size:.8rem;font-weight:400;color:var(--muted)}
.price p{color:var(--muted);font-size:.8rem;margin-bottom:16px}
.price ul{list-style:none;text-align:left;margin-bottom:20px}
.price ul li{padding:5px 0;font-size:.8rem;color:var(--muted);display:flex;align-items:center;gap:6px}
.price ul li::before{content:'✓';color:var(--green);font-weight:700}
.cta{text-align:center;padding:80px 24px;background:radial-gradient(circle,rgba(124,92,252,.06),transparent 60%)}
.cta h2{font-size:2rem;margin-bottom:10px}
.cta p{color:var(--muted);margin-bottom:24px}
.testimonials{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.testimonial{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px}
.testimonial .quote{color:var(--muted);font-size:.85rem;line-height:1.6;margin-bottom:14px;font-style:italic}
.testimonial .author{display:flex;align-items:center;gap:10px}
.testimonial .avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:.8rem;color:#fff}
.testimonial .name{font-size:.85rem;font-weight:600}
.testimonial .role{font-size:.7rem;color:var(--muted)}
footer{text-align:center;padding:24px;border-top:1px solid var(--border);color:var(--muted);font-size:.75rem}
</style>
</head>
<body>
<nav class="nav">
<div class="nav-brand">⚡ Velocity</div>
<div class="nav-links"><a href="#">Features</a><a href="#">Pricing</a><a href="#">Docs</a><button class="btn p" style="padding:8px 20px;font-size:.8rem">Get Started</button></div>
</nav>
<div class="hero">
<div class="badge">🚀 Novo: AI Agents disponíveis</div>
<h1>Construa apps <span>incríveis</span> com IA</h1>
<p>Descreva sua ideia e veja seu app ganhar vida em segundos. Sem código, sem complicação.</p>
<div class="btns"><button class="btn p">Começar Grátis</button><button class="btn s">Ver Demo</button></div>
</div>
<div class="stats-bar">
<div class="stat-item"><div class="stat-num">10K+</div><div class="stat-label">Builders</div></div>
<div class="stat-item"><div class="stat-num">50K+</div><div class="stat-label">Apps Criados</div></div>
<div class="stat-item"><div class="stat-num">99.9%</div><div class="stat-label">Uptime</div></div>
<div class="stat-item"><div class="stat-num">4.9★</div><div class="stat-label">Avaliação</div></div>
</div>
<section>
<h2 class="sec-title">Tudo que você precisa</h2>
<p class="sec-sub">Do conceito ao deploy em minutos</p>
<div class="features">
<div class="feature"><div class="icon">⚡</div><h3>Geração Instantânea</h3><p>Apps funcionais em minutos com IA avançada.</p></div>
<div class="feature"><div class="icon">🎨</div><h3>Design Premium</h3><p>Interfaces modernas que impressionam.</p></div>
<div class="feature"><div class="icon">🚀</div><h3>Deploy 1 Clique</h3><p>Publique no ar em segundos.</p></div>
<div class="feature"><div class="icon">💬</div><h3>Chat com IA</h3><p>Refine por conversa natural.</p></div>
<div class="feature"><div class="icon">🔒</div><h3>Seguro</h3><p>Infraestrutura enterprise.</p></div>
<div class="feature"><div class="icon">📱</div><h3>Responsivo</h3><p>Funciona em qualquer tela.</p></div>
</div>
</section>
<section>
<h2 class="sec-title">O que dizem</h2>
<div class="testimonials">
<div class="testimonial"><div class="quote">"Construí meu SaaS em 2 horas. Incrível o que a IA consegue fazer."</div><div class="author"><div class="avatar">M</div><div><div class="name">Marina Silva</div><div class="role">Founder, StartupXYZ</div></div></div></div>
<div class="testimonial"><div class="quote">"Economizei R$ 15.000 em desenvolvimento. Recomendo demais."</div><div class="author"><div class="avatar">P</div><div><div class="name">Pedro Costa</div><div class="role">Dev Freelancer</div></div></div></div>
<div class="testimonial"><div class="quote">"A melhor ferramenta de vibe coding que já usei. Simplesmente viciante."</div><div class="author"><div class="avatar">A</div><div><div class="name">Ana Oliveira</div><div class="role">Product Manager</div></div></div></div>
</div>
</section>
<section>
<h2 class="sec-title">Planos</h2>
<p class="sec-sub">Escolha o plano ideal</p>
<div class="pricing">
<div class="price"><h3>Starter</h3><div class="val">Grátis</div><p>Para testar</p><ul><li>100 créditos/dia</li><li>1 projeto</li><li>Deploy básico</li></ul><button class="btn s" style="width:100%">Plano Atual</button></div>
<div class="price pop"><h3>Pro</h3><div class="val">R$49<span>/mês</span></div><p>Para builders sérios</p><ul><li>Ilimitado</li><li>Custom domain</li><li>Suporte prioritário</li><li>API access</li></ul><button class="btn p" style="width:100%">Assinar Pro</button></div>
<div class="price"><h3>Enterprise</h3><div class="val">R$199<span>/mês</span></div><p>Para equipes</p><ul><li>Tudo do Pro</li><li>5 membros</li><li>SLA 99.9%</li><li>Suporte dedicado</li></ul><button class="btn s" style="width:100%">Falar com Vendas</button></div>
</div>
</section>
<div class="cta"><h2>Pronto para criar?</h2><p>Comece grátis agora. Sem cartão.</p><button class="btn p" style="font-size:1rem;padding:14px 36px">Criar Meu App →</button></div>
<footer>© 2026 Velocity. Todos os direitos reservados.</footer>
</body>
</html>
\`\`\`

Landing page completa com hero, stats, features, depoimentos, pricing e CTA. Pronta! 💎`;
}

function generateTaskManagerCode() {
    return `Task Manager Kanban:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TaskFlow</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--green:#22c55e;--yellow:#eab308;--red:#ef4444}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--card)}
.topbar h1{font-size:1rem;display:flex;align-items:center;gap:6px}
.topbar h1 span{background:linear-gradient(135deg,var(--accent),#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.add-btn{padding:7px 14px;background:var(--accent);color:#fff;border:none;border-radius:7px;font-size:.8rem;cursor:pointer;font-weight:500}
.board{display:flex;gap:14px;padding:16px;overflow-x:auto;flex:1}
.column{min-width:280px;max-width:280px;background:var(--card);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;max-height:calc(100vh - 100px)}
.col-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border)}
.col-title{font-size:.8rem;font-weight:600;display:flex;align-items:center;gap:6px}
.col-count{background:var(--border);padding:2px 7px;border-radius:8px;font-size:.65rem;color:var(--muted)}
.col-dot{width:7px;height:7px;border-radius:50%}
.cards{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.task{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;cursor:grab;transition:.2s;user-select:none}
.task:hover{border-color:var(--accent);transform:translateY(-1px)}
.task.dragging{opacity:.5;transform:rotate(3deg)}
.task-title{font-size:.8rem;margin-bottom:6px}
.task-meta{display:flex;align-items:center;justify-content:space-between}
.task-tag{padding:2px 7px;border-radius:5px;font-size:.65rem;font-weight:500}
.task-tag.urgent{background:rgba(239,68,68,.12);color:var(--red)}
.task-tag.medium{background:rgba(234,179,8,.12);color:var(--yellow)}
.task-tag.low{background:rgba(34,197,94,.12);color:var(--green)}
.task-date{font-size:.65rem;color:var(--muted)}
.add-card{padding:10px;margin:0 10px 10px;border:1px dashed var(--border);border-radius:7px;text-align:center;color:var(--muted);font-size:.75rem;cursor:pointer;transition:.2s}
.add-card:hover{border-color:var(--accent);color:var(--text)}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;width:100%;max-width:400px}
.modal h2{margin-bottom:16px;font-size:1rem}
.modal input,.modal select{width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:.8rem;margin-bottom:10px;font-family:inherit;outline:none}
.modal input:focus,.modal select:focus{border-color:var(--accent)}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.modal-btns button{padding:7px 16px;border-radius:7px;font-size:.8rem;cursor:pointer;border:none;font-weight:500}
.cancel{background:var(--bg);color:var(--text);border:1px solid var(--border)!important}
.submit{background:var(--accent);color:#fff}
</style>
</head>
<body>
<div class="topbar">
<h1><span>✅ TaskFlow</span> — Projeto Alpha</h1>
<button class="add-btn" onclick="openModal()">+ Nova Tarefa</button>
</div>
<div class="board" id="board">
<div class="column" id="col-todo">
<div class="col-header"><div class="col-title"><div class="col-dot" style="background:var(--muted)"></div>A Fazer <span class="col-count">3</span></div></div>
<div class="cards">
<div class="task" draggable="true"><div class="task-title">Criar wireframe do app</div><div class="task-meta"><span class="task-tag urgent">Urgente</span><span class="task-date">13 Jul</span></div></div>
<div class="task" draggable="true"><div class="task-title">Definir paleta de cores</div><div class="task-meta"><span class="task-tag medium">Médio</span><span class="task-date">14 Jul</span></div></div>
<div class="task" draggable="true"><div class="task-title">Pesquisar concorrentes</div><div class="task-meta"><span class="task-tag low">Baixa</span><span class="task-date">15 Jul</span></div></div>
</div>
<div class="add-card" onclick="openModal()">+ Adicionar</div>
</div>
<div class="column" id="col-prog">
<div class="col-header"><div class="col-title"><div class="col-dot" style="background:var(--accent)"></div>Em Progresso <span class="col-count">2</span></div></div>
<div class="cards">
<div class="task" draggable="true"><div class="task-title">Implementar auth JWT</div><div class="task-meta"><span class="task-tag urgent">Urgente</span><span class="task-date">12 Jul</span></div></div>
<div class="task" draggable="true"><div class="task-title">Design da landing page</div><div class="task-meta"><span class="task-tag medium">Médio</span><span class="task-date">13 Jul</span></div></div>
</div>
</div>
<div class="column" id="col-rev">
<div class="col-header"><div class="col-title"><div class="col-dot" style="background:var(--yellow)"></div>Revisão <span class="col-count">1</span></div></div>
<div class="cards">
<div class="task" draggable="true"><div class="task-title">API de pagamentos</div><div class="task-meta"><span class="task-tag medium">Médio</span><span class="task-date">11 Jul</span></div></div>
</div>
</div>
<div class="column" id="col-done">
<div class="col-header"><div class="col-title"><div class="col-dot" style="background:var(--green)"></div>Feito <span class="col-count">2</span></div></div>
<div class="cards">
<div class="task" draggable="true"><div class="task-title">Setup do projeto</div><div class="task-meta"><span class="task-tag low">Baixa</span><span class="task-date">10 Jul</span></div></div>
<div class="task" draggable="true"><div class="task-title">Configurar CI/CD</div><div class="task-meta"><span class="task-tag low">Baixa</span><span class="task-date">10 Jul</span></div></div>
</div>
</div>
</div>
<div class="modal-overlay" id="modal">
<div class="modal">
<h2>Nova Tarefa</h2>
<input type="text" id="taskTitle" placeholder="Título da tarefa">
<select id="taskPriority"><option value="low">Baixa</option><option value="medium" selected>Média</option><option value="urgent">Urgente</option></select>
<div class="modal-btns">
<button class="cancel" onclick="closeModal()">Cancelar</button>
<button class="submit" onclick="addTask()">Criar</button>
</div>
</div>
</div>
<script>
let dragged=null;
function openModal(){document.getElementById('modal').classList.add('open')}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function addTask(){
const t=document.getElementById('taskTitle').value.trim();if(!t)return;
const p=document.getElementById('taskPriority').value;
const tags={urgent:'Urgente',medium:'Médio',low:'Baixa'};
const c=document.createElement('div');c.className='task';c.draggable=true;
c.innerHTML='<div class="task-title">'+t+'</div><div class="task-meta"><span class="task-tag '+p+'">'+tags[p]+'</span><span class="task-date">'+new Date().toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})+'</span></div>';
c.ondragstart=e=>{dragged=c;c.classList.add('dragging');e.dataTransfer.effectAllowed='move'};
c.ondragend=()=>{c.classList.remove('dragging');dragged=null;document.querySelectorAll('.cards').forEach(col=>col.style.background='');updateCounts()};
document.querySelector('#col-todo .cards').appendChild(c);
document.getElementById('taskTitle').value='';closeModal();updateCounts();
}
document.querySelectorAll('.cards').forEach(col=>{
col.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move';col.style.background='rgba(124,92,252,.05)'};
col.ondragleave=()=>col.style.background='';
col.ondrop=e=>{e.preventDefault();col.style.background='';if(dragged){col.appendChild(dragged);updateCounts()}};
});
function updateCounts(){document.querySelectorAll('.column').forEach(col=>{const count=col.querySelector('.cards').children.length;col.querySelector('.col-count').textContent=count})}
document.querySelectorAll('.task').forEach(t=>{
t.ondragstart=e=>{dragged=t;t.classList.add('dragging');e.dataTransfer.effectAllowed='move'};
t.ondragend=()=>{t.classList.remove('dragging');dragged=null;updateCounts()};
});
</script>
</body>
</html>
\`\`\`

Kanban com drag & drop funcional, modal de criação e contadores automáticos. Pronto! ✅`;
}

function generateChatCode() {
    return `Bate-papo em tempo real:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--green:#22c55e}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex}
.sidebar{width:240px;background:var(--card);border-right:1px solid var(--border);display:flex;flex-direction:column}
.sidebar-header{padding:14px;border-bottom:1px solid var(--border)}
.sidebar-header h2{font-size:1rem;display:flex;align-items:center;gap:6px}
.sidebar-header h2 span{background:linear-gradient(135deg,var(--accent),#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.room-list{flex:1;overflow-y:auto;padding:8px}
.room{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:.8rem;color:var(--muted);transition:.2s}
.room:hover{background:rgba(124,92,252,.08);color:var(--text)}
.room.active{background:rgba(124,92,252,.12);color:var(--text)}
.room-icon{font-size:1rem}
.room-info{flex:1;min-width:0}
.room-name{font-weight:500}
.room-last{font-size:.65rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.room-badge{background:var(--accent);color:#fff;width:16px;height:16px;border-radius:50%;font-size:.6rem;display:flex;align-items:center;justify-content:center}
.chat-main{flex:1;display:flex;flex-direction:column}
.chat-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--card)}
.chat-header h3{font-size:.9rem}
.online{font-size:.7rem;color:var(--green);display:flex;align-items:center;gap:4px}
.online::before{content:'';width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;gap:8px;max-width:70%;animation:fadeUp .3s ease}
.msg.self{align-self:flex-end;flex-direction:row-reverse}
.msg-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:600;flex-shrink:0}
.msg.other .msg-avatar{background:var(--border);color:var(--text)}
.msg.self .msg-avatar{background:var(--accent);color:#fff}
.msg-content{flex:1}
.msg-name{font-size:.65rem;color:var(--muted);margin-bottom:2px}
.msg.self .msg-name{text-align:right}
.msg-bubble{padding:9px 13px;border-radius:12px;font-size:.8rem;line-height:1.5}
.msg.other .msg-bubble{background:var(--card);border:1px solid var(--border);border-top-left-radius:3px}
.msg.self .msg-bubble{background:var(--accent);color:#fff;border-top-right-radius:3px}
.msg-time{font-size:.55rem;color:var(--muted);margin-top:2px}
.msg.self .msg-time{text-align:right}
.typing{display:flex;gap:4px;padding:8px 13px}
.typing-dot{width:5px;height:5px;background:var(--muted);border-radius:50%;animation:typeBounce 1.4s infinite ease-in-out both}
.typing-dot:nth-child(1){animation-delay:-.32s}
.typing-dot:nth-child(2){animation-delay:-.16s}
@keyframes typeBounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
.input-bar{padding:12px 16px;border-top:1px solid var(--border);background:var(--card);display:flex;gap:8px;align-items:flex-end}
.input-bar textarea{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:.8rem;resize:none;max-height:80px;outline:none;line-height:1.4}
.input-bar textarea:focus{border-color:var(--accent)}
.send{background:var(--accent);color:#fff;border:none;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.2s;flex-shrink:0}
.send:hover{background:#6a4ee8}
.emoji-btn{background:none;border:none;font-size:1.1rem;cursor:pointer;padding:4px}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<aside class="sidebar">
<div class="sidebar-header"><h2><span>💬 Chat</span></h2></div>
<div class="room-list">
<div class="room active" onclick="selectRoom(this,'Geral')"><span class="room-icon">🌐</span><div class="room-info"><div class="room-name">Geral</div><div class="room-last">Última msg...</div></div><span class="room-badge">3</span></div>
<div class="room" onclick="selectRoom(this,'Random')"><span class="room-icon">🎲</span><div class="room-info"><div class="room-name">Random</div><div class="room-last">Bora!</div></div></div>
<div class="room" onclick="selectRoom(this,'Games')"><span class="room-icon">🎮</span><div class="room-info"><div class="room-name">Games</div><div class="room-last">Alguém?</div></div></div>
<div class="room" onclick="selectRoom(this,'Música')"><span class="room-icon">🎵</span><div class="room-info"><div class="room-name">Música</div><div class="room-last">Playlist 🔥</div></div></div>
</div>
</aside>
<main class="chat-main">
<div class="chat-header"><h3># Geral</h3><div class="online">5 online</div></div>
<div class="messages" id="messages">
<div class="msg other"><div class="msg-avatar">S</div><div class="msg-content"><div class="msg-name">System</div><div class="msg-bubble">Bem-vindo ao chat! 🎉</div><div class="msg-time">10:00</div></div></div>
</div>
<div class="input-bar">
<button class="emoji-btn" onclick="addEmoji()">😊</button>
<textarea id="msgInput" placeholder="Digite..." rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
<button class="send" onclick="sendMsg()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
</div>
</main>
<script>
const names=['Ana','Pedro','Carlos','Julia','Lucas','Fernanda'];
const emojis=['😂','❤️','👍','🔥','😎','🎉','💪','🤔'];
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,80)+'px'}
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg()}}
function getTime(){return new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}
function sendMsg(){
const input=document.getElementById('msgInput');
const text=input.value.trim();if(!text)return;
addMsg(text,true);input.value='';input.style.height='auto';
setTimeout(()=>simulateReply(),800+Math.random()*1500);
}
function addMsg(text,self){
const msgs=document.getElementById('messages');
const d=document.createElement('div');d.className='msg '+(self?'self':'other');
const n=self?'Você':names[Math.floor(Math.random()*names.length)];
d.innerHTML=(self?'':'<div class="msg-avatar">'+n[0]+'</div>')+'<div class="msg-content"><div class="msg-name">'+n+'</div><div class="msg-bubble">'+escapeHtml(text)+'</div><div class="msg-time">'+getTime()+'</div></div>'+(self?'<div class="msg-avatar">'+n[0]+'</div>':'');
msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;
}
function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}
function simulateReply(){
const replies=['kkkkk','show!','=top','massa','entendi','bora!','legal 😎','com certeza','nossa sim!','alguém mais?','good vibes 🎵'];
const typing=document.createElement('div');typing.className='msg other';typing.id='typing';
const name=names[Math.floor(Math.random()*names.length)];
typing.innerHTML='<div class="msg-avatar">'+name[0]+'</div><div class="msg-content"><div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
document.getElementById('messages').appendChild(typing);
document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight;
setTimeout(()=>{const el=document.getElementById('typing');if(el)el.remove();addMsg(replies[Math.floor(Math.random()*replies.length)],false)},1000+Math.random()*1000);
}
function addEmoji(){const i=document.getElementById('msgInput');i.value+=emojis[Math.floor(Math.random()*emojis.length)];i.focus()}
function selectRoom(el,name){document.querySelectorAll('.room').forEach(r=>r.classList.remove('active'));el.classList.add('active');document.getElementById('messages').innerHTML='<div class="msg other"><div class="msg-avatar">S</div><div class="msg-content"><div class="msg-name">System</div><div class="msg-bubble">Entrou na sala '+name+' 🎉</div><div class="msg-time">'+getTime()+'</div></div></div>'}
</script>
</body>
</html>
\`\`\`

Chat com salas, typing indicator, emojis e respostas automáticas. Pronto! 💬`;
}

function generateBlogCode() {
    return `Blog profissional:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blog</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--pink:#f472b6}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--card)}
.nav-brand{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:20px}
.nav-links a{color:var(--muted);text-decoration:none;font-size:.85rem}
.nav-links a:hover{color:var(--text)}
.hero{padding:50px 24px;text-align:center}
.hero h1{font-size:2.2rem;font-weight:800;margin-bottom:8px}
.hero p{color:var(--muted)}
.container{max-width:800px;margin:0 auto;padding:0 24px}
.posts{display:flex;flex-direction:column;gap:18px;padding:24px 0}
.post{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:.3s;cursor:pointer}
.post:hover{border-color:var(--accent);transform:translateY(-2px)}
.post-img{height:180px;display:flex;align-items:center;justify-content:center;font-size:3rem}
.post-body{padding:18px}
.post-tag{display:inline-block;padding:3px 10px;background:rgba(124,92,252,.12);color:var(--accent);border-radius:10px;font-size:.7rem;font-weight:500;margin-bottom:8px}
.post-title{font-size:1.15rem;font-weight:700;margin-bottom:6px}
.post-excerpt{color:var(--muted);font-size:.8rem;line-height:1.5;margin-bottom:10px}
.post-meta{display:flex;gap:12px;font-size:.65rem;color:var(--muted)}
.post-author{display:flex;align-items:center;gap:5px}
.author-avatar{width:22px;height:22px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:.6rem;color:#fff}
.footer{border-top:1px solid var(--border);text-align:center;padding:20px;color:var(--muted);font-size:.7rem;margin-top:30px}
</style>
</head>
<body>
<nav class="nav"><div class="nav-brand">📝 BlogCode</div><div class="nav-links"><a href="#">Home</a><a href="#">Categorias</a><a href="#">Sobre</a></div></nav>
<div class="hero"><h1>Blog & Artigos</h1><p>Conteúdo sobre dev e tecnologia</p></div>
<div class="container"><div class="posts">
<div class="post"><div class="post-img" style="background:linear-gradient(135deg,var(--accent),var(--pink))">🚀</div><div class="post-body"><span class="post-tag">Tutorial</span><h2 class="post-title">Como construir um SaaS do zero</h2><p class="post-excerpt">Guia completo para lançar seu SaaS usando IA e ferramentas modernas...</p><div class="post-meta"><div class="post-author"><div class="author-avatar">C</div>Corvo Coder</div><span>12 Jul 2026</span><span>5 min</span></div></div></div>
<div class="post"><div class="post-img" style="background:linear-gradient(135deg,#22c55e,#3b82f6)">💡</div><div class="post-body"><span class="post-tag">Dicas</span><h2 class="post-title">10 frameworks essenciais para devs</h2><p class="post-excerpt">React, Vue, Svelte... qual escolher?</p><div class="post-meta"><div class="post-author"><div class="author-avatar">C</div>Corvo Coder</div><span>10 Jul 2026</span><span>8 min</span></div></div></div>
<div class="post"><div class="post-img" style="background:linear-gradient(135deg,#eab308,#ef4444)">🔥</div><div class="post-body"><span class="post-tag">Novidades</span><h2 class="post-title">Vibe Coding: a nova era</h2><p class="post-excerpt">Como IA está transformando o desenvolvimento...</p><div class="post-meta"><div class="post-author"><div class="author-avatar">C</div>Corvo Coder</div><span>8 Jul 2026</span><span>6 min</span></div></div></div>
</div></div>
<footer class="footer">© 2026 BlogCode</footer>
</body>
</html>
\`\`\`

Blog com posts, tags e design clean. Pronto! 📝`;
}

function generatePortfolioCode() {
    return `Portfólio profissional:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portfólio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--pink:#f472b6;--green:#22c55e}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--card)}
.nav-brand{font-size:1rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:20px}
.nav-links a{color:var(--muted);text-decoration:none;font-size:.85rem}
.nav-links a:hover{color:var(--text)}
.hero{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 24px}
.hero::before{content:'';position:absolute;top:30%;left:50%;width:400px;height:400px;background:radial-gradient(circle,rgba(124,92,252,.1),transparent 70%);transform:translateX(-50%)}
.hero h1{font-size:clamp(2rem,5vw,3rem);font-weight:800;margin-bottom:10px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{color:var(--muted);margin-bottom:20px}
.btns{display:flex;gap:10px}
.btn{padding:10px 22px;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;border:none;transition:.2s}
.btn.p{background:var(--accent);color:#fff}
.btn.p:hover{background:#6a4ee8}
.btn.s{background:var(--card);color:var(--text);border:1px solid var(--border)}
section{padding:50px 24px;max-width:900px;margin:0 auto}
.sec-title{font-size:1.8rem;font-weight:700;text-align:center;margin-bottom:24px}
.skills{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:30px}
.skill{padding:7px 16px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:.8rem;color:var(--muted);transition:.2s}
.skill:hover{border-color:var(--accent);color:var(--text)}
.projects{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.project{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:.3s}
.project:hover{border-color:var(--accent);transform:translateY(-3px)}
.project-img{height:150px;display:flex;align-items:center;justify-content:center;font-size:2.5rem}
.project-info{padding:14px}
.project-name{font-size:.9rem;font-weight:600;margin-bottom:4px}
.project-desc{font-size:.75rem;color:var(--muted);margin-bottom:8px}
.project-tech{display:flex;flex-wrap:wrap;gap:4px}
.project-tech span{padding:2px 7px;background:var(--bg);border-radius:5px;font-size:.6rem;color:var(--muted)}
.contact{text-align:center;padding:50px 24px}
.contact h2{font-size:1.8rem;font-weight:700;margin-bottom:8px}
.contact p{color:var(--muted);margin-bottom:20px}
.contact-links{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
.contact-links a{padding:9px 18px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--text);text-decoration:none;font-size:.8rem;transition:.2s}
.contact-links a:hover{border-color:var(--accent)}
.footer{text-align:center;padding:20px;border-top:1px solid var(--border);color:var(--muted);font-size:.7rem}
</style>
</head>
<body>
<nav class="nav"><div class="nav-brand">👨‍💻 Dev</div><div class="nav-links"><a href="#skills">Skills</a><a href="#projects">Projetos</a><a href="#contact">Contato</a></div></nav>
<div class="hero">
<h1>Olá, eu sou o <span>Dev</span></h1>
<p>Full-stack developer & UI/UX enthusiast</p>
<div class="btns"><button class="btn p">Ver Projetos</button><button class="btn s">Contato</button></div>
</div>
<section id="skills"><h2 class="sec-title">Skills</h2><div class="skills"><div class="skill">JavaScript</div><div class="skill">TypeScript</div><div class="skill">React</div><div class="skill">Vue</div><div class="skill">Node.js</div><div class="skill">Python</div><div class="skill">PostgreSQL</div><div class="skill">Docker</div><div class="skill">AWS</div><div class="skill">Figma</div></div></section>
<section id="projects"><h2 class="sec-title">Projetos</h2><div class="projects">
<div class="project"><div class="project-img" style="background:linear-gradient(135deg,var(--accent),var(--pink))">🚀</div><div class="project-info"><div class="project-name">SaaS Dashboard</div><div class="project-desc">Painel analítico com métricas em tempo real</div><div class="project-tech"><span>React</span><span>Node.js</span><span>PostgreSQL</span></div></div></div>
<div class="project"><div class="project-img" style="background:linear-gradient(135deg,#22c55e,#3b82f6)">🛒</div><div class="project-info"><div class="project-name">E-commerce</div><div class="project-desc">Loja virtual com pagamento integrado</div><div class="project-tech"><span>Next.js</span><span>Stripe</span><span>MongoDB</span></div></div></div>
<div class="project"><div class="project-img" style="background:linear-gradient(135deg,#eab308,#ef4444)">📱</div><div class="project-info"><div class="project-name">App Mobile</div><div class="project-desc">Rede social para devs</div><div class="project-tech"><span>React Native</span><span>Firebase</span></div></div></div>
</div></section>
<div class="contact" id="contact"><h2>Vamos conversar?</h2><p>Estou disponível para projetos</p><div class="contact-links"><a href="#">📧 Email</a><a href="#">💼 LinkedIn</a><a href="#">🐙 GitHub</a></div></div>
<footer class="footer">© 2026 Dev</footer>
</body>
</html>
\`\`\`

Portfólio com hero, skills, projetos e contato. Pronto! 💼`;
}

// Funções auxiliares para outros tipos de site
function generateMedicalCode() { return generateGenericSite('site de clínica médica'); }
function generateRestaurantCode() { return generateGenericSite('site de restaurante'); }
function generateRealEstateCode() { return generateGenericSite('site imobiliário'); }
function generateGymCode() { return generateGenericSite('site de academia'); }
function generateEducationCode() { return generateGenericSite('site de educação'); }
function generatePetCode() { return generateGenericSite('site de pet shop'); }
function generateEventCode() { return generateGenericSite('site de eventos'); }
function generateNewsCode() { return generateGenericSite('site de notícias'); }
function generateAgencyCode() { return generateGenericSite('site de agência'); }
function generatePhotographyCode() { return generateGenericSite('site de fotografia'); }
function generateMusicCode() { return generateGenericSite('site de música'); }
function generateGameCode() { return generateGenericSite('site de jogos'); }
function generateFinanceCode() { return generateGenericSite('site financeiro'); }
function generateTravelCode() { return generateGenericSite('site de viagem'); }
function generateRecipeCode() { return generateGenericSite('site de receitas'); }

function generateFixedCode(allText, message) {
    // Detectar o tipo de app do contexto
    const project = null;
    if (allText.includes('venda') || allText.includes('loja') || allText.includes('ecommerce')) return generateStoreCode();
    if (allText.includes('dashboard') || allText.includes('painel')) return generateDashboardCode();
    if (allText.includes('landing') || allText.includes('página')) return generateLandingCode();
    if (allText.includes('tarefa') || allText.includes('kanban')) return generateTaskManagerCode();
    if (allText.includes('chat') || allText.includes('bate papo')) return generateChatCode();
    if (allText.includes('blog')) return generateBlogCode();
    if (allText.includes('portfólio') || allText.includes('portfolio')) return generatePortfolioCode();
    return generateGenericSite('corrigir app');
}

function generateEnhancedCode(allText, message) {
    return generateFixedCode(allText, message);
}

function generateGenericSite(type) {
    const title = type.replace('site de ', '').replace('site ', '');
    return `Seu ${title}:

\`\`\`html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.charAt(0).toUpperCase() + title.slice(1)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a12;--card:#12121f;--border:#1e1e35;--text:#e8e8f0;--muted:#6b7280;--accent:#7c5cfc;--pink:#f472b6;--green:#22c55e}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--card)}
.nav-brand{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:20px}
.nav-links a{color:var(--muted);text-decoration:none;font-size:.85rem}
.nav-links a:hover{color:var(--text)}
.hero{min-height:80vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 24px;position:relative}
.hero::before{content:'';position:absolute;top:40%;left:50%;width:500px;height:500px;background:radial-gradient(circle,rgba(124,92,252,.12),transparent 70%);transform:translate(-50%,-50%)}
.badge{display:inline-block;padding:5px 14px;background:rgba(124,92,252,.1);border:1px solid rgba(124,92,252,.3);border-radius:20px;font-size:.75rem;color:var(--accent);margin-bottom:20px}
.hero h1{font-size:clamp(2rem,5vw,3.5rem);font-weight:800;line-height:1.1;margin-bottom:16px;max-width:600px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{font-size:1.05rem;color:var(--muted);max-width:500px;margin-bottom:30px;line-height:1.6}
.btns{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
.btn{padding:12px 28px;border-radius:10px;font-size:.9rem;font-weight:600;cursor:pointer;border:none;transition:.3s}
.btn.p{background:var(--accent);color:#fff}
.btn.p:hover{background:#6a4ee8;transform:translateY(-2px);box-shadow:0 6px 24px rgba(124,92,252,.35)}
.btn.s{background:var(--card);color:var(--text);border:1px solid var(--border)}
.btn.s:hover{border-color:var(--accent)}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;padding:60px 24px;max-width:1000px;margin:0 auto}
.feature{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;transition:.3s}
.feature:hover{border-color:var(--accent);transform:translateY(-3px)}
.feature .icon{font-size:2rem;margin-bottom:12px}
.feature h3{margin-bottom:8px;font-size:1rem}
.feature p{color:var(--muted);font-size:.85rem;line-height:1.5}
.cta{text-align:center;padding:60px 24px;background:radial-gradient(circle,rgba(124,92,252,.06),transparent 60%)}
.cta h2{font-size:2rem;margin-bottom:10px}
.cta p{color:var(--muted);margin-bottom:24px}
.footer{text-align:center;padding:24px;border-top:1px solid var(--border);color:var(--muted);font-size:.75rem}
</style>
</head>
<body>
<nav class="nav">
<div class="nav-brand">🐦 ${title.charAt(0).toUpperCase() + title.slice(1)}</div>
<div class="nav-links"><a href="#">Início</a><a href="#">Sobre</a><a href="#">Serviços</a><a href="#">Contato</a></div>
</nav>
<div class="hero">
<div class="badge">✨ Bem-vindo</div>
<h1>Soluções <span>incríveis</span> para você</h1>
<p>Oferecemos as melhores soluções com qualidade e tecnologia avançada.</p>
<div class="btns"><button class="btn p">Começar Agora</button><button class="btn s">Saiba Mais</button></div>
</div>
<div class="features">
<div class="feature"><div class="icon">⚡</div><h3>Rápido</h3><p>Soluções ágeis e eficientes para seu negócio.</p></div>
<div class="feature"><div class="icon">🔒</div><h3>Seguro</h3><p>Infraestrutura segura e confiável.</p></div>
<div class="feature"><div class="icon">🎯</div><h3>Preciso</h3><p>Resultados exatos que você precisa.</p></div>
</div>
<div class="cta"><h2>Pronto para começar?</h2><p>Entre em contato conosco</p><button class="btn p" style="font-size:1rem;padding:14px 36px">Fale Conosco →</button></div>
<footer class="footer">© 2026 ${title.charAt(0).toUpperCase() + title.slice(1)}. Todos os direitos reservados.</footer>
</body>
</html>
\`\`\`

Site criado! Quer adicionar algo mais ou mudar algo? 🚀`;
}

function generateWhatsAppBotCode() {
    return `WhatsApp Bot com Baileys - Projeto completo:

\`\`\`json
{
  "name": "whatsapp-bot",
  "version": "1.0.0",
  "description": "Bot WhatsApp com Baileys",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.16",
    "pino": "^9.6.0",
    "qrcode-terminal": "^0.12.0"
  }
}
\`\`\`

\`\`\`javascript
// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const logger = pino({ level: 'silent' });

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Escaneie o QR Code:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada:', lastDisconnect?.error?.output?.statusCode);
            if (shouldReconnect) startBot();
        }
        
        if (connection === 'open') {
            console.log('Bot conectado com sucesso!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            
            console.log(\`Mensagem de \${from}: \${text}\`);
            
            // Comandos
            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(from, { text: '🏓 Pong!' });
            }
            
            if (text.toLowerCase() === '!menu') {
                await sock.sendMessage(from, { 
                    text: \`*📋 MENU*
                    
!ping - Testar bot
!menu - Ver este menu
!info - Sobre o bot
!sticker - Criar sticker (envie imagem)\`
                });
            }
            
            if (text.toLowerCase() === '!info') {
                await sock.sendMessage(from, { 
                    text: \`*🤖 Bot WhatsApp*
Versão: 1.0.0
Criado com: Baileys
Status: Online ✓\`
                });
            }
            
            if (text.toLowerCase() === '!sticker' && msg.message.imageMessage) {
                const buffer = await sock.downloadMediaMessage(msg);
                await sock.sendMessage(from, { 
                    sticker: buffer 
                });
            }
        }
    });
}

startBot().catch(console.error);
\`\`\`

\`\`\`bash
# Como rodar:
# 1. Instalar dependências
npm install

# 2. Iniciar o bot
npm start

# 3. Escanear QR Code com WhatsApp

# 4. Pronto! Bot rodando
\`\`\`

Projeto criado! Copie os arquivos e rode \`npm start\` 🚀`;
}

function generateDiscordBotCode() {
    return `Bot Discord com Discord.js - Projeto completo:

\`\`\`json
{
  "name": "discord-bot",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "discord.js": "^14.16.3",
    "dotenv": "^16.4.7"
  }
}
\`\`\`

\`\`\`javascript
// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', () => {
    console.log(\`✅ Bot online como \${client.user.tag}\`);
    client.user.setActivity('!help | Sou incrível', { type: 'WATCHING' });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;
    
    const args = message.content.slice(1).split(' ');
    const command = args.shift().toLowerCase();
    
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#7c5cfc')
            .setTitle('📋 Comandos')
            .setDescription('Lista de todos os comandos')
            .addFields(
                { name: '!ping', value: 'Ver latência do bot' },
                { name: '!info', value: 'Informações do servidor' },
                { name: '!user [@user]', value: 'Info de um usuário' },
                { name: '!clear [n]', value: 'Limpar mensagens' },
                { name: '!embed', value: 'Demo embed bonito' }
            )
            .setTimestamp();
        
        message.reply({ embeds: [embed] });
    }
    
    if (command === 'ping') {
        const sent = await message.reply('🏓 Calculando...');
        sent.edit(\`🏓 Pong! Latência: \${sent.createdTimestamp - message.createdTimestamp}ms\`);
    }
    
    if (command === 'info') {
        const embed = new EmbedBuilder()
            .setColor('#22c55e')
            .setTitle(\`📊 \${message.guild.name}\`)
            .addFields(
                { name: 'Membros', value: \`\${message.guild.memberCount}\`, inline: true },
                { name: 'Criado em', value: \`<t:\${Math.floor(message.guild.createdTimestamp / 1000)}:R>\`, inline: true },
                { name: 'Dono', value: \`<@\${message.guild.ownerId}>\`, inline: true }
            );
        message.reply({ embeds: [embed] });
    }
    
    if (command === 'user') {
        const member = message.mentions.members.first() || message.member;
        const embed = new EmbedBuilder()
            .setColor('#f472b6')
            .setTitle(\`👤 \${member.user.tag}\`)
            .setThumbnail(member.user.displayAvatarURL())
            .addFields(
                { name: 'ID', value: member.id, inline: true },
                { name: 'Entrou em', value: \`<t:\${Math.floor(member.joinedTimestamp / 1000)}:R>\`, inline: true },
                { name: 'Cargo', value: \`\${member.roles.cache.size - 1} cargos\`, inline: true }
            );
        message.reply({ embeds: [embed] });
    }
    
    if (command === 'clear') {
        const amount = parseInt(args[0]) || 10;
        await message.channel.bulkDelete(amount + 1);
        const msg = await message.channel.send(\`🧹 \${amount} mensagens limpas!\`);
        setTimeout(() => msg.delete(), 3000);
    }
    
    if (command === 'embed') {
        const embed = new EmbedBuilder()
            .setColor('#7c5cfc')
            .setTitle('✨ Embed Incrível')
            .setDescription('Um exemplo de embed bonito!')
            .addFields(
                { name: 'Campo 1', value: 'Valor 1', inline: true },
                { name: 'Campo 2', value: 'Valor 2', inline: true }
            )
            .setImage('https://picsum.photos/400/200')
            .setTimestamp()
            .setFooter({ text: 'Bot criado por Corvo Coder' });
        
        message.reply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
\`\`\`

\`\`\`bash
# .env
DISCORD_TOKEN=seu_token_aqui
\`\`\`

\`\`\`bash
# Como rodar:
# 1. Copie o .env e coloque seu token
# 2. npm install
# 3. npm start
# 4. Use !help no Discord
\`\`\`

Bot criado! 🚀`;
}

function generateTelegramBotCode() {
    return `Bot Telegram com node-telegram-bot-api:

\`\`\`json
{
  "name": "telegram-bot",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "node-telegram-bot-api": "^0.66.0",
    "dotenv": "^16.4.7"
  }
}
\`\`\`

\`\`\`javascript
// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

console.log('🤖 Bot Telegram iniciado!');

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        \`Olá \${msg.from.first_name}! 👋\\n\\nSou seu bot. Use /help para ver os comandos.\`
    );
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        \`📋 *Comandos:*\\n\\n\` +
        \`/start - Iniciar bot\\n\` +
        \`/help - Ver ajuda\\n\` +
        \`/info - Info do chat\\n\` +
        \`/echo [texto] - Repetir texto\\n\` +
        \`/random - Número aleatório\`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/info/, (msg) => {
    const info = [
        \`📱 Chat ID: \${msg.chat.id}\`,
        \`👤 Usuário: \${msg.from.first_name} \${msg.from.last_name || ''}\`,
        \`🆔 User ID: \${msg.from.id}\`,
        \`📝 Username: @\${msg.from.username || 'N/A'}\`
    ].join('\\n');
    bot.sendMessage(msg.chat.id, info);
});

bot.onText(/\/echo (.+)/, (msg, match) => {
    bot.sendMessage(msg.chat.id, match[1]);
});

bot.onText(/\/random/, (msg) => {
    const num = Math.floor(Math.random() * 100) + 1;
    bot.sendMessage(msg.chat.id, \`🎲 Número aleatório: \${num}\`);
});

bot.on('message', (msg) => {
    if (msg.text?.startsWith('/')) return;
    console.log(\`Mensagem de \${msg.from.first_name}: \${msg.text}\`);
});
\`\`\`

\`\`\`bash
# .env
TELEGRAM_TOKEN=seu_token_do_botfather
\`\`\`

Bot criado! Pegue o token com @BotFather no Telegram 🚀`;
}

function generateAPICode() {
    return `API REST com Express.js - Projeto completo:

\`\`\`json
{
  "name": "api-rest",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.21.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.9"
  }
}
\`\`\`

\`\`\`javascript
// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let users = [
    { id: '1', name: 'João', email: 'joao@email.com', role: 'admin' },
    { id: '2', name: 'Maria', email: 'maria@email.com', role: 'user' }
];

// GET - Listar todos
app.get('/api/users', (req, res) => {
    res.json({ success: true, data: users, total: users.length });
});

// GET - Buscar por ID
app.get('/api/users/:id', (req, res) => {
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, data: user });
});

// POST - Criar
app.post('/api/users', (req, res) => {
    const { name, email, role } = req.body;
    if (!name || !email) {
        return res.status(400).json({ success: false, error: 'Nome e email são obrigatórios' });
    }
    const newUser = { id: uuidv4(), name, email, role: role || 'user' };
    users.push(newUser);
    res.status(201).json({ success: true, data: newUser });
});

// PUT - Atualizar
app.put('/api/users/:id', (req, res) => {
    const index = users.findIndex(u => u.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Não encontrado' });
    
    users[index] = { ...users[index], ...req.body, id: req.params.id };
    res.json({ success: true, data: users[index] });
});

// DELETE - Remover
app.delete('/api/users/:id', (req, res) => {
    const index = users.findIndex(u => u.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Não encontrado' });
    
    users.splice(index, 1);
    res.json({ success: true, message: 'Removido com sucesso' });
});

// Busca com filtro
app.get('/api/search', (req, res) => {
    const { q, role } = req.query;
    let results = users;
    if (q) results = results.filter(u => u.name.toLowerCase().includes(q.toLowerCase()));
    if (role) results = results.filter(u => u.role === role);
    res.json({ success: true, data: results });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
    console.log(\`🚀 API rodando em http://localhost:\${PORT}\`);
});
\`\`\`

\`\`\`bash
# Como rodar:
npm install
npm start

# Testar:
# GET    http://localhost:3000/api/users
# POST   http://localhost:3000/api/users
# PUT    http://localhost:3000/api/users/1
# DELETE http://localhost:3000/api/users/1
\`\`\`

API criada! 🚀`;
}

// === FETCH WEBSITE CONTENT ===
function fetchWebsite(url) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 15000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) {
                    const u = new URL(url);
                    redirectUrl = u.origin + redirectUrl;
                }
                return fetchWebsite(redirectUrl).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function extractSiteInfo(html) {
    let clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const title = (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || '';
    const metas = [...html.matchAll(/<meta[^>]*(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']+)["']/gi)]
        .map(m => `${m[1]}: ${m[2]}`).join('\n');
    const headings = [...html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi)]
        .map(h => `H${h[1]}: ${h[2].replace(/<[^>]+>/g, '')}`).join('\n');
    const nav = (html.match(/<nav[\s\S]*?<\/nav>/i) || [])[0] || '';
    const navLinks = [...nav.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)]
        .map(a => `${a[1]} → ${a[2].replace(/<[^>]+>/g, '').trim()}`).join('\n');
    const images = [...html.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi)]
        .slice(0, 20).map(i => `${i[1]} ${i[2] ? '(' + i[2] + ')' : ''}`).join('\n');
    const colors = [...new Set([...html.matchAll(/(?:background-color|color|background):\s*([^;}{]+)/gi)]
        .map(c => c[1].trim()).filter(c => c && !c.startsWith('var(') && c.length < 30))].slice(0, 15).join(', ');
    const classes = [...new Set([...html.matchAll(/class=["']([^"']+)["']/gi)]
        .flatMap(c => c[1].split(/\s+/)))].slice(0, 50).join(', ');

    return `## ANÁLISE DO SITE: ${title}
### METADADOS
${metas || '(nenhum)'}

### ESTRUTURA DE CONTEÚDO
${headings || '(sem headings)'}

### NAVEGAÇÃO
${navLinks || '(sem nav)'}

### IMAGENS PRINCIPAIS
${images || '(sem imagens)'}

### CORES IDENTIFICADAS
${colors || '(não identificadas)'}

### CLASSES CSS PRINCIPAIS
${classes}

### HTML COMPLETO (sem scripts/estilos)
${clean.substring(0, 30000)}`;
}

app.post('/api/chat', optionalAuth, async (req, res) => {
    const { message, history, images, audio, queuedMessages, chatId } = req.body;
    if (!message && (!images || !images.length) && (!audio || !audio.data)) {
        return res.status(400).json({ error: 'Mensagem obrigatória' });
    }

    // Check credits for logged-in users on free plan
    if (req.user && req.user.plan !== 'pro' && req.user.plan !== 'enterprise' && req.user.credits < 1) {
        return res.status(402).json({ error: 'Créditos esgotados. Faça upgrade do seu plano.' });
    }

    let reply = null;
    let source = 'mock';
    let keyName = null;

    const userMessage = message || '';
    const hasMedia = (images?.length) || (audio?.data);

    // Detect URLs in message and fetch site content
    let siteContext = '';
    const urlMatches = userMessage.match(/https?:\/\/[^\s]+/g);
    if (urlMatches) {
        for (const url of urlMatches) {
            try {
                const html = await fetchWebsite(url);
                siteContext += '\n\n## CONTEÚDO DO SITE (' + url + '):\n' + extractSiteInfo(html);
            } catch (e) {
                siteContext += '\n\n(Não foi possível acessar: ' + url + ' - ' + e.message + ')';
            }
        }
    }

    // Build parts for Gemini (multimodal)
    let promptText = SYSTEM_PROMPT;

    // Inject user identity so the AI knows who it's talking to
    if (req.user) {
        promptText += `\n\n## USUÁRIO ATUAL
Nome: ${req.user.name}
Email: ${req.user.email}
Plano: ${req.user.plan || 'free'}
Créditos restantes: ${req.user.plan === 'pro' || req.user.plan === 'enterprise' ? 'ilimitados' : req.user.credits}
Converse com ele pelo primeiro nome. Use o nome dele nas respostas quando apropriado.`;
    }

    // Injeta os arquivos atuais do projeto como contexto para o Gemini saber de alterações manuais
    if (chatId) {
        try {
            const projectFiles = db.getChatFiles(chatId) || {};
            if (Object.keys(projectFiles).length > 0) {
                promptText += '\n\n## CÓDIGO FONTE ATUAL DO PROJETO (pode conter alterações manuais do usuário que você deve manter e respeitar):\n';
                for (const [filePath, file] of Object.entries(projectFiles)) {
                    if (file && typeof file.content === 'string') {
                        promptText += `\n### Arquivo: ${filePath}\n\`\`\`\n${file.content}\n\`\`\`\n`;
                    }
                }
            }
        } catch (dbErr) {
            console.error('Erro ao ler arquivos do chat para o prompt:', dbErr.message);
        }
    }

    if (siteContext) {
        promptText += '\n\n' + siteContext + '\n\nO usuário enviou um link de site acima. Analise a estrutura, design, cores, layout e conteúdo. Use isso como referência para criar algo similar.';
    }
    if (userMessage) {
        promptText += '\n\nUsuário: ' + userMessage;
    } else if (hasMedia) {
        promptText += '\n\nO usuário enviou mídia. Analise e responda.';
    }

    // Append queued follow-up messages for context continuity
    if (queuedMessages && queuedMessages.length > 0) {
        promptText += '\n\n## MENSAGENS ADICIONAIS DO USUÁRIO (agregadas enquanto você processava):';
        for (let i = 0; i < queuedMessages.length; i++) {
            promptText += '\nUsuário (mensagem ' + (i + 1) + '): ' + queuedMessages[i];
        }
        promptText += '\n\nIMPORTANTE: Leve em conta TODAS as mensagens acima. O usuário foi adicionando pedidos enquanto você trabalhava. Consolide tudo em uma resposta única e completa.';
    }
    const systemParts = [{ text: promptText }];
    if (images?.length) {
        for (const img of images) {
            systemParts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
        }
    }
    if (audio?.data) {
        systemParts.push({ inlineData: { mimeType: audio.mimeType || 'audio/mp3', data: audio.data } });
    }

    // Key rotation
    const result = await callGeminiWithRotation(systemParts, history);
    if (result.text) {
        reply = result.text;
        source = 'gemini';
        keyName = result.keyName;
    }

    if (!reply) {
        reply = getMockResponse(userMessage || 'usuário enviou mídia', history);
    }

    // Deduz créditos baseado em tokens reais consumidos (plano free, usuários logados)
    let creditsUsed = 0;
    let creditsLeft = req.user ? req.user.credits : null;
    const outputTokens = result.outputTokens || Math.ceil((reply || '').length / 4);
    const files = parseFilesFromReply(reply);
    const hasFiles = Object.keys(files).length > 0;

    if (req.user && req.user.plan !== 'pro' && req.user.plan !== 'enterprise') {
        const creditResult = db.useCreditsForTokens(req.user.id, outputTokens, hasFiles);
        creditsUsed = creditResult.cost || 1;
        creditsLeft = creditResult.credits;
    }

    if (hasFiles) {
        const msgOnly = reply.replace(/```\w+\n(?:\/\*\s*.+?\s*\*\/\n)?[\s\S]*?```/g, '').trim() || 'Projeto criado com sucesso! ✓';
        if (chatId) {
            db.addMessage(chatId, 'user', userMessage || (hasMedia ? '[Mídia enviada]' : ''));
            db.addMessage(chatId, 'assistant', msgOnly, { filesJson: JSON.stringify(files), code: reply, type: 'web', source });
            db.mergeChatFiles(chatId, files);
        }
        return res.json({ reply: msgOnly, files, type: 'web', source, creditsUsed, creditsLeft });
    }

    if (chatId) {
        db.addMessage(chatId, 'user', userMessage || (hasMedia ? '[Mídia enviada]' : ''));
        db.addMessage(chatId, 'assistant', reply, { source });
    }

    res.json({ reply, source, creditsUsed, creditsLeft });
});

// === CHAT DATABASE API ===

// Optional auth — does not reject, just sets req.user if token is valid
function optionalAuth(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.cc_token;
    if (token) {
        const session = db.getSession(token);
        if (session) {
            req.user = session;
            req.token = token;
        }
    }
    next();
}

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.cc_token;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const session = db.getSession(token);
    if (!session) return res.status(401).json({ error: 'Sessão expirada' });
    req.user = session;
    req.token = token;
    next();
}

// === AUTH API ===
app.post('/api/auth/register', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const result = db.register(name, email, password);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
    const result = db.login(email, password);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
    db.logout(req.token);
    res.json({ success: true });
});

app.post('/api/auth/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });
    const user = db.getUserByEmail(email);
    if (user) {
        const token = db.createPasswordReset(user.id);
        const resetLink = `http://localhost:3000/pages/reset-password.html?token=${token}`;
        console.log(`\n🔑 [RECUPERAÇÃO DE SENHA] Link para ${email}:\n🔗 ${resetLink}\n`);
    }
    res.json({ success: true, message: 'Se o e-mail existir, um link de recuperação foi enviado. (Verifique o terminal do console)' });
});

app.post('/api/auth/reset-password', (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token e senha obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const reset = db.getPasswordReset(token);
    if (!reset) return res.status(400).json({ error: 'Token inválido ou expirado' });
    db.updatePassword(reset.user_id, password);
    db.usePasswordReset(token);
    res.json({ success: true, message: 'Senha redefinida com sucesso' });
});

app.get('/api/auth/google-client-id', (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/google', (req, res) => {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Credential obrigatório' });
    try {
        const parts = credential.split('.');
        if (parts.length !== 3) return res.status(400).json({ error: 'Credential inválido' });
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        const email = payload.email;
        const name = payload.name || email.split('@')[0];
        if (!email) return res.status(400).json({ error: 'Email não encontrado no credential' });

        let user = db.getUserByEmail(email);
        if (!user) {
            const result = db.register(name, email, crypto.randomBytes(16).toString('hex'));
            if (result.error) return res.status(400).json({ error: result.error });
            user = { id: result.user.id, name: result.user.name, email: result.user.email, credits: result.user.credits };
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, credits: user.credits } });
    } catch (err) {
        res.status(400).json({ error: 'Erro ao processar credential Google' });
    }
});

app.get('/api/auth/github', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) return res.status(400).json({ error: 'GitHub OAuth não configurado' });
    const redirectUri = (req.headers.origin || 'http://localhost:3000') + '/api/auth/github/callback';
    const scope = 'read:user user:email';
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`);
});

app.get('/api/auth/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/pages/login.html?error=github_cancelled');
    try {
        const clientId = process.env.GITHUB_CLIENT_ID;
        const clientSecret = process.env.GITHUB_CLIENT_SECRET;
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error) return res.redirect('/pages/login.html?error=github_failed');

        const userRes = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'User-Agent': 'Corvo-Coder' }
        });
        const ghUser = await userRes.json();

        const emailRes = await fetch('https://api.github.com/user/emails', {
            headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'User-Agent': 'Corvo-Coder' }
        });
        const emails = await emailRes.json();
        const email = (emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0])?.email;
        if (!email) return res.redirect('/pages/login.html?error=no_email');

        const name = ghUser.name || ghUser.login;
        let user = db.getUserByEmail(email);
        if (!user) {
            const result = db.register(name, email, crypto.randomBytes(16).toString('hex'));
            if (result.error) return res.redirect('/pages/login.html?error=' + encodeURIComponent(result.error));
            user = { id: result.user.id, name: result.user.name, email: result.user.email, credits: result.user.credits };
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(sessionToken, user.id, expiresAt);

        const userData = encodeURIComponent(JSON.stringify({ id: user.id, name: user.name, email: user.email, credits: user.credits }));
        res.redirect(`/index.html?token=${sessionToken}&user=${userData}`);
    } catch (err) {
        res.redirect('/pages/login.html?error=github_failed');
    }
});

app.get('/api/chats', authMiddleware, (req, res) => {
    const chats = db.listChats(req.user.id);
    res.json({ chats });
});

app.post('/api/chats', authMiddleware, (req, res) => {
    const { title } = req.body;
    const chatId = db.createChat(req.user.id, title || 'Nova Conversa');
    res.json({ id: chatId });
});

app.get('/api/chats/:id', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    const messages = db.getMessages(chat.id);
    const files = db.getChatFiles(chat.id);
    res.json({ chat, messages, files });
});

app.put('/api/chats/:id', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    const { title } = req.body;
    if (title) db.updateChatTitle(chat.id, title);
    res.json({ success: true });
});

app.delete('/api/chats/:id', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    db.deleteChat(chat.id);
    res.json({ success: true });
});

app.post('/api/chats/:id/messages', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    const { role, content, filesJson, code, type, source, hasImages, hasAudio } = req.body;
    const msgId = db.addMessage(chat.id, role, content, { filesJson, code, type, source, hasImages, hasAudio });
    res.json({ id: msgId });
});

app.post('/api/chats/:id/files', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    const { files } = req.body;
    const merged = db.mergeChatFiles(chat.id, files);
    res.json({ files: merged });
});

app.get('/api/chats/:id/files', authMiddleware, (req, res) => {
    const chat = db.getChat(parseInt(req.params.id));
    if (!chat || chat.user_id !== req.user.id) return res.status(404).json({ error: 'Chat não encontrado' });
    const files = db.getChatFiles(chat.id);
    res.json({ files });
});

app.get('/api/credits', authMiddleware, (req, res) => {
    const credits = db.getCredits(req.user.id);
    res.json({ credits });
});

app.put('/api/credits', authMiddleware, (req, res) => {
    const { credits } = req.body;
    db.setCredits(req.user.id, credits);
    res.json({ success: true });
});

// === ADMIN AUTH MIDDLEWARE ===
function adminAuth(req, res, next) {
    const token = req.headers['x-admin-pass'] || req.query.pass;
    if (token !== ADMIN_PASS) return res.status(401).json({ error: 'Acesso negado' });
    next();
}

// === API KEY MANAGEMENT (admin) ===
app.get('/api/keys', adminAuth, (req, res) => {
    const keys = getAllKeysWithState();
    const totalReqs = keys.reduce((s, k) => s + k.requests, 0);
    const totalErrs = keys.reduce((s, k) => s + k.errors, 0);
    res.json({
        keys: keys.map(k => ({ ...k, key: undefined })),
        total: keys.length, active: keys.filter(k => k.enabled).length,
        totalRequests: totalReqs, totalErrors: totalErrs,
        currentIndex: loadState().currentIndex
    });
});

app.put('/api/keys/:id/toggle', adminAuth, (req, res) => {
    const { enabled } = req.body;
    setKeyState(parseInt(req.params.id), { enabled: !!enabled });
    res.json({ success: true });
});

app.post('/api/keys/:id/test', adminAuth, async (req, res) => {
    const envKeys = loadEnvKeys();
    const keyObj = envKeys.find(k => k.id === parseInt(req.params.id));
    if (!keyObj) return res.status(404).json({ error: 'Chave não encontrada' });
    try {
        const genAI = new GoogleGenerativeAI(keyObj.key);
        const mdl = genAI.getGenerativeModel({ model: keyObj.model });
        const result = await mdl.generateContent('Responda apenas: OK');
        setKeyState(keyObj.id, { errors: 0, lastError: null });
        res.json({ success: true, response: result.response.text().substring(0, 100) });
    } catch (err) {
        markKeyFailed(keyObj.id, err.message);
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/keys/stats', adminAuth, (req, res) => {
    const keys = getAllKeysWithState();
    res.json({
        totalKeys: keys.length, activeKeys: keys.filter(k => k.enabled).length,
        totalRequests: keys.reduce((s, k) => s + k.requests, 0),
        totalErrors: keys.reduce((s, k) => s + k.errors, 0)
    });
});

app.post('/api/keys', adminAuth, (req, res) => {
    const { name, key, model } = req.body;
    if (!key) return res.status(400).json({ error: 'API Key obrigatória' });
    const keys = loadEnvKeys();
    const maxId = keys.reduce((max, k) => Math.max(max, k.id), 0);
    const newKey = { id: maxId + 1, name: name || 'Key ' + (maxId + 1), key, model: model || 'gemini-2.0-flash' };
    keys.push(newKey);
    saveEnvKeys(keys);
    res.json({ success: true, id: newKey.id });
});

app.delete('/api/keys/:id', adminAuth, (req, res) => {
    const keys = loadEnvKeys();
    const filtered = keys.filter(k => k.id !== parseInt(req.params.id));
    if (filtered.length === keys.length) return res.status(404).json({ error: 'Chave não encontrada' });
    saveEnvKeys(filtered);
    res.json({ success: true });
});

// === AGENT API ===
const agent = require('./agent/agent');

app.get('/api/agent/status', adminAuth, (req, res) => res.json(agent.getStatus()));
app.get('/api/agent/metrics', adminAuth, (req, res) => res.json(agent.getMetrics()));
app.get('/api/agent/logs', adminAuth, (req, res) => res.json(agent.logs.slice(0, parseInt(req.query.limit) || 50)));
app.get('/api/agent/alerts', adminAuth, (req, res) => res.json(agent.alerts.slice(0, parseInt(req.query.limit) || 20)));
app.get('/api/agent/users', adminAuth, (req, res) => res.json(agent.getUsers()));
app.get('/api/agent/actions', adminAuth, (req, res) => res.json(agent.actions.slice(0, 20)));
app.get('/api/agent/decisions', adminAuth, (req, res) => res.json(agent.decisions.slice(0, 20)));
app.put('/api/agent/config', adminAuth, (req, res) => res.json(agent.updateConfig(req.body)));
app.post('/api/agent/command', adminAuth, (req, res) => res.json(agent.processCommand(req.body.command || '')));
app.get('/api/agent/action/:action', adminAuth, (req, res) => agent.executeAction(req.params.action, req.query).then(r => res.json(r)));

// === MAIN ROUTES ===
app.get('/api/health', (req, res) => {
    const keys = getAllKeysWithState();
    const hasAI = keys.some(k => k.enabled);
    res.json({ status: 'ok', ai: hasAI, agent: 'online', keys: keys.length, activeKeys: keys.filter(k => k.enabled).length });
});

// === STRIPE PAYMENT ENDPOINTS ===
app.get('/api/stripe/config', (req, res) => {
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null, available: !!stripe });
});

app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe não configurado' });
    const { plan } = req.body;
    if (!plan || !['pro', 'enterprise'].includes(plan)) return res.status(400).json({ error: 'Plano inválido' });

    const prices = {
        pro: { amount: 4900, name: 'Corvo Coder Pro', interval: 'month' },
        enterprise: { amount: 19900, name: 'Corvo Coder Enterprise', interval: 'month' }
    };
    const p = prices[plan];

    try {
        // Create or retrieve Stripe customer
        let customerId = req.user.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: req.user.email,
                name: req.user.name,
                metadata: { user_id: req.user.id }
            });
            customerId = customer.id;
            db.setStripeIds(req.user.id, customerId, null);
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'brl',
                    product_data: { name: p.name },
                    unit_amount: p.amount,
                    recurring: { interval: p.interval }
                },
                quantity: 1
            }],
            metadata: { user_id: req.user.id, plan },
            success_url: `${req.protocol}://${req.get('host')}/pages/billing.html?success=true&plan=${plan}`,
            cancel_url: `${req.protocol}://${req.get('host')}/pages/billing.html?cancelled=true`
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe checkout error:', err.message);
        res.status(500).json({ error: 'Erro ao criar sessão de pagamento' });
    }
});

app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe não configurado' });
    const customerId = req.user.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'Nenhuma assinatura encontrada' });

    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${req.protocol}://${req.get('host')}/pages/billing.html`
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe portal error:', err.message);
        res.status(500).json({ error: 'Erro ao abrir portal de pagamento' });
    }
});

// === USER SETTINGS API ===
app.put('/api/user/profile', authMiddleware, (req, res) => {
    const { name, email } = req.body;
    if (name) db.prepare('UPDATE users SET name = ?, updated_at = datetime("now") WHERE id = ?').run(name, req.user.id);
    if (email) db.prepare('UPDATE users SET email = ?, updated_at = datetime("now") WHERE id = ?').run(email, req.user.id);
    res.json({ success: true });
});
app.delete('/api/user/account', authMiddleware, (req, res) => {
    const userId = req.user.id;
    db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM files WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM chats WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true });
});
app.get('/api/chat', (req, res) => res.json({ reply: 'Use POST para enviar mensagens', source: 'info' }));

// Admin panel
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// === WHATSAPP FLOATING BTN ===
app.get('/api/config', (req, res) => {
    res.json({ whatsapp: process.env.WHATSAPP_NUMBER || null });
});

// === DEPLOY & PREVIEW SYSTEM ===
function flattenTree(obj, prefix = '') {
    const result = {};
    for (const [name, file] of Object.entries(obj)) {
        const path = prefix ? prefix + '/' + name : name;
        if (file.type === 'folder') {
            Object.assign(result, flattenTree(file.children || {}, path));
        } else {
            result[path] = { content: file.content || '' };
        }
    }
    return result;
}

app.get('/api/deploy/check', (req, res) => {
    res.json({ netlify: true, vercel: true, railway: true });
});

app.post('/api/deploy', (req, res) => {
    const { files, chatId } = req.body;
    if (!chatId) {
        global._guestFiles = files;
    }
    res.json({ url: `${req.protocol}://${req.get('host')}/preview/${chatId || 'guest'}/` });
});

app.post('/api/deploy/vercel', (req, res) => {
    const { files, chatId } = req.body;
    if (!chatId) {
        global._guestFiles = files;
    }
    res.json({ url: `${req.protocol}://${req.get('host')}/preview/${chatId || 'guest'}/` });
});

app.post('/api/deploy/railway', (req, res) => {
    const { files, chatId } = req.body;
    if (!chatId) {
        global._guestFiles = files;
    }
    res.json({ url: `${req.protocol}://${req.get('host')}/preview/${chatId || 'guest'}/` });
});

app.get('/preview/:chatId', (req, res) => {
    res.redirect(`/preview/${req.params.chatId}/`);
});

app.get('/preview/:chatId/*', (req, res) => {
    const chatId = req.params.chatId;
    let filePath = req.params[0] || 'index.html';
    
    let files;
    if (chatId === 'guest') {
        files = flattenTree(global._guestFiles || {});
    } else {
        files = db.getChatFiles(parseInt(chatId));
    }
    
    if (!files || Object.keys(files).length === 0) {
        return res.status(404).send('Nenhum arquivo encontrado para este projeto.');
    }
    
    const file = files[filePath];
    if (!file) {
        return res.status(404).send(`Arquivo "${filePath}" não encontrado no projeto.`);
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml'
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'text/plain');
    res.send(file.content);
});

// Catch-all for SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = app.listen(PORT, () => console.log(`\n🐦 Corvo Coder: http://localhost:${PORT}\n🤖 Agent: http://localhost:${PORT}/admin/\n`));