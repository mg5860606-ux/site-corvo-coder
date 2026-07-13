// === CORVO CODER FRONTEND ANALYTICS ===
// Tracks user interactions and sends events to the backend
(function() {
    'use strict';

    const API = window.location.origin;
    const SESSION_KEY = 'cc_session_id';
    let sessionId = localStorage.getItem(SESSION_KEY) || 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SESSION_KEY, sessionId);

    function getUserId() {
        try {
            const token = localStorage.getItem('cc_token');
            const user = localStorage.getItem('cc_user');
            if (token && user) {
                const parsed = JSON.parse(user);
                return parsed.id || parsed.email || null;
            }
        } catch {}
        return null;
    }

    function track(eventType, metadata = {}) {
        try {
            const payload = {
                type: eventType,
                page: window.location.pathname.replace(/^\\//, '').replace('.html', '') || 'index',
                url: window.location.href,
                userId: getUserId(),
                sessionId: sessionId,
                metadata: metadata,
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent,
                screen: window.screen ? window.screen.width + 'x' + window.screen.height : null,
                referrer: document.referrer || null
            };

            // Use sendBeacon for reliability (works even during page unload)
            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            navigator.sendBeacon(API + '/api/track', blob);

            // Also try fetch as fallback
            if (!navigator.sendBeacon) {
                fetch(API + '/api/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch(() => {});
            }

            // Log in dev mode
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.log('[📊 Analytics]', eventType, metadata);
            }
        } catch {}
    }

    // Track page view on load
    if (document.readyState === 'complete') {
        track('page_view');
    } else {
        window.addEventListener('load', function() {
            setTimeout(function() { track('page_view'); }, 500);
        });
    }

    // Track page visibility changes (user returning to tab)
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            track('page_focus');
        }
    });

    // Track clicks on interactive elements
    document.addEventListener('click', function(e) {
        const target = e.target;
        
        // Track template card clicks
        const templateCard = target.closest('.template-card');
        if (templateCard) {
            const title = templateCard.querySelector('.template-title')?.textContent || 'unknown';
            track('template_click', { template: title });
            return;
        }

        // Track send button
        if (target.closest('.send-btn') || target.closest('#sendBtn')) {
            track('send_message');
            return;
        }

        // Track new chat button
        if (target.closest('.new-chat-btn') || target.closest('[onclick*=\"newChat\"]')) {
            track('new_chat');
            return;
        }

        // Track export button
        if (target.closest('.export') || target.closest('[onclick*=\"exportChat\"]') || target.closest('[onclick*=\"export\"]')) {
            track('export_chat');
            return;
        }

        // Track deploy button
        if (target.closest('.deploy') || target.closest('[onclick*=\"deploy\"]')) {
            track('deploy');
            return;
        }

        // Track mic button
        if (target.closest('.mic-btn') || target.closest('#micBtn')) {
            track('mic_toggle');
            return;
        }

        // Track attach button
        if (target.closest('.attach-btn')) {
            track('attach_file');
            return;
        }

        // Track navigation to settings/billing
        const link = target.closest('a');
        if (link) {
            const href = link.getAttribute('href');
            if (href) {
                if (href.includes('settings')) track('nav_settings');
                else if (href.includes('billing') || href.includes('planos')) track('nav_billing');
                else if (href.includes('login')) track('nav_login');
                else if (href.includes('signup')) track('nav_signup');
            }
        }

        // Track suggestion clicks
        if (target.closest('[onclick*=\"useSuggestion\"]')) {
            track('use_suggestion');
        }
    });

    // Track search/filter interactions
    document.addEventListener('input', function(e) {
        if (e.target.id === 'searchInput' || e.target.closest('#searchInput')) {
            // Debounce search tracking
            clearTimeout(window._searchTimer);
            window._searchTimer = setTimeout(function() {
                track('search', { query: e.target.value.substring(0, 50) });
            }, 2000);
        }
    });

    // Track errors
    window.addEventListener('error', function(e) {
        if (e.message && !e.message.includes('ResizeObserver')) {
            track('frontend_error', { 
                message: (e.message || '').substring(0, 200),
                source: e.filename || ''
            });
        }
    });

    // Track unhandled promise rejections
    window.addEventListener('unhandledrejection', function(e) {
        track('promise_error', { 
            message: (e.reason?.message || String(e.reason || '')).substring(0, 200)
        });
    });

    // Expose track function globally for manual tracking
    window.analytics = { track: track };

})();
