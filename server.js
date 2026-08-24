/**
 * WhatsApp Web Service v2.0
 * Production-ready with better error handling
 *
 * Usage:
 *   npm start                    # Default port 3001
 *   PORT=8080 npm start        # Custom port
 *
 * API Endpoints:
 *   GET  /qr/:restaurantId     - Get QR code
 *   GET  /status/:restaurantId - Check status
 *   POST /send                 - Send message
 *   POST /disconnect/:id       - Disconnect
 *   GET  /health               - Health check
 */

const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();

// Configuration
const PORT = process.env.PORT || 3001;
const SESSION_DIR = path.join(__dirname, 'sessions');
const QR_EXPIRY = 60000; // QR code expires in 60 seconds

// Ensure sessions directory exists
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Store instances
const clients = new Map();
const qrCodes = new Map();
const initState = new Map();

// Health check on startup
console.log('============================================');
console.log('  WhatsApp Web Service v2.0');
console.log(`  Port: ${PORT}`);
console.log(`  Sessions Dir: ${SESSION_DIR}`);
console.log('============================================\n');

/**
 * Generate QR Code as base64 data URL
 */
async function generateQRCode(text) {
    try {
        return await QRCode.toDataURL(text, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
    } catch (e) {
        console.error('QR generation error:', e);
        return null;
    }
}

/**
 * Create and initialize WhatsApp client for a restaurant
 */
function createClient(restaurantId) {
    const sessionPath = path.join(SESSION_DIR, `session_${restaurantId}`);

    console.log(`[${restaurantId}] Creating client...`);

    const puppeteerConfig = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-infobars',
            '--window-size=1280x720'
        ],
        timeout: 60000
    };

    // Use Chrome from environment if set (for Railway with Dockerfile)
    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    if (chromePath) {
        puppeteerConfig.executablePath = chromePath;
        console.log(`Using Chrome at: ${chromePath}`);
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: sessionPath
        }),
        puppeteer: puppeteerConfig
    });

    // QR Code received
    client.on('qr', async (qr) => {
        console.log(`[${restaurantId}] QR code received`);
        try {
            const qrImage = await generateQRCode(qr);
            if (qrImage) {
                qrCodes.set(restaurantId, {
                    qr: qrImage,
                    timestamp: Date.now()
                });
                console.log(`[${restaurantId}] QR generated successfully`);
            }
        } catch (e) {
            console.error(`[${restaurantId}] Failed to generate QR:`, e.message);
        }
    });

    // Client ready
    client.on('ready', () => {
        console.log(`[${restaurantId}] ✅ WhatsApp connected!`);
        initState.set(restaurantId, { status: 'ready' });
        qrCodes.delete(restaurantId);
    });

    // Authenticated
    client.on('authenticated', () => {
        console.log(`[${restaurantId}] Authenticated`);
    });

    // Auth failure
    client.on('auth_failure', (msg) => {
        console.error(`[${restaurantId}] ❌ Auth failure:`, msg);
        initState.delete(restaurantId);
        qrCodes.delete(restaurantId);
        clients.delete(restaurantId);
    });

    // Disconnected
    client.on('disconnected', (reason) => {
        console.log(`[${restaurantId}] Disconnected:`, reason);
        clients.delete(restaurantId);
        initState.delete(restaurantId);
        qrCodes.delete(restaurantId);
    });

    // Error
    client.on('error', (err) => {
        console.error(`[${restaurantId}] Client error:`, err.message);
    });

    // Initialize
    client.initialize().catch(err => {
        console.error(`[${restaurantId}] Initialize error:`, err.message);
        initState.delete(restaurantId);
    });

    return client;
}

/**
 * Get or create client
 */
function getClient(restaurantId) {
    if (clients.has(restaurantId)) {
        return clients.get(restaurantId);
    }
    const client = createClient(restaurantId);
    clients.set(restaurantId, client);
    return client;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * GET /qr/:restaurantId
 * Get QR code for authentication
 */
app.get('/qr/:restaurantId', async (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    console.log(`[${id}] QR request`);

    try {
        // Already connected?
        const existing = clients.get(id);
        if (existing && existing.info) {
            return res.json({
                success: true,
                connected: true,
                qrcode: null,
                message: 'Already connected'
            });
        }

        // Check stored QR
        if (qrCodes.has(id)) {
            const stored = qrCodes.get(id);
            if (Date.now() - stored.timestamp < QR_EXPIRY) {
                return res.json({
                    success: true,
                    connected: false,
                    qrcode: stored.qr,
                    message: 'Scan QR with WhatsApp'
                });
            }
            qrCodes.delete(id);
        }

        // Create/get client
        getClient(id);
        initState.set(id, { status: 'initializing' });

        // Wait for QR (max 20 seconds)
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));

            const client = clients.get(id);
            if (client && client.info) {
                return res.json({
                    success: true,
                    connected: true,
                    qrcode: null,
                    message: 'Connected'
                });
            }

            if (qrCodes.has(id)) {
                const stored = qrCodes.get(id);
                return res.json({
                    success: true,
                    connected: false,
                    qrcode: stored.qr,
                    message: 'Scan QR with WhatsApp'
                });
            }
        }

        res.json({
            success: true,
            connected: false,
            qrcode: null,
            message: 'Generating QR... Please refresh'
        });

    } catch (e) {
        console.error(`[${id}] QR error:`, e);
        res.json({ success: false, message: e.message });
    }
});

/**
 * GET /status/:restaurantId
 * Check connection status
 */
app.get('/status/:restaurantId', (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    const client = clients.get(id);
    const connected = !!(client && client.info);
    const hasQR = qrCodes.has(id);

    res.json({
        success: true,
        connected,
        hasQR,
        message: connected ? 'Connected' : (hasQR ? 'QR Available' : 'Not connected')
    });
});

/**
 * POST /send
 * Send WhatsApp message
 * Body: { restaurantId, phone, message }
 */
app.post('/send', async (req, res) => {
    const { restaurantId, phone, message } = req.body;

    if (!restaurantId || !phone || !message) {
        return res.json({
            success: false,
            message: 'Missing: restaurantId, phone, message'
        });
    }

    const id = parseInt(restaurantId) || 1;

    try {
        const client = clients.get(id);

        if (!client || !client.info) {
            return res.json({
                success: false,
                message: 'WhatsApp not connected. Scan QR first.'
            });
        }

        // Format phone number
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        if (!formattedPhone.startsWith('62')) {
            if (formattedPhone.startsWith('0')) {
                formattedPhone = '62' + formattedPhone.substring(1);
            } else if (formattedPhone.startsWith('8')) {
                formattedPhone = '62' + formattedPhone;
            }
        }

        const chatId = formattedPhone + '@c.us';
        await client.sendMessage(chatId, message);

        console.log(`[${id}] ✅ Message sent to ${formattedPhone}`);

        res.json({
            success: true,
            message: 'Message sent successfully'
        });

    } catch (e) {
        console.error(`[${id}] Send error:`, e.message);
        res.json({
            success: false,
            message: 'Send failed: ' + e.message
        });
    }
});

/**
 * POST /disconnect/:restaurantId
 * Disconnect WhatsApp session
 */
app.post('/disconnect/:restaurantId', async (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    try {
        const client = clients.get(id);
        if (client) {
            await client.destroy();
        }
        clients.delete(id);
        initState.delete(id);
        qrCodes.delete(id);

        console.log(`[${id}] Disconnected`);

        res.json({
            success: true,
            message: 'Disconnected successfully'
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: clients.size,
        version: '2.0.0'
    });
});

/**
 * GET /
 * Root endpoint - API info
 */
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Web Service',
        version: '2.0.0',
        endpoints: {
            health: 'GET /health',
            qr: 'GET /qr/:restaurantId',
            status: 'GET /status/:restaurantId',
            send: 'POST /send',
            disconnect: 'POST /disconnect/:restaurantId'
        }
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Service ready!');
    console.log(`   http://localhost:${PORT}\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const [id, client] of clients) {
        try {
            await client.destroy();
        } catch (e) {}
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
