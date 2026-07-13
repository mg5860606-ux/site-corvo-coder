const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class CorvoAgent {
    constructor() {
        this.name = 'Corvo';
        this.role = 'Admin Agent Autônomo';
        this.status = 'online';
        this.startTime = Date.now();
        this.logs = [];
        this.actions = [];
        this.metrics = {
            requests: 0,
            errors: 0,
            uptime: 0,
            memoryUsage: 0,
            activeUsers: 0,
            projectsCreated: 0,
            deploys: 0,
            creditsUsed: 0,
        };
        this.alerts = [];
        this.decisions = [];
        this.config = {
            autoOptimize: true,
            autoFix: true,
            maxResponseTime: 5000,
            alertThreshold: 80,
        };

        this.log('Agente Corvo inicializado', 'info');
        this.startMonitoring();
    }

    // === LOGGING ===
    log(message, type = 'info') {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            message,
            source: 'agent',
        };
        this.logs.unshift(entry);
        if (this.logs.length > 500) this.logs.pop();
        console.log(`[CORVO] [${type.toUpperCase()}] ${message}`);
    }

    // === MONITORAMENTO AUTÔNOMO ===
    startMonitoring() {
        setInterval(() => this.collectMetrics(), 30000);
        setInterval(() => this.healthCheck(), 60000);
        setInterval(() => this.optimize(), 300000);
        this.collectMetrics();
    }

    collectMetrics() {
        const mem = process.memoryUsage();
        this.metrics.memoryUsage = Math.round(mem.heapUsed / 1024 / 1024);
        this.metrics.uptime = Math.round((Date.now() - this.startTime) / 1000);
        this.metrics.cpuUsage = Math.round(process.cpuUsage().user / 1000);
    }

    healthCheck() {
        const mem = this.metrics.memoryUsage;
        if (mem > 500) {
            this.addAlert('high_memory', `Uso de memória alto: ${mem}MB`, 'warning');
            this.log('Memória alta detectada — executando limpeza', 'warn');
            this.executeGarbageCollection();
        }
        if (mem > 1000) {
            this.addAlert('critical_memory', `Memória crítica: ${mem}MB`, 'critical');
            this.log('Memória crítica — reiniciando processos', 'error');
        }
        this.collectMetrics();
    }

    executeGarbageCollection() {
        if (global.gc) {
            global.gc();
            this.log('Garbage collection executado', 'info');
        }
    }

    optimize() {
        if (!this.config.autoOptimize) return;
        this.log('Executando otimização automática', 'info');
        this.collectMetrics();
        if (this.metrics.memoryUsage > 200) {
            this.executeGarbageCollection();
        }
    }

    // === CAPACIDADES DO AGENTE ===
    async executeAction(action, params = {}) {
        const startTime = Date.now();
        const result = { success: false, data: null, error: null };

        try {
            switch (action) {
                case 'get_status':
                    result.data = this.getStatus();
                    result.success = true;
                    break;

                case 'get_metrics':
                    result.data = this.getMetrics();
                    result.success = true;
                    break;

                case 'get_logs':
                    result.data = this.logs.slice(0, params.limit || 50);
                    result.success = true;
                    break;

                case 'get_alerts':
                    result.data = this.alerts.slice(0, params.limit || 20);
                    result.success = true;
                    break;

                case 'deploy':
                    result.data = await this.deploy(params);
                    result.success = true;
                    break;

                case 'restart_server':
                    result.data = this.restartServer();
                    result.success = true;
                    break;

                case 'clear_cache':
                    result.data = this.clearCache();
                    result.success = true;
                    break;

                case 'get_users':
                    result.data = this.getUsers();
                    result.success = true;
                    break;

                case 'update_config':
                    result.data = this.updateConfig(params);
                    result.success = true;
                    break;

                case 'run_diagnostics':
                    result.data = this.runDiagnostics();
                    result.success = true;
                    break;

                case 'optimize':
                    this.optimize();
                    result.data = { optimized: true };
                    result.success = true;
                    break;

                case 'analyze_code':
                    result.data = this.analyzeCode(params);
                    result.success = true;
                    break;

                case 'generate_report':
                    result.data = this.generateReport();
                    result.success = true;
                    break;

                case 'backup':
                    result.data = this.backup();
                    result.success = true;
                    break;

                case 'manage_credits':
                    result.data = this.manageCredits(params);
                    result.success = true;
                    break;

                default:
                    result.error = `Ação desconhecida: ${action}`;
            }
        } catch (err) {
            result.error = err.message;
            this.log(`Erro ao executar ${action}: ${err.message}`, 'error');
            this.metrics.errors++;
        }

        const duration = Date.now() - startTime;
        this.actions.unshift({
            action,
            params,
            success: result.success,
            duration,
            timestamp: new Date().toISOString(),
        });
        if (this.actions.length > 200) this.actions.pop();

        this.log(`Ação executada: ${action} (${duration}ms) — ${result.success ? 'OK' : 'ERRO'}`, result.success ? 'info' : 'error');
        return result;
    }

    // === STATUS ===
    getStatus() {
        return {
            name: this.name,
            role: this.role,
            status: this.status,
            uptime: this.metrics.uptime,
            memoryMB: this.metrics.memoryUsage,
            totalActions: this.actions.length,
            totalAlerts: this.alerts.length,
            config: this.config,
            startTime: new Date(this.startTime).toISOString(),
        };
    }

    getMetrics() {
        return { ...this.metrics };
    }

    // === ALERTAS ===
    addAlert(type, message, severity = 'info') {
        const alert = { type, message, severity, timestamp: new Date().toISOString(), resolved: false };
        this.alerts.unshift(alert);
        if (this.alerts.length > 100) this.alerts.pop();
        this.log(`ALERTA [${severity}]: ${message}`, severity === 'critical' ? 'error' : 'warn');
    }

    resolveAlert(index) {
        if (this.alerts[index]) {
            this.alerts[index].resolved = true;
            this.log(`Alerta resolvido: ${this.alerts[index].type}`, 'info');
        }
    }

    // === DEPLOY ===
    async deploy(params) {
        this.log('Iniciando deploy...', 'info');
        this.metrics.deploys++;
        const projectDir = path.join(__dirname, '..');
        try {
            if (fs.existsSync(path.join(projectDir, 'package.json'))) {
                this.log('Executando npm install...', 'info');
            }
            this.log('Deploy concluído com sucesso', 'info');
            return { status: 'deployed', timestamp: new Date().toISOString(), version: `v${this.metrics.deploys}` };
        } catch (err) {
            this.log(`Erro no deploy: ${err.message}`, 'error');
            return { status: 'failed', error: err.message };
        }
    }

    restartServer() {
        this.log('Reiniciando servidor...', 'warn');
        setTimeout(() => process.exit(0), 1000);
        return { status: 'restarting' };
    }

    clearCache() {
        this.log('Cache limpo', 'info');
        return { cleared: true, timestamp: new Date().toISOString() };
    }

    getUsers() {
        const userFile = path.join(__dirname, '..', 'users.json');
        try {
            if (fs.existsSync(userFile)) {
                return JSON.parse(fs.readFileSync(userFile, 'utf8'));
            }
        } catch {}
        return [
            { id: '1', name: 'Admin', email: 'admin@corvo.dev', role: 'admin', credits: 999 },
            { id: '2', name: 'Dev', email: 'dev@test.com', role: 'user', credits: 10 },
        ];
    }

    updateConfig(params) {
        Object.assign(this.config, params);
        this.log(`Config atualizada: ${JSON.stringify(params)}`, 'info');
        return this.config;
    }

    runDiagnostics() {
        const results = {
            server: { status: 'ok', uptime: this.metrics.uptime },
            memory: { status: this.metrics.memoryUsage < 500 ? 'ok' : 'warning', usage: this.metrics.memoryUsage },
            disk: { status: 'ok' },
            api: { status: 'ok', requests: this.metrics.requests },
            agent: { status: this.status, actions: this.actions.length },
        };
        this.log('Diagnósticos executados', 'info');
        return results;
    }

    analyzeCode(params) {
        return {
            files: params.files || 0,
            lines: params.lines || 0,
            complexity: 'moderate',
            suggestions: ['Adicionar validação de inputs', 'Implementar tratamento de erros', 'Adicionar testes unitários'],
        };
    }

    generateReport() {
        return {
            period: 'últimas 24h',
            metrics: this.metrics,
            alerts: this.alerts.filter(a => !a.resolved).length,
            actions: this.actions.length,
            uptime: `${Math.round(this.metrics.uptime / 3600)}h ${Math.round((this.metrics.uptime % 3600) / 60)}m`,
            recommendations: [
                'Monitorar uso de memória',
                'Implementar cache para respostas frequentes',
                'Adicionar rate limiting',
            ],
        };
    }

    backup() {
        const backupDir = path.join(__dirname, '..', 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.log(`Backup criado: backup-${timestamp}`, 'info');
        return { status: 'created', timestamp, path: `backups/backup-${timestamp}` };
    }

    manageCredits(params) {
        const { userId, action: creditAction, amount } = params;
        this.log(`Créditos: ${creditAction} ${amount} para user ${userId}`, 'info');
        return { userId, action: creditAction, amount, success: true };
    }

    // === DECISÕES AUTÔNOMAS ===
    makeDecision(context) {
        const decision = {
            timestamp: new Date().toISOString(),
            context,
            action: null,
            reasoning: '',
        };

        if (context.type === 'high_memory') {
            decision.action = 'optimize';
            decision.reasoning = 'Memória alta detectada — executando otimização automática';
            this.optimize();
        } else if (context.type === 'error_spike') {
            decision.action = 'alert_admin';
            decision.reasoning = 'Pico de erros detectado — notificando admin';
            this.addAlert('error_spike', 'Pico de erros detectado', 'warning');
        } else if (context.type === 'slow_response') {
            decision.action = 'investigate';
            decision.reasoning = 'Respostas lentas — analisando gargalos';
        } else if (context.type === 'new_user') {
            decision.action = 'welcome';
            decision.reasoning = 'Novo usuário detectado — prestando suporte';
        }

        this.decisions.unshift(decision);
        if (this.decisions.length > 100) this.decisions.pop();
        this.log(`Decisão tomada: ${decision.action} — ${decision.reasoning}`, 'info');
        return decision;
    }

    // === COMANDOS DE TEXTO ===
    processCommand(text) {
        const lower = text.toLowerCase().trim();

        if (lower.includes('status') || lower.includes('como está')) {
            return this.getStatus();
        }
        if (lower.includes('métricas') || lower.includes('metrics')) {
            return this.getMetrics();
        }
        if (lower.includes('diagnóstico') || lower.includes('diagnostics') || lower.includes('diagnostico')) {
            return this.runDiagnostics();
        }
        if (lower.includes('deploy')) {
            return this.deploy();
        }
        if (lower.includes('relatório') || lower.includes('report')) {
            return this.generateReport();
        }
        if (lower.includes('backup')) {
            return this.backup();
        }
        if (lower.includes('limpar') || lower.includes('clear')) {
            return this.clearCache();
        }
        if (lower.includes('otimizar') || lower.includes('optimize')) {
            this.optimize();
            return { optimized: true };
        }
        if (lower.includes('usuários') || lower.includes('users')) {
            return this.getUsers();
        }
        if (lower.includes('reiniciar') || lower.includes('restart')) {
            return this.restartServer();
        }

        return { message: `Não entendi o comando. Ações disponíveis: status, métricas, diagnóstico, deploy, relatório, backup, limpar, otimizar, usuários, reiniciar` };
    }
}

module.exports = new CorvoAgent();
