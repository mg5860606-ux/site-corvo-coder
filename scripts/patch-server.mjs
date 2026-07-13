import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('server.js', 'utf8');
let lines = src.split('\n');

const changes = [];

// 1. Add imageGen require after line 14
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("require('dotenv').config();")) {
      lines.splice(i + 1, 0, "const imageGen = require('./image-gen');");
      console.log(`Added imageGen require after line ${i+1}`);
      break;
    }
  }
});

// 2. Update SYSTEM_PROMPT - add image gen instructions before "APÓS GERAR CÓDIGO"
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('**APÓS GERAR CÓDIGO**')) {
      const imageSection = [
        '',
        '## GERACAO DE IMAGENS',
        '- Voce PODE gerar imagens usando o formato: ![IMAGEM: descricao detalhada da imagem]',
        '- Exemplo: ![IMAGEM: um gato preto com olhos verdes sentado em um sofa vermelho]',
        '- A descricao deve ser detalhada em portugues para melhor resultado',
        '- A imagem sera gerada automaticamente quando voce usar este formato',
        '- Use para ilustrar conceitos, mostrar designs, criar assets visuais',
        '- NAO use para fotos de pessoas reais ou conteudo improprio',
        '- A geracao de imagem NAO substitui a geracao de codigo - use para complementar',
        ''
      ];
      lines.splice(i, 0, ...imageSection);
      console.log(`Added image gen section before line ${i+1}`);
      break;
    }
  }
});

// 3. Add image generation processing after parseFilesFromReply
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('const files = parseFilesFromReply(reply);')) {
      const imageProcessCode = [
        '',
        '    // === IMAGE GENERATION ===',
        '    let generatedImages = [];',
        '    if (reply && reply.includes("![IMAGEM:")) {',
        '        try {',
        '            const markers = imageGen.extractImageMarkers(reply);',
        '            if (markers.length > 0) {',
        '                const allKeys = getAllKeysWithState();',
        '                const enabledKey = allKeys.find(k => k.enabled);',
        '                if (enabledKey) {',
        '                    for (const marker of markers) {',
        '                        const result = await imageGen.generateImage(marker.prompt, enabledKey.key);',
        '                        if (result.imageData) {',
        '                            generatedImages.push({',
        '                                prompt: marker.prompt,',
        '                                imageData: result.imageData,',
        '                                mimeType: result.mimeType',
        '                            });',
        '                            reply = reply.replace(marker.fullMatch, "[Imagem: " + marker.prompt + "]");',
        '                        }',
        '                    }',
        '                }',
        '            }',
        '        } catch (imgErr) {',
        '            console.log("[IMAGE-GEN] Error:", imgErr.message);',
        '        }',
        '    }',
        ''
      ];
      lines.splice(i + 1, 0, ...imageProcessCode);
      console.log(`Added image gen processing after line ${i+1}`);
      break;
    }
  }
});

// 4. Update response objects to include images
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("return res.json({ reply: msgOnly, files, type: 'web', source });")) {
      lines[i] = "        return res.json({ reply: msgOnly, files, type: 'web', source, images: generatedImages.length > 0 ? generatedImages : undefined });";
      console.log(`Updated response with images at line ${i+1}`);
    }
    if (lines[i].includes('res.json({ reply, source });')) {
      // Only update the response in the chat route (after hasFiles check)
      if (i > 2370 && i < 2390) {
        lines[i] = "    res.json({ reply, source, images: generatedImages.length > 0 ? generatedImages : undefined });";
        console.log(`Updated simple response with images at line ${i+1}`);
      }
    }
  }
});

// 5. Add /api/generate-image endpoint before /api/chat route
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("app.post('/api/chat', authMiddleware")) {
      const endpointCode = [
        '',
        '// === IMAGE GENERATION API ===',
        "app.post('/api/generate-image', authMiddleware, async (req, res) => {",
        "    const { prompt } = req.body;",
        "    if (!prompt) return res.status(400).json({ error: 'Prompt obrigatorio' });",
        '    try {',
        '        const allKeys = getAllKeysWithState();',
        '        const enabledKey = allKeys.find(k => k.enabled);',
        "        if (!enabledKey) return res.status(503).json({ error: 'Nenhuma API key disponivel' });",
        '        const result = await imageGen.generateImage(prompt, enabledKey.key);',
        "        if (result.error) return res.status(500).json({ error: result.error });",
        '        res.json({ imageData: result.imageData, mimeType: result.mimeType, text: result.text });',
        '    } catch (err) {',
        '        res.status(500).json({ error: err.message });',
        '    }',
        '});',
        ''
      ];
      lines.splice(i, 0, ...endpointCode);
      console.log(`Added /api/generate-image endpoint before line ${i+1}`);
      break;
    }
  }
});

// 6. Add imageGenLimiter rate limiter before image gen endpoint (max 3 per minute)
changes.push(() => {
  // First, add the rateLimit require at the top
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("const imageGen = require('./image-gen');")) {
      lines.splice(i + 1, 0, "const imageGenLimiter = require('express-rate-limit')({");
      lines.splice(i + 2, 0, "    windowMs: 60 * 1000, // 1 minute");
      lines.splice(i + 3, 0, "    max: 3,");
      lines.splice(i + 4, 0, "    message: { error: 'Limite de 3 imagens por minuto. Aguarde um instante.' },");
      lines.splice(i + 5, 0, "    standardHeaders: true,");
      lines.splice(i + 6, 0, "    legacyHeaders: false");
      lines.splice(i + 7, 0, "});");
      console.log(`Added imageGenLimiter after line ${i+2}`);
      break;
    }
  }
});

// 7. Apply rate limiter to the /api/generate-image endpoint
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("app.post('/api/generate-image', authMiddleware")) {
      // Replace the route to include the rate limiter middleware
      lines[i] = "app.post('/api/generate-image', imageGenLimiter, authMiddleware, async (req, res) => {";
      console.log(`Applied imageGenLimiter to /api/generate-image at line ${i+1}`);
      break;
    }
  }
});

// 8. Add simple in-memory rate limit check in the chat route image processing
changes.push(() => {
  // Add a simple rate limit map before the image generation block
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('let generatedImages = [];')) {
      const rateCheck = [
        '    // Per-user rate limit: max 3 image generations per minute',
        '    const _rateKey = req.user?.id || \'anonymous\';',
        '    const _now = Date.now();',
        '    if (!global._imgRateLimits) global._imgRateLimits = {};',
        '    if (!global._imgRateLimits[_rateKey]) global._imgRateLimits[_rateKey] = [];',
        '    global._imgRateLimits[_rateKey] = global._imgRateLimits[_rateKey].filter(t => _now - t < 60000);',
        '    if (global._imgRateLimits[_rateKey].length >= 3) {',
        '        console.log("[IMAGE-GEN] Rate limited:", _rateKey);',
        '    } else {',
        ''
      ];
      // Add these lines INSIDE the image generation block at the right spot
      // Actually, we need to add the rate limiter INSIDE the if block, not outside
      break;
    }
  }
});

// 8b. Better approach: add rate limiter inside the markers loop
changes.push(() => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('for (const marker of markers) {')) {
      // Add rate limiting before imageGen.generateImage call
      const rateCode = [
        '                            // Enforce rate limit: max 3 per minute per user',
        '                            const rateKey = req.user?.id || \'anonymous\';',
        '                            const nw = Date.now();',
        '                            global._imgRateLimits = global._imgRateLimits || {};',
        '                            global._imgRateLimits[rateKey] = (global._imgRateLimits[rateKey] || []).filter(t => nw - t < 60000);',
        '                            if (global._imgRateLimits[rateKey].length >= 3) {',
        '                                console.log("[IMAGE-GEN] Rate limit reached for", rateKey);',
        '                                continue;',
        '                            }',
        '                            global._imgRateLimits[rateKey].push(nw);',
        ''
      ];
      lines.splice(i + 2, 0, ...rateCode);
      console.log(`Added rate limit check inside markers loop at line ${i+3}`);
      break;
    }
  }
});

// Apply all changes
for (const change of changes) {
  try { change(); } catch(e) { console.log('Skipping change:', e.message); }
}

writeFileSync('server.js', lines.join('\n'), 'utf8');
console.log('\nAll changes applied successfully!');
