/**
 * Cloudflare Worker Environment Bindings
 */
export interface Env {
    // KV Namespace for transfer metadata
    TRANSFERS_KV: KVNamespace;
    // R2 Bucket for file storage
    FILES_R2: R2Bucket;
    // D1 Database for user management
    USERS_DB: D1Database;
    // R2 S3-compatible API credentials (for presigned URLs)
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_ACCOUNT_ID: string;
    R2_BUCKET_NAME: string;
    R2_PUBLIC_URL: string;
    // GitHub OAuth
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    JWT_SECRET: string;
    // Admin config
    ADMIN_GITHUB_LOGIN: string;
    // Environment variables
    MAX_FILE_SIZE: string;
    AUTH_MAX_FILE_SIZE: string;
    DEFAULT_EXPIRY_HOURS: string;
    DEFAULT_MAX_DOWNLOADS: string;
}

/**
 * Transfer metadata stored in KV
 */
export interface TransferMeta {
    id: string;
    status: 'pending' | 'ready' | 'banned';
    filename: string;
    size: number;
    contentType: string;
    createdAt: number;
    expiresAt: number;
    maxDownloads: number;
    downloads: number;
    userId?: string; // GitHub user ID if authenticated
    bannedAt?: number;
    bannedReason?: string;
}

/**
 * Upload request options
 */
export interface UploadOptions {
    expiryHours?: number;
    maxDownloads?: number;
}

/**
 * API response types
 */
export interface UploadResponse {
    success: boolean;
    id: string;
    url: string;
    expiresAt: number;
    maxDownloads: number;
}

export interface StatusResponse {
    success: boolean;
    id: string;
    ready: boolean;
    filename: string;
    size: number;
    createdAt: number;
    expiresAt: number;
    maxDownloads: number;
    downloads: number;
    expired: boolean;
}

export interface ErrorResponse {
    success: false;
    error: string;
}

/**
 * Presigned URL API types
 */
export interface InitRequest {
    expiryHours?: number;
    maxDownloads?: number;
}

export interface InitResponse {
    success: boolean;
    id: string;
    uploadUrl: string;
    expiresAt: number;
    maxDownloads: number;
    maxFileSize: number;
}

export interface CompleteRequest {
    filename: string;
    size: number;
    contentType: string;
}

export interface SignResponse {
    success: boolean;
    url: string;
    filename: string;
    size: number;
    expiresAt: number;
    downloadsRemaining: number;
}

/**
 * GitHub OAuth types
 */
export interface GitHubUser {
    id: number;
    login: string;
    avatar_url: string;
    name: string | null;
}

export interface JWTPayload {
    userId: string;
    login: string;
    avatar: string;
    name: string;
    isAdmin: boolean;
    exp: number;
}

export interface UserResponse {
    success: boolean;
    authenticated: boolean;
    user?: {
        id: string;
        login: string;
        avatar: string;
        name: string;
        isAdmin?: boolean;
    };
    maxFileSize: number;
}

