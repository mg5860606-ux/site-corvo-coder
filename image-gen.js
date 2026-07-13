// === IMAGE GENERATION MODULE ===
// Uses Gemini models with responseModalities to generate images natively
// Falls back gracefully if the model doesn't support image output

async function generateImage(prompt, apiKey) {
    if (!apiKey) return { error: 'API key não disponível' };
    
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    
    // Try Gemini 2.0 Flash (supports image output with responseModalities)
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
            generationConfig: {
                responseModalities: ['Text', 'Image']
            }
        });

        const result = await model.generateContent(prompt);
        const response = result.response;
        const candidates = response.candidates;

        if (!candidates || !candidates.length) {
            return { error: 'Nenhuma imagem gerada' };
        }

        const parts = candidates[0].content.parts;
        let imageData = null;
        let imageMime = 'image/png';
        let text = '';

        for (const part of parts) {
            if (part.text) {
                text += part.text;
            }
            if (part.inlineData) {
                imageData = part.inlineData.data;
                imageMime = part.inlineData.mimeType || 'image/png';
            }
        }

        if (imageData) {
            return { imageData, mimeType: imageMime, text };
        }

        // Try the same model again with a stronger image-focused prompt
        console.log('[IMAGE-GEN] No image in response, retrying with image-focused prompt...');
        const enhancedPrompt = `Generate ONLY an image of: ${prompt}. Return the image with no text preface.`;
        const model2 = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
            generationConfig: {
                responseModalities: ['Text', 'Image']
            }
        });
        
        const result2 = await model2.generateContent(enhancedPrompt);
        const response2 = result2.response;
        const candidates2 = response2.candidates;
        
        if (candidates2 && candidates2.length) {
            const parts2 = candidates2[0].content.parts;
            for (const part of parts2) {
                if (part.inlineData) {
                    return {
                        imageData: part.inlineData.data,
                        mimeType: part.inlineData.mimeType || 'image/png',
                        text: ''
                    };
                }
            }
        }
        
        return { error: 'Nenhuma imagem gerada. O modelo pode nao suportar geracao no seu plano.', text };
    } catch (err) {
        console.log('[IMAGE-GEN] Error:', err.message);
        return { error: err.message };
    }
}

// Helper: extract IMAGE markers from text content
// The AI uses format: ![IMAGEM: description of image]
function extractImageMarkers(text) {
    const markers = [];
    const regex = /!\[IMAGEM:\s*([^\]]+)\]/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        markers.push({
            prompt: match[1].trim(),
            fullMatch: match[0]
        });
    }
    return markers;
}

// Replace markers in text with HTML image tags (base64)
// Images array: [{ prompt, imageData, mimeType, fullMatch? }]
function replaceWithImages(text, images) {
    let result = text;
    for (const img of images) {
        if (img.imageData) {
            const imgTag = `<div class="gen-image-wrap"><img src="data:${img.mimeType};base64,${img.imageData}" class="gen-image" alt="${img.prompt}" loading="lazy"></div>`;
            result = result.replace(`[🖼️ ${img.prompt}]`, imgTag);
        }
    }
    return result;
}

module.exports = { generateImage, extractImageMarkers, replaceWithImages };
