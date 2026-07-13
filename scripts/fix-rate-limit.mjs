import { readFileSync, writeFileSync } from 'fs';

const fp = 'server.js';
let src = readFileSync(fp, 'utf8');
const lines = src.split('\n');

// Find the generateImage call and the rate limit code
let genLineIdx = -1;
let rateLineIdx = -1;
let pushLineIdx = -1;
let resultCheckIdx = -1;

for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('const result = await imageGen.generateImage(marker.prompt, enabledKey.key)')) {
        genLineIdx = i;
    }
    if (l.includes("// Enforce rate limit: max 3 per minute per user")) {
        rateLineIdx = i;
    }
    if (l.includes('global._imgRateLimits[rateKey].push(nw)')) {
        pushLineIdx = i;
    }
    if (l.includes('if (result.imageData)')) {
        resultCheckIdx = i;
    }
}

console.log('generateImage line:', genLineIdx);
console.log('rate limit line:', rateLineIdx);
console.log('push line:', pushLineIdx);
console.log('result check line:', resultCheckIdx);

if (genLineIdx === -1 || rateLineIdx === -1 || pushLineIdx === -1 || resultCheckIdx === -1) {
    console.log('ERROR: Could not find all required lines');
    process.exit(1);
}

// Delete lines from rateLineIdx to pushLineIdx (inclusive)
// Then re-insert them before genLineIdx, plus add cleanup
const rateLimitBlock = lines.slice(rateLineIdx, pushLineIdx + 1);

// Build new insert: rate limit check + push + cleanup
const newRateLimit = [
    '                        // Rate limit: max 3 per minute per user (check BEFORE API call)',
    '                        const rateKey = req.user?.id || \'anonymous\';',
    '                        const nw = Date.now();',
    '                        global._imgRateLimits = global._imgRateLimits || {};',
    '                        global._imgRateLimits[rateKey] = (global._imgRateLimits[rateKey] || []).filter(t => nw - t < 60000);',
    '                        if (global._imgRateLimits[rateKey].length >= 3) {',
    '                            console.log("[IMAGE-GEN] Rate limit reached for", rateKey);',
    '                            reply = reply.replace(marker.fullMatch, "[\\u26A0\\uFE0F Limite de imagens excedido]");',
    '                            continue;',
    '                        }',
    '                        global._imgRateLimits[rateKey].push(nw);',
    '                        // Cleanup empty keys to prevent memory leak',
    '                        if (global._imgRateLimits[rateKey].length === 0) {',
    '                            delete global._imgRateLimits[rateKey];',
    '                        }',
    ''
];

// Remove old rate limit block (rateLineIdx to pushLineIdx inclusive)
lines.splice(rateLineIdx, pushLineIdx - rateLineIdx + 1);

// The genLineIdx may have shifted after the splice
// If genLineIdx was AFTER rateLineIdx, it decreased by (pushLineIdx - rateLineIdx + 1)
const oldGenIdx = genLineIdx;
const blockLen = pushLineIdx - rateLineIdx + 1;
if (genLineIdx > rateLineIdx) {
    genLineIdx -= blockLen;
}

// Insert new rate limit code before the generateImage line
lines.splice(genLineIdx, 0, ...newRateLimit);

// Also remove the old Enforce rate limit comment that might remain
// Actually the splice already removed it all

src = lines.join('\n');
writeFileSync(fp, src, 'utf8');
console.log('Rate limit fix applied');
