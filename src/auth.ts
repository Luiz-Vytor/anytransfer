import { Context } from 'hono';
import type { Env, GitHubUser, JWTPayload, UserResponse } from './types';

// File size limits
export const ANONYMOUS_MAX_SIZE = 100 * 1024 * 1024; // 100MB
export const AUTH_MAX_SIZE = 1024 * 1024 * 1024; // 1GB

/**
 * Base64URL encode
 */
function base64UrlEncode(data: string): string {
    return btoa(data)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Base64URL decode
 */
function base64UrlDecode(data: string): string {
    const padded = data + '='.repeat((4 - data.length % 4) % 4);
    return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

/**
 * Create JWT token using Web Crypto API
 */
export async function createJWT(payload: Omit<JWTPayload, 'exp'>, secret: string): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JWTPayload = {
        ...payload,
        exp: now + 7 * 24 * 60 * 60, // 7 days
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
    const message = `${headerB64}.${payloadB64}`;

    // Sign with HMAC-SHA256
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const signatureB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

    return `${message}.${signatureB64}`;
}

/**
 * Verify and decode JWT token
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerB64, payloadB64, signatureB64] = parts;
        const message = `${headerB64}.${payloadB64}`;

        // Verify signature
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );

        const signatureBytes = Uint8Array.from(base64UrlDecode(signatureB64), c => c.charCodeAt(0));
        const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(message));
        if (!valid) return null;

        // Decode payload
        const payload: JWTPayload = JSON.parse(base64UrlDecode(payloadB64));

        // Check expiration
        if (payload.exp < Math.floor(Date.now() / 1000)) return null;

        return payload;
    } catch {
        return null;
    }
}

/**
 * Get user from session cookie
 */
export async function getUserFromRequest(c: Context<{ Bindings: Env }>): Promise<JWTPayload | null> {
    const cookie = c.req.header('Cookie');
    if (!cookie) return null;

    const match = cookie.match(/session=([^;]+)/);
    if (!match) return null;

    return verifyJWT(match[1], c.env.JWT_SECRET);
}

/**
 * GitHub OAuth: Start authorization
 */
export function getGitHubAuthUrl(clientId: string, redirectUri: string): string {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * GitHub OAuth: Exchange code for access token
 */
export async function exchangeCodeForToken(
    code: string,
    clientId: string,
    clientSecret: string
): Promise<string | null> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
        }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { access_token?: string };
    return data.access_token || null;
}

/**
 * GitHub OAuth: Get user info
 */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser | null> {
    const response = await fetch('https://api.github.com/user', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'AnyTransfer',
        },
    });

    if (!response.ok) return null;
    return response.json() as Promise<GitHubUser>;
}
