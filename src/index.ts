import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
    Env,
    TransferMeta,
    InitRequest,
    InitResponse,
    CompleteRequest,
    SignResponse,
    StatusResponse,
    ErrorResponse,
    UserResponse
} from './types';
import {
    getUserFromRequest,
    createJWT,
    getGitHubAuthUrl,
    exchangeCodeForToken,
    getGitHubUser,
    ANONYMOUS_MAX_SIZE,
    AUTH_MAX_SIZE
} from './auth';

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for frontend
app.use('*', cors());

/**
 * Generate a random transfer ID (提取码)
 */
function generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

/**
 * Create S3 client for R2
 */
function createS3Client(env: Env): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
    });
}

/**
 * GET /t/:id - Serve download page for a transfer
 */
app.get('/t/:id', async (c) => {
    const id = c.req.param('id');
    return c.redirect(`/download.html?id=${id}`);
});

/**
 * POST /api/init - Initialize a transfer and get presigned upload URL
 * Returns the 提取码 immediately before upload starts
 */
app.post('/api/init', async (c) => {
    try {
        const body: InitRequest = await c.req.json<InitRequest>().catch(() => ({}));
        const user = await getUserFromRequest(c);

        const expiryHours = body.expiryHours || parseInt(c.env.DEFAULT_EXPIRY_HOURS || '24');
        const maxDownloads = body.maxDownloads || parseInt(c.env.DEFAULT_MAX_DOWNLOADS || '10');
        const maxFileSize = user ? AUTH_MAX_SIZE : ANONYMOUS_MAX_SIZE;

        // Generate unique ID (提取码)
        const id = generateId();
        const now = Date.now();
        const expiresAt = now + expiryHours * 60 * 60 * 1000;

        // Create S3 client for presigned URL
        const s3 = createS3Client(c.env);

        // Generate presigned PUT URL (valid for 1 hour)
        const command = new PutObjectCommand({
            Bucket: c.env.R2_BUCKET_NAME,
            Key: id,
        });
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

        // Store pending metadata in KV
        const meta: TransferMeta = {
            id,
            status: 'pending',
            filename: '',
            size: 0,
            contentType: '',
            createdAt: now,
            expiresAt,
            maxDownloads,
            downloads: 0,
            userId: user?.userId,
        };

        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: expiryHours * 60 * 60,
        });

        return c.json<InitResponse>({
            success: true,
            id,
            uploadUrl,
            expiresAt,
            maxDownloads,
            maxFileSize,
        });
    } catch (error) {
        console.error('Init error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Failed to initialize transfer' }, 500);
    }
});

/**
 * POST /api/complete/:id - Confirm upload completion with file metadata
 */
app.post('/api/complete/:id', async (c) => {
    const id = c.req.param('id');

    try {
        const body = await c.req.json<CompleteRequest>();

        // Get existing metadata
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json<ErrorResponse>({ success: false, error: 'Transfer not found' }, 404);
        }

        const meta: TransferMeta = JSON.parse(metaJson);

        // Update metadata with file info
        meta.status = 'ready';
        meta.filename = body.filename;
        meta.size = body.size;
        meta.contentType = body.contentType;

        const remainingTtl = Math.max(1, Math.floor((meta.expiresAt - Date.now()) / 1000));
        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: remainingTtl,
        });

        return c.json({ success: true, id });
    } catch (error) {
        console.error('Complete error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Failed to complete transfer' }, 500);
    }
});

/**
 * GET /api/sign/:id - Get presigned download URL
 */
app.get('/api/sign/:id', async (c) => {
    const id = c.req.param('id');

    try {
        // Get metadata
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json<ErrorResponse>({ success: false, error: 'File not found or expired' }, 404);
        }

        const meta: TransferMeta = JSON.parse(metaJson);

        // Check if file is banned
        if (meta.status === 'banned') {
            return c.json<ErrorResponse>({ success: false, error: 'File has been banned' }, 403);
        }

        // Check if upload is complete
        if (meta.status !== 'ready') {
            return c.json<ErrorResponse>({ success: false, error: 'File upload not yet complete' }, 400);
        }

        // Check expiration
        if (Date.now() > meta.expiresAt) {
            await c.env.TRANSFERS_KV.delete(`transfer:${id}`);
            await c.env.FILES_R2.delete(id);
            return c.json<ErrorResponse>({ success: false, error: 'File expired' }, 410);
        }

        // Check download limit
        if (meta.downloads >= meta.maxDownloads) {
            await c.env.TRANSFERS_KV.delete(`transfer:${id}`);
            await c.env.FILES_R2.delete(id);
            return c.json<ErrorResponse>({ success: false, error: 'Download limit reached' }, 410);
        }

        // Create S3 client for presigned URL
        const s3 = createS3Client(c.env);

        // Generate presigned GET URL (valid for 10 minutes)
        const command = new GetObjectCommand({
            Bucket: c.env.R2_BUCKET_NAME,
            Key: id,
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(meta.filename)}"`,
        });
        const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });

        // Increment download count
        meta.downloads++;
        const remainingTtl = Math.max(1, Math.floor((meta.expiresAt - Date.now()) / 1000));
        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: remainingTtl,
        });

        // If this was the last download, schedule cleanup
        if (meta.downloads >= meta.maxDownloads) {
            c.executionCtx.waitUntil(
                (async () => {
                    await c.env.FILES_R2.delete(id);
                    await c.env.TRANSFERS_KV.delete(`transfer:${id}`);
                })()
            );
        }

        return c.json<SignResponse>({
            success: true,
            url: downloadUrl,
            filename: meta.filename,
            size: meta.size,
            expiresAt: meta.expiresAt,
            downloadsRemaining: meta.maxDownloads - meta.downloads,
        });
    } catch (error) {
        console.error('Sign error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Failed to generate download URL' }, 500);
    }
});

/**
 * GET /api/status/:id - Get file status (for download page)
 */
app.get('/api/status/:id', async (c) => {
    const id = c.req.param('id');

    try {
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json<ErrorResponse>({ success: false, error: 'File not found or expired' }, 404);
        }

        const meta: TransferMeta = JSON.parse(metaJson);
        const expired = Date.now() > meta.expiresAt || meta.downloads >= meta.maxDownloads;

        return c.json<StatusResponse>({
            success: true,
            id: meta.id,
            ready: meta.status === 'ready',
            filename: meta.filename,
            size: meta.size,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            maxDownloads: meta.maxDownloads,
            downloads: meta.downloads,
            expired,
        });
    } catch (error) {
        console.error('Status error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Failed to get status' }, 500);
    }
});

/**
 * DELETE /api/delete/:id - Manually delete a file
 */
app.delete('/api/delete/:id', async (c) => {
    const id = c.req.param('id');

    try {
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json<ErrorResponse>({ success: false, error: 'File not found' }, 404);
        }

        await Promise.all([
            c.env.TRANSFERS_KV.delete(`transfer:${id}`),
            c.env.FILES_R2.delete(id),
        ]);

        return c.json({ success: true, message: 'File deleted' });
    } catch (error) {
        console.error('Delete error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Delete failed' }, 500);
    }
});

/**
 * POST /api/report/:id - Report a file for review
 */
app.post('/api/report/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ reason: string; email?: string }>().catch(() => ({ reason: '' }));

    if (!body.reason || body.reason.length < 5) {
        return c.json<ErrorResponse>({ success: false, error: 'Please provide a reason' }, 400);
    }

    try {
        // Check if transfer exists
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json<ErrorResponse>({ success: false, error: 'File not found' }, 404);
        }

        // Store report in KV (simple approach - in production use D1)
        const reportKey = `report:${id}:${Date.now()}`;
        await c.env.TRANSFERS_KV.put(reportKey, JSON.stringify({
            transferId: id,
            reason: body.reason,
            email: body.email || null,
            createdAt: Date.now(),
            userAgent: c.req.header('User-Agent'),
        }), { expirationTtl: 30 * 24 * 60 * 60 }); // 30 days

        return c.json({ success: true, message: 'Report submitted, thank you!' });
    } catch (error) {
        console.error('Report error:', error);
        return c.json<ErrorResponse>({ success: false, error: 'Failed to submit report' }, 500);
    }
});

/**
 * Health check
 */
app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
});

// ============ OAuth Routes ============

/**
 * GET /auth/github - Start GitHub OAuth flow
 */
app.get('/auth/github', async (c) => {
    const url = new URL(c.req.url);
    const redirectUri = `${url.origin}/auth/github/callback`;
    const authUrl = getGitHubAuthUrl(c.env.GITHUB_CLIENT_ID, redirectUri);
    return c.redirect(authUrl);
});

/**
 * GET /auth/github/callback - Handle GitHub OAuth callback
 */
app.get('/auth/github/callback', async (c) => {
    const code = c.req.query('code');

    if (!code) {
        return c.redirect('/?error=auth_failed');
    }

    try {
        // Exchange code for access token
        const accessToken = await exchangeCodeForToken(
            code,
            c.env.GITHUB_CLIENT_ID,
            c.env.GITHUB_CLIENT_SECRET
        );

        if (!accessToken) {
            return c.redirect('/?error=token_failed');
        }

        // Get user info
        const githubUser = await getGitHubUser(accessToken);
        if (!githubUser) {
            return c.redirect('/?error=user_failed');
        }

        const now = Date.now();
        const isAdmin = githubUser.login === c.env.ADMIN_GITHUB_LOGIN ? 1 : 0;

        // Upsert user in D1
        await c.env.USERS_DB.prepare(`
            INSERT INTO users (github_id, login, name, avatar_url, is_admin, created_at, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(github_id) DO UPDATE SET
                login = excluded.login,
                name = excluded.name,
                avatar_url = excluded.avatar_url,
                is_admin = excluded.is_admin,
                last_login_at = excluded.last_login_at
        `).bind(
            String(githubUser.id),
            githubUser.login,
            githubUser.name,
            githubUser.avatar_url,
            isAdmin,
            now,
            now
        ).run();

        // Create JWT session
        const jwt = await createJWT({
            userId: String(githubUser.id),
            login: githubUser.login,
            avatar: githubUser.avatar_url,
            name: githubUser.name || githubUser.login,
            isAdmin: isAdmin === 1,
        }, c.env.JWT_SECRET);

        // Set cookie and redirect
        return new Response(null, {
            status: 302,
            headers: {
                'Location': '/',
                'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
            },
        });
    } catch (error) {
        console.error('OAuth callback error:', error);
        return c.redirect('/?error=auth_error');
    }
});

/**
 * GET /auth/logout - Clear session
 */
app.get('/auth/logout', (c) => {
    return new Response(null, {
        status: 302,
        headers: {
            'Location': '/',
            'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        },
    });
});

/**
 * GET /api/me - Get current user info
 */
app.get('/api/me', async (c) => {
    const user = await getUserFromRequest(c);
    const maxFileSize = user ? AUTH_MAX_SIZE : ANONYMOUS_MAX_SIZE;

    if (!user) {
        return c.json<UserResponse>({
            success: true,
            authenticated: false,
            maxFileSize,
        });
    }

    return c.json<UserResponse>({
        success: true,
        authenticated: true,
        user: {
            id: user.userId,
            login: user.login,
            avatar: user.avatar,
            name: user.name,
            isAdmin: user.isAdmin,
        },
        maxFileSize,
    });
});

// ============ Admin Routes ============

/**
 * Admin middleware - check if user is admin
 */
async function requireAdmin(c: any): Promise<Response | null> {
    const user = await getUserFromRequest(c);
    if (!user || !user.isAdmin) {
        return c.json({ success: false, error: 'Admin access required' }, 403);
    }
    return null;
}

/**
 * GET /admin/transfers - List all transfers (admin only)
 */
app.get('/admin/transfers', async (c) => {
    const adminCheck = await requireAdmin(c);
    if (adminCheck) return adminCheck;

    try {
        // List transfers from KV (note: KV list has 1000 limit)
        const list = await c.env.TRANSFERS_KV.list({ prefix: 'transfer:' });
        const transfers = [];

        for (const key of list.keys.slice(0, 100)) { // Limit to 100
            const meta = await c.env.TRANSFERS_KV.get(key.name);
            if (meta) {
                transfers.push(JSON.parse(meta));
            }
        }

        // Sort by createdAt desc
        transfers.sort((a, b) => b.createdAt - a.createdAt);

        return c.json({ success: true, transfers });
    } catch (error) {
        console.error('Admin transfers error:', error);
        return c.json({ success: false, error: 'Failed to list transfers' }, 500);
    }
});

/**
 * POST /admin/ban/:id - Ban a file (admin only)
 */
app.post('/admin/ban/:id', async (c) => {
    const adminCheck = await requireAdmin(c);
    if (adminCheck) return adminCheck;

    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));

    try {
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json({ success: false, error: 'Transfer not found' }, 404);
        }

        const meta: TransferMeta = JSON.parse(metaJson);
        meta.status = 'banned';
        meta.bannedAt = Date.now();
        meta.bannedReason = body.reason || 'Violation of terms';

        const remainingTtl = Math.max(1, Math.floor((meta.expiresAt - Date.now()) / 1000));
        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: remainingTtl,
        });

        return c.json({ success: true, message: 'File banned' });
    } catch (error) {
        console.error('Admin ban error:', error);
        return c.json({ success: false, error: 'Failed to ban file' }, 500);
    }
});

/**
 * POST /admin/unban/:id - Unban a file (admin only)
 */
app.post('/admin/unban/:id', async (c) => {
    const adminCheck = await requireAdmin(c);
    if (adminCheck) return adminCheck;

    const id = c.req.param('id');

    try {
        const metaJson = await c.env.TRANSFERS_KV.get(`transfer:${id}`);
        if (!metaJson) {
            return c.json({ success: false, error: 'Transfer not found' }, 404);
        }

        const meta: TransferMeta = JSON.parse(metaJson);
        meta.status = 'ready';
        delete meta.bannedAt;
        delete meta.bannedReason;

        const remainingTtl = Math.max(1, Math.floor((meta.expiresAt - Date.now()) / 1000));
        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: remainingTtl,
        });

        return c.json({ success: true, message: 'File unbanned' });
    } catch (error) {
        console.error('Admin unban error:', error);
        return c.json({ success: false, error: 'Failed to unban file' }, 500);
    }
});

/**
 * GET /admin/users - List all users (admin only)
 */
app.get('/admin/users', async (c) => {
    const adminCheck = await requireAdmin(c);
    if (adminCheck) return adminCheck;

    try {
        const result = await c.env.USERS_DB.prepare(
            'SELECT * FROM users ORDER BY last_login_at DESC LIMIT 100'
        ).all();

        return c.json({ success: true, users: result.results });
    } catch (error) {
        console.error('Admin users error:', error);
        return c.json({ success: false, error: 'Failed to list users' }, 500);
    }
});

export default app;

