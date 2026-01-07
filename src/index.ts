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
    ErrorResponse
} from './types';

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

        const expiryHours = body.expiryHours || parseInt(c.env.DEFAULT_EXPIRY_HOURS || '24');
        const maxDownloads = body.maxDownloads || parseInt(c.env.DEFAULT_MAX_DOWNLOADS || '10');

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
        };

        await c.env.TRANSFERS_KV.put(`transfer:${id}`, JSON.stringify(meta), {
            expirationTtl: expiryHours * 60 * 60,
        });

        // Build download URL for display
        const url = new URL(c.req.url);
        const downloadUrl = `${url.origin}/t/${id}`;

        return c.json<InitResponse>({
            success: true,
            id,
            uploadUrl,
            expiresAt,
            maxDownloads,
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
 * Health check
 */
app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
});

export default app;
